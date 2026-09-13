import { test, expect } from "@playwright/test";
import {
  base,
  snapshot,
  name,
  demand,
  openControl,
  enter,
  act,
  mark,
  openDemandHistory,
} from "./helpers";
const full =
  "合成完整来源：累了可以歇一会儿。陪在身边就是关心，心意本身就是礼物。遇到新伙伴可以先看看，慢慢来。";
async function selected(
  page: any,
  story: string,
  refs: Record<string, string>,
) {
  await page.getByLabel("核验的故事").selectOption(story);
  for (const [claim, id] of Object.entries(refs)) await mark(page, claim, id);
  await act(page, "核验并选择旅行信");
}

test("Three complete linked stories, missing/negative/conditional claims fallback, first read vs history", async ({
  browser,
}) => {
  const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
    }),
    page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  const id = await name(page, "联动合成猫");
  await demand(page, full);
  await demand(
    page,
    "合成限制：只有回家才可以休息，不要在山上停。小鱼干可以慢慢吃。",
  );
  let row = (await snapshot(page)).rows[0],
    r = row.letters.find((l: any) => l.response === full).responseId,
    negative = row.letters.find(
      (l: any) => l.response && l.response !== full,
    ).responseId;
  await openControl(page);
  await act(page, "独立开始旅行");
  await mark(page, "rest", negative, "CONDITION_MISMATCH");
  await act(page, "核验并选择旅行信");
  expect((await snapshot(page)).rows[0].reviews.at(-1).kind).toBe("ORDINARY");
  await mark(page, "rest", negative, "NEGATED");
  await act(page, "核验并选择旅行信");
  expect((await snapshot(page)).rows[0].reviews.at(-1).kind).toBe("ORDINARY");
  for (const [story, claims, title] of [
    ["L-RHINE", ["rest"], "我走了另一条路"],
    ["L-FIREFLY", ["companionship", "care_value"], "抱抱也是礼物"],
    ["L-LIGHTHOUSE", ["new_friends"], "灯塔亮起来的时候"],
  ] as const) {
    if (story !== "L-RHINE") {
      await page
        .getByLabel("普通故事／出发场景")
        .selectOption(story.replace("L-", "O-") + "-01");
      await act(page, "独立开始旅行");
    }
    if (story === "L-FIREFLY") {
      await selected(page, story, { companionship: r });
      expect((await snapshot(page)).rows[0].reviews.at(-1).kind).toBe(
        "ORDINARY",
      );
    }
    if (story === "L-LIGHTHOUSE") {
      await page.getByLabel("核验的故事").selectOption(story);
      await mark(page, "new_friends", negative, "CONDITION_MISMATCH");
      await act(page, "核验并选择旅行信");
      expect((await snapshot(page)).rows[0].reviews.at(-1).kind).toBe(
        "ORDINARY",
      );
    }
    await selected(page, story, Object.fromEntries(claims.map((c) => [c, r])));
    expect((await snapshot(page)).rows[0].reviews.at(-1).kind).toBe("LINKED");
    await act(page, "寄出已选旅行信");
    await enter(page);
    if (story === "L-LIGHTHOUSE") {
      await page.getByRole("button", { name: "来信盒", exact: true }).click();
      await page.getByRole("button", { name: new RegExp(title) }).click();
    } else
      await page.getByRole("button", { name: "打开看看", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect(page.getByText("看看以前的来信", { exact: true })).toHaveCount(
      0,
    );
    if (story === "L-FIREFLY")
      await page.screenshot({
        path: "/tmp/catletters-e2a-evidence/linked-first-mobile.png",
        fullPage: true,
      });
    await page.getByRole("button", { name: "收好这封信" }).click();
    await page.getByRole("button", { name: "来信盒", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(title) }).click();
    await page.getByText("看看以前的来信", { exact: true }).click();
    await expect(page.getByText(full, { exact: true }).first()).toBeVisible();
    if (story === "L-FIREFLY") {
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBeTruthy();
      await page.screenshot({
        path: "/tmp/catletters-e2a-evidence/linked-sources-mobile.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({
        path: "/tmp/catletters-e2a-evidence/linked-sources-desktop.png",
        fullPage: true,
      });
    }
    await openControl(page);
    await act(page, "结束旅行回家");
  }
  row = (await snapshot(page)).rows.find((x: any) => x.participant.id === id);
  expect(row.letters.filter((l: any) => l.type === "POSTCARD")).toHaveLength(3);
  expect(row.trip).toBeNull();
  expect(errors).toEqual([]);
  await ctx.close();
});

