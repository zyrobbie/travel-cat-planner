import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const base = `http://127.0.0.1:${process.env.PAGES_TEST_PORT ?? 4173}/travel-cat-planner/app/`;
const shots = "/tmp/e3-visual-qa";
mkdirSync(shots, { recursive: true });

async function row(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("cat-letters-pages-v1");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const value = await new Promise<any>((resolve, reject) => {
      const tx = db.transaction("participants", "readonly");
      const req = tx.objectStore("participants").get(location.hash.slice(1));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return value;
  });
}

async function participantCount(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("cat-letters-pages-v1");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const count = await new Promise<number>((resolve, reject) => {
      const req = db.transaction("participants", "readonly").objectStore("participants").count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return count;
  });
}

async function control(page: Page, action: string) {
  await page.getByRole("button", { name: "演示推进", exact: true }).click();
  await expect(page.getByRole("heading", { name: "本机演示控制台" })).toBeVisible();
  await page.getByRole("button", { name: action, exact: true }).click();
  await page.getByRole("button", { name: "进入此体验", exact: true }).click();
}
async function adopt(page: Page, choice: string, name: string) {
  await page.getByRole("radio", { name: choice }).check();
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.getByLabel("给它起个名字吧").fill(name);
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await expect(page.getByRole("heading", { name: "确认领养" })).toBeVisible();
  await page.getByRole("button", { name: "确认领养", exact: true }).click();
  await expect(page.getByText("今天没有新来信。", { exact: true })).toBeVisible();
}

test("E3 new cat persists appearance and approved scenes without changing the 14-day plan", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await expect(page.getByRole("radio")).toHaveCount(4);
  await page.screenshot({ path: `${shots}/adoption-mobile.png`, fullPage: true });
  await adopt(page, "选择奶油白猫", "合成奶油");
  await expect(page.locator(".e3-home-scene.is-ready")).toBeVisible();
  await expect.poll(() => page.locator(".e3-home-cat").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: `${shots}/home-mobile.png`, fullPage: true });
  const initial = await row(page);
  expect(initial.participant.appearanceId).toBe("cat-03");
  expect(initial.calendar.nodes.map((n: any) => [n.id, n.kind, n.contentId])).toEqual([
    ["fixed:d1", "DEMAND", "D-03"], ["fixed:d3", "DEMAND", "D-04"],
    ["fixed:d5", "DEMAND", "D-02"], ["fixed:d6", "START", undefined],
    ["fixed:d7", "POSTCARD", undefined], ["fixed:d8", "END", undefined],
    ["fixed:d9", "DEMAND", "D-05"], ["fixed:d10", "DEMAND", "D-01"],
    ["fixed:d11", "DEMAND", "D-06"], ["fixed:d12", "START", undefined],
    ["fixed:d13", "POSTCARD", undefined], ["fixed:d14", "END", undefined],
    ["welcome:d0", "DEMAND", "D-07"],
  ]);
  expect(initial.calendar.nodes.slice(0, 12).map((n: any) => n.order)).toEqual(
    Array.from({ length: 12 }, (_, index) => index),
  );
  expect(await page.evaluate(() => localStorage.getItem("cat-letters-e3-g2r:daily-v1"))).toBeNull();

  for (const contentId of ["D-01", "D-02", "D-03", "D-04", "D-05", "D-06", "D-07"]) {
    await control(page, "投递下一需求卡");
    await page.getByRole("button", { name: "看看来信", exact: true }).click();
    await expect(page.locator(".e3-letter-scene.is-ready img")).toBeVisible();
    const item = (await row(page)).letters[0];
    expect(item.snapshot.contentId).toBe(contentId);
    expect(item.snapshot.contentVersion).toBeTruthy();
    expect(await page.locator(".e3-letter-scene img").getAttribute("src")).toContain(
      contentId === "D-07" ? "need-window-cat-03" : `demand-${contentId.replace("-", "")}-cat-03`,
    );
    if (contentId === "D-07") {
      await expect(page.getByText("窗边的小光点，刚才还在我的爪子旁边。", { exact: false })).toBeVisible();
      await page.screenshot({ path: `${shots}/seventh-demand-mobile.png`, fullPage: true });
    }
    await page.getByRole("button", { name: "这次先不回" }).click();
  }
  expect((await row(page)).letters).toHaveLength(7);

  await control(page, "独立开始旅行");
  await expect(page.locator(".e3-home-scene.is-ready")).toBeVisible();
  await expect(page.locator(".e3-home-cat")).toHaveCount(0);
  await page.screenshot({ path: `${shots}/trip-empty-home-mobile.png`, fullPage: true });
  await control(page, "寄出普通旅行信");
  await page.getByRole("button", { name: "打开看看", exact: true }).click();
  await expect(page.locator(".e3-letter-scene.is-ready img")).toBeVisible();
  expect(await page.locator(".e3-letter-scene img").getAttribute("src")).toContain("postcard-rhine-cat-03");
  await page.screenshot({ path: `${shots}/postcard-mobile.png`, fullPage: true });
  expect(errors).toEqual([]);
  await context.close();
});

