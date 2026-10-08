import { test, expect, type Page } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";

// Real browser -> HTTP -> disposable PostgreSQL. No mocked API or real user archive.
const origin = process.env.E4_TEST_ORIGIN!;
const local = "http://127.0.0.1:18994/";
const shots = resolve(
  process.env.E4_EVIDENCE_DIR ?? ".local/e4-binding-evidence",
  "screenshots",
);
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
test.beforeAll(async () => {
  const result = await db.query("SELECT current_database() AS name");
  expect(result.rows[0].name).toBe("catletters_e4_binding_test");
  await mkdir(shots, { recursive: true });
});
test.afterAll(async () => {
  await db.end();
});

function collectErrors(page: Page, errors: string[]) {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const expectedUnauthorized =
      message.location().url.startsWith(`${origin}/api/e4/`) &&
      /status of 401/.test(message.text());
    if (!expectedUnauthorized) errors.push(message.text());
  });
}

async function browserGet(page: Page, path: string) {
  const result = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
    });
    return { status: response.status, data: await response.json() };
  }, path);
  expect(result.status, `Browser GET ${path}`).toBe(200);
  return result.data;
}

function watchFiles(page: Page, events: string[]) {
  page.on("download", () => events.push("download"));
  page.on("filechooser", () => events.push("filechooser"));
}
async function localRows(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("cat-letters-pages-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<unknown[]>((resolve, reject) => {
      const tx = database.transaction("participants", "readonly"),
        rows = tx.objectStore("participants").getAll();
      tx.oncomplete = () => {
        resolve(rows.result);
        database.close();
      };
      tx.onabort = () => {
        reject(tx.error);
        database.close();
      };
    });
  });
}
async function gate(page: Page, id: string) {
  return page.evaluate(async (id) => {
    const path = "/binding-storage.ts",
      storage = await import(/* @vite-ignore */ path);
    return storage.readBindingGate(id);
  }, id);
}
async function openBinding(page: Page, label = "登录并保存这只小猫") {
  await page.evaluate(() => {
    if ((window as any).__bindingOpenCapture) return;
    (window as any).__bindingOpenCapture = true;
    const original = window.open;
    window.open = function (...args: Parameters<typeof window.open>) {
      (window as any).__lastBindingUrl = String(args[0]);
      return original.apply(window, args);
    };
  });
  const opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: label, exact: true }).click();
  const popup = await opened;
  await expect.poll(() => new URL(popup.url()).origin).toBe(origin);
  return popup;
}