test("Edit invalidates selected story; stale send/version conflicts reject; delivered snapshot survives edit/delete without text copies", async ({
  browser,
}) => {
  const ctx = await browser.newContext(),
    control = await ctx.newPage();
  await control.goto(base);
  const id = await name(control, "删改合成猫");
  const original = "独有合成原文一：累了就歇一会儿。";
  await demand(control, original);
  let row = (await snapshot(control)).rows[0],
    rid = row.letters[0].responseId;
  await openControl(control);
  await act(control, "独立开始旅行");
  await selected(control, "L-RHINE", { rest: rid });
  const stale = await ctx.newPage();
  await stale.addInitScript(() => {
    Object.defineProperty(window, "BroadcastChannel", { value: undefined });
  });
  await stale.goto(base + "#" + id);
  await openControl(stale);
  const editor = await ctx.newPage();
  await editor.goto(base + "#" + id);
  await openDemandHistory(editor);
  await editor.getByRole("button", { name: "管理这条回应" }).click();
  const conflict = await ctx.newPage();
  await conflict.goto(base + "#" + id);
  await openDemandHistory(conflict);
  await conflict.getByRole("button", { name: "管理这条回应" }).click();
  const changed = "独有合成原文二：在山路上累了可以休息。";
  await editor.getByLabel("更正后的回应").fill(changed);
  await editor.getByRole("button", { name: "保存更正" }).click();
  await expect(editor.getByText("已更正。", { exact: true })).toBeVisible();
  row = (await snapshot(editor)).rows[0];
  expect(row.reviews.at(-1).status).toBe("NEEDS_REVIEW");
  expect(row.letters.filter((l: any) => l.type === "POSTCARD")).toHaveLength(0);
  await stale.getByRole("button", { name: "寄出已选旅行信" }).click();
  await expect(stale.locator("p[role=alert]")).toContainText("失效");
  await conflict.getByLabel("更正后的回应").fill("不应覆盖的旧版本合成内容");
  await conflict.getByRole("button", { name: "保存更正" }).click();
  await expect(conflict.locator("p[role=alert]")).toContainText("版本已变化");
  expect((await snapshot(editor)).rows[0].responses[rid].currentRevision).toBe(
    2,
  );
  await control.getByRole("button", { name: "刷新演示状态" }).click();
  await selected(control, "L-RHINE", { rest: rid });
  await act(control, "寄出已选旅行信");
  const body = (await snapshot(control)).rows[0].letters.find(
    (l: any) => l.type === "POSTCARD",
  ).snapshot.body;
  await editor.getByRole("button", { name: "管理这条回应" }).click();
  await editor
    .getByLabel("更正后的回应")
    .fill("独有合成原文三：现在的更正不应改写旧故事。");
  await editor.getByRole("button", { name: "保存更正" }).click();
  await expect(editor.getByText("已更正。", { exact: true })).toBeVisible();
  await enter(control);
  await control.getByRole("button", { name: "打开看看", exact: true }).click();
  await expect(
    control.getByRole("heading", { name: "我走了另一条路" }),
  ).toBeVisible();
  await control.getByRole("button", { name: "收好这封信" }).click();
  await control.getByRole("button", { name: "来信盒", exact: true }).click();
  await control.getByRole("button", { name: /我走了另一条路/ }).click();
  await control.getByText("看看以前的来信", { exact: true }).click();
  await expect(
    control.getByText("这条回应已更正。以下是寄出时使用的旧版本。"),
  ).toBeVisible();
  await expect(control.getByText(changed, { exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "管理这条回应" }).click();
  await editor
    .getByRole("button", { name: "删除这条回应", exact: true })
    .click();
  await editor.getByRole("button", { name: "确认删除回应" }).click();
  await expect(editor.getByText("已删除。", { exact: true })).toBeVisible();
  await expect(
    control.getByText("这条回应已删除。", { exact: true }),
  ).toBeVisible();
  row = (await snapshot(control)).rows[0];
  expect(
    row.responses[rid].revisions.every((v: any) => v.text === null),
  ).toBeTruthy();
  expect(JSON.stringify(row)).not.toContain("独有合成原文");
  expect(
    row.letters.find((l: any) => l.type === "POSTCARD").snapshot.body,
  ).toBe(body);
  await control.screenshot({
    path: "/tmp/catletters-e2a-evidence/deleted-source.png",
    fullPage: true,
  });
  await openControl(control);
  await act(control, "结束旅行回家");
  await act(control, "独立开始旅行");
  await act(control, "寄出普通旅行信");
  expect(
    (await snapshot(control)).rows[0].letters.filter(
      (l: any) => l.type === "POSTCARD",
    ),
  ).toHaveLength(2);
  await ctx.close();
});

test("Deleting another local participant does not erase unrelated draft; failed edit does not save", async ({
  browser,
}) => {
  const ctx = await browser.newContext(),
    a = await ctx.newPage();
  await a.goto(base);
  const idA = await name(a, "草稿合成甲");
  await demand(a, "甲的合成回应");
  await openControl(a);
  await act(a, "投递下一需求卡");
  await enter(a);
  await a.getByRole("button", { name: "看看来信", exact: true }).click();
  await a.getByLabel("你想跟它说什么？").fill("甲未发送的草稿必须保留");
  const b = await ctx.newPage();
  await b.goto(base);
  const idB = await name(b, "删除合成乙");
  await demand(b, "乙独有的合成回应");
  await openDemandHistory(b);
  await b.getByRole("button", { name: "管理这条回应" }).click();
  await b.getByLabel("更正后的回应").fill("[SYNTHETIC:UNAVAILABLE]");
  await b.getByRole("button", { name: "保存更正" }).click();
  await expect(b.locator("p[role=alert]")).toContainText("尚未完成更正");
  expect(
    (await snapshot(b)).rows
      .find((r: any) => r.participant.id === idB)
      .letters.find((l: any) => l.response).response,
  ).toBe("乙独有的合成回应");
  await b.getByLabel("更正后的回应").fill("写失败不应留下");
  await expect(b.getByText("更正草稿已保存在本机，尚未提交。")).toBeVisible();
  const before = await snapshot(b);
  await b.evaluate(() => {
    IDBObjectStore.prototype.put = function () {
      throw new DOMException("synthetic", "QuotaExceededError");
    };
  });
  await b.getByRole("button", { name: "保存更正" }).click();
  await expect(b.locator("p[role=alert]")).toContainText("尚未保存");
  expect(await snapshot(b)).toEqual(before);
  await b.reload();
  await openDemandHistory(b);
  await b.getByRole("button", { name: "管理这条回应" }).click();
  await b.getByRole("button", { name: "删除这条回应", exact: true }).click();
  await b.getByRole("button", { name: "确认删除回应" }).click();
  await expect(b.getByText("已删除。", { exact: true })).toBeVisible();
  await expect(a.getByLabel("你想跟它说什么？")).toHaveValue(
    "甲未发送的草稿必须保留",
  );
  expect(idA).not.toBe(idB);
  await ctx.close();
});

test("Delete before send invalidates; stale edit cannot resurrect; a new response has a new identity", async ({
  browser,
}) => {
  const ctx = await browser.newContext(),
    p = await ctx.newPage();
  await p.goto(base);
  const id = await name(p, "失效合成猫");
  await demand(p, full);
  let row = (await snapshot(p)).rows[0],
    rid = row.letters[0].responseId;
  await openControl(p);
  await act(p, "独立开始旅行");
  await selected(p, "L-RHINE", { rest: rid });
  const stale = await ctx.newPage();
  await stale.addInitScript(() =>
    Object.defineProperty(window, "BroadcastChannel", { value: undefined }),
  );
  await stale.goto(base + "#" + id);
  await openDemandHistory(stale);
  await stale.getByRole("button", { name: "管理这条回应" }).click();
  const control = await ctx.newPage();
  await control.addInitScript(() =>
    Object.defineProperty(window, "BroadcastChannel", { value: undefined }),
  );
  await control.goto(base + "#" + id);
  await openControl(control);
  await enter(p);
  await openDemandHistory(p);
  await p.getByRole("button", { name: "管理这条回应" }).click();
  await p.getByRole("button", { name: "删除这条回应", exact: true }).click();
  await p.getByRole("button", { name: "确认删除回应" }).click();
  await expect(p.getByText("已删除。", { exact: true })).toBeVisible();
  expect((await snapshot(p)).rows[0].reviews.at(-1).status).toBe(
    "NEEDS_REVIEW",
  );
  const replay = await p.evaluate(
    async ({ id, full }) => {
      const url = location.pathname + "store-test.js",
        store = await import(/* @vite-ignore */ url),
        row = await store.readState(id);
      try {
        await store.letterAction(id, row.letters[0].id, "respond", full, null);
        return "unexpected success";
      } catch (e) {
        return (e as Error).message;
      }
    },
    { id, full },
  );
  expect(replay).toContain("记录已变化");

  await control.getByRole("button", { name: "寄出已选旅行信" }).click();
  await expect(control.locator("p[role=alert]")).toContainText("失效");
  await stale.getByLabel("更正后的回应").fill("旧页面禁止复活");
  await stale.getByRole("button", { name: "保存更正" }).click();
  await expect(stale.locator("p[role=alert]")).toContainText("已删除");
  await p.getByLabel("你想跟它说什么？").fill("重新发送的合成回应");
  await p.getByRole("button", { name: "送出去", exact: true }).dblclick();
  await expect(p.getByRole("status")).toHaveText("送出去啦。");
  row = (await snapshot(p)).rows[0];
  expect(row.responses[rid].status).toBe("DELETED");
  expect(row.letters[0].responseId).not.toBe(rid);
  expect(
    Object.values(row.responses).filter((r: any) => r.status === "ACTIVE"),
  ).toHaveLength(1);
  await stale.getByRole("button", { name: "保存更正" }).click();
  expect((await snapshot(p)).rows[0]).toEqual(row);
  await control.getByRole("button", { name: "刷新演示状态" }).click();
  await act(control, "寄出普通旅行信");
  await act(control, "结束旅行回家");
  await ctx.close();
});

test("Two pages simultaneously delete/send and edit/send serialize safely", async ({
  browser,
}) => {
  for (const mutation of ["delete", "edit"]) {
    const ctx = await browser.newContext(),
      control = await ctx.newPage();
    await control.goto(base);
    const id = await name(control, "并发合成猫");
    await demand(control, full);
    const rid = (await snapshot(control)).rows[0].letters[0].responseId;
    await openControl(control);
    await act(control, "独立开始旅行");
    await selected(control, "L-RHINE", { rest: rid });
    const p = await ctx.newPage();
    await p.goto(base + "#" + id);
    await openDemandHistory(p);
    await p.getByRole("button", { name: "管理这条回应" }).click();
    if (mutation === "delete")
      await p
        .getByRole("button", { name: "删除这条回应", exact: true })
        .click();
    else await p.getByLabel("更正后的回应").fill("并发更正后的原文");
    // Dispatch both real store operations before cross-tab rendering can disable a button.
    // Separate UI tests above retain the user click, confirmation and source refresh checks.
    const reviewId = (await snapshot(p)).rows[0].reviews.at(-1).id;
    const invoke = (page: any, method: string, args: any[]) =>
      page.evaluate(
        async ({ method, args }: any) => {
          const store = await import(location.pathname + "store-test.js");
          return store[method](...args);
        },
        { method, args },
      );
    const outcomes = await Promise.allSettled([
      invoke(
        p,
        mutation === "delete" ? "deleteResponse" : "editResponse",
        mutation === "delete"
          ? [id, rid, 1]
          : [id, rid, 1, "并发更正后的原文", "concurrent-edit"],
      ),
      invoke(control, "deliverReview", [id, reviewId, "concurrent-send"]),
    ]);
    expect(outcomes[0].status).toBe("fulfilled");
    const row = (await snapshot(p)).rows[0],
      events = row.events.map((e: any) => e.event),
      sent = events.lastIndexOf("POSTCARD_DELIVERED"),
      mutated = events.lastIndexOf(
        mutation === "delete" ? "RESPONSE_DELETED" : "RESPONSE_EDITED",
      ),
      postcards = row.letters.filter((l: any) => l.type === "POSTCARD");
    if (sent >= 0) {
      expect(sent).toBeLessThan(mutated);
      expect(postcards).toHaveLength(1);
      expect(postcards[0].sourceRefs[0].revision).toBe(1);
    } else {
      expect(postcards).toHaveLength(0);
      expect(row.reviews.at(-1).status).toBe("NEEDS_REVIEW");
    }
    await ctx.close();
  }
});

test("Foreign participant source cannot be selected; intercepted edit stores no proposed text", async ({
  browser,
}) => {
  const ctx = await browser.newContext(),
    p = await ctx.newPage();
  await p.goto(base);
  await name(p, "来源合成甲");
  await demand(p, full);
  const foreign = (await snapshot(p)).rows[0].letters[0].responseId;
  await openControl(p);
  await p.getByRole("button", { name: "建立全新体验" }).click();
  const own = await name(p, "来源合成乙");
  await demand(p, "乙的合成回应");
  await openControl(p);
  await act(p, "独立开始旅行");
  expect(
    await p
      .locator("#source-rest option")
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLOptionElement).value)),
  ).not.toContain(foreign);
  const rejected = await p.evaluate(
    async ({ foreign, own }) => {
      const url = location.pathname + "store-test.js";
      const store = await import(/* @vite-ignore */ url);
      const row = await store.readState(own);
      try {
        await store.selectReview(
          own,
          "L-RHINE",
          [
            {
              claim: "rest",
              responseId: foreign,
              revision: 1,
              start: 0,
              end: 1,
              assessment: "SUPPORTED",
              attested: true,
            },
          ],
          row.controlRevision,
          crypto.randomUUID(),
        );
        return "unexpected success";
      } catch (e) {
        return (e as Error).message;
      }
    },
    { foreign, own },
  );
  expect(rejected).toContain("不属于本体验");
  expect(
    (await snapshot(p)).rows.find((r: any) => r.participant.id === own).reviews,
  ).toHaveLength(0);
  await enter(p);
  await openDemandHistory(p);
  await p.getByRole("button", { name: "管理这条回应" }).click();
  await p.getByLabel("更正后的回应").fill("[SYNTHETIC:INTERCEPT]");
  await p.getByRole("button", { name: "保存更正" }).click();
  await expect(p.getByRole("heading", { name: "独立安全路径" })).toBeVisible();
  const row = (await snapshot(p)).rows.find(
    (r: any) => r.participant.id === own,
  );
  expect(row.participant.safety_state).toBe("INTERCEPTED");
  expect(
    Object.values(row.responses).every((r: any) => r.currentRevision === 1),
  ).toBeTruthy();
  expect(JSON.stringify(row)).not.toContain("[SYNTHETIC:INTERCEPT]");
  await ctx.close();
});

