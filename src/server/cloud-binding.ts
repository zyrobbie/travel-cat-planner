import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import frozen from "../content/frozen.json";
import { LIGHT_DEMAND } from "../content/supplemental";
import {
  LEGACY_TRANSFER_MAX_BYTES,
  parseLegacyTransfer,
} from "../shared/legacy-transfer";
import { transaction } from "./db";
import { ensure } from "./errors";
import { lockActiveAccount } from "./account-service";
import {
  cloudContentHash,
  getCloudContent,
  registerCloudContent,
} from "./cloud-content";

type Trip = {
  id: string;
  scene: string;
  status: "ACTIVE" | "COMPLETE";
  startedAt: string | null;
  endedAt: string | null;
  plannedStartAt: number | null;
  plannedEndAt: number | null;
};
type Prepared = ReturnType<typeof prepare>;
const date = (ms: number | null) => (ms === null ? null : new Date(ms));
const match = (condition: unknown, message: string) =>
  ensure(condition, 400, message);
// All metadata reasons in the local producer are fixed copy, not free text.
// Restrict them so deleted response text cannot be smuggled into provenance.
const reviewReasons = new Set([
  "",
  "逐项人工核验通过。",
  "来源不足、否定、条件或情境不适用，选用完整普通故事。",
  "来源已更正或删除，请重新核验或选择普通故事。",
  "来源已失效，请重新核验。",
  "本次日历来信节点已跳过，不补发。",
]);
const nodeReasons = new Set([
  "已处理",
  "已有旅行，保留原旅行并跳过本次出发。",
  "对应旅行已结束或未开始，不影响其他旅行。",
  "对应旅行当前不在进行。",
  "有效人工来源联动投递。",
  "使用同场景普通故事；没有当前可投递的同场景人工联动选择。",
  "还有未读来信，请先打开阅读；不需要回复。",
  "合成安全路径中不能投递。",
  "没有可用的冻结正文。",
  "这封故事已经寄过。",
  "旅行中不投递日常卡。",
  "请先独立开始旅行。",
  "这次旅行已经寄过明信片。",
]);