async function login(page: Page, email: string, navigate = true) {
  if (navigate) await page.goto(`${origin}/account-app/`);
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  const pending = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/e4/auth/request-code") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "获取验证码", exact: true }).click();
  const response = await pending;
  expect(response.ok()).toBe(true);
  const { challengeId } = await response.json();
  const otp = JSON.parse(
    await readFile(
      join(process.env.E4_SYNTHETIC_INBOX!, `${challengeId}.json`),
      "utf8",
    ),
  );
  expect(otp.email).toBe(email);
  // OTP comes only from the private test outbox. Tracing is disabled; screenshots are taken after login.
  await expect(page.locator("main")).not.toContainText(otp.code);
  await page.getByLabel("验证码", { exact: true }).fill(otp.code);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  try {
    await expect(
      page.getByRole("button", { name: "退出账号", exact: true }),
    ).toBeVisible();
  } finally {
    const field = page.getByLabel("验证码", { exact: true });
    if (await field.isVisible()) await field.fill("");
  }
}
async function adopt(page: Page, name: string) {
  await page.getByRole("radio", { name: "选择橘白猫", exact: true }).check();
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.getByLabel("给它起个名字吧", { exact: true }).fill(name);
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.getByRole("button", { name: "确认领养", exact: true }).click();
  await expect(page.locator(".e3-home-page")).toBeVisible();
}
async function navBoundary(page: Page) {
  const nav = page.locator(".e3-app-shell > nav");
  await expect(nav).toBeVisible();
  const box = await nav.boundingBox();
  const height = page.viewportSize()!.height;
  expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1);
  expect(box!.y + box!.height).toBeGreaterThanOrEqual(height - 3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
async function localFixture(page: Page) {
  await page.goto(`${local}?product=1`);
  await adopt(page, "合成绑定猫");
  const info = await page.evaluate(async () => {
    // Vite serves the existing local producer. This new browser context contains no user records.
    const path = "/store.ts";
    const store = await import(/* @vite-ignore */ path);
    const id = location.hash.slice(1);
    let state = await store.readState(id);
    await store.control(
      id,
      "deliver-demand",
      "",
      state.controlRevision,
      crypto.randomUUID(),
    );
    state = await store.readState(id);
    const source = state.letters[0];
    await store.letterAction(id, source.id, "read");
    const text = "累的时候可以先休息。";
    await store.letterAction(id, source.id, "respond", text, null);
    state = await store.readState(id);
    const response = Object.values(state.responses)[0] as {
      id: string;
      currentRevision: number;
    };
    await store.control(
      id,
      "start-trip",
      "O-RHINE-01",
      state.controlRevision,
      crypto.randomUUID(),
    );
    state = await store.readState(id);
    const selected = await store.selectReview(
      id,
      "L-RHINE",
      [
        {
          claim: "rest",
          responseId: response.id,
          revision: 1,
          start: 0,
          end: text.length,
          assessment: "SUPPORTED",
          attested: true,
        },
      ],
      state.controlRevision,
      crypto.randomUUID(),
    );
    await store.deliverReview(id, selected.reviewId, crypto.randomUUID());
    state = await store.readState(id);
    const linked = state.letters.find(
      (l: { type: string }) => l.type === "POSTCARD",
    );
    await store.letterAction(id, linked.id, "read");
    state = await store.readState(id);
    await store.control(
      id,
      "end-trip",
      "",
      state.controlRevision,
      crypto.randomUUID(),
    );
    state = await store.readState(id);
    await store.control(
      id,
      "deliver-demand",
      "",
      state.controlRevision,
      crypto.randomUUID(),
    );
    state = await store.readState(id);
    const unread = state.letters.find(
      (l: { read_at: string | null }) => !l.read_at,
    );
    await store.saveDraft(
      id,
      source.id,
      "edit",
      "LOCAL_ONLY_DRAFT",
      response.id,
      1,
    );
    return {
      id,
      sourceId: source.id,
      sourceTitle: source.snapshot.title,
      responseId: response.id,
      linkedId: linked.id,
      linkedTitle: linked.snapshot.title,
      unreadId: unread.id,
      unreadTitle: unread.snapshot.title,
      unreadBody: unread.snapshot.body,
      sourceText: text,
    };
  });
  await page.reload();
  await expect(page.locator(".e3-home-page")).toBeVisible();

  return info;
}

test("E4-B3 current-browser popup binding, cloud UI, source management and two-context sync", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    acceptDownloads: true,
  });
  let page = await context.newPage();
  const errors: string[] = [];
  collectErrors(page, errors);
  await page.clock.setFixedTime(new Date());
  const info = await localFixture(page);
  const source = page;
  const before = await localRows(source);
  const handoffs: string[] = [];
  context.on("page", (p) => watchFiles(p, handoffs));
  watchFiles(source, handoffs);
  const email = `browser-${randomUUID()}@example.test`;
  let popup = await openBinding(source);
  collectErrors(popup, errors);
  await login(popup, email, false);
  await expect(
    popup.getByRole("button", { name: "确认保存这只小猫", exact: true }),
  ).toBeVisible();
  expect((await browserGet(popup, "/api/e4/account")).cat).toBeNull();
  await popup.screenshot({
    path: join(shots, "mobile-binding-confirmation.png"),
  });
  await popup.setViewportSize({ width: 1280, height: 900 });
  await popup.screenshot({
    path: join(shots, "desktop-binding-confirmation.png"),
  });
  await popup.setViewportSize({ width: 390, height: 844 });
  expect(await gate(source, info.id)).toBeNull();
  await popup.getByRole("button", { name: "暂不保存", exact: true }).click();
  await expect.poll(() => popup.isClosed()).toBe(true);
  expect(await localRows(source)).toEqual(before);
  expect(await gate(source, info.id)).toBeNull();
  popup = await openBinding(source);
  collectErrors(popup, errors);
  await expect(
    popup.getByRole("button", { name: "确认保存这只小猫", exact: true }),
  ).toBeVisible();
  await popup
    .getByRole("button", { name: "确认保存这只小猫", exact: true })
    .click();
  await expect
    .poll(async () => (await gate(source, info.id))?.phase)
    .toBe("BOUND");
  expect(await localRows(source)).toEqual(before);
  expect(handoffs).toEqual([]);
  page = popup;
  await expect(page.locator(".e3-home-page")).toBeVisible();
  await expect(page.locator(".e3-home-scene.is-ready")).toBeVisible();
  await expect(page.locator(".e3-new-letter")).not.toContainText(
    info.unreadTitle,
  );
  await expect(page.locator(".e3-home-page")).not.toContainText(
    info.unreadBody,
  );
  expect(
    (await browserGet(page, "/api/e4/v1/letters")).letters.find(
      (l: { id: string }) => l.id === info.unreadId,
    ).readAt,
  ).toBeNull();
  await navBoundary(page);
  await page.screenshot({ path: join(shots, "mobile-home.png") });
  await page.getByRole("button", { name: "看看来信", exact: true }).click();
  await expect(page.locator(".e3-story")).toHaveText(info.unreadBody);
  await expect(page.locator("#response")).toHaveCount(0);
  await page.getByRole("button", { name: "给它回信", exact: true }).click();
  await page
    .getByLabel("你想跟它说什么？", { exact: true })
    .fill("BROWSER_ONLY_DRAFT");
  await expect(
    page.getByText("草稿已保存在本机，尚未发送。", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByLabel("你想跟它说什么？", { exact: true }),
  ).toHaveValue("BROWSER_ONLY_DRAFT");
  const account = await browserGet(page, "/api/e4/account");
  expect(typeof account.id).toBe("string");
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM cloud_response_revisions WHERE text=$1",
        ["BROWSER_ONLY_DRAFT"],
      )
    ).rows[0].n,
  ).toBe(0);
  await page.screenshot({ path: join(shots, "mobile-restored-draft.png") });
  await page.getByRole("button", { name: "送出去", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /^送出去啦。$/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "回到合成绑定猫身边", exact: true })
    .click();

  const other = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    }),
    desktop = await other.newPage();
  collectErrors(desktop, errors);
  // Simulate the real 60-second request cooldown elapsing for this exact synthetic email.
  // Only created_at changes in the dedicated test DB; expiry and production policy stay intact.
  await db.query(
    "UPDATE email_challenges SET created_at=created_at-interval '61 seconds' WHERE email_normalized=$1 AND consumed_at IS NOT NULL",
    [email],
  );
  await login(desktop, email);
  await expect(desktop.locator(".e3-home-page")).toBeVisible();
  await expect(desktop.locator(".e3-home-scene.is-ready")).toBeVisible();
  await navBoundary(desktop);
  await desktop.screenshot({ path: join(shots, "desktop-home.png") });
  await desktop.getByRole("button", { name: "来信盒", exact: true }).click();
  await navBoundary(desktop);
  await desktop
    .getByRole("button")
    .filter({ has: desktop.getByText(info.unreadTitle, { exact: true }) })
    .click();
  await expect(desktop.locator(".e3-response-summary")).toContainText(
    "BROWSER_ONLY_DRAFT",
  );
  await desktop
    .getByRole("button", { name: "管理这条回应", exact: true })
    .click();
  await desktop
    .getByRole("button", { name: "更正这条回应", exact: true })
    .click();
  await desktop
    .getByLabel("更正后的回应", { exact: true })
    .fill("云端更正后的合成回应");
  await desktop.getByRole("button", { name: "保存更正", exact: true }).click();
  await expect(desktop.locator(".e3-response-summary")).toContainText(
    "云端更正后的合成回应",
  );
  await desktop
    .getByRole("button", { name: "管理这条回应", exact: true })
    .click();
  await desktop
    .getByRole("button", { name: "删除这条回应", exact: true })
    .click();
  await expect(desktop.getByRole("alertdialog")).toBeVisible();
  await desktop.getByRole("button", { name: "取消删除", exact: true }).click();
  await expect(desktop.locator(".e3-response-manager")).toContainText(
    "云端更正后的合成回应",
  );
  await desktop
    .getByRole("button", { name: "删除这条回应", exact: true })
    .click();
  await desktop
    .getByRole("button", { name: "确认删除回应", exact: true })
    .click();
  await expect(desktop.locator(".e3-deleted-response")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "来信盒", exact: true }).click();
  await page
    .getByRole("button")
    .filter({ has: page.getByText(info.unreadTitle, { exact: true }) })
    .click();
  await expect(page.locator(".e3-deleted-response")).toBeVisible();
  await expect(page.locator("main")).not.toContainText("BROWSER_ONLY_DRAFT");

  await page.getByRole("button", { name: "← 来信盒", exact: true }).click();
  await page
    .getByRole("button")
    .filter({ has: page.getByText(info.linkedTitle, { exact: true }) })
    .click();
  await page.getByText("看看以前说过的话", { exact: true }).click();
  await expect(page.locator(".e3-source-note")).toContainText(info.sourceText);
  await page.getByRole("button", { name: "管理这条回应", exact: true }).click();
  await page.getByRole("button", { name: "删除这条回应", exact: true }).click();
  await page.getByRole("button", { name: "确认删除回应", exact: true }).click();
  await expect(page.locator(".e3-deleted-response")).toBeVisible();
  await page.getByRole("button", { name: "← 返回旅行信", exact: true }).click();
  await expect(page.locator(".e3-source-note")).toContainText(
    "这条回应已删除。",
  );
  await expect(page.locator(".e3-source-note")).not.toContainText(
    info.sourceText,
  );
  await page.screenshot({ path: join(shots, "mobile-deleted-source.png") });
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM cloud_response_revisions WHERE account_id=$1 AND text IS NOT NULL",
        [account.id],
      )
    ).rows[0].n,
  ).toBe(0);

  await page.getByRole("button", { name: "退出账号", exact: true }).click();
  await expect(page.getByLabel("邮箱", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("合成绑定猫");
  await login(page, `fresh-${randomUUID()}@example.test`);
  await expect(
    page.getByRole("heading", { name: "选一只你喜欢的小猫吧", exact: true }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("BROWSER_ONLY_DRAFT");
  expect(await localRows(source)).toEqual(before);
  expect(handoffs).toEqual([]);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  expect(errors).toEqual([]);
  await other.close();
  await context.close();
});

test("new cloud adoption persists and an expired session clears the visible cat", async ({
  browser,
}) => {
  const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    }),
    page = await context.newPage();
  const errors: string[] = [];
  collectErrors(page, errors);
  await login(page, `adoption-${randomUUID()}@example.test`);
  await adopt(page, "合成新账号猫");
  await page.reload();
  await expect(page.locator(".e3-home-page h1")).toContainText("合成新账号猫");
  await navBoundary(page);
  const account = await browserGet(page, "/api/e4/account");
  expect(typeof account.id).toBe("string");
  // Only the dedicated synthetic account is revoked; no global reset occurs in a browser case.
  const revoked = await db.query(
    "UPDATE account_sessions SET revoked_at=now() WHERE account_id=$1",
    [account.id],
  );
  expect(revoked.rowCount).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByLabel("邮箱", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("合成新账号猫");
  expect(errors).toEqual([]);
  await context.close();
});

async function bindingFixture(
  browser: import("@playwright/test").Browser,
  prefix: string,
  dropCompleteAck = false,
) {
  const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    }),
    source = await context.newPage();
  if (dropCompleteAck)
    await context.addInitScript(() => {
      (window as any).__droppedCompleteAck = false;
      window.addEventListener(
        "message",
        (event) => {
          if (
            !(window as any).__droppedCompleteAck &&
            event.data?.protocol === "catletters-binding-v1" &&
            event.data?.ok === true &&
            event.data?.value?.complete === true
          ) {
            (window as any).__droppedCompleteAck = true;
            event.stopImmediatePropagation();
          }
        },
        true,
      );
    });
  await source.clock.setFixedTime(new Date());
  const info = await localFixture(source),
    before = await localRows(source);
  const popup = await openBinding(source),
    email = `${prefix}-${randomUUID()}@example.test`;
  const preflight = popup.waitForResponse(
    (r) =>
      r.url().endsWith("/api/e4/legacy/preflight") &&
      r.request().method() === "POST",
  );
  await login(popup, email, false);
  const response = await preflight;
  expect(response.status()).toBe(200);
  const checked = await response.json();
  await expect(
    popup.getByRole("button", { name: "确认保存这只小猫", exact: true }),
  ).toBeVisible();
  return { context, source, info, before, popup, email, checked };
}
async function browserPost(page: Page, path: string, body: unknown) {
  return page.evaluate(
    async ({ path, body }) => {
      const me = await fetch("/api/e4/account", {
        credentials: "same-origin",
      }).then((r) => r.json());
      const r = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "x-catletters-account": me.id,
        },
        body: JSON.stringify(body),
      });
      return { status: r.status, data: await r.json() };
    },
    { path, body },
  );
}
async function neutralPopup(source: Page, url: string) {
  await source.context().route(url, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Untrusted bridge sender</title>",
    }),
  );
  const opened = source.waitForEvent("popup");
  await source.evaluate((url) => window.open(url, "_blank"), url);
  const page = await opened;
  await page.waitForURL(url);
  return page;
}
async function postToSource(sender: Page, message: unknown) {
  await sender.evaluate(
    ({ message, target }) => window.opener.postMessage(message, target),
    { message, target: new URL(local).origin },
  );
}

