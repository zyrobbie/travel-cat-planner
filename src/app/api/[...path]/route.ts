import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { pool, transaction } from "@/server/db";
import {
  identity,
  digest,
  token,
  sameSecret,
  originCheck,
  rateLimit,
  newParticipant,
  reissueInvite,
} from "@/server/auth";
import { ensure, HttpError } from "@/server/errors";
import { assertInternal, checkInput } from "@/server/safety";
import * as service from "@/server/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const uuid = z.string().uuid();
function cookie(res: NextResponse, name: string, value: string) {
  res.cookies.set(name, value, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.COOKIE_SECURE === "true",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}
async function handler(req: NextRequest) {
  try {
    assertInternal();
    const path = req.nextUrl.pathname.slice(5);
    const write = req.method === "POST";
    if (write) originCheck(req);
    if (path === "health") {
      await pool.query("SELECT 1 FROM schema_migrations LIMIT 1");
      return NextResponse.json({
        status: "ok",
        mode: "INTERNAL",
        safety: "synthetic-v1",
      });
    }
    let body: Record<string, unknown> = {};
    if (write) {
      ensure(
        Number(req.headers.get("content-length") ?? 0) < 16000,
        413,
        "输入过长。",
      );
      const raw = await req.text();
      ensure(raw.length < 16000, 413, "输入过长。");
      body = JSON.parse(raw || "{}");
    }
    if (path === "admin/login" && write) {
      await rateLimit("admin-login", 12);
      const secret = z.string().max(256).parse(body.secret);
      ensure(
        process.env.ADMIN_SECRET && process.env.ADMIN_SECRET.length >= 32,
        503,
        "管理员尚未配置。",
      );
      ensure(
        sameSecret(secret, process.env.ADMIN_SECRET),
        401,
        "登录信息不正确。",
      );
      const raw = token();
      await pool.query(
        "INSERT INTO sessions(token_hash,role,expires_at) VALUES($1,'ADMIN',now()+interval '8 hours')",
        [digest(raw)],
      );
      const res = NextResponse.json({ ok: true });
      cookie(res, "cat_admin", raw);
      return res;
    }
    if (path === "invite" && write) {
      await rateLimit("invite-exchange", 30);
      const invite = z.string().length(64).parse(body.invite);
      const raw = token();
      await transaction(async (db) => {
        const r = await db.query(
          "UPDATE invites SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING participant_id",
          [digest(invite)],
        );
        ensure(r.rows[0], 401, "邀请无效、已使用或已过期。");
        await db.query(
          "INSERT INTO sessions(token_hash,participant_id,role,expires_at) VALUES($1,$2,'USER',now()+interval '7 days')",
          [digest(raw), r.rows[0].participant_id],
        );
      });
      const res = NextResponse.json({ ok: true });
      cookie(res, "cat_session", raw);
      return res;
    }
    if (path.startsWith("admin/")) {
      await identity(req, "ADMIN");
      if (path === "admin/participants" && !write) {
        const r = await pool.query(
          "SELECT p.*,EXISTS(SELECT 1 FROM trips t WHERE t.participant_id=p.id AND ended_at IS NULL) AS traveling FROM participants p ORDER BY created_at DESC",
        );
        return NextResponse.json(r.rows);
      }
      if (path === "admin/participants" && write) {
        await rateLimit("admin-create", 20);
        return NextResponse.json(await newParticipant());
      }
      if (path === "admin/timeline" && !write) {
        const pid = uuid.parse(req.nextUrl.searchParams.get("id"));
        const [s, a] = await Promise.all([
          service.state(pid),
          pool.query(
            "SELECT * FROM audit_events WHERE participant_id=$1 ORDER BY id DESC",
            [pid],
          ),
        ]);
        return NextResponse.json({ ...s, events: a.rows });
      }
      if (path === "admin/reissue-invite" && write)
        return NextResponse.json(
          await reissueInvite(uuid.parse(body.participantId)),
        );
      if (path === "admin/action" && write) {
        const b = z
          .object({
            participantId: uuid,
            action: z.enum([
              "deliver-demand",
              "start-trip",
              "deliver-postcard",
              "end-trip",
            ]),
            contentId: z.string().optional(),
            key: uuid,
          })
          .parse(body);
        return NextResponse.json(
          await service.adminAction(
            b.participantId,
            b.action,
            b.contentId,
            b.key,
          ),
        );
      }
      throw new HttpError(404, "没有此接口。");
    }
    const session = await identity(req);
    const pid = session.participant_id!;
    if (write) await rateLimit(`user:${pid}`, 60);
    if (path === "state" && !write)
      return NextResponse.json(await service.state(pid));
    if (path === "start" && write)
      return NextResponse.json(
        await service.start(
          pid,
          z.string().trim().min(1).max(12).parse(body.name),
        ),
      );
    if (path === "input-check" && write)
      return NextResponse.json(
        checkInput(z.string().min(1).max(2000).parse(body.text)),
      );
    if (path === "response-result" && !write) {
      const key = uuid.parse(req.nextUrl.searchParams.get("key"));
      const r = await pool.query(
        "SELECT id,letter_id,text FROM responses WHERE participant_id=$1 AND idempotency_key=$2",
        [pid, key],
      );
      return NextResponse.json(
        r.rows[0]
          ? {
              id: r.rows[0].id,
              letter_id: r.rows[0].letter_id,
              payloadHash: digest(r.rows[0].text),
              message: "送出去啦。",
            }
          : { pending: true },
      );
    }
    const match = path.match(/^letters\/([^/]+)\/(read|skip|respond)$/);
    if (match && write) {
      const id = uuid.parse(match[1]);
      if (match[2] === "read")
        return NextResponse.json(await service.readLetter(pid, id));
      if (match[2] === "skip")
        return NextResponse.json(await service.skip(pid, id));
      const b = z
        .object({ text: z.string().trim().min(1).max(2000), key: uuid })
        .parse(body);
      return NextResponse.json(await service.respond(pid, id, b.text, b.key));
    }
    throw new HttpError(404, "没有此接口。");
  } catch (e) {
    const status =
      e instanceof HttpError
        ? e.status
        : e instanceof z.ZodError || e instanceof SyntaxError
          ? 400
          : 503;
    return NextResponse.json(
      {
        error:
          e instanceof HttpError
            ? e.message
            : status === 400
              ? "请检查输入。"
              : "服务暂不可用，请稍后再试。",
      },
      { status },
    );
  }
}
async function wrapped(req: NextRequest) {
  const res = await handler(req);
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("X-Content-Type-Options", "nosniff");
  return res;
}
export const GET = wrapped;
export const POST = wrapped;
