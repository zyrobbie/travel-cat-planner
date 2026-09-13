import { test, expect, type Page } from "@playwright/test";
const base = "http://127.0.0.1:4173/travel-cat-planner/app/";
async function data(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("cat-letters-pages-v1");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return new Promise<any[]>((resolve, reject) => {
      const t = db.transaction("participants"),
        r = t.objectStore("participants").getAll();
      t.oncomplete = () => {
        db.close();
        resolve(r.result);
      };
      t.onabort = () => reject(t.error);
    });
  });
}
async function name(page: Page, value: string) {
  await page.getByLabel("给它起个名字吧").fill(value);
  await page.getByRole("button", { name: "开始一起生活" }).click();
  await expect(
    page.getByText("今天没有新来信。", { exact: true }),
  ).toBeVisible();
}
async function consoleOpen(page: Page) {
  await page.getByRole("button", { name: "演示推进", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "本机演示控制台" }),
  ).toBeVisible();
}
async function enter(page: Page) {
  await page.getByRole("button", { name: "进入此体验", exact: true }).click();
}

test("Static P1–P6, refresh persistence, double tabs, zero response travel and local partitions", async ({
  browser,
}) => {
  const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
    }),
    page = await ctx.newPage();
  const errors: string[] = [],
    external: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (!r.url().startsWith("http://127.0.0.1:4173")) external.push(r.url());
  });
  await page.goto(base);
  await expect(
    page.getByText("数据仅保存在此浏览器，清除浏览器数据后可能丢失。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/catletters-pages-evidence/p1-mobile.png",
    fullPage: true,
  });
  await name(page, "本机合成甲");
  const urlA = page.url(),
    idA = new URL(urlA).hash.slice(1);
  await consoleOpen(page);
  await page
    .getByRole("button", { name: "投递下一需求卡", exact: true })
    .dblclick();
  await expect.poll(async () => (await data(page))[0].letters.length).toBe(1);
  await page.getByRole("button", { name: "回到体验", exact: true }).click();
  await page.getByRole("button", { name: "看看来信", exact: true }).click();
  await page.getByLabel("你想跟它说什么？").fill("合成回应甲");
  await expect(page.getByText("草稿已保存在本机，尚未发送。")).toBeVisible();
  const second = await ctx.newPage();
  // Keep a deliberately stale form for the duplicate-write test. Otherwise the
  // cross-tab refresh can remove its button before Playwright dispatches click.
  await second.addInitScript(() => {
    Object.defineProperty(window, "BroadcastChannel", { value: undefined });
  });
  await second.goto(urlA);
  await expect(second.getByLabel("你想跟它说什么？")).toHaveValue("合成回应甲");
  await second.getByLabel("你想跟它说什么？").fill("合成回应甲");
  await Promise.all([
    page.getByRole("button", { name: "送出去", exact: true }).click(),
    second.getByRole("button", { name: "送出去", exact: true }).click(),
  ]);
  await expect(page.getByRole("status")).toHaveText("送出去啦。");
  await expect(second.getByRole("status")).toHaveText("送出去啦。");
  let a = (await data(page)).find((x) => x.participant.id === idA);
  expect(a.events.filter((e: any) => e.event === "RESPONSE_SENT")).toHaveLength(
    1,
  );
  expect(a.trip).toBeNull();
  await page.getByRole("button", { name: "回到本机合成甲身边" }).click();
  await second.getByRole("button", { name: "回到本机合成甲身边" }).click();
  await consoleOpen(page);
  await consoleOpen(second);
  await Promise.all([
    page.getByRole("button", { name: "投递下一需求卡", exact: true }).click(),
    second.getByRole("button", { name: "投递下一需求卡", exact: true }).click(),
  ]);
  a = (await data(page)).find((x) => x.participant.id === idA);
  expect(a.letters).toHaveLength(2);
  expect(
    (await page.locator("p[role=alert]").count()) +
      (await second.locator("p[role=alert]").count()),
  ).toBe(1);
  await page.getByRole("button", { name: "刷新演示状态" }).click();
  await enter(page);
  await page.getByRole("button", { name: "看看来信", exact: true }).click();
  await page.getByLabel("你想跟它说什么？").fill("合成回应乙");
  await page.getByRole("button", { name: "送出去", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("送出去啦。");
  a = (await data(page)).find((x) => x.participant.id === idA);
  expect(a.trip).toBeNull();
  expect(a.letters).toHaveLength(2);
  await page.reload();
  await expect(
    page.getByText("今天没有新来信。", { exact: true }),
  ).toBeVisible();
  await consoleOpen(page);
  await page
    .getByRole("button", { name: "投递下一需求卡", exact: true })
    .click();
  await enter(page);
  await page.getByRole("button", { name: "看看来信", exact: true }).click();
  await expect(page.getByLabel("你想跟它说什么？")).toBeVisible();
  await page.screenshot({
    path: "/tmp/catletters-pages-evidence/p3-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "这次先不回", exact: true }).click();
  await expect(
    page.getByText("今天没有新来信。", { exact: true }),
  ).toBeVisible();
  await consoleOpen(page);
  await page.getByLabel("普通故事／出发场景").selectOption("O-FIREFLY-01");
  await page.getByRole("button", { name: "独立开始旅行" }).click();
  await page.getByRole("button", { name: "寄出普通旅行信" }).click();
  await enter(page);
  await page.getByRole("button", { name: "打开看看", exact: true }).click();
  await expect(page.getByText(/怕把它们吓跑喵~/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "/tmp/catletters-pages-evidence/postcard-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: "/tmp/catletters-pages-evidence/postcard-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "收好这封信" }).click();
  await consoleOpen(page);
  await page.getByRole("button", { name: "结束旅行回家" }).click();
  await enter(page);
  await expect(page.getByText("在家", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "来信盒", exact: true }).click();
  await page.getByRole("button", { name: /好多小星星飞起来啦/ }).click();
  await expect(page.getByText(/怕把它们吓跑喵~/)).toBeVisible();
  await consoleOpen(page);
  await page.getByRole("button", { name: "建立全新体验" }).click();
  await name(page, "本机零回应乙");
  const idB = new URL(page.url()).hash.slice(1);
  await consoleOpen(page);
  await page.getByRole("button", { name: "独立开始旅行" }).click();
  await page.getByRole("button", { name: "寄出普通旅行信" }).click();
  await enter(page);
  await page.getByRole("button", { name: "打开看看", exact: true }).click();
  await expect(page.getByText(/差点忘记肚子饿了喵~/)).toBeVisible();
  let b = (await data(page)).find((x) => x.participant.id === idB);
  expect(b.letters).toHaveLength(1);
  expect(b.letters[0].response).toBeNull();
  expect(await page.getByText("合成回应甲", { exact: true }).count()).toBe(0);
  await consoleOpen(page);
  await page.getByLabel("选择本机体验").selectOption(idA);
  await enter(page);
  await page.getByRole("button", { name: "来信盒", exact: true }).click();
  await page.getByRole("button", { name: /阿橘/ }).click();
  await expect(page.getByText("合成回应甲", { exact: true })).toBeVisible();
  await page.goto(base);
  await page
    .getByRole("button", { name: "继续本机合成甲", exact: true })
    .click();
  await expect(page.getByText("在家", { exact: true })).toBeVisible();
  expect(new URL(page.url()).hash.slice(1)).toBe(idA);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  await ctx.close();
});

test("Unavailable storage and aborted writes never report success", async ({
  browser,
}) => {
  const unavailable = await browser.newContext();
  await unavailable.addInitScript(() => {
    Object.defineProperty(IDBFactory.prototype, "open", {
      value() {
        throw new DOMException("Unavailable", "SecurityError");
      },
    });
  });
  const p = await unavailable.newPage();
  await p.goto(base);
  await expect(p.locator("p[role=alert]")).toContainText("无法保存本机数据");
  await expect(p.getByText("今天没有新来信。", { exact: true })).toHaveCount(0);
  await unavailable.close();
  const ctx = await browser.newContext(),
    page = await ctx.newPage();
  await page.goto(base);
  await name(page, "写入失败合成");
  await consoleOpen(page);
  await page.getByRole("button", { name: "投递下一需求卡" }).click();
  await enter(page);
  await page.getByRole("button", { name: "看看来信", exact: true }).click();
  await page.getByLabel("你想跟它说什么？").fill("不会保存的合成内容");
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () {
      throw new DOMException("Quota full", "QuotaExceededError");
    };
  });
  await page.getByRole("button", { name: "送出去", exact: true }).click();
  await expect(page.locator("p[role=alert]")).toContainText("尚未保存");
  await expect(page.getByRole("status")).toHaveCount(0);
  expect((await data(page))[0].letters[0].response).toBeNull();
  await page.screenshot({
    path: "/tmp/catletters-pages-evidence/write-failure.png",
    fullPage: true,
  });
  await ctx.close();
});