test("real wrong-origin/window/nonce messages cannot freeze a cat; stale preflight cannot bind changed history", async ({
  browser,
}) => {
  const { context, source, info, before, popup, checked } =
    await bindingFixture(browser, "bridge");
  const account = await browserGet(popup, "/api/e4/account");
  const openingUrl = await source.evaluate(
    () => (window as any).__lastBindingUrl,
  );
  const nonce = new URLSearchParams(new URL(openingUrl).hash.slice(1)).get(
    "binding",
  );
  expect(nonce).toBeTruthy();
  const message = {
    protocol: "catletters-binding-v1",
    nonce,
    requestId: randomUUID(),
    op: "FREEZE",
    payload: {
      accountId: account.id,
      key: randomUUID(),
      bundleHash: checked.bundleHash,
    },
  };
  const wrongOrigin = await neutralPopup(
    source,
    "http://localhost:18994/__bridge-untrusted",
  );
  await postToSource(wrongOrigin, message);
  const wrongWindow = await neutralPopup(
    source,
    `${origin}/__bridge-wrong-window`,
  );
  await postToSource(wrongWindow, { ...message, requestId: randomUUID() });
  await postToSource(popup, {
    ...message,
    nonce: randomUUID(),
    requestId: randomUUID(),
  });
  await postToSource(popup, {
    ...message,
    protocol: "unexpected-protocol",
    requestId: randomUUID(),
  });
  await source.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  expect(await gate(source, info.id)).toBeNull();
  expect(await localRows(source)).toEqual(before);
  expect((await browserGet(popup, "/api/e4/account")).cat).toBeNull();
  // A real local business change after the preview invalidates that preview.
  await source.evaluate(async (id) => {
    const p = "/store.ts",
      s = await import(/* @vite-ignore */ p),
      state = await s.readState(id);
    await s.control(
      id,
      "start-trip",
      "O-RHINE-01",
      state.controlRevision,
      crypto.randomUUID(),
    );
  }, info.id);
  const changed = await localRows(source);
  await popup
    .getByRole("button", { name: "确认保存这只小猫", exact: true })
    .click();
  await expect(popup.getByRole("alert")).toContainText(/变化|重新/);
  expect(await gate(source, info.id)).toBeNull();
  expect(await localRows(source)).toEqual(changed);
  expect((await browserGet(popup, "/api/e4/account")).cat).toBeNull();
  await context.close();
});

