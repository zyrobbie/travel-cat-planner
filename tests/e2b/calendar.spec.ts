import { test, expect } from "@playwright/test";
import {
  base,
  snapshot,
  name,
  openControl,
  enter,
  act,
  storeCall,
  replaceRows,
} from "./helpers";
const DAY = 86400000,
  T0 = Date.UTC(2026, 8, 13, 0, 0, 0);
async function at(page: any, id: string, time: number) {
  await page.clock.setFixedTime(time);
  return storeCall(page, "readState", [id]);
}
function semantic(row: any) {
  return {
    trip: row.trip,
    tripCount: row.tripCount,
    letters: row.letters.map(({ delivered_at, effective_at, ...l }: any) => l),
    nodes: row.calendar.nodes.map((n: any) => ({
      id: n.id,
      at: n.at,
      kind: n.kind,
      tripId: n.tripId,
      result: n.result && {
        outcome: n.result.outcome,
        reason: n.result.reason,
        letterId: n.result.letterId,
      },
    })),
  };
}

test("Short absence does not write; one jump equals incremental settlement with empty or occupied slot", async ({
  browser,
}) => {
  for (const occupied of [false, true]) {
    const a = await browser.newContext(),
      p = await a.newPage();
    await p.clock.install({ time: T0 });
    await p.clock.setFixedTime(T0);
    await p.goto(base);
    const id = await name(p, "等价合成猫");
    if (occupied) {
      await openControl(p);
      await act(p, "投递下一需求卡");
    }
    const initial = (await snapshot(p)).rows[0],
      b = await browser.newContext(),
      q = await b.newPage();
    await q.clock.install({ time: T0 });
    await q.clock.setFixedTime(T0);
    await q.goto(base);
    await replaceRows(q, [initial]);
    await p.evaluate(() => {
      (window as any).__calendarPutCount = 0;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        (window as any).__calendarPutCount++;
        return put.apply(this, args);
      };
    });
    const early = await at(p, id, T0 + 1000);
    expect(early).toEqual(initial);
    expect(await p.evaluate(() => (window as any).__calendarPutCount)).toBe(0);
    let stepped;
    for (let day = 1; day <= 14; day++)
      stepped = await at(p, id, T0 + day * DAY);
    const batch = await at(q, id, T0 + 14 * DAY);
    expect(semantic(stepped)).toEqual(semantic(batch));
    expect(batch.letters.filter((l: any) => !l.read_at)).toHaveLength(1);
    expect(batch.trip).toBeNull();
    expect(batch.calendar.processedCount).toBe(12);
    const stable = await at(q, id, T0);
    expect(stable).toEqual(batch);
    await at(q, id, T0 + 1000 * DAY);
    expect((await snapshot(q)).rows[0]).toEqual(batch);
    await a.close();
    await b.close();
  }
});

test("Read first settles missed nodes; read or skip never replays skipped mail and no response is required", async ({
  page,
}) => {
  await page.clock.install({ time: T0 });
  await page.clock.setFixedTime(T0);
  await page.goto(base);
  const id = await name(page, "阅读合成猫");
  await openControl(page);
  await act(page, "投递下一需求卡");
  let row = (await snapshot(page)).rows[0],
    letter = row.letters[0];
  await page.clock.setFixedTime(T0 + 5 * DAY);
  await storeCall(page, "letterAction", [id, letter.id, "read"]);
  row = (await snapshot(page)).rows[0];
  expect(row.letters).toHaveLength(1);
  expect(row.calendar.processedCount).toBe(3);
  expect(row.letters[0].read_at).not.toBeNull();
  await storeCall(page, "readState", [id]);
  expect((await snapshot(page)).rows[0].letters).toHaveLength(1);
  row = await at(page, id, T0 + 7 * DAY);
  expect(row.letters[0].storyId).toBe("O-FIREFLY-01");
  expect(Object.keys(row.responses)).toHaveLength(0);
  row = await at(page, id, T0 + 8 * DAY);
  expect(row.trip).toBeNull();
  expect(row.letters[0].read_at).toBeNull();
  await page.reload();
  await page.getByRole("button", { name: "打开看看", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "好多小星星飞起来啦" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "收好这封信" }).click();
  await page.getByRole("button", { name: "来信盒", exact: true }).click();
  await page.getByRole("button", { name: /好多小星星飞起来啦/ }).click();
  row = await at(page, id, T0 + 9 * DAY);
  expect(row.letters[0].id.endsWith(":D-05")).toBeTruthy();
  await storeCall(page, "letterAction", [id, row.letters[0].id, "skip"]);
  row = await at(page, id, T0 + 10 * DAY);
  expect(row.letters).toHaveLength(3); // D-01 already used manually; no replacement.
});

test("Real close/reopen uses persisted calendar and actual write time, not a background delivery claim", async ({
  browser,
}) => {
  const ctx = await browser.newContext(),
    p = await ctx.newPage();
  await p.goto(base);
  const id = await name(p, "关页合成猫"),
    row = (await snapshot(p)).rows[0];
  const due = Date.now() + 1500,
    shift = due - row.calendar.nodes[0].at;
  row.calendar.baseAt += shift;
  row.calendar.nodes.forEach((n: any) => (n.at += shift));
  await replaceRows(p, [row]);
  await p.close();
  await new Promise((r) => setTimeout(r, 1800));
  const q = await ctx.newPage();
  await q.goto(base + "#" + id);
  await expect(
    q.getByRole("button", { name: "看看来信", exact: true }),
  ).toBeVisible();
  const after = (await snapshot(q)).rows[0];
  expect(after.letters).toHaveLength(1);
  expect(Date.parse(after.letters[0].planned_at)).toBe(due);
  expect(Date.parse(after.letters[0].delivered_at)).toBeGreaterThanOrEqual(due);
  await q.reload();
  expect((await snapshot(q)).rows[0].letters).toEqual(after.letters);
  await ctx.close();
});

