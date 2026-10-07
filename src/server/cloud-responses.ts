import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { digest } from "./auth";
import { ensure } from "./errors";
import { checkInput } from "./safety";
import {
  bumpCloudRevision,
  cloudId,
  ownedCloudLetter,
  ownedCloudResponse,
  withCloudCat,
  type CloudCat,
  type CloudOperation,
} from "./cloud-repository";

// The approved editor counter uses JavaScript UTF-16 length, not code points.
const textInput = z
  .string()
  .trim()
  .min(1)
  .refine((text) => text.length <= 2000, "回应最多 2000 字。");
export const sendCloudInput = z.strictObject({
  text: textInput,
  key: z.uuid(),
  expectedResponseId: cloudId.nullable(),
});
export const editCloudInput = z.strictObject({
  text: textInput,
  key: z.uuid(),
  expectedRevision: z.number().int().positive(),
});
export const deleteCloudInput = z.strictObject({
  key: z.uuid(),
  expectedRevision: z.number().int().positive(),
});
type Result = {
  message?: string;
  responseId?: string;
  revision?: number;
  stateRevision: number;
  safety?: "INTERCEPTED";
};

async function previous(
  db: PoolClient,
  cat: CloudCat,
  operation: CloudOperation,
  key: string,
  hash: string,
): Promise<Result | undefined> {
  const r = await db.query(
    "SELECT payload_hash,result FROM cloud_requests WHERE account_id=$1 AND cat_id=$2 AND operation=$3 AND key=$4",
    [cat.accountId, cat.catId, operation, key],
  );
  if (!r.rows[0]) return undefined;
  ensure(
    r.rows[0].payload_hash === hash,
    409,
    "这次请求的内容已改变，请使用新请求。",
  );
  return r.rows[0].result;
}
async function remember(
  db: PoolClient,
  cat: CloudCat,
  operation: CloudOperation,
  key: string,
  hash: string,
  result: Result,
) {
  // Only identifiers, counters and fixed receipts are persisted, never response text.
  await db.query(
    "INSERT INTO cloud_requests(account_id,cat_id,operation,key,payload_hash,result) VALUES($1,$2,$3,$4,$5,$6)",
    [cat.accountId, cat.catId, operation, key, hash, result],
  );
  return result;
}
async function invalidateReviews(
  db: PoolClient,
  cat: CloudCat,
  responseId: string,
) {
  await db.query(
    `UPDATE cloud_reviews r SET status='NEEDS_REVIEW',reason='来源已更正或删除，请重新核验或选择普通故事。'
    WHERE r.cat_id=$1 AND r.account_id=$2 AND r.kind='LINKED' AND r.status='SELECTED'
    AND EXISTS(SELECT 1 FROM cloud_review_sources s WHERE s.cat_id=r.cat_id AND s.account_id=r.account_id AND s.review_id=r.id AND s.response_id=$3)`,
    [cat.catId, cat.accountId, responseId],
  );
}
async function intercept(db: PoolClient, cat: CloudCat): Promise<Result> {
  await db.query(
    "UPDATE participants SET safety_state='INTERCEPTED' WHERE id=$1",
    [cat.participantId],
  );
  return {
    safety: "INTERCEPTED",
    stateRevision: await bumpCloudRevision(db, cat),
  };
}

export async function sendCloudResponse(
  accountId: string,
  letterId: string,
  input: unknown,
) {
  cloudId.parse(letterId);
  const value = sendCloudInput.parse(input),
    hash = digest(JSON.stringify({ letterId, ...value }));
  // Pure synthetic adapter today. Future network adapters must also run outside locks.
  const safety = checkInput(value.text);
  return withCloudCat(accountId, async (db, cat) => {
    const old = await previous(db, cat, "SEND_RESPONSE", value.key, hash);
    if (old) return old;
    const letter = await ownedCloudLetter(db, cat, letterId);
    ensure(letter.type === "DEMAND", 409, "这封信不需要回应。");
    const existing = await db.query(
      "SELECT id,status FROM cloud_responses WHERE cat_id=$1 AND account_id=$2 AND letter_id=$3",
      [cat.catId, cat.accountId, letterId],
    );
    ensure(
      !existing.rows[0],
      409,
      existing.rows[0]?.status === "DELETED"
        ? "这条回应已删除，不能从原信再次寄出。"
        : "这封信已经有回应，请重新载入。",
    );
    ensure(value.expectedResponseId === null, 409, "回应已改变，请重新载入。");
    ensure(cat.safety === "CLEAR", 409, "当前安全状态下暂不能发送回应。");
    ensure(safety.status !== "UNAVAILABLE", 503, "服务暂不可用，请稍后再试。");
    if (safety.status === "INTERCEPTED")
      return remember(
        db,
        cat,
        "SEND_RESPONSE",
        value.key,
        hash,
        await intercept(db, cat),
      );
    const id = randomUUID();
    await db.query(
      "INSERT INTO cloud_responses(id,cat_id,account_id,letter_id,current_revision,status) VALUES($1,$2,$3,$4,1,'ACTIVE')",
      [id, cat.catId, cat.accountId, letterId],
    );
    await db.query(
      "INSERT INTO cloud_response_revisions(cat_id,account_id,response_id,revision,text,at) VALUES($1,$2,$3,1,$4,now())",
      [cat.catId, cat.accountId, id, value.text],
    );
    await db.query(
      "UPDATE cloud_letters SET read_at=COALESCE(read_at,now()) WHERE cat_id=$1 AND account_id=$2 AND id=$3",
      [cat.catId, cat.accountId, letterId],
    );
    return remember(db, cat, "SEND_RESPONSE", value.key, hash, {
      message: "送出去啦。",
      responseId: id,
      revision: 1,
      stateRevision: await bumpCloudRevision(db, cat),
    });
  });
}

