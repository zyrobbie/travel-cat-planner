import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { pool, transaction } from "./db";
import { digest } from "./auth";
import { ensure } from "./errors";

// Matches the approved Pages naming rule in static-app/model.ts.
export const countAccountCatName = (name: string) =>
  [
    ...new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(
      name.trim(),
    ),
  ].length;

export const adoptionInput = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .refine((name) => countAccountCatName(name) <= 12, "名字最多 12 个字。")
    .refine(
      (name) => Buffer.byteLength(name) <= 1024,
      "名字包含过多组合字符。",
    ),
  appearanceId: z.enum(["cat-01", "cat-02", "cat-03", "cat-04"]),
  key: z.uuid(),
});

/** E4-B binding must enter through this same account lock and eligibility check. */
export async function lockActiveAccount(db: PoolClient, id: string) {
  const r = await db.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [
    id,
  ]);
  ensure(r.rows[0]?.status === "ACTIVE", 401, "账号当前不可用。");
  return r.rows[0];
}

export async function accountState(id: string) {
  const r = await pool.query(
    `SELECT a.id,a.email_normalized,a.status,to_jsonb(c) AS cat
     FROM accounts a LEFT JOIN cat_profiles c ON c.account_id=a.id
     WHERE a.id=$1 AND a.status='ACTIVE'`,
    [id],
  );
  ensure(r.rows[0], 401, "账号当前不可用。");
  return r.rows[0];
}

export async function adoptCat(accountId: string, input: unknown) {
  const { name, appearanceId, key } = adoptionInput.parse(input);
  const payloadHash = digest(JSON.stringify({ name, appearanceId }));
  return transaction(async (db) => {
    await lockActiveAccount(db, accountId);
    const prior = await db.query(
      "SELECT payload_hash,result FROM account_requests WHERE account_id=$1 AND operation='ADOPT' AND key=$2",
      [accountId, key],
    );
    if (prior.rows[0]) {
      ensure(
        prior.rows[0].payload_hash === payloadHash,
        409,
        "这次请求的内容已改变，请使用新请求。",
      );
      return prior.rows[0].result;
    }
    const existing = await db.query(
      "SELECT id FROM cat_profiles WHERE account_id=$1",
      [accountId],
    );
    ensure(!existing.rows[0], 409, "你已有一只小猫，请继续原来的体验。");
    const catId = randomUUID(),
      participantId = randomUUID();
    await db.query(
      "INSERT INTO participants(id,cat_name,status) VALUES($1,$2,'ACTIVE')",
      [participantId, name],
    );
    const r = await db.query(
      `INSERT INTO cat_profiles(id,account_id,participant_id,appearance_id,name)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [catId, accountId, participantId, appearanceId, name],
    );
    // Serialize once so first response and later idempotent results are identical.
    const result = JSON.parse(JSON.stringify({ cat: r.rows[0] }));
    await db.query(
      "INSERT INTO account_requests(account_id,operation,key,payload_hash,result) VALUES($1,'ADOPT',$2,$3,$4)",
      [accountId, key, payloadHash, result],
    );
    return result;
  });
}

export async function adoptionResult(accountId: string, key: string) {
  z.uuid().parse(key);
  const r = await pool.query(
    `SELECT r.result FROM account_requests r JOIN accounts a ON a.id=r.account_id
     WHERE r.account_id=$1 AND r.operation='ADOPT' AND r.key=$2 AND a.status='ACTIVE'`,
    [accountId, key],
  );
  return r.rows[0]?.result ?? { pending: true };
}

/** Internal lifecycle primitive only. Export/erasure workflow belongs to E4-C. */
export async function freezeAccountForDeletion(
  accountId: string,
  requestId: string,
) {
  z.uuid().parse(requestId);
  return transaction(async (db) => {
    const email = await db.query(
      "SELECT email_normalized FROM accounts WHERE id=$1",
      [accountId],
    );
    ensure(email.rows[0], 404, "没有找到账号。");
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 4))", [
      email.rows[0].email_normalized,
    ]);
    const a = await db.query(
      "SELECT status FROM accounts WHERE id=$1 FOR UPDATE",
      [accountId],
    );
    const old = await db.query(
      "SELECT request_id,status FROM account_deletions WHERE account_id=$1",
      [accountId],
    );
    if (old.rows[0])
      return { requestId: old.rows[0].request_id, status: old.rows[0].status };
    ensure(a.rows[0].status !== "DELETED", 409, "账号已注销。");
    await db.query("UPDATE accounts SET status='DELETING' WHERE id=$1", [
      accountId,
    ]);
    await db.query(
      "UPDATE account_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE account_id=$1",
      [accountId],
    );
    await db.query(
      "UPDATE email_challenges SET revoked_at=COALESCE(revoked_at,now()) WHERE email_normalized=$1 AND consumed_at IS NULL",
      [email.rows[0].email_normalized],
    );
    await db.query(
      "INSERT INTO account_deletions(account_id,request_id,status) VALUES($1,$2,'PENDING')",
      [accountId, requestId],
    );
    return { requestId, status: "PENDING" };
  });
}
