import {
  createHash,
  randomBytes,
  timingSafeEqual,
  randomUUID,
} from "node:crypto";
import type { NextRequest } from "next/server";
import { pool, transaction } from "./db";
import { ensure } from "./errors";
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("hex");
export function sameSecret(a: string, b: string) {
  return timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
}
export async function identity(
  req: NextRequest,
  role: "USER" | "ADMIN" = "USER",
) {
  const raw = req.cookies.get(
    role === "ADMIN" ? "cat_admin" : "cat_session",
  )?.value;
  ensure(raw, 401, "请重新登录。");
  const result = await pool.query(
    "SELECT participant_id,role FROM sessions WHERE token_hash=$1 AND expires_at>now() AND role=$2",
    [digest(raw), role],
  );
  ensure(result.rows[0], 401, "会话已过期，请重新登录。");
  return result.rows[0] as { participant_id: string | null; role: string };
}
export function originCheck(req: NextRequest) {
  ensure(
    req.headers.get("origin") === process.env.APP_ORIGIN,
    403,
    "请求来源不被允许。",
  );
}
export async function rateLimit(key: string, max = 30) {
  const r = await pool.query(
    `INSERT INTO rate_limits(key) VALUES($1) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN rate_limits.window_at<now()-interval '1 minute' THEN 1 ELSE rate_limits.attempts+1 END,window_at=CASE WHEN rate_limits.window_at<now()-interval '1 minute' THEN now() ELSE rate_limits.window_at END RETURNING attempts`,
    [key],
  );
  ensure(r.rows[0].attempts <= max, 429, "操作太频繁，请稍后再试。");
}
export async function newParticipant() {
  const id = randomUUID(),
    invite = token();
  await transaction(async (db) => {
    await db.query("INSERT INTO participants(id) VALUES($1)", [id]);
    await db.query(
      "INSERT INTO invites(token_hash,participant_id,expires_at) VALUES($1,$2,now()+interval '24 hours')",
      [digest(invite), id],
    );
    await db.query(
      "INSERT INTO audit_events(participant_id,event,actor,simulation) VALUES($1,'PARTICIPANT_CREATED','ADMIN',true)",
      [id],
    );
  });
  return { id, invite };
}

export async function reissueInvite(pid: string) {
  const raw = token();
  await transaction(async (db) => {
    const p = await db.query(
      "SELECT id FROM participants WHERE id=$1 FOR UPDATE",
      [pid],
    );
    ensure(p.rows[0], 404, "没有找到参与者。");
    await db.query("DELETE FROM invites WHERE participant_id=$1", [pid]);
    await db.query("DELETE FROM sessions WHERE participant_id=$1", [pid]);
    await db.query(
      "INSERT INTO invites(token_hash,participant_id,expires_at) VALUES($1,$2,now()+interval '24 hours')",
      [digest(raw), pid],
    );
    await db.query(
      "INSERT INTO audit_events(participant_id,event,actor,simulation) VALUES($1,'INVITE_REISSUED','ADMIN',true)",
      [pid],
    );
  });
  return { invite: raw };
}
