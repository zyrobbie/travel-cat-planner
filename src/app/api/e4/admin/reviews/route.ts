import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { identity, originCheck } from "@/server/auth";
import { accountCookieSecure } from "@/server/account-auth";
import { HttpError, ensure } from "@/server/errors";
import { assertInternal } from "@/server/safety";
import { withCloudCat } from "@/server/cloud-repository";
import { settleCloudCalendar } from "@/server/cloud-calendar";
import { selectCloudReview } from "@/server/cloud-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

async function boundedBody(req: NextRequest): Promise<unknown> {
  const limit = 32768;
  const declared = req.headers.get("content-length");
  if (declared !== null) ensure(Number(declared) <= limit, 413, "输入过长。");
  if (!req.body) return {};
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
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

// Internal human review only. An app-account cookie or self-reported attestation
// cannot authorize a review; the service repeats the admin-session check in-lock.
export async function POST(req: NextRequest) {
  try {
    assertInternal();
    accountCookieSecure();
    originCheck(req);
    await identity(req, "ADMIN");
    const body = z
      .object({ accountId: z.uuid() })
      .passthrough()
      .parse(await boundedBody(req));
    const { accountId, ...input } = body;
    const result = await withCloudCat(accountId, async (db, cat) => {
      await settleCloudCalendar(db, cat);
      return selectCloudReview(
        db,
        cat,
        req.cookies.get("cat_admin")?.value,
        input,
      );
    });
    return json(result);
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
