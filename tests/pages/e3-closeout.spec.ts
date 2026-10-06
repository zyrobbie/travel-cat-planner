import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = `http://127.0.0.1:${process.env.PAGES_TEST_PORT ?? 4173}/travel-cat-planner/app/`;
const shots = "/tmp/e3-closeout-qa";
mkdirSync(shots, { recursive: true });

async function row(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("cat-letters-pages-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise<any>((resolve, reject) => {
      const request = db.transaction("participants", "readonly").objectStore("participants").get(location.hash.slice(1));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value;
  });
}

async function adopt(page: Page) {
  await page.getByRole("radio", { name: "选择橘白猫" }).check();
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.getByLabel("给它起个名字吧").fill("收尾合成猫");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.getByRole("button", { name: "确认领养", exact: true }).click();
  await expect(page.getByText("今天没有新来信。", { exact: true })).toBeVisible();
  return new URL(page.url()).hash.slice(1);
}

test("R01 welcome letter balances its first paragraph without changing frozen copy", async ({ browser }) => {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.install({ time: Date.UTC(2026, 9, 6, 12) });
    await page.goto(`${base}?review=1`);
    const id = await adopt(page);
    const welcome = (await row(page)).calendar.nodes.find((node: any) => node.id === "welcome:d0");
    await page.clock.setFixedTime(welcome.at);
    await page.goto(`${base}?product=1#${id}`);
    await page.getByRole("button", { name: "看看来信", exact: true }).click();
    await expect(page.locator(".e3-welcome-letter .e3-story")).toContainText("窗边的小光点，刚才还在我的爪子旁边。");
    const lengths = await page.locator(".e3-welcome-letter .e3-story").evaluate((element) => {
      const text = element.firstChild as Text;
      const paragraph = text.textContent!.split("\n")[0];
      const byTop = new Map<number, number>();
      for (let i = 0; i < paragraph.length; i++) {
        const range = document.createRange();
        range.setStart(text, i);
        range.setEnd(text, i + 1);
        const top = Math.round(range.getBoundingClientRect().top);
        byTop.set(top, (byTop.get(top) ?? 0) + 1);
      }
      return [...byTop.values()];
    });
    expect(lengths.at(-1)).toBeGreaterThanOrEqual(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator(".e3-welcome-letter").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/d07-${width}.png` });
    expect(errors).toEqual([]);
    await context.close();
  }
});

test("R02 200% cat descriptions avoid isolated final characters", async ({ browser }) => {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
    const page = await context.newPage();
    await page.goto(`${base}?product=1`);
    await expect(page.getByRole("radio")).toHaveCount(4);
    const factors = await page.evaluate(() => {
      const elements = [...document.querySelectorAll<HTMLElement>("body *")];
      const baseline = elements.map((element) => {
        const style = getComputedStyle(element);
        return { element, fontSize: parseFloat(style.fontSize), lineHeight: style.lineHeight === "normal" ? null : parseFloat(style.lineHeight) };
      });
      const descriptions = [...document.querySelectorAll<HTMLElement>(".e3-choice-line span")];
      const before = descriptions.map((element) => parseFloat(getComputedStyle(element).fontSize));
      for (const { element, fontSize, lineHeight } of baseline) {
        element.style.fontSize = `${fontSize * 2}px`;
        if (lineHeight != null) element.style.lineHeight = `${lineHeight * 2}px`;
      }
      return descriptions.map((element, index) => parseFloat(getComputedStyle(element).fontSize) / before[index]);
    });
    for (const factor of factors) expect(factor).toBeCloseTo(2, 3);
    writeFileSync(`${shots}/text200-factors-${width}.json`, JSON.stringify({ width, factors }, null, 2));
    const rows = await page.locator(".e3-choice-line span").evaluateAll((spans) => spans.map((span) => {
      const text = span.firstChild as Text;
      const byTop = new Map<number, number>();
      for (let i = 0; i < text.length; i++) {
        const range = document.createRange();
        range.setStart(text, i);
        range.setEnd(text, i + 1);
        const top = Math.round(range.getBoundingClientRect().top);
        byTop.set(top, (byTop.get(top) ?? 0) + 1);
      }
      return [...byTop.values()];
    }));
    for (const lengths of rows) expect(lengths.at(-1)).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator(".e3-adoption-card").last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/adoption-text200-${width}.png` });
    await context.close();
  }
});