test("Visible timer and repeated focus settle once without clearing an unsent draft", async ({
  page,
}) => {
  await page.clock.install({ time: T0 });
  await page.clock.setFixedTime(T0);
  await page.goto(base);
  const id = await name(page, "草稿日历猫");
  await openControl(page);
  await act(page, "投递下一需求卡");
  await enter(page);
  await page.getByRole("button", { name: "看看来信", exact: true }).click();
  await page.getByLabel("你想跟它说什么？").fill("不会自动发送的草稿");
  await page.clock.setFixedTime(T0 + DAY);
  await page.clock.runFor(16000);
  await expect
    .poll(async () => (await snapshot(page)).rows[0].letters.length)
    .toBe(2);
  await page.evaluate(() => {
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event("focus"));
  });
  await expect(page.getByLabel("你想跟它说什么？")).toHaveValue(
    "不会自动发送的草稿",
  );
  const row = (await snapshot(page)).rows[0];
  expect(row.calendar.processedCount).toBe(1);
  expect(Object.keys(row.responses)).toHaveLength(0);
  expect(row.letters.filter((l: any) => !l.read_at)).toHaveLength(1);
});

test("Two returning pages and read/delivery race obey the shared unread slot and atomic rollback", async ({
  browser,
}) => {
  const ctx = await browser.newContext(),
    p = await ctx.newPage();
  await p.clock.install({ time: T0 });
  await p.clock.setFixedTime(T0);
  await p.goto(base);
  const id = await name(p, "并发日历猫");
  await openControl(p);
  await act(p, "投递下一需求卡");
  const initial = (await snapshot(p)).rows[0],
    q = await ctx.newPage();
  await q.clock.install({ time: T0 });
  await q.clock.setFixedTime(T0);
  await q.goto(base + "#" + id);
  await p.clock.setFixedTime(T0 + 7 * DAY);
  await q.clock.setFixedTime(T0 + 7 * DAY);
  await Promise.all([
    storeCall(p, "letterAction", [id, initial.letters[0].id, "read"]),
    storeCall(q, "readState", [id]),
    storeCall(p, "readState", [id]),
  ]);
  const row = (await snapshot(p)).rows[0];
  expect(row.letters).toHaveLength(1);
  expect(row.calendar.processedCount).toBe(5);
  expect(row.letters[0].read_at).not.toBeNull();
  await p.clock.setFixedTime(T0 + 14 * DAY);
  const before = await snapshot(p);
  await p.evaluate(() => {
    IDBObjectStore.prototype.put = function () {
      throw new DOMException("synthetic failure", "QuotaExceededError");
    };
  });
  await expect(storeCall(p, "readState", [id])).rejects.toThrow("尚未保存");
  expect(await snapshot(p)).toEqual(before);
  await q.clock.setFixedTime(T0 + 14 * DAY);
  const after = await storeCall(q, "readState", [id]);
  expect(after.calendar.processedCount).toBe(12);
  expect(after.letters.filter((l: any) => !l.read_at)).toHaveLength(1);
  await ctx.close();
});

test("Manual trip is not replaced by scheduled start; old end cannot end a newer trip; fast-forward stays per cat", async ({
  page,
}) => {
  await page.clock.install({ time: T0 });
  await page.clock.setFixedTime(T0);
  await page.goto(base);
  const id = await name(page, "冲突合成猫");
  let row = await at(page, id, T0 + 5 * DAY);
  await storeCall(page, "control", [
    id,
    "start-trip",
    "O-RHINE-01",
    row.controlRevision,
    "manual1",
  ]);
  const old = (await snapshot(page)).rows[0].trip.id;
  row = await at(page, id, T0 + 6 * DAY);
  expect(row.trip.id).toBe(old);
  expect(
    row.calendar.nodes.find((n: any) => n.id === "fixed:d6").result.outcome,
  ).toBe("SKIPPED");
  await storeCall(page, "control", [
    id,
    "end-trip",
    "",
    row.controlRevision,
    "end1",
  ]);
  row = (await snapshot(page)).rows[0];
  await storeCall(page, "control", [
    id,
    "start-trip",
    "O-RHINE-01",
    row.controlRevision,
    "manual2",
  ]);
  const next = (await snapshot(page)).rows[0].trip.id;
  row = await at(page, id, T0 + 7 * DAY);
  expect(row.trip.id).toBe(next);
  const other = await storeCall(page, "createParticipant", ["另一时钟猫"]),
    offset = other.calendar.offsetMs;
  const repeated = await Promise.all([
    storeCall(page, "fastForward", [id, "end", row.controlRevision, "jump"]),
    storeCall(page, "fastForward", [id, "end", row.controlRevision, "jump"]),
  ]);
  expect(repeated[0]).toEqual(repeated[1]);
  const all = (await snapshot(page)).rows;
  expect(
    all.find((r: any) => r.participant.id === other.participant.id).calendar
      .offsetMs,
  ).toBe(offset);
  expect(all.find((r: any) => r.participant.id === id).trip).toBeNull();
});
