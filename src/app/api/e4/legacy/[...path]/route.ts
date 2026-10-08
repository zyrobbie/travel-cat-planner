import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  ACCOUNT_COOKIE,
  accountCookieSecure,
  accountIdentity,
} from "@/server/account-auth";
import { assertAccountContext } from "@/server/account-context";
import { originCheck } from "@/server/auth";
import { HttpError, ensure } from "@/server/errors";
import { assertInternal } from "@/server/safety";
import {
  confirmLegacyBinding,
  legacyBindingResult,
  preflightLegacyBinding,
  cancelLegacyBinding,
} from "@/server/cloud-binding";
import { LEGACY_TRANSFER_MAX_BYTES } from "@/shared/legacy-transfer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
async function body(req: NextRequest) {
  const declared = req.headers.get("content-length");
  if (declared !== null)
    ensure(
      Number(declared) <= LEGACY_TRANSFER_MAX_BYTES,
      413,
      "转移文件过大。",
    );
  if (!req.body) return {};
  const reader = req.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > LEGACY_TRANSFER_MAX_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "转移文件过大。");
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
    accountCookieSecure();
    const write = req.method === "POST";
    if (write) originCheck(req);
    const accountId = await accountIdentity(
      req.cookies.get(ACCOUNT_COOKIE)?.value,
    );
    assertAccountContext(req, accountId);
    const path = req.nextUrl.pathname
      .slice("/api/e4/legacy/".length)
      .split("/")
      .map(decodeURIComponent);
    if (!write && path.length === 2 && path[0] === "requests")
      return json(await legacyBindingResult(accountId, path[1]));
    if (write && path.length === 1 && path[0] === "preflight") {
      const input = z
        .strictObject({ bundle: z.unknown() })
        .parse(await body(req));
      return json(await preflightLegacyBinding(accountId, input.bundle));
    }
    if (write && path.length === 1 && path[0] === "confirm")
      return json(await confirmLegacyBinding(accountId, await body(req)));
    if (write && path.length === 1 && path[0] === "cancel")
      return json(await cancelLegacyBinding(accountId, await body(req)));
    throw new HttpError(404, "没有此接口。");
  } catch (error) {
    const status =
      error instanceof HttpError
        ? error.status
        : error instanceof z.ZodError ||
            error instanceof SyntaxError ||
            error instanceof URIError ||
            (error instanceof TypeError &&
              error.message.includes("encoded data"))
          ? 400
          : 503;
    return json(
      {
        error:
          error instanceof HttpError
            ? error.message
            : status === 400
              ? "转移文件格式不正确，原档未改写。"
              : "服务暂不可用，请稍后再试。",
      },
      status,
    );
  }
}
export const GET = handler;
export const POST = handler;
