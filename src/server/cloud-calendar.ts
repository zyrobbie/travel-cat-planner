import type { PoolClient } from "pg";
import frozen from "../content/frozen.json";
import { LIGHT_DEMAND } from "../content/supplemental";
import type { CloudCat } from "./cloud-repository";
import { newCloudCalendarPlan } from "./cloud-calendar-plan";
import {
  cloudBodyHash,
  cloudContentHash,
  getCloudContent,
  registerCloudContent,
  type CloudContentItem,
} from "./cloud-content";
import {
  cloudReviewSources,
  eligibleCloudSources,
  type CloudEvidence,
} from "./cloud-review";

class BusinessSkip extends Error {}
const skip = (reason: string): never => {
  throw new BusinessSkip(reason);
};
function validTime(value: unknown): number {
  const n = value instanceof Date ? value.getTime() : NaN;
  if (!Number.isSafeInteger(n) || n < 0 || n > 8e15)
    throw new Error("Invalid persisted calendar time");
  return n;
}
async function clock(db: PoolClient) {
  return validTime(
    (await db.query("SELECT clock_timestamp() AS now")).rows[0].now,
  );
}

/** Only new adoption calls this in its existing account/cat/state transaction.
 * A fixture may supply nowMs explicitly; there is no user-controlled clock API.
 */