export async function editCloudResponse(
  accountId: string,
  responseId: string,
  input: unknown,
) {
  cloudId.parse(responseId);
  const value = editCloudInput.parse(input),
    hash = digest(JSON.stringify({ responseId, ...value }));
  const safety = checkInput(value.text);
  return withCloudCat(accountId, async (db, cat) => {
    const old = await previous(db, cat, "EDIT_RESPONSE", value.key, hash);
    if (old) return old;
    const r = await ownedCloudResponse(db, cat, responseId);
    ensure(r.status === "ACTIVE", 409, "回应已删除或不存在，请重新载入。");
    ensure(
      r.current_revision === value.expectedRevision,
      409,
      "回应已被更正，请重新载入。",
    );
    ensure(cat.safety === "CLEAR", 409, "当前安全状态下暂不能更正回应。");
    ensure(safety.status !== "UNAVAILABLE", 503, "服务暂不可用，请稍后再试。");
    if (safety.status === "INTERCEPTED")
      return remember(
        db,
        cat,
        "EDIT_RESPONSE",
        value.key,
        hash,
        await intercept(db, cat),
      );
    const revision = r.current_revision + 1;
    await db.query(
      "INSERT INTO cloud_response_revisions(cat_id,account_id,response_id,revision,text,at) VALUES($1,$2,$3,$4,$5,now())",
      [cat.catId, cat.accountId, responseId, revision, value.text],
    );
    await db.query(
      "UPDATE cloud_responses SET current_revision=$4 WHERE cat_id=$1 AND account_id=$2 AND id=$3",
      [cat.catId, cat.accountId, responseId, revision],
    );
    await invalidateReviews(db, cat, responseId);
    return remember(db, cat, "EDIT_RESPONSE", value.key, hash, {
      message: "已更正。",
      responseId,
      revision,
      stateRevision: await bumpCloudRevision(db, cat),
    });
  });
}

export async function deleteCloudResponse(
  accountId: string,
  responseId: string,
  input: unknown,
) {
  cloudId.parse(responseId);
  const value = deleteCloudInput.parse(input),
    hash = digest(JSON.stringify({ responseId, ...value }));
  return withCloudCat(accountId, async (db, cat) => {
    const old = await previous(db, cat, "DELETE_RESPONSE", value.key, hash);
    if (old) return old;
    const r = await ownedCloudResponse(db, cat, responseId);
    ensure(
      r.current_revision === value.expectedRevision,
      409,
      "回应已被更正，请重新载入。",
    );
    if (r.status !== "DELETED") {
      await db.query(
        "UPDATE cloud_response_revisions SET text=NULL WHERE cat_id=$1 AND account_id=$2 AND response_id=$3",
        [cat.catId, cat.accountId, responseId],
      );
      await db.query(
        "UPDATE cloud_responses SET status='DELETED',deleted_at=now() WHERE cat_id=$1 AND account_id=$2 AND id=$3",
        [cat.catId, cat.accountId, responseId],
      );
      await invalidateReviews(db, cat, responseId);
      await bumpCloudRevision(db, cat);
    }
    return remember(db, cat, "DELETE_RESPONSE", value.key, hash, {
      message: "已删除。",
      responseId,
      revision: r.current_revision,
      stateRevision: cat.stateRevision,
    });
  });
}
