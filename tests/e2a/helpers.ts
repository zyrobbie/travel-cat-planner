import { expect, type Page } from "@playwright/test";
export const base = "http://127.0.0.1:4180/travel-cat-planner/app/";
export async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("cat-letters-pages-v1");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const version = db.version;
    const rows = await new Promise<any[]>((resolve, reject) => {
      const tx = db.transaction("participants"),
        r = tx.objectStore("participants").getAll();
      tx.oncomplete = () => resolve(r.result);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    return { version, rows };
  });
}
export async function name(page: Page, value: string) {
  await page.getByLabel("给它起个名字吧").fill(value);
  await page.getByRole("button", { name: "开始一起生活", exact: true }).click();
  await expect(
    page.getByText("今天没有新来信。", { exact: true }),
  ).toBeVisible();
  return new URL(page.url()).hash.slice(1);
}
export async function openControl(page: Page) {
  await page.getByRole("button", { name: "演示推进", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "本机演示控制台" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "刷新演示状态" }),
  ).toBeEnabled();
}
export async function enter(page: Page) {
  await page.getByRole("button", { name: "进入此体验", exact: true }).click();
}
export async function act(page: Page, label: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await expect(
    page.getByRole("button", { name: "刷新演示状态" }),
  ).toBeEnabled();
}
export async function demand(page: Page, text: string) {
  await openControl(page);
  await act(page, "投递下一需求卡");
  await enter(page);
  await page.getByRole("button", { name: "看看来信", exact: true }).click();
  await page.getByLabel("你想跟它说什么？").fill(text);
  await page.getByRole("button", { name: "送出去", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("送出去啦。");
  await page.getByRole("button", { name: /回到.*身边/ }).click();
}
export async function mark(
  page: Page,
  claim: string,
  responseId: string,
  assessment = "SUPPORTED",
) {
  await page.locator(`#source-${claim}`).selectOption(responseId);
  await page.locator(`#assessment-${claim}`).selectOption(assessment);
  if (assessment === "SUPPORTED")
    await page
      .locator("fieldset")
      .filter({ has: page.locator(`#source-${claim}`) })
      .getByRole("checkbox")
      .check();
}
export async function openDemandHistory(page: Page, title = "阿橘") {
  await page.getByRole("button", { name: "来信盒", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await expect(
    page.getByRole("button", { name: "管理这条回应", exact: true }),
  ).toBeVisible();
}
export async function seedOld(page: Page) {
  await page.goto(base + "?__baseline=1");
  const a = await name(page, "旧版合成甲");
  await demand(page, "旧版合成休息原文：累了就歇一会儿。");
  await openControl(page);
  await act(page, "投递下一需求卡");
  await enter(page);
  await page.getByRole("button", { name: "看看来信", exact: true }).click();
  await page.getByRole("button", { name: "这次先不回" }).click();
  await openControl(page);
  await act(page, "独立开始旅行");
  await act(page, "寄出旅行明信片");
  await enter(page);
  await page.getByRole("button", { name: "打开看看", exact: true }).click();
  await expect(page.getByRole("button", { name: "收好这封信" })).toBeVisible();
  await page.getByRole("button", { name: "收好这封信" }).click();
  await openControl(page);
  await act(page, "结束旅行回家");
  await act(page, "独立开始旅行");
  await page.getByRole("button", { name: "建立全新体验" }).click();
  const b = await name(page, "旧版合成乙");
  await demand(
    page,
    "旧版合成陪伴原文：陪在旁边也能表达关心，心意本身就是礼物。",
  );
  await openControl(page);
  await act(page, "独立开始旅行");
  await page.getByLabel("本次旅行故事").selectOption("O-FIREFLY-01");
  await act(page, "寄出旅行明信片");
  await enter(page);
  await expect(
    page.getByRole("button", { name: "打开看看", exact: true }),
  ).toBeVisible();
  return { a, b, before: await snapshot(page) };
}
