import { test, expect, type Page } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";
import {
  base,
  snapshot,
  name,
  demand,
  openControl,
  act,
  enter,
  mark,
  storeCall,
} from "./helpers";
const full =
  "升级合成来源：累时允许休息，陪伴能表达关心，心意本身就是礼物。新伙伴面前可以先看看慢慢来。";
async function history(p: Page, title: string) {
  await p.getByRole("button", { name: "来信盒", exact: true }).click();
  await p.getByRole("button", { name: new RegExp(title) }).click();
}
async function seedV2(p: Page) {
  await p.goto(base + "?__baseline=1");
  const a = await name(p, "旧二版合成甲");
  await demand(p, full);
  await history(p, "阿橘");
  await p.getByRole("button", { name: "管理这条回应" }).click();
  await p.getByLabel("更正后的回应").fill(full + " 已更正一次。");
  await p.getByRole("button", { name: "保存更正" }).click();
  await expect(p.getByText("已更正。", { exact: true })).toBeVisible();
  await p.getByRole("button", { name: "← 来信盒" }).click();
  await demand(p, "待删除的独有合成原文");
  await history(p, "小黑虫子");
  await p.getByRole("button", { name: "管理这条回应" }).click();
  await p.getByRole("button", { name: "删除这条回应", exact: true }).click();
  await p.getByRole("button", { name: "确认删除回应" }).click();
  await expect(p.getByText("已删除。", { exact: true })).toBeVisible();
  await openControl(p);
  await act(p, "投递下一需求卡");
  await act(p, "独立开始旅行");
  await p.getByLabel("本次旅行故事").selectOption("O-LIGHTHOUSE-01");
  await act(p, "寄出旅行明信片");
  await act(p, "结束旅行回家");
  await act(p, "独立开始旅行");
  await p.getByLabel("核验的故事").selectOption("L-FIREFLY");
  let row = (await snapshot(p)).rows.find((r) => r.participant.id === a),
    rid = row.letters.find((l: any) => l.response).responseId;
  await mark(p, "companionship", rid);
  await mark(p, "care_value", rid);
  await act(p, "核验并选择旅行信");
  await enter(p);
  await history(p, "阿橘");
  await p.getByRole("button", { name: "管理这条回应" }).click();
  await p.getByLabel("更正后的回应").fill(full + " 再次更正使未寄来源失效。");
  await p.getByRole("button", { name: "保存更正" }).click();
  await expect(p.getByText("已更正。", { exact: true })).toBeVisible();
  await openControl(p);
  await p.getByRole("button", { name: "建立全新体验" }).click();
  const b = await name(p, "旧二版合成乙");
  await demand(p, "旧乙合成：累了允许歇一会儿。");
  await openControl(p);
  await act(p, "投递下一需求卡");
  await enter(p);
  await p.getByRole("button", { name: "看看来信", exact: true }).click();
  await p.getByRole("button", { name: "← 来信盒" }).click();
  await openControl(p);
  await act(p, "独立开始旅行");
  row = (await snapshot(p)).rows.find((r) => r.participant.id === b);
  rid = row.letters.find((l: any) => l.response).responseId;
  await mark(p, "rest", rid);
  await act(p, "核验并选择旅行信");
  return { a, b, before: await snapshot(p) };
}