test("Duplicate mutation and delivery requests do not create extra versions or postcards", async ({
  page,
}) => {
  await page.goto(base);
  const id = await name(page, "重试合成猫");
  await demand(page, full);
  const result = await page.evaluate(
    async ({ id, full }) => {
      const url = location.pathname + "store-test.js",
        s = await import(/* @vite-ignore */ url);
      let row = await s.readState(id);
      const rid = row.letters[0].responseId,
        key = crypto.randomUUID();
      await Promise.all([
        s.editResponse(id, rid, 1, full + " 合成更正", key),
        s.editResponse(id, rid, 1, full + " 合成更正", key),
      ]);
      row = await s.readState(id);
      const revision = row.responses[rid].currentRevision;
      await s.control(
        id,
        "start-trip",
        "",
        row.controlRevision,
        crypto.randomUUID(),
      );
      row = await s.readState(id);
      const selectKey = crypto.randomUUID(),
        refs = [
          {
            claim: "rest",
            responseId: rid,
            revision: 2,
            start: 0,
            end: full.length,
            assessment: "SUPPORTED",
            attested: true,
          },
        ];
      const [first, second] = await Promise.all([
        s.selectReview(id, "L-RHINE", refs, row.controlRevision, selectKey),
        s.selectReview(id, "L-RHINE", refs, row.controlRevision, selectKey),
      ]);
      const sendKey = crypto.randomUUID();
      await Promise.all([
        s.deliverReview(id, first.reviewId, sendKey),
        s.deliverReview(id, first.reviewId, sendKey),
      ]);
      row = await s.readState(id);
      return {
        revision,
        same: first.reviewId === second.reviewId,
        reviews: row.reviews.length,
        postcards: row.letters.filter((l: any) => l.type === "POSTCARD").length,
      };
    },
    { id, full },
  );
  expect(result).toEqual({ revision: 2, same: true, reviews: 1, postcards: 1 });
});

