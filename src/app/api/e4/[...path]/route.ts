import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertInternal } from "@/server/safety";
import { originCheck } from "@/server/auth";
import { assertAccountContext } from "@/server/account-context";
import { HttpError, ensure } from "@/server/errors";
import {
  ACCOUNT_COOKIE,
  SESSION_SECONDS,
  accountIdentity,
  accountCookieSecure,
  accountRateLimit,
  logoutAccount,
  requestCode,
  verifyCode,
} from "@/server/account-auth";
import {
  accountState,
  adoptCat,
  adoptionResult,
} from "@/server/account-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function handler(req: NextRequest) {
  try {
    assertInternal();
    const secure = accountCookieSecure();
    const path = req.nextUrl.pathname.slice("/api/e4/".length);
    const write = req.method === "POST";
    if (write) originCheck(req);
    let body: unknown = {};
    if (write) {
      const raw = await req.text();
      ensure(Buffer.byteLength(raw) <= 4096, 413, "输入过长。");
      body = JSON.parse(raw || "{}");
    }
    if (path === "auth/request-code" && write) {
      // Conservative global bucket until a trusted deployment proxy is chosen.
      await accountRateLimit("request-global", 60);
      const input = z.strictObject({ email: z.string() }).parse(body);
      return json(await requestCode(input.email));
    }
    if (path === "auth/verify-code" && write) {
      await accountRateLimit("verify-global", 120);
      const input = z
        .strictObject({
          challengeId: z.uuid(),
          email: z.string(),
          code: z.string(),
        })
        .parse(body);
      const login = await verifyCode(
        input.challengeId,
        input.email,
        input.code,
      );
      const response = json({
        ok: true,
        accountId: login.accountId,
        mode: "synthetic-v1",
      });
      response.cookies.set(ACCOUNT_COOKIE, login.rawToken, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        secure,
        maxAge: SESSION_SECONDS,
      });
      return response;
    }
    if (path === "auth/logout" && write) {
      if (req.headers.has("x-catletters-account"))
        assertAccountContext(
          req,
          await accountIdentity(req.cookies.get(ACCOUNT_COOKIE)?.value),
        );
      await logoutAccount(req.cookies.get(ACCOUNT_COOKIE)?.value);
      const response = json({ ok: true });
      response.cookies.set(ACCOUNT_COOKIE, "", {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: 0,
        secure,
      });
      return response;
    }
    const accountId = await accountIdentity(
      req.cookies.get(ACCOUNT_COOKIE)?.value,
    );
    assertAccountContext(req, accountId);
    if (path === "account" && !write)
      return json(await accountState(accountId));
    if (path === "cat/adopt" && write)
      return json(await adoptCat(accountId, body));
    const result = path.match(/^requests\/([^/]+)$/);
    if (result && !write)
      return json(await adoptionResult(accountId, result[1]));
    throw new HttpError(404, "没有此接口。");
  } catch (error) {
    const status =
      error instanceof HttpError
        ? error.status
        : error instanceof z.ZodError || error instanceof SyntaxError
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
