import "dotenv/config";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
const origin = "http://127.0.0.1:3100";
test("P1–P6, T1/T2/T3/T7, scoped API, error handling and readable viewports", async ({
  browser,
}) => {
  const admin = await browser.newContext({ baseURL: origin });
  expect(
    (
      await admin.request.post("/api/admin/login", {
        headers: { origin },
        data: { secret: process.env.ADMIN_SECRET },
      })
    ).status(),
  ).toBe(200);
  async function create() {
    const r = await admin.request.post("/api/admin/participants", {
      headers: { origin },
      data: {},
    });
    expect(r.ok()).toBeTruthy();
    return r.json();
  }
  async function action(
    pid: string,
    action: string,
    contentId?: string,
    key = randomUUID(),
  ) {
    const r = await admin.request.post("/api/admin/action", {
      headers: { origin },
      data: { participantId: pid, action, contentId, key },
    });
    expect(r.ok()).toBeTruthy();
    return r.json();
  }
  const a = await create(),
    b = await create();
  const ctx = await browser.newContext({
    baseURL: origin,
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("邀请码", { exact: true }).fill(a.invite);
  await page.getByRole("button", { name: "进入体验", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "这是一只还在慢慢长大的小猫。" }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/catletters-evidence/p1-mobile.png",
    fullPage: true,
  });
  await page.getByLabel("给它起个名字吧").fill("合成旅行猫");
  await page.getByRole("button", { name: "开始一起生活" }).click();
  await expect(
    page.getByText("今天没有新来信。", { exact: true }),
  ).toBeVisible();
  const firstKey = randomUUID();
  const first = await action(a.id, "deliver-demand", undefined, firstKey);
  const repeated = await action(a.id, "deliver-demand", undefined, firstKey);
  expect(repeated.id).toBe(first.id);
  await page.getByRole("button", { name: "刷新来信", exact: true }).click();
  await page.getByRole("button", { name: "看看来信", exact: true }).click();
  await page.getByLabel("你想跟它说什么？").fill("合成测试：玩累了就休息。");
  await page.screenshot({
    path: "/tmp/catletters-evidence/p3-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "送出去", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("送出去啦。");
  await page.screenshot({ path: "/tmp/catletters-evidence/t1-success.png" });
  await page.getByRole("button", { name: "回到合成旅行猫身边" }).click();
  await action(a.id, "deliver-demand");
  await page.getByRole("button", { name: "刷新来信", exact: true }).click();
  await page.getByRole("button", { name: "看看来信", exact: true }).click();
  await page.getByLabel("你想跟它说什么？").fill("合成测试：可以慢慢来。");
  // A confirmed send remains success even when the following state refresh fails.
  await page.route("**/api/state", (r) =>
    r.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "模拟读取故障" }),
    }),
  );
  await page.getByRole("button", { name: "送出去", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("送出去啦。");
  await page.unroute("**/api/state");
  const st = await (await ctx.request.get("/api/state")).json();
  expect(st.trip).toBeNull();
  expect(st.letters).toHaveLength(2);
  expect(
    st.letters.every((l: { type: string }) => l.type === "DEMAND"),
  ).toBeTruthy();
  await page.reload();
  await expect(
    page.getByText("今天没有新来信。", { exact: true }),
  ).toBeVisible();
  const third = await action(a.id, "deliver-demand");
  await page.getByRole("button", { name: "刷新来信", exact: true }).click();
  await page.getByRole("button", { name: "看看来信", exact: true }).click();
  // Server saved original, response and result lookup lost. Changed text must not be falsely confirmed.
  await page.getByLabel("你想跟它说什么？").fill("合成原始内容");
  await page.route("**/respond", async (r) => {
    await ctx.request.post(r.request().url(), {
      headers: { origin },
      data: r.request().postDataJSON(),
    });
    await r.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"模拟已落库但响应丢失"}',
    });
  });
  await page.route("**/api/response-result?*", (r) => r.abort("failed"));
  await page.getByRole("button", { name: "送出去", exact: true }).click();
  await expect(page.locator("p[role=alert]")).toContainText("模拟已落库但响应丢失");
  await expect(
    page.getByRole("button", { name: "送出去", exact: true }),
  ).toBeEnabled();
  await page.unroute("**/respond");
  await page.unroute("**/api/response-result?*");
  await page.getByLabel("你想跟它说什么？").fill("合成修改内容");
  await page.getByRole("button", { name: "送出去", exact: true }).click();
  await expect(page.locator("p[role=alert]")).toContainText("已有回应");
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.reload();
  await action(a.id, "deliver-demand");
  await page.getByRole("button", { name: "刷新来信", exact: true }).click();
  await page.getByRole("button", { name: "看看来信", exact: true }).click();
  await page.getByRole("button", { name: "这次先不回" }).click();
  await expect(
    page.getByText("今天没有新来信。", { exact: true }),
  ).toBeVisible();
  await action(a.id, "start-trip");
  await page.getByRole("button", { name: "刷新来信", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "合成旅行猫出去旅行啦 🐾" }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/catletters-evidence/p4-mobile.png",
    fullPage: true,
  });
  await action(a.id, "deliver-postcard", "O-FIREFLY-01");
  await page.getByRole("button", { name: "刷新来信", exact: true }).click();
  await page.getByRole("button", { name: "打开看看", exact: true }).click();
  await expect(page.getByText(/怕把它们吓跑喵~/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "/tmp/catletters-evidence/p5-mobile.png",
    fullPage: true,
  });
  await page.screenshot({
    path: "/tmp/catletters-evidence/p5-mobile-first.png",
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: "/tmp/catletters-evidence/p5-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "收好这封信" }).click();
  await page.getByRole("button", { name: "来信盒", exact: true }).click();
  await page.screenshot({
    path: "/tmp/catletters-evidence/p6-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: /好多小星星飞起来啦/ }).click();
  await expect(page.getByText(/怕把它们吓跑喵~/)).toBeVisible();
  await action(a.id, "end-trip");
  await page.getByRole("button", { name: "收好这封信" }).click();
  await page.getByRole("button", { name: "刷新来信", exact: true }).click();
  await expect(page.getByText("在家", { exact: true })).toBeVisible();
  const ctxB = await browser.newContext({ baseURL: origin });
  await ctxB.request.post("/api/invite", {
    headers: { origin },
    data: { invite: b.invite },
  });
  await ctxB.request.post("/api/start", {
    headers: { origin },
    data: { name: "零回应合成猫" },
  });
  await action(b.id, "start-trip");
  await action(b.id, "deliver-postcard", "O-RHINE-01");
  const sb = await (await ctxB.request.get("/api/state")).json();
  expect(sb.letters).toHaveLength(1);
  expect(sb.letters[0].response).toBeNull();
  expect(
    (
      await ctxB.request.post(`/api/letters/${first.id}/read`, {
        headers: { origin },
        data: {},
      })
    ).status(),
  ).toBe(404);
  expect(
    (
      await ctxB.request.post(`/api/letters/${first.id}/respond`, {
        headers: { origin },
        data: { text: "合成越权", key: randomUUID() },
      })
    ).status(),
  ).toBe(404);
  expect((await ctxB.request.get("/api/admin/participants")).status()).toBe(
    401,
  );
  expect(
    (
      await ctxB.request.post("/api/start", {
        headers: { origin: "https://invalid.example" },
        data: { name: "越权" },
      })
    ).status(),
  ).toBe(403);
  const ri = await admin.request.post("/api/admin/reissue-invite", {
    headers: { origin },
    data: { participantId: b.id },
  });
  expect(ri.ok()).toBeTruthy();
  expect((await ctxB.request.get("/api/state")).status()).toBe(401);
  const retry = await ctxB.request.post("/api/invite", {
    headers: { origin },
    data: { invite: (await ri.json()).invite },
  });
  expect(retry.ok()).toBeTruthy();
  expect(
    (await (await ctxB.request.get("/api/state")).json()).letters,
  ).toHaveLength(1);
  // Infrastructure failure on initial load is a retry surface, not a false invitation page.
  await page.route("**/api/state", (r) =>
    r.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"synthetic outage"}',
    }),
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "暂时无法读取来信" }),
  ).toBeVisible();
  await expect(page.getByLabel("邀请码", { exact: true })).toHaveCount(0);
  await page.unroute("**/api/state");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByText("在家", { exact: true })).toBeVisible();
  await writeFile(
    ".local/restart-session.json",
    JSON.stringify(await ctx.storageState()),
    { mode: 0o600 },
  );
  await writeFile(
    ".local/restart-expected.json",
    JSON.stringify({
      participantId: a.id,
      letterCount: 5,
      body: "合成原始内容",
    }),
  );
  expect(errors).toEqual([]);
  await ctx.close();
  await ctxB.close();
  await admin.close();
});