test("Skip-only experience travels independently and receives the complete ordinary fallback", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await name(page, "仅跳过合成猫");
  await openControl(page);
  await act(page, "投递下一需求卡");
  await enter(page);
  await page.getByRole("button", { name: "看看来信", exact: true }).click();
  await page.getByRole("button", { name: "这次先不回", exact: true }).click();
  await openControl(page);
  await act(page, "独立开始旅行");
  await act(page, "核验并选择旅行信");
  await expect(
    page.getByText("普通故事 · 山下面有一条亮亮的河", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/catletters-e2a-evidence/manual-review-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await act(page, "寄出已选旅行信");
  const row = (await snapshot(page)).rows[0],
    postcard = row.letters.find((l: any) => l.type === "POSTCARD");
  expect(Object.keys(row.responses)).toHaveLength(0);
  expect(row.reviews.at(-1).kind).toBe("ORDINARY");
  const { readFile } = await import("node:fs/promises"),
    frozen = JSON.parse(await readFile("src/content/frozen.json", "utf8"));
  expect(postcard.snapshot.body).toBe(
    frozen.items.find((c: any) => c.id === "O-RHINE-01").body,
  );
  expect(postcard.sourceRefs).toBeUndefined();
  await act(page, "结束旅行回家");
  expect((await snapshot(page)).rows[0].trip).toBeNull();
});