test("R03 source history leads to read-only management, edit, return, and tombstone", async ({ browser }) => {
  test.setTimeout(90000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install({ time: Date.UTC(2026, 9, 6, 12) });
  await page.goto(`${base}?review=1`);
  await adopt(page);
  const control = async () => {
    await page.getByRole("button", { name: "演示推进", exact: true }).click();
    await expect(page.getByRole("heading", { name: "本机演示控制台" })).toBeVisible();
  };
  const act = async (name: string) => {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("button", { name: "刷新演示状态" })).toBeEnabled();
  };
  await control();
  await act("投递下一需求卡");
  await page.getByRole("button", { name: "进入此体验", exact: true }).click();
  await page.getByRole("button", { name: "看看来信", exact: true }).click();
  const originalTitle = await page.locator(".e3-demand-title").textContent();
  await page.getByRole("button", { name: "给它回信", exact: true }).click();
  const original = "完整合成来源：累了可以歇一会儿。";
  await page.getByLabel("你想跟它说什么？").fill(original);
  await page.getByRole("button", { name: "送出去", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("送出去啦。");
  await page.getByRole("button", { name: /回到.*身边/ }).click();
  const demandRow = await row(page);
  const source = demandRow.letters.find((letter: any) => letter.response === original);
  expect(source?.responseId).toBeTruthy();
  await control();
  await act("独立开始旅行");
  await page.getByLabel("核验的故事").selectOption("L-RHINE");
  await page.locator("#source-rest").selectOption(source.responseId);
  await page.locator("#assessment-rest").selectOption("SUPPORTED");
  await page.locator("fieldset").filter({ has: page.locator("#source-rest") }).getByRole("checkbox").check();
  await act("核验并选择旅行信");
  await act("寄出已选旅行信");
  await page.getByRole("button", { name: "进入此体验", exact: true }).click();
  await page.getByRole("button", { name: "打开看看", exact: true }).click();
  await page.getByRole("button", { name: "收好这封信" }).click();
  await page.getByRole("button", { name: "来信盒", exact: true }).click();
  await page.getByRole("button", { name: /我走了另一条路/ }).click();
  await page.getByText("看看以前说过的话", { exact: true }).click();
  const history = page.locator(".e3-source-note");
  await expect(history).toContainText(originalTitle!);
  await expect(history).toContainText("来源版本 1");
  await expect(history).toContainText("版本时间：");
  await expect(history).toContainText(original);
  await page.screenshot({ path: `${shots}/source-390.png` });
  await history.getByRole("button", { name: "管理这条回应" }).click();
  await expect(page.getByRole("button", { name: "← 返回旅行信" })).toBeVisible();
  await expect(page.locator(".e3-response-manager")).toContainText("版本 1");
  await expect(page.getByLabel("更正后的回应")).toHaveCount(0);
  await page.screenshot({ path: `${shots}/manager-readonly-390.png` });
  await page.getByRole("button", { name: "← 返回旅行信" }).click();
  await expect(history).toBeVisible();
  await history.getByRole("button", { name: "管理这条回应" }).click();
  await page.getByRole("button", { name: "更正这条回应" }).click();
  const changed = "完整合成来源：在山路上累了也可以休息。";
  await page.getByLabel("更正后的回应").fill(changed);
  await expect(page.locator("#edit-response-count")).toContainText(`${changed.length} / 2000`);
  await expect(page.getByText("更正草稿已保存在本机，尚未提交。")).toBeVisible();
  await page.screenshot({ path: `${shots}/manager-edit-390.png` });
  await page.getByRole("button", { name: "← 返回旅行信" }).click();
  await expect(history).toBeVisible();
  await history.getByRole("button", { name: "管理这条回应" }).click();
  await expect(page.getByLabel("更正后的回应")).toHaveCount(0);
  await expect(page.getByText("有未提交的更正草稿，点“更正这条回应”可继续。")).toBeVisible();
  await page.getByRole("button", { name: "更正这条回应" }).click();
  await expect(page.getByLabel("更正后的回应")).toHaveValue(changed);
  await page.getByRole("button", { name: "取消更正" }).click();
  await expect(page.getByLabel("更正后的回应")).toHaveCount(0);
  await page.getByRole("button", { name: "更正这条回应" }).click();
  await expect(page.getByLabel("更正后的回应")).toHaveValue(changed);
  await page.getByRole("button", { name: "保存更正" }).click();
  await expect(page.getByText("已更正。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "← 返回旅行信" }).click();
  await expect(page.getByText("看看以前说过的话", { exact: true })).toBeVisible();
  await expect(history).toContainText("这条回应已更正。以下是寄出时使用的旧版本。");
  await expect(history).toContainText(original);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${shots}/source-1280.png` });
  await page.getByRole("button", { name: "← 来信盒" }).click();
  await page.getByRole("button", { name: "管理我的回应" }).click();
  await page.locator(".e3-inbox-page").getByRole("button", { name: new RegExp(originalTitle!) }).click();
  await expect(page.getByRole("button", { name: "← 返回回应列表" })).toBeVisible();
  await expect(page.getByLabel("更正后的回应")).toHaveCount(0);
  await page.getByRole("button", { name: "← 返回回应列表" }).click();
  await expect(page.getByRole("heading", { name: "管理我的回应" })).toBeVisible();
  await page.getByRole("button", { name: "← 返回来信盒" }).click();
  await page.getByRole("button", { name: /我走了另一条路/ }).click();
  await page.getByText("看看以前说过的话", { exact: true }).click();
  await history.getByRole("button", { name: "管理这条回应" }).click();
  await page.getByRole("button", { name: "删除这条回应" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(originalTitle!);
  await expect(dialog).toContainText("版本 2");
  await expect(dialog).toContainText("删除无法撤销");
  await expect(dialog.getByRole("button", { name: "取消删除" })).toBeFocused();
  await page.screenshot({ path: `${shots}/manager-delete-1280.png` });
  await page.getByRole("button", { name: "← 返回旅行信" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "删除这条回应" }).click();
  await dialog.getByRole("button", { name: "取消删除" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "删除这条回应" }).click();
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () { throw new DOMException("synthetic", "QuotaExceededError"); };
  });
  await dialog.getByRole("button", { name: "确认删除回应" }).click();
  await expect(page.getByRole("alert")).toContainText("尚未");
  await page.getByRole("button", { name: "← 返回旅行信" }).click();
  await page.getByRole("button", { name: "← 返回旅行信" }).click();
  await expect(history).toContainText(original);
  await page.reload();
  await page.getByRole("button", { name: "来信盒", exact: true }).click();
  await page.getByRole("button", { name: /我走了另一条路/ }).click();
  await page.getByText("看看以前说过的话", { exact: true }).click();
  await history.getByRole("button", { name: "管理这条回应" }).click();
  await page.getByRole("button", { name: "删除这条回应" }).click();
  await dialog.getByRole("button", { name: "确认删除回应" }).click();
  await expect(page.getByText("已删除。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "← 返回旅行信" }).click();
  await expect(history).toContainText("这条回应已删除。");
  await expect(history).toContainText("版本时间：");
  await expect(history).not.toContainText(original);
  await page.screenshot({ path: `${shots}/source-deleted-1280.png` });
  expect(errors).toEqual([]);
  await context.close();
});