test("Delayed reads cannot select the wrong participant; pending sends cannot switch experience", async ({
  browser,
}) => {
  const ctx = await browser.newContext(),
    page = await ctx.newPage();
  await page.goto(base);
  await name(page, "竞态合成甲");
  const idA = new URL(page.url()).hash.slice(1);
  await consoleOpen(page);
  await page.getByRole("button", { name: "建立全新体验" }).click();
  await name(page, "竞态合成乙");
  const idB = new URL(page.url()).hash.slice(1);
  await consoleOpen(page);
  // Hold each readonly transaction open for 250ms with real IDB requests.
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function (
      ...args: Parameters<IDBObjectStore["getAll"]>
    ) {
      const result = original.apply(this, args),
        store = this,
        until = performance.now() + 250;
      const keep = () => {
        if (performance.now() < until) {
          const r = store.get("__synthetic_hold__");
          r.onsuccess = keep;
        }
      };
      keep();
      return result;
    };
  });
  await page.getByLabel("选择本机体验").selectOption(idA);
  await expect(page.getByLabel("选择本机体验")).toBeDisabled();
  // Even a forced change event while disabled is ignored by the synchronous busy guard.
  await page.getByLabel("选择本机体验").evaluate((el, id) => {
    const s = el as HTMLSelectElement;
    s.value = id;
    s.dispatchEvent(new Event("change", { bubbles: true }));
  }, idB);
  await expect(
    page.getByRole("heading", { name: "竞态合成甲", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("选择本机体验")).toBeEnabled();
  await page.getByRole("button", { name: "投递下一需求卡" }).click();
  await expect(page.getByRole("button", { name: "进入此体验" })).toBeEnabled();
  const rows = await data(page);
  expect(rows.find((x) => x.participant.id === idA).letters).toHaveLength(1);
  expect(rows.find((x) => x.participant.id === idB).letters).toHaveLength(0);
  await enter(page);
  await page.getByRole("button", { name: "看看来信", exact: true }).click();
  await page.getByLabel("你想跟它说什么？").fill("延迟合成发送");
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      const result = original.apply(this, args),
        store = this,
        until = performance.now() + 300;
      const keep = () => {
        if (performance.now() < until) {
          const r = store.get("__synthetic_hold__");
          r.onsuccess = keep;
        }
      };
      keep();
      return result;
    };
  });
  await page.getByRole("button", { name: "送出去", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "演示推进", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "演示推进", exact: true })
    .dispatchEvent("click");
  await expect(
    page.getByRole("heading", { name: "本机演示控制台" }),
  ).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("送出去啦。");
  expect(new URL(page.url()).hash.slice(1)).toBe(idA);
  expect(
    (await data(page)).find((x) => x.participant.id === idB).events,
  ).toHaveLength(0);
  await ctx.close();
});
