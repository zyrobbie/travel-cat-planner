import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  ACCOUNT_COOKIE,
  accountCookieSecure,
  accountIdentity,
  accountRateLimit,
} from "@/server/account-auth";
import { assertAccountContext } from "@/server/account-context";
import { originCheck } from "@/server/auth";
import { HttpError, ensure } from "@/server/errors";
import { assertInternal } from "@/server/safety";
import {
  DELETION_COOKIE,
  DELETION_RECEIPT_SECONDS,
  prepareAccountDeletion,
  confirmAccountDeletion,
  deletionStatus,
  retryAccountDeletion,
  finishAccountDeletion,
} from "@/server/account-lifecycle";
import {
  requestAccountExport,
  listAccountExports,
  accountExportStatus,
  retryAccountExport,
  downloadAccountExport,
} from "@/server/account-export";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store, private", Pragma: "no-cache" },
  });
async function readBody(req: NextRequest) {
  const declared = req.headers.get("content-length");
  if (declared !== null) ensure(Number(declared) <= 4096, 413, "输入过长。");
  if (!req.body) return {};
  const reader = req.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        throw new HttpError(413, "输入过长。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) ||
      "{}",
  );
}
async function handler(req: NextRequest) {
  try {
    assertInternal();
    const secure = accountCookieSecure(),
      write = req.method === "POST";
    if (write) originCheck(req);
    const p = req.nextUrl.pathname
      .slice("/api/e4/privacy/".length)
      .split("/")
      .map(decodeURIComponent);
    const recovery = req.cookies.get(DELETION_COOKIE)?.value;
    if (p.join("/") === "deletions/status" && !write)
      return json(await deletionStatus(recovery));
    if (
      p[0] === "deletions" &&
      ["retry", "finish"].includes(p[1]) &&
      p.length === 2 &&
      write
    ) {
      const { requestId } = z
        .strictObject({ requestId: z.uuid() })
        .parse(await readBody(req));
      const existing = await deletionStatus(recovery);
      ensure(
        existing.deletion?.requestId === requestId,
        401,
        "注销进度凭证已失效。",
      );
      if (p[1] === "finish") {
        ensure(
          existing.deletion.status === "COMPLETE",
          409,
          "注销尚未完成，暂时不能结束查询。",
        );
        return json(await finishAccountDeletion(requestId, recovery));
      }
      const res = json(await retryAccountDeletion(requestId, recovery));
      // Old normal sessions are already revoked. Do not touch a new account's cookie.
      return res;
    }
    const accountId = await accountIdentity(
      req.cookies.get(ACCOUNT_COOKIE)?.value,
    );
    assertAccountContext(req, accountId);
    if (write) await accountRateLimit(`privacy:${accountId}`, 20);
    if (p.join("/") === "deletions/prepare" && write) {
      const { key } = z
        .strictObject({ key: z.uuid() })
        .parse(await readBody(req));
      const r = await prepareAccountDeletion(accountId, key, recovery);
      const res = json({ deletion: r.deletion });
      res.cookies.set(DELETION_COOKIE, r.receipt, {
        httpOnly: true,
        sameSite: "strict",
        secure,
        path: "/api/e4/privacy",
        maxAge: DELETION_RECEIPT_SECONDS,
      });
      return res;
    }
    if (p.join("/") === "deletions/confirm" && write) {
      const input = z
        .strictObject({ requestId: z.uuid(), confirm: z.literal(true) })
        .parse(await readBody(req));
      return json(
        await confirmAccountDeletion(accountId, input.requestId, recovery),
      );
    }
    if (p[0] === "exports" && p.length === 1) {
      if (!write) return json(await listAccountExports(accountId));
      const { key } = z
        .strictObject({ key: z.uuid() })
        .parse(await readBody(req));
      return json(await requestAccountExport(accountId, key));
    }
    if (p[0] === "exports" && p.length >= 2) {
      if (p.length === 2 && !write)
        return json(await accountExportStatus(accountId, p[1]));
      if (p.length === 3 && p[2] === "retry" && write) {
        z.strictObject({}).parse(await readBody(req));
        return json(await retryAccountExport(accountId, p[1]));
      }
      if (p.length === 3 && p[2] === "download" && !write) {
        const r = await downloadAccountExport(accountId, p[1]);
        return new NextResponse(new Uint8Array(r.bytes), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="${r.filename}"`,
            "Cache-Control": "private, no-store, max-age=0",
            Pragma: "no-cache",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
          },
        });
      }
    }
    throw new HttpError(404, "没有此接口。");
  } catch (error) {
    const status =
      error instanceof HttpError
        ? error.status
        : error instanceof z.ZodError ||
            error instanceof SyntaxError ||
            error instanceof URIError
          ? 400
          : 503;
    return json(
      {
        error:
          error instanceof HttpError
            ? error.message
            : status === 400
              ? "输入格式不正确。"
              : "服务暂不可用，未确认完成，请保留此页后重试。",
      },
      status,
    );
  }
}
export const GET = handler;
export const POST = handler;