test("E3 old participant without appearance remains readable and gains no guessed cat", async ({ page }) => {
  await page.goto(base);
  await adopt(page, "选择橘白猫", "合成旧猫");
  const id = new URL(page.url()).hash.slice(1);
  await page.evaluate(async (participantId) => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open("cat-letters-pages-v1");
      req.onsuccess = () => resolve(req.result);
    });
    const tx = db.transaction("participants", "readwrite");
    const store = tx.objectStore("participants");
    const record = await new Promise<any>((resolve) => {
      const req = store.get(participantId);
      req.onsuccess = () => resolve(req.result);
    });
    delete record.participant.appearanceId;
    record.calendar.nodes = record.calendar.nodes.filter((n: any) => n.id !== "welcome:d0");
    store.put(record);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    db.close();
  }, id);
  await page.reload();
  await expect(page.getByText("这份旧体验没有记录外观，原有小猫和来信已保留。")).toBeVisible();
  expect((await row(page)).participant.appearanceId).toBeUndefined();
  expect((await row(page)).participant.id).toBe(id);
  expect((await row(page)).calendar.nodes).toHaveLength(12);
});

test("new adoption schedules one persisted welcome letter and settles it only when due", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const startedAt = Date.UTC(2026, 9, 6, 12, 0, 0);
  await page.clock.install({ time: startedAt });
  await page.clock.setFixedTime(startedAt);
  await page.goto(base);
  expect(await participantCount(page)).toBe(0);
  await adopt(page, "选择橘白猫", "欢迎合成猫");
  const first = await row(page);
  const welcome = first.calendar.nodes.find((n: any) => n.id === "welcome:d0");
  expect(welcome).toMatchObject({ kind: "DEMAND", contentId: "D-07", result: null });
  expect(welcome.at).toBeGreaterThanOrEqual(first.calendar.initializedAt + 5 * 60_000);
  expect(welcome.at).toBeLessThanOrEqual(first.calendar.initializedAt + 10 * 60_000);
  await page.reload();
  expect((await row(page)).calendar.nodes.find((n: any) => n.id === "welcome:d0").at).toBe(welcome.at);
  await page.clock.setFixedTime(welcome.at - 1);
  await page.reload();
  expect((await row(page)).letters).toHaveLength(0);
  const second = await context.newPage();
  await second.clock.install({ time: welcome.at - 1 });
  await second.clock.setFixedTime(welcome.at - 1);
  await second.goto(page.url());
  await Promise.all([page.clock.runFor(1), second.clock.runFor(1)]);
  await expect(page.getByRole("button", { name: "看看来信", exact: true })).toBeVisible();
  const settled = await row(page);
  expect(settled.letters).toHaveLength(1);
  expect(settled.letters[0].snapshot.contentId).toBe("D-07");
  expect(settled.letters[0].read_at).toBeNull();
  expect(Date.parse(settled.letters[0].planned_at)).toBe(welcome.at);
  expect(settled.calendar.nodes.find((n: any) => n.id === "welcome:d0").result.outcome).toBe("APPLIED");
  await second.reload();
  expect((await row(second)).letters).toHaveLength(1);
  await context.close();
});

