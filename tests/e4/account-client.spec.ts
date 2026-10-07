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

async function login(page: Page, email: string) {
  await page.goto(`${origin}/account-app/`);
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
async function fixtureAndExport(page: Page, path: string) {
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
  const readOriginal = () =>
    page.evaluate(async () => {
      const path = "/database.ts";
      const database = await import(/* @vite-ignore */ path);
      return JSON.stringify(await database.readState(location.hash.slice(1)));
    });
  const beforeExport = await readOriginal();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出这只小猫", exact: true }).click();
  await (await download).saveAs(path);
  expect(await readOriginal()).toBe(beforeExport);
  const bundle = JSON.parse(await readFile(path, "utf8"));
  expect(bundle.sourceExperienceId).toBe(info.id);
  expect(bundle.letters).toHaveLength(3);
  expect(bundle).not.toHaveProperty("drafts");
  expect(bundle).not.toHaveProperty("events");
  expect(bundle).not.toHaveProperty("requests");
  expect(JSON.stringify(bundle)).not.toContain("LOCAL_ONLY_DRAFT");
  return info;
}

test("E4-B3 actual local export, confirmed import, cloud UI, source management and two-device sync", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    acceptDownloads: true,
  });
  const page = await context.newPage(),
    errors: string[] = [];
  collectErrors(page, errors);
  const file = testInfo.outputPath("synthetic-single-cat.json");
  const info = await fixtureAndExport(page, file);
  const email = `browser-${randomUUID()}@example.test`;
  await login(page, email);
  await page.getByText("已有本机小猫？导入选定记录", { exact: true }).click();
  await page
    .getByLabel("选择小猫记录文件", { exact: true })
    .setInputFiles(file);
  await page.getByRole("button", { name: "检查这份记录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "确认带回 合成绑定猫" }),
  ).toBeVisible();
  expect((await browserGet(page, "/api/e4/account")).cat).toBeNull();
  await page.getByRole("button", { name: "取消导入", exact: true }).click();
  expect((await browserGet(page, "/api/e4/account")).cat).toBeNull();
  await page
    .getByLabel("选择小猫记录文件", { exact: true })
    .setInputFiles(file);
  await page.getByRole("button", { name: "检查这份记录", exact: true }).click();
  await page
    .getByRole("button", { name: "确认导入这只小猫", exact: true })
    .click();
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