test("Admin confirmed action followed by failed refresh does not deliver twice", async ({
  browser,
}) => {
  const admin = await browser.newContext({ baseURL: origin });
  await admin.request.post("/api/admin/login", {
    headers: { origin },
    data: { secret: process.env.ADMIN_SECRET },
  });
  const participant = await (
    await admin.request.post("/api/admin/participants", {
      headers: { origin },
      data: {},
    })
  ).json();
  const user = await browser.newContext({ baseURL: origin });
  await user.request.post("/api/invite", {
    headers: { origin },
    data: { invite: participant.invite },
  });
  await user.request.post("/api/start", {
    headers: { origin },
    data: { name: "后台重试合成猫" },
  });
  const page = await admin.newPage();
  await page.goto("/admin");
  await page
    .getByRole("button", { name: new RegExp(participant.id.slice(0, 8)) })
    .click();
  await expect(
    page.getByRole("button", { name: "投递下一需求卡", exact: true }),
  ).toBeEnabled();
  await page.route("**/api/admin/participants", (r) =>
    r.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"模拟后台刷新故障"}',
    }),
  );
  await page
    .getByRole("button", { name: "投递下一需求卡", exact: true })
    .click();
  await expect(page.locator("p[role=alert]")).toHaveText("模拟后台刷新故障");
  await page.unroute("**/api/admin/participants");
  await page
    .getByRole("button", { name: "投递下一需求卡", exact: true })
    .click();
  await expect(page.locator("p[role=alert]")).toHaveCount(0);
  const state = await (await user.request.get("/api/state")).json();
  expect(state.letters).toHaveLength(1);
  await admin.close();
  await user.close();
});