function prepare(input: unknown) {
  const bundle = parseLegacyTransfer(input);
  match(
    Buffer.byteLength(JSON.stringify(bundle)) <=
      LEGACY_TRANSFER_MAX_BYTES - 1024,
    "这份体验超过单次转移大小上限。",
  );
  match(
    bundle.calendar.offsetMs + Date.now() <= 8e15,
    "旧日历偏移超出可处理范围。",
  );
  const contents = new Map<string, { id: string; version: string }>();
  const seenContent = new Set<string>();
  const postTrips = new Set<string>();
  for (const l of bundle.letters) {
    const id = l.id.slice(bundle.sourceExperienceId.length + 1);
    const item = getCloudContent(id, l.snapshot.contentVersion);
    match(
      item && (!l.snapshot.contentId || l.snapshot.contentId === id),
      "这份档案包含无法证明的内容或版本，请保留原档。",
    );
    const c = item!;
    const tip =
      c.type !== "DEMAND"
        ? null
        : c.id === LIGHT_DEMAND.id
          ? LIGHT_DEMAND.tip
          : (frozen.items.find((t) => t.id === c.id.replace("D-", "TIPS-"))
              ?.body ?? null);
    // The old local producer also copied a postcard's frozen body into tip
    // because replace("D-", "TIPS-") left its ID unchanged. Both known shapes
    // are provable; preserve the original snapshot instead of fixing history.
    const tipMatches =
      l.snapshot.tip === tip ||
      (c.type !== "DEMAND" && l.snapshot.tip === c.body);
    match(
      l.snapshot.title === c.title &&
        l.snapshot.body === c.body &&
        tipMatches &&
        l.snapshot.scene === (c.sceneId ?? null) &&
        l.snapshot.season === (c.narrativeSeason ?? null) &&
        l.snapshot.timeOfDay === (c.timeOfDay ?? null) &&
        l.type === (c.type === "DEMAND" ? "DEMAND" : "POSTCARD"),
      "原信快照与可证明的冻结版本不一致，请保留原档。",
    );
    match(!seenContent.has(id), "同一内容重复出现。");
    seenContent.add(id);
    contents.set(l.id, { id: c.id, version: c.version });
    if (l.type === "POSTCARD") {
      match(
        !postTrips.has(l.tripId!) && (!l.storyId || l.storyId === id),
        "旅行信重复或故事标识不一致。",
      );
      postTrips.add(l.tripId!);
      match(
        !l.sourceRefs?.length || c.type === "LINKED",
        "普通旅行信不能附加联动来源。",
      );
    }
  }
  for (const n of bundle.calendar.nodes) {
    if (n.kind === "DEMAND")
      match(
        getCloudContent(n.contentId!)?.type === "DEMAND",
        "旧日历含未知需求卡。",
      );
    if (n.result)
      match(
        nodeReasons.has(n.result.reason),
        "旧日历结果原因无法核对，原档未改写。",
      );
    if (n.result?.letterId) {
      const c = contents.get(n.result.letterId)!;
      match(
        n.kind === "DEMAND"
          ? n.contentId === c.id
          : getCloudContent(c.id)?.sceneId === n.scene,
        "日历结果的内容或场景不一致。",
      );
    }
  }
  for (const r of bundle.reviews) {
    const story = getCloudContent(r.storyId),
      fallback = getCloudContent(r.fallbackId);
    match(
      story?.type === "LINKED" &&
        fallback?.type === "ORDINARY" &&
        story.sceneId === fallback.sceneId &&
        r.fallbackId === `O-${String(story?.sceneId)}-01`,
      "旧人工选择的故事映射错误。",
    );
    match(reviewReasons.has(r.reason), "旧人工选择原因无法核对，原档未改写。");
  }

  const sceneByTrip = new Map<string, string>();
  const noteScene = (id: string, scene: string) => {
    match(
      ["RHINE", "FIREFLY", "LIGHTHOUSE"].includes(scene),
      "无法证明旧旅行场景。",
    );
    match(
      !sceneByTrip.has(id) || sceneByTrip.get(id) === scene,
      "同次旧旅行出现不同场景。",
    );
    sceneByTrip.set(id, scene);
  };
  for (const n of bundle.calendar.nodes)
    if (n.tripId) noteScene(n.tripId, n.scene!);
  for (const l of bundle.letters)
    if (l.tripId) noteScene(l.tripId, l.snapshot.scene!);
  for (const r of bundle.reviews)
    noteScene(r.tripId, String(getCloudContent(r.storyId)!.sceneId));
  // Only evidence of a trip that actually existed creates a row. Future START
  // nodes remain plans, so settlement can later insert their unique trip once.
  const existing = new Set<string>([
    ...bundle.letters.flatMap((l) => (l.tripId ? [l.tripId] : [])),
    ...bundle.reviews.map((r) => r.tripId),
    ...bundle.calendar.nodes
      .filter((n) => n.kind === "START" && n.result?.outcome === "APPLIED")
      .map((n) => n.tripId!),
    ...(bundle.trip ? [bundle.trip.id] : []),
  ]);
  const trips: Trip[] = [];
  for (const id of existing) {
    const nodes = bundle.calendar.nodes.filter((n) => n.tripId === id);
    const starts = nodes.filter((n) => n.kind === "START"),
      ends = nodes.filter((n) => n.kind === "END");
    match(
      starts.length <= 1 && ends.length <= 1 && sceneByTrip.has(id),
      "旧旅行起止或场景不明确。",
    );
    const start = starts[0],
      end = ends[0];
    match(!start || !end || start.at < end.at, "旧旅行计划时间错误。");
    // A pending START cannot coexist with history that says the trip existed.
    match(
      !start || start.result?.outcome === "APPLIED",
      "旧旅行历史与未执行出发节点冲突。",
    );
    const active = bundle.trip?.id === id;
    match(
      !active || end?.result?.outcome !== "APPLIED",
      "进行中的旅行已有结束结果。",
    );
    trips.push({
      id,
      scene: sceneByTrip.get(id)!,
      status: active ? "ACTIVE" : "COMPLETE",
      startedAt:
        start?.result?.outcome === "APPLIED" ? start.result.writtenAt : null,
      endedAt: end?.result?.outcome === "APPLIED" ? end.result.writtenAt : null,
      plannedStartAt: start?.at ?? null,
      plannedEndAt: end?.at ?? null,
    });
  }
  for (const n of bundle.calendar.nodes.filter(
    (n) => n.kind === "START" && !n.result,
  )) {
    const ends = bundle.calendar.nodes.filter(
      (e) => e.kind === "END" && e.tripId === n.tripId,
    );
    match(
      ends.length === 1 && ends[0].at > n.at && ends[0].scene === n.scene,
      "待开始旅行缺少有效结束计划。",
    );
  }
  const unknownTimes = {
    responseCreated: bundle.responses
      .filter((r) => r.revisions.find((v) => v.revision === 1)!.at === null)
      .map((r) => r.id),
    responseDeleted: bundle.responses
      .filter((r) => r.status === "DELETED")
      .map((r) => r.id),
    tripStarted: trips.filter((t) => t.startedAt === null).map((t) => t.id),
    tripEnded: trips
      .filter((t) => t.status === "COMPLETE" && t.endedAt === null)
      .map((t) => t.id),
  };
  const summary = {
    logicalCatId: bundle.sourceExperienceId,
    name: bundle.participant.cat_name,
    appearanceId: bundle.participant.appearanceId,
    letters: bundle.letters.length,
    responses: bundle.responses.length,
    deletedResponses: bundle.responses.filter((r) => r.status === "DELETED")
      .length,
    revisions: bundle.responses.reduce((sum, r) => sum + r.revisions.length, 0),
    reviews: bundle.reviews.length,
    calendarNodes: bundle.calendar.nodes.length,
    processedNodes: bundle.calendar.processedCount,
    unread: bundle.letters.filter((l) => l.read_at === null).length,
    offsetMs: bundle.calendar.offsetMs,
  };
  return {
    bundle,
    bundleHash: cloudContentHash(bundle),
    contents,
    trips,
    summary,
    provenance: {
      sourceSchema: 3,
      controlRevision: bundle.controlRevision,
      tripCount: bundle.tripCount,
      omitted: ["drafts", "requests", "events"],
      unknownTimes,
    },
    warnings: [
      "只迁入这一份本机体验；原本机存档会保留，草稿不会上传。",
      "本机匿名标识不是历史账号身份证明。",
      "旧人工选择保留为未核验，后续联动需重新授权审核。",
      ...(Object.values(unknownTimes).some((ids) => ids.length)
        ? ["原档缺失的实际时间保留为空，不推算补写。"]
        : []),
    ],
  };
}