test("lost confirm response and refreshed source recover the original committed binding without files or a second cat", async ({
  browser,
}) => {
  const { context, source, info, before, popup } = await bindingFixture(
    browser,
    "recover",
  );
  let committed = false,
    sentBody: Record<string, unknown> | null = null;
  await popup.route("**/api/e4/legacy/confirm", async (route) => {
    sentBody = route.request().postDataJSON();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed = true;
    await route.abort("failed");
  });
  await popup
    .getByRole("button", { name: "确认保存这只小猫", exact: true })
    .click();
  await expect.poll(() => committed).toBe(true);
  await expect
    .poll(async () => (await gate(source, info.id))?.phase)
    .toBe("PENDING");
  const pending = await gate(source, info.id);
  expect(pending.key).toBe((sentBody as any).key);
  await popup.close();
  await source.reload();
  const recovered = await openBinding(source, "继续确认保存结果");
  await expect
    .poll(async () => (await gate(source, info.id))?.phase)
    .toBe("BOUND");
  await expect(recovered.locator(".e3-home-page")).toBeVisible();
  expect((await gate(source, info.id)).key).toBe(pending.key);
  expect(await localRows(source)).toEqual(before);
  const account = await browserGet(recovered, "/api/e4/account");
  const cats = await db.query(
    "SELECT count(*)::int AS n FROM cat_profiles WHERE account_id=$1",
    [account.id],
  );
  expect(cats.rows[0].n).toBe(1);
  await source.screenshot({ path: join(shots, "source-bound-recovery.png") });
  await context.close();
});

