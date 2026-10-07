import test from "node:test";
import assert from "node:assert/strict";
import { createAccountClient } from "../../static-app/account-client";
import type { ViewState } from "../../static-app/app-client";

const when = "2026-10-07T00:00:00.000Z";
const detail = {
  id: "letter:1",
  type: "DEMAND",
  snapshot: {
    title: "正式标题",
    body: "打开后才能看见",
    catName: "小咪",
    tip: null,
    scene: null,
    season: null,
    timeOfDay: null,
    contentId: "D-07",
  },
  deliveredAt: when,
  readAt: when,
  skippedAt: null,
  response: null,
  responseStatus: null,
};
function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
}
function setup() {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memory(),
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: memory(),
  });
  const calls: {
    path: string;
    body: Record<string, unknown> | undefined;
    account: string | null;
  }[] = [];
  let read = false;
  const route = async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input).replace("/api/e4/", ""),
      body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({
      path,
      body,
      account: new Headers(options?.headers).get("X-Catletters-Account"),
    });
    let data: unknown;
    if (path === "v1/state")
      data = {
        cat: { id: "cat", name: "小咪", appearanceId: "cat-01" },
        world: { status: "HOME", tripId: null },
        safety: "CLEAR",
        stateRevision: 1,
      };
    else if (path === "v1/letters")
      data = {
        letters: [
          {
            id: "letter:1",
            type: "DEMAND",
            title: read ? "正式标题" : "有一封来信，还没打开",
            deliveredAt: when,
            readAt: read ? when : null,
            skippedAt: null,
          },
        ],
        stateRevision: 1,
      };
    else if (path === "v1/responses")
      data = { responses: [], stateRevision: 1 };
    else if (path === "v1/letters/letter%3A1/read") {
      read = true;
      data = { letter: detail, firstRead: true, stateRevision: 1 };
    } else if (path === "v1/letters/letter%3A1/detail")
      data = { letter: detail, stateRevision: 1 };
    else if (path === "v1/letters/letter%3A1/respond")
      data = {
        message: "送出去啦。",
        responseId: "r1",
        revision: 1,
        stateRevision: 2,
      };
    else throw new Error(`unexpected ${path}`);
    return new Response(JSON.stringify(data), { status: 200 });
  };
  globalThis.fetch = route;
  return {
    calls,
    route,
    client: (id = "account-a", expired = () => {}) =>
      createAccountClient(
        { id, email_normalized: "synthetic@example.test", cat: { id: "cat" } },
        expired,
      ),
  };
}

test("cloud Home receives metadata only; explicit read supplies detail without a second fetch", async () => {
  const { client, calls } = setup(),
    c = client();
  const home = (await c.api("state")) as ViewState;
  assert.equal(home.letters[0].snapshot.body, "");
  assert.equal(home.calendar, undefined);
  assert.deepEqual(calls.map((x) => x.path).sort(), [
    "v1/letters",
    "v1/responses",
    "v1/state",
  ]);
  const before = calls.length;
  const opened = (await c.api("letters/letter:1/read", {})) as {
    state: ViewState;
    firstRead: boolean;
  };
  assert.equal(calls.length, before + 1);
  assert.equal(opened.state.letters[0].snapshot.body, "打开后才能看见");
  assert.equal(opened.firstRead, true);
  assert.ok(calls.every((x) => x.account === "account-a"));
  c.dispose();
});

test("drafts remain local and isolated by account; malformed storage does not hide cloud letters", async () => {
  const { client, calls } = setup(),
    a = client(),
    b = client("account-b");
  await a.api("state");
  await a.api("letters/letter:1/read", {});
  const before = calls.length;
  await a.saveDraft("cat", "letter:1", "reply", "仅账号A草稿", null, null);
  assert.equal(calls.length, before);
  assert.equal(
    ((await a.api("state")) as ViewState).drafts["letter:1"].text,
    "仅账号A草稿",
  );
  assert.deepEqual(
    Object.keys(((await b.api("state")) as ViewState).drafts),
    [],
  );
  localStorage.setItem(
    "cat-letters:account-draft:v1:account-a:cat:letter%3A1:reply",
    "broken json",
  );
  const restored = (await a.api("state")) as ViewState;
  assert.equal(restored.letters.length, 1);
  assert.match(restored.storageNotice!, /格式异常/);
  a.dispose();
  b.dispose();
});

test("successful submit is not reported failed when local draft cleanup throws", async () => {
  const { client } = setup(),
    c = client();
  await c.api("state");
  await c.api("letters/letter:1/read", {});
  await c.saveDraft("cat", "letter:1", "reply", "待提交", null, null);
  Object.defineProperty(localStorage, "removeItem", {
    value: () => {
      throw new Error("storage disabled");
    },
  });
  const result = await c.api("letters/letter:1/respond", {
    text: "待提交",
    expectedResponseId: null,
  });
  assert.equal((result as { message: string }).message, "送出去啦。");
  const restored = (await c.api("state")) as ViewState;
  assert.deepEqual(Object.keys(restored.drafts), []);
  assert.match(restored.storageNotice!, /提交已成功/);
  c.dispose();
});

test("lost mutation response recovers through scoped request result with the original key", async () => {
  const { client, route } = setup(),
    c = client();
  await c.api("state");
  let key = "";
  globalThis.fetch = async (input, options) => {
    if (String(input).endsWith("/respond")) {
      key = JSON.parse(String(options?.body)).key;
      throw new Error("connection lost after commit");
    }
    if (String(input).includes("/requests/SEND_RESPONSE/")) {
      assert.ok(key);
      assert.ok(String(input).endsWith(key));
      return new Response(
        JSON.stringify({
          message: "送出去啦。",
          responseId: "r1",
          revision: 1,
        }),
      );
    }
    return route(input, options);
  };
  assert.equal(
    (
      (await c.api("letters/letter:1/respond", {
        text: "合成回应",
        expectedResponseId: null,
      })) as { message: string }
    ).message,
    "送出去啦。",
  );
  c.dispose();
});

test("401 expires visible client state and never falls back to local data", async () => {
  let expired = 0;
  const { client } = setup(),
    c = client("account-a", () => {
      expired++;
    });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "登录状态已变化" }), { status: 401 });
  await assert.rejects(c.api("state"));
  assert.equal(expired, 1);
  await assert.rejects(
    c.saveDraft("cat", "letter:1", "reply", "不应保存", null, null),
    /登录状态已变化/,
  );
  await assert.rejects(c.api("state"));
  assert.equal(expired, 1);
});

test("legacy response IDs named __proto__ remain ordinary own records across detail merges", async () => {
  const { client, route } = setup(),
    c = client();
  globalThis.fetch = async (input, options) => {
    if (String(input).endsWith("v1/responses"))
      return new Response(
        JSON.stringify({
          responses: [
            {
              id: "__proto__",
              letterId: "letter:1",
              currentRevision: 1,
              status: "ACTIVE",
              text: "合法旧ID",
              at: when,
            },
          ],
          stateRevision: 1,
        }),
      );
    return route(input, options);
  };
  const state = (await c.api("state")) as ViewState;
  assert.equal(Object.getPrototypeOf(state.responses), null);
  assert.equal(Object.hasOwn(state.responses, "__proto__"), true);
  assert.equal(state.responses["__proto__"].revisions[0].text, "合法旧ID");
  const merged = await c.detail!("letter:1");
  assert.equal(Object.getPrototypeOf(merged.responses), null);
  assert.equal(Object.hasOwn(merged.responses, "__proto__"), true);
  c.dispose();
});
