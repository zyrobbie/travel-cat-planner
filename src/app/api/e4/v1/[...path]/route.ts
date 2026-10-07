import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  ACCOUNT_COOKIE,
  accountCookieSecure,
  accountIdentity,
} from "@/server/account-auth";
import { originCheck } from "@/server/auth";
import { HttpError, ensure } from "@/server/errors";
import { assertInternal } from "@/server/safety";
import {
  cloudRequestResult,
  cloudState,
  listCloudLetters,
  readCloudLetter,
  skipCloudLetter,
} from "@/server/cloud-repository";
import {
  deleteCloudResponse,
  editCloudResponse,
  sendCloudResponse,
} from "@/server/cloud-responses";
import { readCloudResponse, readCloudSources } from "@/server/cloud-sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
async function boundedBody(req: NextRequest) {
  const limit = 32768;
  const declared = req.headers.get("content-length");
  if (declared !== null) ensure(Number(declared) <= limit, 413, "输入过长。");
  if (!req.body) return {};
  const reader = req.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new HttpError(413, "输入过长。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function handler(req: NextRequest) {
  try {
    assertInternal();
    accountCookieSecure();
    const write = req.method === "POST";
    if (write) originCheck(req);
    // Split first, decode each component once: text IDs can contain encoded slashes.
    const path = req.nextUrl.pathname
      .slice("/api/e4/v1/".length)
      .split("/")
      .map((part) => decodeURIComponent(part));
    const accountId = await accountIdentity(
      req.cookies.get(ACCOUNT_COOKIE)?.value,
    );
    const body: unknown = write ? await boundedBody(req) : {};
    if (!write && path.length === 1 && path[0] === "state")
      return json(await cloudState(accountId));
    if (!write && path.length === 1 && path[0] === "letters")
      return json(await listCloudLetters(accountId));
    if (path[0] === "letters" && path.length === 3) {
      if (write && path[2] === "read") {
        z.strictObject({}).parse(body);
        return json(await readCloudLetter(accountId, path[1]));
      }
      if (write && path[2] === "skip") {
        z.strictObject({}).parse(body);
        return json(await skipCloudLetter(accountId, path[1]));
      }
      if (write && path[2] === "respond")
        return json(await sendCloudResponse(accountId, path[1], body));
      if (!write && path[2] === "sources")
        return json(await readCloudSources(accountId, path[1]));
    }
    if (path[0] === "responses") {
      if (!write && path.length === 2)
        return json(await readCloudResponse(accountId, path[1]));
      if (write && path.length === 3 && path[2] === "edit")
        return json(await editCloudResponse(accountId, path[1], body));
      if (write && path.length === 3 && path[2] === "delete")
        return json(await deleteCloudResponse(accountId, path[1], body));
    }
    if (!write && path[0] === "requests" && path.length === 3)
      return json(await cloudRequestResult(accountId, path[1], path[2]));
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
              : "服务暂不可用，请稍后再试。",
      },
      status,
    );
  }
}
export const GET = handler;
export const POST = handler;