test("unknown confirmation can be cancelled safely and a delayed original confirm remains rejected", async ({
  browser,
}) => {
  const { context, source, info, before, popup } = await bindingFixture(
    browser,
    "cancel",
  );
  let sentBody: unknown;
  await popup.route("**/api/e4/legacy/confirm", async (route) => {
    sentBody = route.request().postDataJSON();
    await route.abort("failed");
  });
  await popup
    .getByRole("button", { name: "确认保存这只小猫", exact: true })
    .click();
  await expect
    .poll(async () => (await gate(source, info.id))?.phase)
    .toBe("PENDING");
  const pending = await gate(source, info.id);
  await popup.getByRole("button", { name: "取消保存", exact: true }).click();
  await expect.poll(() => gate(source, info.id)).toBeNull();
  expect(await localRows(source)).toEqual(before);
  const accountPage = await context.newPage();
  await accountPage.goto(`${origin}/account-app/`);
  const result = await browserGet(
    accountPage,
    `/api/e4/legacy/requests/${pending.key}`,
  );
  expect(result.cancelled).toBe(true);
  expect(result.key).toBe(pending.key);
  expect(result.bundleHash).toBe(pending.bundleHash);
  const late = await browserPost(
    accountPage,
    "/api/e4/legacy/confirm",
    sentBody,
  );
  expect(late.status).toBe(409);
  expect((await browserGet(accountPage, "/api/e4/account")).cat).toBeNull();
  expect(await localRows(source)).toEqual(before);
  await context.close();
});

