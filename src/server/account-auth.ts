import { createHmac, randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { pool, transaction } from "./db";
import { digest, sameSecret, token } from "./auth";
import { ensure, HttpError } from "./errors";
import { configuredOtpDelivery, type OtpDelivery } from "./otp-delivery";

export const ACCOUNT_COOKIE = "cat_account_session";
export const SESSION_SECONDS = 7 * 24 * 60 * 60;
export const OTP_MAX_FAILURES = 5;

/** HTTPS always wins over a mistaken false flag; insecure cookies are loopback-only. */
export function accountCookieSecure(
  origin = process.env.APP_ORIGIN,
  configured = process.env.COOKIE_SECURE,
) {
  ensure(origin, 503, "账号服务地址尚未配置。");
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new HttpError(503, "账号服务地址配置无效。");
  }
  if (url.protocol === "https:") return true;
  ensure(
    url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    503,
    "账号服务需要 HTTPS。",
  );
  return configured === "true";
}

export function normalizeEmail(value: string) {
  return z.email().max(254).parse(value.trim().toLowerCase());
}

function codeDigest(id: string, email: string, code: string) {
  const secret = process.env.OTP_HASH_SECRET;
  ensure(secret && secret.length >= 32, 503, "验证码服务尚未配置。");
  return createHmac("sha256", secret)
    .update(JSON.stringify(["LOGIN", id, email, code]))
    .digest("hex");
}

/** A separate committed statement: rejecting a request must not undo its limit. */
export async function accountRateLimit(key: string, maximum: number) {
  const r = await pool.query(
    `INSERT INTO account_rate_limits(key) VALUES($1)
     ON CONFLICT(key) DO UPDATE SET
       attempts=CASE WHEN account_rate_limits.window_at < now()-interval '1 minute'
         THEN 1 ELSE account_rate_limits.attempts+1 END,
       window_at=CASE WHEN account_rate_limits.window_at < now()-interval '1 minute'
         THEN now() ELSE account_rate_limits.window_at END RETURNING attempts`,
    [key],
  );
  ensure(r.rows[0].attempts <= maximum, 429, "操作太频繁，请稍后再试。");
}

export async function requestCode(input: string, delivery?: OtpDelivery) {
  const email = normalizeEmail(input);
  const id = randomUUID();
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const hash = codeDigest(id, email, code);
  const adapter = delivery ?? configuredOtpDelivery();
  await accountRateLimit(`request:${digest(email)}`, 10);
  const challenge = await transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 4))", [
      email,
    ]);
    const recent = await db.query(
      `SELECT count(*) FILTER (WHERE created_at > now()-interval '60 seconds')::int AS cooldown,
              count(*)::int AS hourly
       FROM email_challenges WHERE email_normalized=$1 AND created_at > now()-interval '1 hour'`,
      [email],
    );
    ensure(
      recent.rows[0].cooldown === 0 && recent.rows[0].hourly < 3,
      429,
      "验证码请求过于频繁，请稍后再试。",
    );
    const account = await db.query(
      "SELECT id FROM accounts WHERE email_normalized=$1 AND status <> 'DELETED' FOR UPDATE",
      [email],
    );
    await db.query(
      "UPDATE email_challenges SET revoked_at=now() WHERE email_normalized=$1 AND consumed_at IS NULL AND revoked_at IS NULL",
      [email],
    );
    const r = await db.query(
      `INSERT INTO email_challenges(id,email_normalized,subject_account_id,purpose,code_hash,expires_at,delivery_status)
       VALUES($1,$2,$3,'LOGIN',$4,now()+interval '10 minutes','PENDING') RETURNING expires_at`,
      [id, email, account.rows[0]?.id ?? null, hash],
    );
    return { expiresAt: r.rows[0].expires_at.toISOString() as string };
  });
  try {
    await adapter.send({ challengeId: id, email, code, ...challenge });
    await pool.query(
      "UPDATE email_challenges SET delivery_status='SENT' WHERE id=$1",
      [id],
    );
  } catch {
    // No automatic resend after an unknown outcome; this challenge cannot verify.
    await pool.query(
      "UPDATE email_challenges SET delivery_status='FAILED',revoked_at=COALESCE(revoked_at,now()) WHERE id=$1",
      [id],
    );
    throw new HttpError(503, "验证码未能就绪，请稍后重新请求。");
  }
  return { accepted: true, challengeId: id, mode: "synthetic-v1" as const };
}

export async function verifyCode(id: string, input: string, code: string) {
  z.uuid().parse(id);
  const email = normalizeEmail(input);
  z.string()
    .regex(/^\d{6}$/)
    .parse(code);
  const hash = codeDigest(id, email, code);
  await accountRateLimit(`verify:${digest(email)}`, 30);
  const rawToken = token();
  const result = await transaction(async (db) => {
    // All email/account lifecycle operations acquire this lock before row locks.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 4))", [
      email,
    ]);
    const r = await db.query(
      `SELECT *,expires_at > now() AS valid_time FROM email_challenges
       WHERE id=$1 AND email_normalized=$2 FOR UPDATE`,
      [id, email],
    );
    const challenge = r.rows[0];
    if (
      !challenge ||
      !challenge.valid_time ||
      challenge.revoked_at ||
      challenge.consumed_at ||
      challenge.delivery_status !== "SENT" ||
      challenge.failures >= OTP_MAX_FAILURES
    )
      return { ok: false as const };
    if (!sameSecret(challenge.code_hash, hash)) {
      await db.query(
        "UPDATE email_challenges SET failures=failures+1 WHERE id=$1",
        [id],
      );
      // Return, do not throw: the failed-attempt counter must COMMIT.
      return { ok: false as const };
    }
    const a = await db.query(
      "SELECT id,status FROM accounts WHERE email_normalized=$1 AND status <> 'DELETED' FOR UPDATE",
      [email],
    );
    let account = a.rows[0] as { id: string; status: string } | undefined;
    if (
      (account && account.status !== "ACTIVE") ||
      (challenge.subject_account_id &&
        challenge.subject_account_id !== account?.id)
    ) {
      await db.query(
        "UPDATE email_challenges SET revoked_at=now() WHERE id=$1",
        [id],
      );
      return { ok: false as const };
    }
    if (!account) {
      account = { id: randomUUID(), status: "ACTIVE" };
      await db.query(
        "INSERT INTO accounts(id,email_normalized) VALUES($1,$2)",
        [account.id, email],
      );
    }
    await db.query(
      "UPDATE email_challenges SET consumed_at=now() WHERE id=$1",
      [id],
    );
    await db.query(
      "INSERT INTO account_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
      [digest(rawToken), account.id],
    );
    return { ok: true as const, accountId: account.id };
  });
  ensure(result.ok, 401, "验证码无效或已失效，请重新请求。");
  return { accountId: result.accountId, rawToken };
}

export async function accountIdentity(raw: string | undefined) {
  ensure(raw && /^[a-f0-9]{64}$/.test(raw), 401, "请重新登录。");
  const r = await pool.query(
    `SELECT a.id FROM account_sessions s JOIN accounts a ON a.id=s.account_id
     WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND a.status='ACTIVE'`,
    [digest(raw)],
  );
  ensure(r.rows[0], 401, "会话已过期，请重新登录。");
  return r.rows[0].id as string;
}

export async function logoutAccount(raw: string | undefined) {
  if (raw)
    await pool.query(
      "UPDATE account_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE token_hash=$1",
      [digest(raw)],
    );
  return { ok: true };
}