test("E3 product shows only the approved tip and centers the sent confirmation", async ({ browser }) => {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 900 },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await adopt(page, "选择橘白猫", "视觉合成猫");
    const id = new URL(page.url()).hash.slice(1);
    await control(page, "投递下一需求卡");
    await page.goto(`${base}?product=1#${id}`);
    await expect(page.getByRole("button", { name: "演示推进" })).toHaveCount(0);
    await page.getByRole("button", { name: "看看来信", exact: true }).click();
    await page.getByRole("button", { name: "给它回信", exact: true }).click();
    const tip = (await row(page)).letters[0].snapshot.tip;
    await page.getByText("看看小提示").click();
    await expect(page.locator(".e3-detail-page details")).toContainText(tip);
    await expect(page.getByText("内部草案，尚未专业审核")).toHaveCount(0);
    await page.screenshot({ path: `${shots}/tip-${width}.png` });
    await page.getByLabel("你想跟它说什么？").fill("合成回应，只验证成功界面。");
    await page.getByRole("button", { name: "送出去", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("送出去啦。");
    await expect(page.locator(".e3-success-panel svg")).toBeVisible();
    const layout = await page.evaluate(() => {
      const main = document.querySelector(".e3-success-page")!.getBoundingClientRect();
      const content = document.querySelector(".e3-success-content")!.getBoundingClientRect();
      const icon = document.querySelector(".e3-success-panel svg")!.getBoundingClientRect();
      const title = document.querySelector(".e3-success-panel h1")!.getBoundingClientRect();
      const button = document.querySelector(".e3-success-content button")!.getBoundingClientRect();
      return {
        centerOffset: Math.abs((content.top + content.bottom - main.top - main.bottom) / 2),
        horizontalOffset: Math.abs((button.left + button.right - main.left - main.right) / 2),
        iconAboveTitle: icon.bottom < title.top,
        titleAboveButton: title.bottom < button.top,
        buttonInViewport: button.bottom <= innerHeight && button.top >= 0,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(layout.centerOffset).toBeLessThan(80);
    expect(layout.horizontalOffset).toBeLessThan(8);
    expect(layout.iconAboveTitle).toBe(true);
    expect(layout.titleAboveButton).toBe(true);
    expect(layout.buttonInViewport).toBe(true);
    expect(layout.overflow).toBe(false);
    await page.screenshot({ path: `${shots}/success-${width}.png` });
    await page.getByRole("button", { name: /回到.*身边/ }).click();
    await expect(page.locator(".e3-home-page")).toBeVisible();
    expect(errors).toEqual([]);
    await context.close();
  }
});

test("explicit review entry exposes existing local controls while product entry stays clean", async ({ page }) => {
  await page.goto(`${base}?review=1`);
  await expect(page.getByRole("button", { name: "演示推进", exact: true })).toBeVisible();
  await expect(page.getByText("测试工具 · 演示快进会改变这份本机测试日历")).toBeVisible();
  await adopt(page, "选择狸花猫", "入口合成猫");
  const id = new URL(page.url()).hash.slice(1);
  await control(page, "投递下一需求卡");
  expect((await row(page)).letters).toHaveLength(1);
  await page.goto(`${base}?product=1#${id}`);
  await expect(page.getByRole("button", { name: "演示推进" })).toHaveCount(0);
  await expect(page.getByText("测试工具 · 演示快进会改变这份本机测试日历")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "看看来信", exact: true })).toBeVisible();
});

test("E3 preview and new IDB experience stay independent, with both entries available", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("cat-letters-e3-g2r:confirmed-cat-v1", JSON.stringify({ version: 1, catId: "cat-04", name: "预览三花" }));
    localStorage.setItem("cat-letters-e3-g2r:daily-v1", JSON.stringify({
      version: 2,
      state: { schemaVersion: 2, appearanceId: "cat-04", catName: "预览三花", letters: {} },
      receipts: {},
    }));
  });
  await page.goto(base);
  await expect(page.getByRole("radio")).toHaveCount(4);
  await expect(page.getByText("新版在本机独立测试；", { exact: false })).toContainText("两份数据不迁入、不合并，也不会互相覆盖。");
  await expect(page.getByRole("link", { name: "原审阅入口" })).toHaveAttribute("href", "https://zyrobbie.github.io/travel-cat-planner/ui-daily-core-v1/index.html");
  const previewBefore = await page.evaluate(() => [
    localStorage.getItem("cat-letters-e3-g2r:confirmed-cat-v1"),
    localStorage.getItem("cat-letters-e3-g2r:daily-v1"),
  ]);
  await adopt(page, "选择橘白猫", "正式橘白");
  expect((await row(page)).participant.cat_name).toBe("正式橘白");
  expect(await page.evaluate(() => [
    localStorage.getItem("cat-letters-e3-g2r:confirmed-cat-v1"),
    localStorage.getItem("cat-letters-e3-g2r:daily-v1"),
  ])).toEqual(previewBefore);
  await page.goto(base);
  await expect(page.getByRole("button", { name: "继续正式橘白" })).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(4);
  await page.getByRole("button", { name: "继续正式橘白" }).click();
  expect((await row(page)).participant.cat_name).toBe("正式橘白");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("cat-letters-e3-g2r:daily-v1")!).state.catName)).toBe("预览三花");
  await context.close();
});