test("occupied account, blocked popup and closed popup leave the selected local archive unchanged", async ({
  browser,
}) => {
  const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    }),
    cloud = await context.newPage();
  await login(cloud, `occupied-${randomUUID()}@example.test`);
  await adopt(cloud, "账号原有猫");
  const account = await browserGet(cloud, "/api/e4/account"),
    source = await context.newPage();
  await source.clock.setFixedTime(new Date());
  const info = await localFixture(source),
    before = await localRows(source);
  await source.evaluate(() => {
    (window as any).realOpen = window.open;
    window.open = () => null;
  });
  await source
    .getByRole("button", { name: "登录并保存这只小猫", exact: true })
    .click();
  await expect(source.getByRole("alert")).toContainText(/窗口|弹窗|浏览器/);
  expect(await gate(source, info.id)).toBeNull();
  expect(await localRows(source)).toEqual(before);
  await source.evaluate(() => {
    window.open = (window as any).realOpen;
  });
  const popup = await openBinding(source, "继续确认保存结果");
  await expect(popup.getByRole("alert")).toContainText(/已有|已经|一只/);
  await expect(
    popup.getByRole("button", { name: "确认保存这只小猫", exact: true }),
  ).toHaveCount(0);
  expect((await browserGet(popup, "/api/e4/account")).cat.id).toBe(
    account.cat.id,
  );
  expect(await gate(source, info.id)).toBeNull();
  await popup.close();
  await expect(source.getByRole("alert")).toContainText(/关闭|重试|窗口/);
  expect(await localRows(source)).toEqual(before);
  await context.close();
});