async function ensureVacancy(db: PoolClient, accountId: string, p: Prepared) {
  const cat = await db.query(
    "SELECT id FROM cat_profiles WHERE account_id=$1",
    [accountId],
  );
  ensure(!cat.rows[0], 409, "此账号已有小猫，不能覆盖、追加或合并旧体验。");
  const source = await db.query(
    "SELECT 1 FROM legacy_bindings WHERE source_namespace=$1 AND source_experience_id=$2",
    [p.bundle.sourceNamespace, p.bundle.sourceExperienceId],
  );
  ensure(!source.rows[0], 409, "这份旧体验已经绑定，不能重复迁入。");
}
export async function preflightLegacyBinding(
  accountId: string,
  input: unknown,
) {
  const p = prepare(input);
  return transaction(async (db) => {
    await lockActiveAccount(db, accountId);
    await ensureVacancy(db, accountId, p);
    return {
      bundleHash: p.bundleHash,
      summary: p.summary,
      warnings: p.warnings,
    };
  });
}
export const legacyConfirmInput = z.strictObject({
  bundle: z.unknown(),
  key: z.uuid(),
  bundleHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export async function confirmLegacyBinding(accountId: string, input: unknown) {
  const { bundle: raw, key, bundleHash } = legacyConfirmInput.parse(input),
    p = prepare(raw),
    b = p.bundle;
  ensure(
    bundleHash === p.bundleHash,
    409,
    "小猫记录在检查后已改变，请重新检查。",
  );
  return transaction(async (db) => {
    await lockActiveAccount(db, accountId);
    const cancelled = await db.query(
      "SELECT 1 FROM legacy_binding_cancellations WHERE account_id=$1 AND key=$2",
      [accountId, key],
    );
    ensure(
      !cancelled.rowCount,
      409,
      "这次保存已取消，请从原小猫页面重新开始。",
    );
    const prior = await db.query(
      "SELECT bundle_hash,result FROM legacy_binding_requests WHERE account_id=$1 AND key=$2",
      [accountId, key],
    );
    if (prior.rows[0]) {
      ensure(
        prior.rows[0].bundle_hash === p.bundleHash,
        409,
        "这次请求已用于另一份内容。",
      );
      return prior.rows[0].result;
    }
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7))", [
      `${b.sourceNamespace}:${b.sourceExperienceId}`,
    ]);
    await ensureVacancy(db, accountId, p);
    await registerCloudContent(db);
    const catId = randomUUID(),
      participantId = randomUUID(),
      importBatchId = randomUUID();
    await db.query(
      "INSERT INTO participants(id,cat_name,status,safety_state) VALUES($1,$2,'ACTIVE',$3)",
      [participantId, b.participant.cat_name, b.participant.safety_state],
    );
    await db.query(
      "INSERT INTO cat_profiles(id,account_id,participant_id,appearance_id,name) VALUES($1,$2,$3,$4,$5)",
      [
        catId,
        accountId,
        participantId,
        b.participant.appearanceId,
        b.participant.cat_name,
      ],
    );
    await db.query(
      "INSERT INTO cloud_state(cat_id,account_id,revision) VALUES($1,$2,$3)",
      [catId, accountId, b.controlRevision],
    );
    await db.query(
      "INSERT INTO legacy_bindings(source_namespace,source_experience_id,account_id,cat_id,import_batch_id,logical_cat_id,bundle_hash,provenance) VALUES($1,$2,$3,$4,$5,$2,$6,$7)",
      [
        b.sourceNamespace,
        b.sourceExperienceId,
        accountId,
        catId,
        importBatchId,
        p.bundleHash,
        p.provenance,
      ],
    );
    for (const t of p.trips)
      await db.query(
        "INSERT INTO cloud_trips(id,cat_id,account_id,scene,status,started_at,ended_at,planned_start_at,planned_end_at,origin) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'LEGACY')",
        [
          t.id,
          catId,
          accountId,
          t.scene,
          t.status,
          t.startedAt,
          t.endedAt,
          date(t.plannedStartAt),
          date(t.plannedEndAt),
        ],
      );
    for (const l of b.letters) {
      const c = p.contents.get(l.id)!;
      await db.query(
        `INSERT INTO cloud_letters(id,cat_id,account_id,type,content_id,content_version,snapshot,trip_id,story_id,calendar_node_id,delivered_at,planned_at,effective_at,read_at,skipped_at,origin)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'LEGACY')`,
        [
          l.id,
          catId,
          accountId,
          l.type,
          c.id,
          c.version,
          l.snapshot,
          l.tripId ?? null,
          l.storyId ?? null,
          l.calendarNodeId ?? null,
          l.delivered_at,
          l.planned_at ?? null,
          l.effective_at ?? null,
          l.read_at,
          l.skipped_at,
        ],
      );
    }
    for (const r of b.responses) {
      const firstAt = r.revisions.find((v) => v.revision === 1)!.at;
      await db.query(
        "INSERT INTO cloud_responses(id,cat_id,account_id,letter_id,current_revision,status,created_at,deleted_at,origin) VALUES($1,$2,$3,$4,$5,$6,$7,NULL,'LEGACY')",
        [
          r.id,
          catId,
          accountId,
          r.letterId,
          r.currentRevision,
          r.status,
          firstAt,
        ],
      );
      for (const v of r.revisions)
        await db.query(
          "INSERT INTO cloud_response_revisions(cat_id,account_id,response_id,revision,text,at) VALUES($1,$2,$3,$4,$5,$6)",
          [catId, accountId, r.id, v.revision, v.text, v.at],
        );
    }
    for (const r of b.reviews)
      await db.query(
        "INSERT INTO cloud_reviews(id,cat_id,account_id,trip_id,story_id,fallback_id,kind,status,reason,review_authority) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'UNVERIFIED')",
        [
          r.id,
          catId,
          accountId,
          r.tripId,
          r.storyId,
          r.fallbackId,
          r.kind,
          r.status,
          r.reason,
        ],
      );
    for (const [kind, owners] of [
      [
        "letter",
        b.letters.map((l) => ({ id: l.id, sources: l.sourceRefs ?? [] })),
      ],
      ["review", b.reviews],
    ] as const) {
      for (const owner of owners)
        for (const [index, s] of owner.sources.entries())
          await db.query(
            `INSERT INTO cloud_${kind}_sources(cat_id,account_id,${kind}_id,source_order,response_id,revision,claim,start_offset,end_offset,assessment,attested) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              catId,
              accountId,
              owner.id,
              index,
              s.responseId,
              s.revision,
              s.claim,
              s.start,
              s.end,
              s.assessment,
              s.attested,
            ],
          );
    }
    const c = b.calendar;
    await db.query(
      "INSERT INTO cloud_calendars(cat_id,account_id,version,initialized_at,base_at,offset_ms,last_effective_at,processed_count,node_count) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8)",
      [
        catId,
        accountId,
        date(c.initializedAt),
        date(c.baseAt),
        c.offsetMs,
        date(c.lastEffectiveAt),
        c.processedCount,
        c.nodes.length,
      ],
    );
    for (const n of c.nodes)
      await db.query(
        `INSERT INTO cloud_calendar_nodes(cat_id,account_id,id,planned_at,node_order,kind,trip_id,scene,content_id,origin,result_outcome,result_reason,written_at,effective_at,letter_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          catId,
          accountId,
          n.id,
          date(n.at),
          n.order,
          n.kind,
          n.tripId ?? null,
          n.scene ?? null,
          n.contentId ?? null,
          n.origin,
          n.result?.outcome ?? null,
          n.result?.reason ?? null,
          n.result?.writtenAt ?? null,
          date(n.result?.effectiveAt ?? null),
          n.result?.letterId ?? null,
        ],
      );
    const pending = c.nodes
      .filter((n) => !n.result)
      .sort((a, b) => a.at - b.at || a.order - b.order);
    // Imported high-watermark may already be past a pending node even when
    // wall+offset is not. Wake immediately, without replaying inside import.
    const next = pending[0]
      ? pending[0].at <= c.lastEffectiveAt
        ? ((await db.query("SELECT clock_timestamp() AS now")).rows[0]
            .now as Date)
        : date(Math.max(0, pending[0].at - c.offsetMs))
      : null;
    await db.query(
      "INSERT INTO cloud_jobs(cat_id,account_id,status,next_run_at) VALUES($1,$2,$3,$4)",
      [catId, accountId, next ? "READY" : "COMPLETE", next],
    );
    // No settlement in confirmation: imported facts commit intact first. The
    // worker / next authenticated read then uses the same preserved calendar.
    const result = {
      catId,
      logicalCatId: b.sourceExperienceId,
      importBatchId,
      bundleHash: p.bundleHash,
      stateRevision: b.controlRevision,
    };
    await db.query(
      "INSERT INTO legacy_binding_requests(account_id,key,cat_id,bundle_hash,result) VALUES($1,$2,$3,$4,$5)",
      [accountId, key, catId, p.bundleHash, result],
    );
    return result;
  });
}
export async function legacyBindingResult(accountId: string, key: string) {
  z.uuid().parse(key);
  return transaction(async (db) => {
    await lockActiveAccount(db, accountId);
    const r = await db.query(
      "SELECT result FROM legacy_binding_requests WHERE account_id=$1 AND key=$2",
      [accountId, key],
    );
    if (r.rows[0]) return r.rows[0].result;
    const cancelled = await db.query(
      "SELECT bundle_hash FROM legacy_binding_cancellations WHERE account_id=$1 AND key=$2",
      [accountId, key],
    );
    return cancelled.rows[0]
      ? { cancelled: true, key, bundleHash: cancelled.rows[0].bundle_hash }
      : { pending: true };
  });
}

export async function cancelLegacyBinding(accountId: string, input: unknown) {
  const { key, bundleHash } = z
    .strictObject({
      key: z.uuid(),
      bundleHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(input);
  return transaction(async (db) => {
    await lockActiveAccount(db, accountId);
    const prior = await db.query(
      "SELECT bundle_hash,result FROM legacy_binding_requests WHERE account_id=$1 AND key=$2",
      [accountId, key],
    );
    if (prior.rows[0]) {
      ensure(
        prior.rows[0].bundle_hash === bundleHash,
        409,
        "这次请求属于另一份记录。",
      );
      return prior.rows[0].result;
    }
    const cancelled = await db.query(
      "SELECT bundle_hash FROM legacy_binding_cancellations WHERE account_id=$1 AND key=$2",
      [accountId, key],
    );
    ensure(
      !cancelled.rows[0] || cancelled.rows[0].bundle_hash === bundleHash,
      409,
      "这次请求属于另一份记录。",
    );
    await db.query(
      "INSERT INTO legacy_binding_cancellations(account_id,key,bundle_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [accountId, key, bundleHash],
    );
    return { cancelled: true as const, key, bundleHash };
  });
}