test("Real v2 records retain every old field, invalidated destination and old trip IDs; stale v2 cannot write v3", async ({
  browser,
}) => {
  const ctx = await browser.newContext(),
    old = await ctx.newPage();
  const { a, b, before } = await seedV2(old);
  expect(before.version).toBe(2);
  expect(
    before.rows
      .find((r) => r.participant.id === a)
      .letters.filter((l: any) => !l.read_at),
  ).toHaveLength(2);
  const current = await ctx.newPage();
  await current.goto(base + "#" + a);
  await expect(
    current.getByRole("button", { name: "打开看看", exact: true }),
  ).toBeVisible();
  const after = await snapshot(current);
  expect(after.version).toBe(3);
  for (const was of before.rows) {
    const now = after.rows.find((r) => r.participant.id === was.participant.id);
    const { schema, calendar, drafts, ...rest } = now,
      { schema: priorSchema, ...prior } = was;
    expect(rest).toEqual(prior);
    expect(drafts).toEqual({});
    const remaining = calendar.nodes.filter((n: any) => n.origin === "LEGACY");
    expect(remaining.map((n: any) => n.at - calendar.initializedAt)).toEqual([
      86400000, 172800000,
    ]);
    expect(remaining.every((n: any) => n.tripId === was.trip.id)).toBeTruthy();
    if (was.participant.id === a) expect(remaining[0].scene).toBe("FIREFLY");
    expect(calendar.baseAt).toBe(calendar.initializedAt + 172800000);
  }
  await old
    .getByRole("button", { name: "寄出旅行明信片", exact: true })
    .click();
  await expect(old.locator("p[role=alert]")).toBeVisible();
  expect(await snapshot(current)).toEqual(after);
  await current.reload();
  expect(await snapshot(current)).toEqual(after);
  await openControl(current);
  await act(current, "演示快进到日历末尾");
  const final = (await snapshot(current)).rows.find(
    (r) => r.participant.id === a,
  );
  expect(final.letters).toEqual(
    after.rows.find((r) => r.participant.id === a).letters,
  );
  expect(final.trip).toBeNull();
  expect(
    final.calendar.nodes
      .filter((n: any) => n.kind === "DEMAND" || n.kind === "POSTCARD")
      .every((n: any) => n.result.outcome === "SKIPPED"),
  ).toBeTruthy();
  expect(
    (await snapshot(current)).rows.find((r) => r.participant.id === b),
  ).toEqual(after.rows.find((r) => r.participant.id === b));
  await mkdir("/tmp/catletters-e2b-evidence", { recursive: true });
  await writeFile(
    "/tmp/catletters-e2b-evidence/real-v2-upgrade.json",
    JSON.stringify({ before, after, final }, null, 2),
  );
  await current.screenshot({
    path: "/tmp/catletters-e2b-evidence/upgraded-calendar-desktop.png",
    fullPage: true,
  });
  await ctx.close();
});

test("v2 migration update failure leaves all rows and version intact; retry preserves deleted text tombstones", async ({
  page,
}) => {
  const { before } = await seedV2(page);
  await page.evaluate(() => sessionStorage.setItem("abort-v3", "1"));
  await page.addInitScript(() => {
    if (sessionStorage.getItem("abort-v3") === "1") {
      sessionStorage.setItem("abort-v3", "0");
      const original = IDBCursor.prototype.update;
      const probe = { attempts: 0, successes: 0, failedAfterSuccess: false };
      (window as any).__migrationProbe = probe;
      IDBCursor.prototype.update = function (value) {
        probe.attempts++;
        if (probe.attempts === 2) {
          probe.failedAfterSuccess = probe.successes === 1;
          throw new DOMException(
            "synthetic second update failure",
            "QuotaExceededError",
          );
        }
        const request = original.call(this, value);
        request.addEventListener("success", () => {
          probe.successes++;
        });
        return request;
      };
    }
  });
  await page.goto("about:blank");
  await page.goto(base);
  await expect(
    page.getByRole("heading", { name: "暂时无法读取本机数据" }),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as any).__migrationProbe)).toEqual({
    attempts: 2,
    successes: 1,
    failedAfterSuccess: true,
  });
  expect(await snapshot(page)).toEqual(before);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "继续已有体验" }),
  ).toBeVisible();
  const after = await snapshot(page);
  expect(after.version).toBe(3);
  expect(JSON.stringify(after)).not.toContain("待删除的独有合成原文");
  for (const old of before.rows)
    expect(
      after.rows.find((r) => r.participant.id === old.participant.id).responses,
    ).toEqual(old.responses);
});