test("a different logged-in account cannot confirm the original account preview", async ({
  browser,
}) => {
  const { context, source, info, before, popup } = await bindingFixture(
    browser,
    "account-a",
  );
  const original = await browserGet(popup, "/api/e4/account");
  const other = await context.newPage();
  await other.goto(`${origin}/account-app/`);
  await other.getByRole("button", { name: "退出账号", exact: true }).click();
  await login(other, `account-b-${randomUUID()}@example.test`);
  const switched = await browserGet(other, "/api/e4/account");
  expect(switched.id).not.toBe(original.id);
  // The current UI must either invalidate the old preview or safely reject its stale confirmation.
  const confirm = popup.getByRole("button", {
    name: "确认保存这只小猫",
    exact: true,
  });
  if (await confirm.isVisible()) await confirm.click();
  await expect(popup.getByRole("alert")).toContainText(/账号|登录|会话|变化/);
  expect((await browserGet(other, "/api/e4/account")).cat).toBeNull();
  const binding = await gate(source, info.id);
  expect(binding?.phase).not.toBe("BOUND");
  if (binding) expect(binding.accountId).toBe(original.id);
  expect(await localRows(source)).toEqual(before);
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM cat_profiles WHERE account_id=ANY($1::uuid[])",
        [[original.id, switched.id]],
      )
    ).rows[0].n,
  ).toBe(0);
  await context.close();
});

test("switching the selected local cat invalidates an already opened binding window", async ({
  browser,
}) => {
  const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    }),
    source = await context.newPage();
  await source.clock.setFixedTime(new Date());
  const info = await localFixture(source);
  const otherId = await source.evaluate(async () => {
    const p = "/store.ts",
      s = await import(/* @vite-ignore */ p);
    return (await s.createParticipant("不可串入的另一猫", "cat-04")).participant
      .id;
  });
  const before = await localRows(source),
    popup = await openBinding(source);
  let uploads = 0;
  popup.on("request", (r) => {
    if (r.url().includes("/api/e4/legacy/preflight")) uploads++;
  });
  await source.evaluate((id) => {
    location.hash = id;
  }, otherId);
  await login(popup, `selection-${randomUUID()}@example.test`, false);
  await expect(popup.getByRole("alert")).toContainText(/页面已变化|重新开始/);
  expect(uploads).toBe(0);
  expect((await browserGet(popup, "/api/e4/account")).cat).toBeNull();
  expect(await gate(source, info.id)).toBeNull();
  expect(await gate(source, otherId)).toBeNull();
  expect(await localRows(source)).toEqual(before);
  await context.close();
});

test("expired preview cannot submit a binding and retains the source for original-account recovery", async ({
  browser,
}) => {
  const { context, source, info, before, popup } = await bindingFixture(
    browser,
    "expired-preview",
  );
  const account = await browserGet(popup, "/api/e4/account");
  const revoked = await db.query(
    "UPDATE account_sessions SET revoked_at=now() WHERE account_id=$1",
    [account.id],
  );
  expect(revoked.rowCount).toBeGreaterThan(0);
  await popup
    .getByRole("button", { name: "确认保存这只小猫", exact: true })
    .click();
  await expect(popup.getByLabel("邮箱", { exact: true })).toBeVisible();
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM cat_profiles WHERE account_id=$1",
        [account.id],
      )
    ).rows[0].n,
  ).toBe(0);
  const pending = await gate(source, info.id);
  expect(pending?.phase).not.toBe("BOUND");
  if (pending) expect(pending.accountId).toBe(account.id);
  expect(await localRows(source)).toEqual(before);
  await context.close();
});

