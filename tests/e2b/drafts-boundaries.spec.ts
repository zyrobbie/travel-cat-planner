import { test, expect } from "@playwright/test";
import {
  base,
  snapshot,
  name,
  openControl,
  act,
  enter,
  demand,
  storeCall,
  mark,
} from "./helpers";
const T0 = Date.UTC(2026, 8, 13),
  DAY = 86400000;
test("Reply and edit drafts survive hard refresh, remain non-sources, and deletion clears draft copies", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  const id = await name(page, "持久草稿猫");
  await openControl(page);
  await act(page, "投递下一需求卡");
  await enter(page);
  await page.getByRole("button", { name: "看看来信", exact: true }).click();
  await page.getByLabel("你想跟它说什么？").fill("尚未发送的独有草稿");
  await expect(
    page.getByText("草稿已保存在本机，尚未发送。", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("你想跟它说什么？")).toHaveValue(
    "尚未发送的独有草稿",
  );
  await page.screenshot({
    path: "/tmp/catletters-e2b-evidence/restored-reply-mobile.png",
    fullPage: true,
  });
  expect(Object.keys((await snapshot(page)).rows[0].responses)).toHaveLength(0);
  await page.getByRole("button", { name: "送出去", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("送出去啦。");
  expect((await snapshot(page)).rows[0].drafts).toEqual({});
  await page.getByRole("button", { name: /回到.*身边/ }).click();
  await page.getByRole("button", { name: "来信盒", exact: true }).click();
  await page.getByRole("button", { name: /阿橘/ }).click();
  await page.getByRole("button", { name: "管理这条回应" }).click();
  await page.getByLabel("更正后的回应").fill("未提交更正的独有草稿");
  await expect(
    page.getByText("更正草稿已保存在本机，尚未提交。"),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("更正后的回应")).toHaveValue(
    "未提交更正的独有草稿",
  );
  await page.screenshot({
    path: "/tmp/catletters-e2b-evidence/restored-edit-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: "/tmp/catletters-e2b-evidence/restored-edit-desktop.png",
    fullPage: true,
  });
  const row = (await snapshot(page)).rows[0],
    rid = row.letters[0].responseId;
  expect(row.responses[rid].currentRevision).toBe(1);
  await page.getByRole("button", { name: "删除这条回应", exact: true }).click();
  await page.getByRole("button", { name: "确认删除回应" }).click();
  await expect(page.getByText("已删除。", { exact: true })).toBeVisible();
  expect((await snapshot(page)).rows[0].drafts).toEqual({});
  expect(JSON.stringify((await snapshot(page)).rows[0])).not.toContain(
    "独有草稿",
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "今天没有新来信。" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await openControl(page);
  await act(page, "演示快进到日历末尾");
  await page.screenshot({
    path: "/tmp/catletters-e2b-evidence/calendar-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});

test("Read commit opens first-read detail even when subsequent readback fails; abort does not release slot", async ({
  page,
}) => {
  await page.goto(base);
  await name(page, "读取故障猫");
  await openControl(page);
  await act(page, "独立开始旅行");
  await act(page, "寄出普通旅行信");
  await enter(page);
  await page.evaluate(() => {
    let committed = false;
    const put = IDBObjectStore.prototype.put,
      get = IDBObjectStore.prototype.get;
    (window as any).__failedReadCount = 0;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (value.letters?.some((l: any) => l.type === "POSTCARD" && l.read_at))
        this.transaction.addEventListener("complete", () => {
          committed = true;
        });
      return put.call(this, value, ...args);
    };
    IDBObjectStore.prototype.get = function (...args) {
      if (committed) {
        (window as any).__failedReadCount++;
        throw new DOMException("synthetic readback failure", "UnknownError");
      }
      return get.apply(this, args);
    };
  });
  await page.getByRole("button", { name: "打开看看", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "山下面有一条亮亮的河" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "收好这封信" })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect
    .poll(() => page.evaluate(() => (window as any).__failedReadCount))
    .toBeGreaterThan(0);
  await expect(
    page.getByRole("heading", { name: "山下面有一条亮亮的河" }),
  ).toBeVisible();
  await page.reload();
  const before = await snapshot(page);
  await openControl(page);
  await act(page, "结束旅行回家");
  await act(page, "投递下一需求卡");
  await enter(page);
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () {
      throw new DOMException("synthetic read abort", "QuotaExceededError");
    };
  });
  await page.getByRole("button", { name: "看看来信", exact: true }).click();
  await expect(page.locator("p[role=alert]")).toContainText("尚未保存");
  expect(
    (await snapshot(page)).rows[0].letters.filter((l: any) => !l.read_at),
  ).toHaveLength(1);
  expect(
    (await snapshot(page)).rows[0].letters.filter(
      (l: any) => l.type === "POSTCARD",
    ),
  ).toEqual(before.rows[0].letters);
});

test("Late selection/delivery cannot bypass elapsed trip, and normal read afterwards settles consistently", async ({
  browser,
}) => {
  for (const selected of [false, true]) {
    const ctx = await browser.newContext(),
      p = await ctx.newPage();
    await p.clock.install({ time: T0 });
    await p.clock.setFixedTime(T0);
    await p.goto(base);
    const id = await name(p, "迟到操作猫");
    await demand(p, "累了可以休息的合成原文");
    await openControl(p);
    await act(p, "独立开始旅行");
    const row = (await snapshot(p)).rows[0],
      rid = row.letters[0].responseId,
      refs = [
        {
          claim: "rest",
          responseId: rid,
          revision: 1,
          start: 0,
          end: 5,
          assessment: "SUPPORTED",
          attested: true,
        },
      ];
    let review: any;
    if (selected)
      review = await storeCall(p, "selectReview", [
        id,
        "L-RHINE",
        refs,
        row.controlRevision,
        "select",
      ]);
    const before = (await snapshot(p)).rows[0];
    await p.clock.setFixedTime(T0 + 3 * DAY);
    await expect(
      storeCall(
        p,
        selected ? "deliverReview" : "selectReview",
        selected
          ? [id, review.reviewId, "late-send"]
          : [id, "L-RHINE", refs, before.controlRevision, "late-select"],
      ),
    ).rejects.toThrow();
    expect((await snapshot(p)).rows[0]).toEqual(before);
    const after = await storeCall(p, "readState", [id]);
    expect(after.trip).toBeNull();
    expect(after.letters.filter((l: any) => !l.read_at)).toHaveLength(1);
    expect(
      after.calendar.nodes.filter(
        (n: any) => n.origin === "MANUAL" && n.kind === "END",
      )[0].result.outcome,
    ).toBe("APPLIED");
    await ctx.close();
  }
});

test("Chosen linked cannot be silently replaced by ordinary button or stale direct request", async ({
  page,
}) => {
  await page.goto(base);
  const id = await name(page, "明确选择猫");
  await demand(page, "合成：累了可以休息。");
  await openControl(page);
  await act(page, "独立开始旅行");
  let row = (await snapshot(page)).rows[0];
  await mark(page, "rest", row.letters[0].responseId);
  await act(page, "核验并选择旅行信");
  await expect(
    page.getByRole("button", { name: "寄出普通旅行信" }),
  ).toBeDisabled();
  row = (await snapshot(page)).rows[0];
  await expect(
    storeCall(page, "control", [
      id,
      "deliver-postcard",
      "O-RHINE-01",
      row.controlRevision,
      "stale-ordinary",
    ]),
  ).rejects.toThrow("已有待寄选择");
  expect((await snapshot(page)).rows[0].reviews.at(-1).kind).toBe("LINKED");
  await act(page, "改选为这篇普通故事");
  expect((await snapshot(page)).rows[0].reviews.at(-1).kind).toBe("ORDINARY");
  await act(page, "寄出已选旅行信");
  expect((await snapshot(page)).rows[0].letters[0].storyId).toBe("O-RHINE-01");
});

test("Calendar rechecks actual current source and safety at settlement, without reviving edited or deleted evidence", async ({
  browser,
}) => {
  for (const mutation of ["none", "edit", "delete", "intercept", "used"]) {
    const ctx = await browser.newContext(),
      p = await ctx.newPage();
    await p.clock.install({ time: T0 });
    await p.clock.setFixedTime(T0);
    await p.goto(base);
    const id = await name(p, "到期来源猫");
    await demand(p, "合成：累了可以休息。");
    if (mutation === "used") {
      let prior = await storeCall(p, "readState", [id]);
      const responseId = prior.letters[0].responseId;
      await storeCall(p, "control", [
        id,
        "start-trip",
        "O-RHINE-01",
        prior.controlRevision,
        "past-start",
      ]);
      prior = await storeCall(p, "readState", [id]);
      const chosen = await storeCall(p, "selectReview", [
        id,
        "L-RHINE",
        [
          {
            claim: "rest",
            responseId,
            revision: 1,
            start: 0,
            end: 5,
            assessment: "SUPPORTED",
            attested: true,
          },
        ],
        prior.controlRevision,
        "past-select",
      ]);
      await storeCall(p, "deliverReview", [
        id,
        chosen.reviewId,
        "past-deliver",
      ]);
      prior = await storeCall(p, "readState", [id]);
      await storeCall(p, "letterAction", [id, prior.letters[0].id, "read"]);
      prior = await storeCall(p, "readState", [id]);
      await storeCall(p, "control", [
        id,
        "end-trip",
        "",
        prior.controlRevision,
        "past-end",
      ]);
    }
    await p.clock.setFixedTime(T0 + DAY);
    let row = await storeCall(p, "readState", [id]);
    await storeCall(p, "letterAction", [id, row.letters[0].id, "read"]);
    row = await storeCall(p, "readState", [id]);
    const rid = row.letters.find((l: any) => l.response).responseId;
    await storeCall(p, "control", [
      id,
      "start-trip",
      "O-RHINE-01",
      row.controlRevision,
      "start",
    ]);
    row = await storeCall(p, "readState", [id]);
    await storeCall(p, "selectReview", [
      id,
      "L-RHINE",
      [
        {
          claim: "rest",
          responseId: rid,
          revision: 1,
          start: 0,
          end: 5,
          assessment: "SUPPORTED",
          attested: true,
        },
      ],
      row.controlRevision,
      "select",
    ]);
    if (mutation === "delete")
      await storeCall(p, "deleteResponse", [id, rid, 1]);
    if (mutation === "edit" || mutation === "intercept")
      await storeCall(p, "editResponse", [
        id,
        rid,
        1,
        mutation === "edit" ? "不同条件的合成更正" : "[SYNTHETIC:INTERCEPT]",
        "edit",
      ]);
    await p.clock.setFixedTime(T0 + 2 * DAY);
    row = await storeCall(p, "readState", [id]);
    const cards = row.letters.filter(
      (l: any) => l.type === "POSTCARD" && l.tripId === row.trip?.id,
    );
    if (mutation === "intercept") expect(cards).toHaveLength(0);
    else {
      expect(cards).toHaveLength(1);
      expect(cards[0].storyId).toBe(
        mutation === "none" ? "L-RHINE" : "O-RHINE-01",
      );
      if (mutation !== "none") expect(cards[0].sourceRefs).toBeUndefined();
    }
    await p.clock.setFixedTime(T0 + 3 * DAY);
    row = await storeCall(p, "readState", [id]);
    expect(row.trip).toBeNull();
    if (cards.length)
      expect(
        row.letters.find((l: any) => l.id === cards[0].id).read_at,
      ).toBeNull();
    await ctx.close();
  }
});

test("Unread mail takes priority on cold return, while reply/edit drafts persist and foreground notice never marks read", async ({
  browser,
}) => {
  for (const kind of ["reply", "edit"] as const) {
    for (const cold of [false, true]) {
      const ctx = await browser.newContext({
          viewport: { width: 390, height: 844 },
        }),
        p = await ctx.newPage();
      await p.clock.install({ time: T0 });
      await p.clock.setFixedTime(T0);
      await p.goto(base);
      const id = await name(p, "返回优先猫");
      if (kind === "edit") {
        await demand(p, "原有合成回应");
        await p.getByRole("button", { name: "来信盒", exact: true }).click();
        await p.getByRole("button", { name: /阿橘/ }).click();
        await p.getByRole("button", { name: "管理这条回应" }).click();
      } else {
        await openControl(p);
        await act(p, "投递下一需求卡");
        await enter(p);
        await p.getByRole("button", { name: "看看来信", exact: true }).click();
      }
      const label = kind === "edit" ? "更正后的回应" : "你想跟它说什么？",
        text = `${kind}返回仍保留的合成草稿`;
      await p.getByLabel(label).fill(text);
      await expect(
        p.getByText(
          kind === "edit"
            ? "更正草稿已保存在本机，尚未提交。"
            : "草稿已保存在本机，尚未发送。",
          { exact: true },
        ),
      ).toBeVisible();
      const before = (await snapshot(p)).rows[0];
      await p.clock.setFixedTime(T0 + DAY);
      if (cold) await p.reload();
      else {
        await p.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(
          p.getByRole("button", { name: "有一封新来信", exact: true }),
        ).toBeVisible();
        await expect(p.getByLabel(label)).toHaveValue(text);
        if (kind === "edit")
          await p.screenshot({
            path: "/tmp/catletters-e2b-evidence/new-mail-during-edit-mobile.png",
            fullPage: true,
          });
        await p
          .getByRole("button", { name: "有一封新来信", exact: true })
          .click();
      }
      await expect(
        p.getByRole("heading", { name: "今天有一封来信", exact: true }),
      ).toBeVisible();
      const after = (await snapshot(p)).rows[0];
      expect(after.drafts).toEqual(before.drafts);
      expect(after.responses).toEqual(before.responses);
      expect(after.letters.filter((l: any) => !l.read_at)).toHaveLength(1);
      await p.getByRole("button", { name: "来信盒", exact: true }).click();
      await p.getByRole("button", { name: /阿橘/ }).click();
      await expect(p.getByLabel(label)).toHaveValue(text);
      expect(
        (await snapshot(p)).rows[0].letters.filter((l: any) => !l.read_at),
      ).toHaveLength(1);
      await ctx.close();
    }
  }
});