export async function initializeCloudCalendar(
  db: PoolClient,
  cat: CloudCat,
  nowMs?: number,
) {
  const old = await db.query(
    "SELECT 1 FROM cloud_calendars WHERE account_id=$1 AND cat_id=$2 FOR UPDATE",
    [cat.accountId, cat.catId],
  );
  if (old.rows[0]) return { initialized: false };
  const at = nowMs ?? (await clock(db)),
    nodes = newCloudCalendarPlan(at);
  await registerCloudContent(db);
  await db.query(
    "INSERT INTO cloud_calendars(cat_id,account_id,initialized_at,base_at,last_effective_at,node_count) VALUES($1,$2,$3,$3,$3,$4)",
    [cat.catId, cat.accountId, new Date(at), nodes.length],
  );
  for (const n of nodes)
    await db.query(
      `INSERT INTO cloud_calendar_nodes(cat_id,account_id,id,planned_at,node_order,kind,trip_id,scene,content_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        cat.catId,
        cat.accountId,
        n.id,
        new Date(n.plannedAt),
        n.order,
        n.kind,
        n.tripId,
        n.scene,
        n.contentId,
      ],
    );
  await db.query(
    "INSERT INTO cloud_jobs(cat_id,account_id,next_run_at) VALUES($1,$2,$3)",
    [
      cat.catId,
      cat.accountId,
      new Date(Math.min(...nodes.map((n) => n.plannedAt))),
    ],
  );
  return { initialized: true };
}

async function activeTrip(db: PoolClient, cat: CloudCat) {
  const r = await db.query(
    "SELECT id,scene FROM cloud_trips WHERE account_id=$1 AND cat_id=$2 AND status='ACTIVE'",
    [cat.accountId, cat.catId],
  );
  return r.rows[0] as { id: string; scene: string } | undefined;
}
async function registeredContent(
  db: PoolClient,
  id: string,
): Promise<CloudContentItem> {
  const expected = getCloudContent(id);
  if (!expected) return skip("没有可用的冻结正文。");
  const r = await db.query(
    "SELECT type,payload,body_checksum,payload_checksum FROM cloud_content_versions WHERE content_id=$1 AND version=$2",
    [id, expected.version],
  );
  if (!r.rows[0]) return skip("没有可用的冻结正文。");
  const saved = r.rows[0],
    expectedHash = cloudContentHash(expected);
  if (
    saved.type !== expected.type ||
    saved.body_checksum !== cloudBodyHash(expected.body) ||
    saved.payload_checksum !== expectedHash ||
    cloudContentHash(saved.payload) !== expectedHash
  )
    throw new Error("Cloud content checksum mismatch");
  return expected;
}
function tipFor(content: CloudContentItem): string | null {
  if (content.type !== "DEMAND") return null;
  if (content.id === LIGHT_DEMAND.id) return LIGHT_DEMAND.tip;
  const tip = frozen.items.find(
    (item) => item.id === content.id.replace("D-", "TIPS-"),
  );
  if (!tip || cloudBodyHash(tip.body) !== tip.sha256)
    throw new Error("Frozen tip missing or changed");
  return tip.body;
}
type Node = {
  id: string;
  planned_at: Date;
  kind: string;
  trip_id: string | null;
  scene: string | null;
  content_id: string | null;
  result_outcome: string | null;
};
async function deliver(
  db: PoolClient,
  cat: CloudCat,
  node: Node,
  contentId: string,
  actual: number,
  effective: number,
  sources?: CloudEvidence[],
) {
  const content = await registeredContent(db, contentId);
  if (
    (node.kind === "DEMAND" && content.type !== "DEMAND") ||
    (node.kind === "POSTCARD" && !["ORDINARY", "LINKED"].includes(content.type))
  )
    throw new Error("Calendar node content type mismatch");
  const unread = await db.query(
    "SELECT 1 FROM cloud_letters WHERE account_id=$1 AND cat_id=$2 AND read_at IS NULL LIMIT 1",
    [cat.accountId, cat.catId],
  );
  if (unread.rows[0]) return skip("还有未读来信，请先打开阅读；不需要回复。");
  if (cat.safety !== "CLEAR") return skip("合成安全路径中不能投递。");
  const prior = await db.query(
    "SELECT 1 FROM cloud_letters WHERE account_id=$1 AND cat_id=$2 AND content_id=$3",
    [cat.accountId, cat.catId, contentId],
  );
  if (prior.rows[0]) return skip("这封故事已经寄过。");
  const trip = await activeTrip(db, cat);
  if (content.type === "DEMAND" && trip) return skip("旅行中不投递日常卡。");
  if (content.type !== "DEMAND") {
    if (!trip || trip.id !== node.trip_id)
      return skip("对应旅行当前不在进行。");
    if (content.sceneId !== trip.scene || content.sceneId !== node.scene)
      throw new Error("Calendar postcard scene mismatch");
    const sent = await db.query(
      "SELECT 1 FROM cloud_letters WHERE account_id=$1 AND cat_id=$2 AND trip_id=$3 AND type='POSTCARD'",
      [cat.accountId, cat.catId, trip.id],
    );
    if (sent.rows[0]) return skip("这次旅行已经寄过明信片。");
  }
  const id = `${cat.logicalCatId ?? cat.catId}:${content.id}`;
  const snapshot = {
    title: content.title,
    body: content.body,
    contentId: content.id,
    contentVersion: content.version,
    catName: cat.name,
    tip: tipFor(content),
    scene: content.sceneId ?? null,
    season: content.narrativeSeason ?? null,
    timeOfDay: content.timeOfDay ?? null,
  };
  await db.query(
    `INSERT INTO cloud_letters(id,cat_id,account_id,type,content_id,content_version,snapshot,trip_id,story_id,calendar_node_id,delivered_at,planned_at,effective_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id,
      cat.catId,
      cat.accountId,
      content.type === "DEMAND" ? "DEMAND" : "POSTCARD",
      content.id,
      content.version,
      snapshot,
      content.type === "DEMAND" ? null : trip!.id,
      content.type === "DEMAND" ? null : content.id,
      node.id,
      new Date(actual),
      node.planned_at,
      new Date(effective),
    ],
  );
  for (const [order, s] of (sources ?? []).entries())
    await db.query(
      `INSERT INTO cloud_letter_sources(cat_id,account_id,letter_id,source_order,response_id,revision,claim,start_offset,end_offset,assessment,attested)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        cat.catId,
        cat.accountId,
        id,
        order,
        s.responseId,
        s.revision,
        s.claim,
        s.start,
        s.end,
        s.assessment,
        s.attested,
      ],
    );
  return id;
}

/** Caller owns account/cat/state locks. All world, letter, node and job mutations
 * commit together. Only known business exclusions become permanent SKIPPED.
 */
export async function settleCloudCalendar(
  db: PoolClient,
  cat: CloudCat,
): Promise<{ processed: number; nextRunAt: Date | null }> {
  const cr = await db.query(
    "SELECT * FROM cloud_calendars WHERE account_id=$1 AND cat_id=$2 FOR UPDATE",
    [cat.accountId, cat.catId],
  );
  if (!cr.rows[0]) return { processed: 0, nextRunAt: null };
  const cal = cr.rows[0];
  const job = await db.query(
    "SELECT id FROM cloud_jobs WHERE account_id=$1 AND cat_id=$2 FOR UPDATE",
    [cat.accountId, cat.catId],
  );
  if (!job.rows[0]) throw new Error("Calendar job missing");
  const nr = await db.query(
    "SELECT * FROM cloud_calendar_nodes WHERE account_id=$1 AND cat_id=$2 ORDER BY planned_at,node_order FOR UPDATE",
    [cat.accountId, cat.catId],
  );
  const nodes: Node[] = nr.rows;
  if (
    cal.version !== 1 ||
    nodes.length !== cal.node_count ||
    nodes.filter((n) => n.result_outcome !== null).length !==
      cal.processed_count
  )
    throw new Error("Invalid calendar progress");
  validTime(cal.initialized_at);
  validTime(cal.base_at);
  for (const n of nodes) validTime(n.planned_at);
  const offset = Number(cal.offset_ms),
    wall = await clock(db),
    priorTime = validTime(cal.last_effective_at);
  if (!Number.isSafeInteger(offset) || offset < 0 || wall + offset > 8e15)
    throw new Error("Invalid calendar offset");
  const until = Math.max(priorTime, wall + offset),
    due = nodes.filter(
      (n) => n.result_outcome === null && n.planned_at.getTime() <= until,
    );
  for (const n of due) {
    let outcome = "APPLIED",
      reason = "已处理",
      letterId: string | null = null;
    try {
      if (n.kind === "START") {
        if (await activeTrip(db, cat))
          skip("已有旅行，保留原旅行并跳过本次出发。");
        const end = nodes.find(
          (other) => other.kind === "END" && other.trip_id === n.trip_id,
        );
        if (!end || end.planned_at <= n.planned_at)
          throw new Error("Invalid calendar trip end");
        await db.query(
          `INSERT INTO cloud_trips(id,cat_id,account_id,scene,status,started_at,planned_start_at,planned_end_at)
          VALUES($1,$2,$3,$4,'ACTIVE',$5,$6,$7)`,
          [
            n.trip_id,
            cat.catId,
            cat.accountId,
            n.scene,
            new Date(wall),
            n.planned_at,
            end.planned_at,
          ],
        );
      } else if (n.kind === "END") {
        const trip = await activeTrip(db, cat);
        if (trip?.id !== n.trip_id)
          skip("对应旅行已结束或未开始，不影响其他旅行。");
        await db.query(
          "UPDATE cloud_trips SET status='COMPLETE',ended_at=$4 WHERE account_id=$1 AND cat_id=$2 AND id=$3",
          [cat.accountId, cat.catId, n.trip_id, new Date(wall)],
        );
        await db.query(
          "UPDATE cloud_reviews SET status='EXPIRED' WHERE account_id=$1 AND cat_id=$2 AND trip_id=$3 AND status<>'DELIVERED'",
          [cat.accountId, cat.catId, n.trip_id],
        );
      } else if (n.kind === "DEMAND") {
        letterId = await deliver(db, cat, n, n.content_id!, wall, until);
      } else if (n.kind === "POSTCARD") {
        const trip = await activeTrip(db, cat);
        if (trip?.id !== n.trip_id) skip("对应旅行当前不在进行。");
        const rr = await db.query(
          "SELECT * FROM cloud_reviews WHERE account_id=$1 AND cat_id=$2 AND trip_id=$3 AND status='SELECTED' AND story_id=$4 ORDER BY reviewed_at DESC NULLS LAST,id DESC LIMIT 1",
          [cat.accountId, cat.catId, n.trip_id, `L-${n.scene}`],
        );
        const review = rr.rows[0];
        const authorized =
          review?.kind === "LINKED" &&
          review.review_authority === "INTERNAL_ADMIN" &&
          !!review.reviewed_by &&
          !!review.reviewed_at;
        const sources = authorized
          ? await cloudReviewSources(db, cat, review.id)
          : [];
        const duplicate = review
          ? await db.query(
              "SELECT 1 FROM cloud_letters WHERE account_id=$1 AND cat_id=$2 AND content_id=$3",
              [cat.accountId, cat.catId, review.story_id],
            )
          : null;
        const linked =
          authorized &&
          (await eligibleCloudSources(db, cat, review.story_id, sources)) &&
          !duplicate?.rows[0];
        letterId = await deliver(
          db,
          cat,
          n,
          linked ? review.story_id : `O-${n.scene}-01`,
          wall,
          until,
          linked ? sources : undefined,
        );
        reason = linked
          ? "有效人工来源联动投递。"
          : "使用同场景普通故事；没有当前可投递的同场景人工联动选择。";
        await db.query(
          "UPDATE cloud_reviews SET status=CASE WHEN id=$4 AND $5 THEN 'DELIVERED' ELSE 'EXPIRED' END WHERE account_id=$1 AND cat_id=$2 AND trip_id=$3 AND status<>'DELIVERED'",
          [
            cat.accountId,
            cat.catId,
            n.trip_id,
            review?.id ?? null,
            !!review && (linked || review.kind === "ORDINARY"),
          ],
        );
      } else throw new Error("Unknown calendar node kind");
    } catch (e) {
      if (!(e instanceof BusinessSkip)) throw e;
      outcome = "SKIPPED";
      reason = e.message;
    }
    await db.query(
      "UPDATE cloud_calendar_nodes SET result_outcome=$4,result_reason=$5,written_at=$6,effective_at=$7,letter_id=$8 WHERE account_id=$1 AND cat_id=$2 AND id=$3",
      [
        cat.accountId,
        cat.catId,
        n.id,
        outcome,
        reason,
        new Date(wall),
        new Date(until),
        letterId,
      ],
    );
    n.result_outcome = outcome;
    if (n.kind === "POSTCARD" && outcome === "SKIPPED")
      await db.query(
        "UPDATE cloud_reviews SET status='EXPIRED',reason='本次日历来信节点已跳过，不补发。' WHERE account_id=$1 AND cat_id=$2 AND trip_id=$3 AND status='SELECTED'",
        [cat.accountId, cat.catId, n.trip_id],
      );
  }
  if (due.length) {
    await db.query(
      "UPDATE cloud_calendars SET processed_count=processed_count+$3,last_effective_at=$4 WHERE account_id=$1 AND cat_id=$2",
      [cat.accountId, cat.catId, due.length, new Date(until)],
    );
    const state = await db.query(
      "UPDATE cloud_state SET revision=revision+1 WHERE account_id=$1 AND cat_id=$2 RETURNING revision",
      [cat.accountId, cat.catId],
    );
    cat.stateRevision = Number(state.rows[0].revision);
  }
  const pending = nodes.find((n) => n.result_outcome === null),
    nextRunAt = pending
      ? new Date(pending.planned_at.getTime() - offset)
      : null;
  await db.query(
    "UPDATE cloud_jobs SET status=$3,next_run_at=$4,lease_token=NULL,lease_until=NULL,attempts=0,last_error=NULL WHERE account_id=$1 AND cat_id=$2",
    [cat.accountId, cat.catId, nextRunAt ? "READY" : "COMPLETE", nextRunAt],
  );
  return { processed: due.length, nextRunAt };
}