test("E3 damaged preview metadata cannot block independent new adoption", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("cat-letters-e3-g2r:confirmed-cat-v1", "invalid preview data");
  });
  await page.goto(base);
  await expect(page.getByRole("radio")).toHaveCount(4);
  await adopt(page, "选择三花猫", "独立三花");
  expect((await row(page)).participant.cat_name).toBe("独立三花");
  expect(await page.evaluate(() => localStorage.getItem("cat-letters-e3-g2r:confirmed-cat-v1"))).toBe("invalid preview data");
});

test("E3 adoption saves only after confirmation and keeps the chosen name on return", async ({ page }) => {
  await page.goto(base);
  await page.getByRole("radio", { name: "选择狸花猫" }).check();
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.getByLabel("给它起个名字吧").fill("合成狸花");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  expect(await participantCount(page)).toBe(0);
  await page.getByRole("button", { name: "再看看" }).click();
  await expect(page.getByRole("radio", { name: "选择狸花猫" })).toBeChecked();
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await expect(page.getByLabel("给它起个名字吧")).toHaveValue("合成狸花");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.getByRole("button", { name: "确认领养", exact: true }).click();
  await expect(page.getByText("今天没有新来信。", { exact: true })).toBeVisible();
  expect(await participantCount(page)).toBe(1);
  await page.reload();
  expect(await participantCount(page)).toBe(1);
});

