import { ensure } from "./errors";

/** Reject a stale tab after the browser's shared session cookie changed accounts. */
export function assertAccountContext(
  request: { headers: { get(name: string): string | null } },
  accountId: string,
) {
  const expected = request.headers.get("x-catletters-account");
  ensure(
    !expected || expected === accountId,
    401,
    "登录账号已变化，请重新载入。",
  );
}