test("a lost COMPLETE acknowledgement recovers in the same source window when receipt key order changes", async ({
  browser,
}) => {
  const { context, source, info, before, popup } = await bindingFixture(
    browser,
    "lost-ack",
    true,
  );
  const committed = popup.waitForResponse(
    (r) =>
      r.url().endsWith("/api/e4/legacy/confirm") &&
      r.request().method() === "POST",
  );
  await popup
    .getByRole("button", { name: "确认保存这只小猫", exact: true })
    .click();
  const confirmation = await committed;
  expect(confirmation.status()).toBe(200);
  const originalReceipt = await confirmation.json();
  await expect
    .poll(() => popup.evaluate(() => (window as any).__droppedCompleteAck))
    .toBe(true);
  await expect
    .poll(async () => (await gate(source, info.id))?.phase)
    .toBe("BOUND");
  await expect(popup.getByRole("alert")).toContainText(/响应|重试|超时/, {
    timeout: 20000,
  });
  await expect(popup.locator(".e3-home-page")).toHaveCount(0);
  const pending = await gate(source, info.id);
  let orderChanged = false;
  await popup.route(
    `**/api/e4/legacy/requests/${pending.key}`,
    async (route) => {
      const actual = await route.fetch();
      expect(actual.status()).toBe(200);
      const receipt = await actual.json();
      expect(receipt).toEqual(originalReceipt);
      // Only JSON object key order changes; all fields come from this real committed receipt.
      const reordered = Object.fromEntries(
        Object.keys(originalReceipt)
          .reverse()
          .map((key) => [key, receipt[key]]),
      );
      orderChanged =
        JSON.stringify(Object.keys(reordered)) !==
        JSON.stringify(Object.keys(originalReceipt));
      await route.fulfill({
        response: actual,
        body: JSON.stringify(reordered),
      });
    },
  );
  await popup
    .getByRole("button", { name: "重试确认保存结果", exact: true })
    .click();
  await expect(popup.locator(".e3-home-page")).toBeVisible();
  expect(orderChanged).toBe(true);
  expect((await gate(source, info.id)).key).toBe(pending.key);
  expect(await localRows(source)).toEqual(before);
  await context.close();
});

test("cancelling an already committed unknown result shows the saved cat instead of claiming cancellation", async ({
  browser,
}) => {
  const { context, source, info, before, popup } = await bindingFixture(
    browser,
    "committed-cancel",
  );
  let committed = false;
  await popup.route("**/api/e4/legacy/confirm", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed = true;
    await route.abort("failed");
  });
  await popup
    .getByRole("button", { name: "确认保存这只小猫", exact: true })
    .click();
  await expect.poll(() => committed).toBe(true);
  await expect
    .poll(async () => (await gate(source, info.id))?.phase)
    .toBe("PENDING");
  const cancellation = popup.waitForResponse((r) =>
    r.url().endsWith("/api/e4/legacy/cancel"),
  );
  await popup.getByRole("button", { name: "取消保存", exact: true }).click();
  const response = await cancellation;
  expect(response.status()).toBe(200);
  const receipt = await response.json();
  expect(receipt.logicalCatId).toBe(info.id);
  expect(receipt).not.toHaveProperty("cancelled");
  await expect
    .poll(async () => (await gate(source, info.id))?.phase)
    .toBe("BOUND");
  await expect(popup.locator(".e3-home-page")).toBeVisible();
  await expect(
    popup.getByRole("heading", { name: "已取消保存", exact: true }),
  ).toHaveCount(0);
  expect(await localRows(source)).toEqual(before);
  await context.close();
});