test("E3 inbox filters and response entry retain an honest empty state", async ({ page }) => {
  await page.goto(base);
  await adopt(page, "选择橘白猫", "筛选合成猫");
  await control(page, "投递下一需求卡");
  await page.getByRole("button", { name: "来信盒", exact: true }).click();
  await page.getByRole("button", { name: "旅行来信", exact: true }).click();
  await expect(page.getByRole("heading", { name: "没有符合筛选的来信" })).toBeVisible();
  await page.getByRole("button", { name: "查看全部" }).click();
  await expect(page.getByRole("button", { name: /阿橘/ })).toHaveCount(1);
  await page.getByRole("button", { name: "管理我的回应" }).click();
  await expect(page.getByText("还没有送出的回应。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "← 返回来信盒" }).click();
  await page.getByRole("button", { name: /阿橘/ }).click();
  await page.getByRole("button", { name: "这次先不回" }).click();
  await page.getByRole("button", { name: "来信盒", exact: true }).click();
  await page.getByRole("checkbox", { name: "只看未读" }).check();
  await expect(page.getByRole("heading", { name: "没有符合筛选的来信" })).toBeVisible();
  await page.getByRole("button", { name: "查看全部" }).click();
  await expect(page.getByRole("button", { name: /阿橘/ })).toHaveCount(1);
});

test("E3 scene retry, HOME/TRIP return, and short viewport keep actions reachable", async ({ page }) => {
  const blockedRoom = /home-empty.*\.webp/;
  await page.route(blockedRoom, (route) => route.abort());
  await page.setViewportSize({ width: 390, height: 670 });
  await page.goto(base);
  await adopt(page, "选择三花猫", "场景合成猫");
  await expect(page.getByText("画面暂时没能加载，原有记录仍在。")).toBeVisible();
  await page.unroute(blockedRoom);
  await page.getByRole("button", { name: "再试一次" }).click();
  await expect(page.locator(".e3-home-scene.is-ready .e3-home-cat")).toBeVisible();
  for (const height of [670, 350, 670]) {
    await page.setViewportSize({ width: 390, height });
    await expect.poll(() => page.locator(".e3-app-shell").evaluate((el) => el.getBoundingClientRect().height)).toBe(height);
    const geometry = await page.evaluate(() => {
      const shell = document.querySelector(".e3-app-shell")!.getBoundingClientRect();
      const nav = document.querySelector(".e3-app-shell nav")!.getBoundingClientRect();
      const main = document.querySelector(".e3-app-shell > main")!;
      return { shellTop: shell.top, shellBottom: shell.bottom, navBottom: nav.bottom,
        mainScrolls: main.scrollHeight > main.clientHeight, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(geometry.shellTop).toBeGreaterThanOrEqual(-1);
    expect(geometry.shellBottom).toBeLessThanOrEqual(height + 1);
    expect(geometry.navBottom).toBeLessThanOrEqual(height + 1);
    expect(geometry.overflow).toBe(false);
    if (height === 350) expect(geometry.mainScrolls).toBe(true);
  }
  await control(page, "独立开始旅行");
  await expect(page.locator(".e3-home-scene.is-ready")).toBeVisible();
  await expect(page.locator(".e3-home-cat")).toHaveCount(0);
  await control(page, "结束旅行回家");
  await expect(page.locator(".e3-home-scene.is-ready .e3-home-cat")).toBeVisible();
});

test("E3 narrow phone and desktop keep the adoption and home layouts within the viewport", async ({ browser }) => {
  for (const width of [320, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage();
    await page.goto(base);
    await expect(page.getByRole("radio")).toHaveCount(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${shots}/adoption-${width}.png`, fullPage: true });
    await adopt(page, "选择三花猫", "合成三花");
    await expect(page.locator(".e3-home-scene.is-ready")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${shots}/home-${width}.png`, fullPage: true });
    await context.close();
  }
});

test("E3 adoption cards grow without text overlap at 200% text size", async ({ browser }) => {
  for (const width of [320, 390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${base}?product=1`);
    await expect(page.getByRole("radio")).toHaveCount(4);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll<HTMLElement>("body *")) {
        const style = getComputedStyle(element);
        element.style.fontSize = `${parseFloat(style.fontSize) * 2}px`;
        if (style.lineHeight !== "normal") element.style.lineHeight = `${parseFloat(style.lineHeight) * 2}px`;
      }
    });
    await page.locator(".e3-adoption-card").first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/adoption-text200-${width}.png` });
    const geometry = await page.locator(".e3-adoption-card").evaluateAll((cards) => cards.map((card) => {
      const bounds = card.getBoundingClientRect();
      const name = card.querySelector("strong")!.getBoundingClientRect();
      const choice = card.querySelector(".e3-choice-control")!.getBoundingClientRect();
      const lines = card.querySelector(".e3-choice-line")!.getBoundingClientRect();
      const image = card.querySelector("img")!.getBoundingClientRect();
      return {
        imageClear: image.bottom <= Math.min(name.top, choice.top) + 1,
        labelsSeparate: name.right <= choice.left + 1 || name.bottom <= choice.top + 1,
        descriptionClear: Math.max(name.bottom, choice.bottom) <= lines.top + 1,
        textContained: lines.bottom <= bounds.bottom - 1,
        horizontalContained: bounds.left >= -1 && bounds.right <= innerWidth + 1,
      };
    }));
    for (const card of geometry) expect(card).toEqual({
      imageClear: true,
      labelsSeparate: true,
      descriptionClear: true,
      textContained: true,
      horizontalContained: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await context.close();
  }
});

test("E3 skip and cancel management preserve reply and correction drafts", async ({ page }) => {
  await page.goto(base);
  await adopt(page, "选择橘白猫", "草稿合成猫");
  await control(page, "投递下一需求卡");
  await page.getByRole("button", { name: "看看来信", exact: true }).click();
  await expect(page.getByLabel("你想跟它说什么？")).toHaveCount(0);
  await page.getByRole("button", { name: "给它回信", exact: true }).click();
  await page.getByLabel("你想跟它说什么？").fill("先写一点，晚点再回");
  await expect(page.getByText("草稿已保存在本机，尚未发送。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "这次先不回" }).click();
  expect(Object.values((await row(page)).drafts).map((d: any) => d.text)).toEqual(["先写一点，晚点再回"]);
  await page.getByRole("button", { name: "来信盒", exact: true }).click();
  await page.getByRole("button", { name: /阿橘/ }).click();
  await expect(page.getByLabel("你想跟它说什么？")).toHaveValue("先写一点，晚点再回");
  await page.getByRole("button", { name: "送出去", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("送出去啦。");
  await page.getByRole("button", { name: /回到.*身边/ }).click();
  await page.getByRole("button", { name: "来信盒", exact: true }).click();
  await page.getByRole("button", { name: /阿橘/ }).click();
  await page.getByRole("button", { name: "管理这条回应" }).click();
  await page.getByLabel("更正后的回应").fill("想改一改，先保存草稿");
  await expect(page.getByText("更正草稿已保存在本机，尚未提交。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消管理" }).click();
  expect(Object.values((await row(page)).drafts).map((d: any) => d.text)).toEqual(["想改一改，先保存草稿"]);
  await page.getByRole("button", { name: "管理这条回应" }).click();
  await expect(page.getByLabel("更正后的回应")).toHaveValue("想改一改，先保存草稿");
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () { throw new DOMException("synthetic", "QuotaExceededError"); };
  });
  await page.getByLabel("更正后的回应").fill("保存失败时不能丢的文字");
  await page.getByRole("button", { name: "取消管理" }).click();
  await expect(page.getByRole("alert")).toContainText("更正草稿尚未保存");
  await expect(page.getByLabel("更正后的回应")).toHaveValue("保存失败时不能丢的文字");
});
