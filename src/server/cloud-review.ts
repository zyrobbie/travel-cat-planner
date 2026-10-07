import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { digest } from "./auth";
import { ensure } from "./errors";
import type { CloudCat } from "./cloud-repository";

export const cloudStories = [
  { id: "L-RHINE", scene: "RHINE", fallback: "O-RHINE-01", claims: ["rest"] },
  {
    id: "L-FIREFLY",
    scene: "FIREFLY",
    fallback: "O-FIREFLY-01",
    claims: ["companionship", "care_value"],
  },
  {
    id: "L-LIGHTHOUSE",
    scene: "LIGHTHOUSE",
    fallback: "O-LIGHTHOUSE-01",
    claims: ["new_friends"],
  },
] as const;
export const cloudEvidenceInput = z.strictObject({
  claim: z.enum(["rest", "companionship", "care_value", "new_friends"]),
  responseId: z.string().min(1).max(1024),
  revision: z.number().int().positive(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  assessment: z.enum([
    "SUPPORTED",
    "NEGATED",
    "CONDITION_MISMATCH",
    "UNCERTAIN",
  ]),
  attested: z.boolean(),
});
export type CloudEvidence = z.infer<typeof cloudEvidenceInput>;
export const cloudReviewInput = z.strictObject({
  tripId: z.string().min(1).max(1024),
  storyId: z.enum(["L-RHINE", "L-FIREFLY", "L-LIGHTHOUSE"]),
  sources: z.array(cloudEvidenceInput).max(16),
  expectedStateRevision: z.number().int().nonnegative(),
  key: z.uuid(),
});

export async function currentCloudEvidence(
  db: PoolClient,
  cat: CloudCat,
  evidence: CloudEvidence,
) {
  const r = await db.query(
    `SELECT r.status,r.current_revision,v.text FROM cloud_responses r
    JOIN cloud_response_revisions v ON (v.account_id,v.cat_id,v.response_id,v.revision)=(r.account_id,r.cat_id,r.id,r.current_revision)
    WHERE r.account_id=$1 AND r.cat_id=$2 AND r.id=$3`,
    [cat.accountId, cat.catId, evidence.responseId],
  );
  const row = r.rows[0];
  return (
    !!row &&
    row.status === "ACTIVE" &&
    row.current_revision === evidence.revision &&
    typeof row.text === "string" &&
    evidence.start >= 0 &&
    evidence.end <= row.text.length &&
    evidence.start < evidence.end
  );
}
export async function eligibleCloudSources(
  db: PoolClient,
  cat: CloudCat,
  storyId: string,
  sources: CloudEvidence[],
) {
  const story = cloudStories.find((s) => s.id === storyId);
  if (!story || sources.length !== story.claims.length) return false;
  for (const claim of story.claims) {
    const matches = sources.filter((s) => s.claim === claim);
    if (
      matches.length !== 1 ||
      matches[0].assessment !== "SUPPORTED" ||
      !matches[0].attested ||
      !(await currentCloudEvidence(db, cat, matches[0]))
    )
      return false;
  }
  return true;
}
export async function cloudReviewSources(
  db: PoolClient,
  cat: CloudCat,
  reviewId: string,
): Promise<CloudEvidence[]> {
  const r = await db.query(
    "SELECT claim,response_id,revision,start_offset,end_offset,assessment,attested FROM cloud_review_sources WHERE account_id=$1 AND cat_id=$2 AND review_id=$3 ORDER BY source_order",
    [cat.accountId, cat.catId, reviewId],
  );
  return r.rows.map((s) =>
    cloudEvidenceInput.parse({
      claim: s.claim,
      responseId: s.response_id,
      revision: s.revision,
      start: s.start_offset,
      end: s.end_offset,
      assessment: s.assessment,
      attested: s.attested,
    }),
  );
}

/** Protected internal service. Caller already owns the account/cat/state lock.
 * Authority is verified from the existing ADMIN session, never from user JSON.
 */
export async function selectCloudReview(
  db: PoolClient,
  cat: CloudCat,
  adminToken: string | undefined,
  input: unknown,
) {
  ensure(adminToken, 403, "需要管理员核验权限。");
  const reviewer = digest(adminToken);
  const authorized = await db.query(
    "SELECT token_hash FROM sessions WHERE token_hash=$1 AND role='ADMIN' AND expires_at>clock_timestamp()",
    [reviewer],
  );
  ensure(authorized.rows[0], 403, "需要管理员核验权限。");
  const value = cloudReviewInput.parse(input),
    hash = digest(JSON.stringify(value));
  const prior = await db.query(
    "SELECT payload_hash,review_id FROM cloud_review_requests WHERE account_id=$1 AND cat_id=$2 AND key=$3",
    [cat.accountId, cat.catId, value.key],
  );
  if (prior.rows[0]) {
    ensure(prior.rows[0].payload_hash === hash, 409, "重复选择与原操作不同。");
    const old = await db.query(
      "SELECT status FROM cloud_reviews WHERE account_id=$1 AND cat_id=$2 AND id=$3",
      [cat.accountId, cat.catId, prior.rows[0].review_id],
    );
    ensure(
      old.rows[0]?.status === "SELECTED",
      409,
      "这次选择已失效，请重新核验。",
    );
    return { reviewId: prior.rows[0].review_id };
  }
  ensure(
    cat.stateRevision === value.expectedStateRevision,
    409,
    "体验已更新，请刷新后重新核验来源。",
  );
  ensure(cat.safety === "CLEAR", 409, "合成安全路径中不能选取旅行信。");
  const trip = await db.query(
    "SELECT id,scene FROM cloud_trips WHERE account_id=$1 AND cat_id=$2 AND id=$3 AND status='ACTIVE'",
    [cat.accountId, cat.catId, value.tripId],
  );
  ensure(trip.rows[0], 409, "请先独立开始旅行。");
  const story = cloudStories.find((s) => s.id === value.storyId)!;
  ensure(
    story.scene === trip.rows[0].scene,
    409,
    "核验故事须与本次出发场景一致。",
  );
  const sent = await db.query(
    "SELECT 1 FROM cloud_letters WHERE account_id=$1 AND cat_id=$2 AND trip_id=$3 AND type='POSTCARD'",
    [cat.accountId, cat.catId, value.tripId],
  );
  ensure(!sent.rows[0], 409, "这次旅行已经寄过明信片。");
  for (const source of value.sources) {
    ensure(
      (story.claims as readonly string[]).includes(source.claim) &&
        (await currentCloudEvidence(db, cat, source)),
      409,
      "来源不属于本体验、已失效或范围错误，请重新核验。",
    );
  }
  const linked = await eligibleCloudSources(
    db,
    cat,
    value.storyId,
    value.sources,
  );
  await db.query(
    "UPDATE cloud_reviews SET status='EXPIRED' WHERE account_id=$1 AND cat_id=$2 AND trip_id=$3 AND status<>'DELIVERED'",
    [cat.accountId, cat.catId, value.tripId],
  );
  const id = randomUUID();
  await db.query(
    `INSERT INTO cloud_reviews(id,cat_id,account_id,trip_id,story_id,fallback_id,kind,status,reason,review_authority,reviewed_by,reviewed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'SELECTED',$8,'INTERNAL_ADMIN',$9,clock_timestamp())`,
    [
      id,
      cat.catId,
      cat.accountId,
      value.tripId,
      story.id,
      story.fallback,
      linked ? "LINKED" : "ORDINARY",
      linked
        ? "逐项人工核验通过。"
        : "来源不足、否定、条件或情境不适用，选用完整普通故事。",
      reviewer,
    ],
  );
  for (const [order, s] of value.sources.entries())
    await db.query(
      `INSERT INTO cloud_review_sources(cat_id,account_id,review_id,source_order,response_id,revision,claim,start_offset,end_offset,assessment,attested)
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
  const state = await db.query(
    "UPDATE cloud_state SET revision=revision+1 WHERE cat_id=$1 AND account_id=$2 RETURNING revision",
    [cat.catId, cat.accountId],
  );
  cat.stateRevision = Number(state.rows[0].revision);
  await db.query(
    "INSERT INTO cloud_review_requests(cat_id,account_id,key,payload_hash,review_id) VALUES($1,$2,$3,$4,$5)",
    [cat.catId, cat.accountId, value.key, hash, id],
  );
  return { reviewId: id };
}
