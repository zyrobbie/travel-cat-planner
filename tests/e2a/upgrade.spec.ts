import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import {
  base,
  seedOld,
  snapshot,
  openControl,
  act,
  enter,
  openDemandHistory,
} from "./helpers";
test("Real published old UI → atomic multi-participant upgrade → reload/edit/continue trip", async ({
  browser,
}) => {
  const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
    }),
    page = await ctx.newPage();
  const { a, b, before } = await seedOld(page);
  expect(before.version).toBe(1);
  expect(before.rows.every((r) => r.schema === 1)).toBeTruthy();
  await page.goto("about:blank");
  const other = await ctx.newPage();
  await Promise.all([page.goto(base + "#" + a), other.goto(base + "#" + b)]);
  await expect(
    page.getByRole("heading", { name: "旧版合成甲出去旅行啦 🐾" }),
  ).toBeVisible();
  await expect(
    other.getByRole("button", { name: "打开看看", exact: true }),
  ).toBeVisible();
  const after = await snapshot(page);
  expect(after.version).toBe(3);
  expect(after.rows).toHaveLength(before.rows.length);
  for (const old of before.rows) {
    const next = after.rows.find(
      (r) => r.participant.id === old.participant.id,
    );
    for (const field of [
      "participant",
      "trip",
      "tripCount",
      "controlRevision",
      "events",
      "requests",
    ])
      expect(next[field]).toEqual(old[field]);
    expect(next.letters.map(({ responseId, ...l }: any) => l)).toEqual(
      old.letters,
    );
    expect(
      Object.values(next.responses).every(
        (r: any) => r.revisions[0].at === null,
      ),
    ).toBeTruthy();
  }
  await page.reload();
  expect(await snapshot(page)).toEqual(after);
  await openControl(page);
  const rid = (await snapshot(page)).rows
    .find((r) => r.participant.id === a)
    .letters.find((l: any) => l.responseId).responseId;
  const { mark } = await import("./helpers");
  await mark(page, "rest", rid);
  await act(page, "核验并选择旅行信");
  await act(page, "寄出已选旅行信");
  await act(page, "结束旅行回家");
  await enter(page);
  await openDemandHistory(page);
  await page.getByRole("button", { name: "管理这条回应" }).click();
  await page
    .getByLabel("更正后的回应")
    .fill("升级后合成更正：可以在累时歇一会儿。");
  await page.screenshot({
    path: "/tmp/catletters-e2a-evidence/manager-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: "/tmp/catletters-e2a-evidence/manager-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "保存更正" }).click();
  await expect(page.getByText("已更正。", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "/tmp/catletters-e2a-evidence/upgraded-management.png",
    fullPage: true,
  });
  await mkdir("/tmp/catletters-e2a-evidence", { recursive: true });
  await writeFile(
    "/tmp/catletters-e2a-evidence/real-old-upgrade.json",
    JSON.stringify(
      { baseline: "288f71225c4a48139af43f30bed1429710deed0e", before, after },
      null,
      2,
    ),
  );
  await ctx.close();
});

test("Upgrade abort is atomic; unknown record survives; retry upgrades same data", async ({
  browser,
}) => {
  const ctx = await browser.newContext(),
    page = await ctx.newPage();
  const { before } = await seedOld(page);
  await page.evaluate(() => sessionStorage.setItem("fail-upgrade", "1"));
  await page.addInitScript(() => {
    if (sessionStorage.getItem("fail-upgrade") === "1") {
      sessionStorage.setItem("fail-upgrade", "0");
      IDBCursor.prototype.update = function () {
        throw new DOMException("Synthetic quota", "QuotaExceededError");
      };
    }
  });
  await page.goto(base);
  await expect(
    page.getByRole("heading", { name: "暂时无法读取本机数据" }),
  ).toBeVisible();
  expect(await snapshot(page)).toEqual(before);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "继续已有体验" }),
  ).toBeVisible();
  expect((await snapshot(page)).version).toBe(3);
  await ctx.close();
  const other = await browser.newContext(),
    p = await other.newPage();
  const seeded = await seedOld(p);
  await p.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("cat-letters-pages-v1");
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve) => {
      const t = db.transaction("participants", "readwrite"),
        s = t.objectStore("participants"),
        r = s.getAll();
      r.onsuccess = () => s.put({ ...r.result[0], schema: 99 });
      t.oncomplete = () => resolve();
    });
    db.close();
  });
  const corrupted = await snapshot(p);
  await p.goto(base);
  await expect(
    p.getByRole("heading", { name: "暂时无法读取本机数据" }),
  ).toBeVisible();
  expect(await snapshot(p)).toEqual(corrupted);
  expect(corrupted.rows).toHaveLength(seeded.before.rows.length);
  await other.close();
});

test("Existing database missing participants is rejected without creating empty store", async ({
  page,
}) => {
  await page.goto(base + "?__baseline=1"); // Before initial name, no participants have been created by UI.
  // Use a fresh, explicitly corrupted database fixture; no user data is deleted.
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.deleteDatabase("cat-letters-pages-v1");
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
    await new Promise<void>((resolve) => {
      const r = indexedDB.open("cat-letters-pages-v1", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("original-sentinel");
      r.onsuccess = () => {
        r.result.close();
        resolve();
      };
    });
  });
  await page.goto(base);
  await expect(
    page.getByRole("heading", { name: "暂时无法读取本机数据" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      async () =>
        new Promise((resolve) => {
          const r = indexedDB.open("cat-letters-pages-v1");
          r.onsuccess = () => {
            const value = {
              version: r.result.version,
              stores: [...r.result.objectStoreNames],
            };
            r.result.close();
            resolve(value);
          };
        }),
    ),
  ).toEqual({ version: 1, stores: ["original-sentinel"] });
});

test("Schema 2 orphan active response is rejected and preserved", async ({
  page,
}) => {
  const { name, demand } = await import("./helpers");
  await page.goto(base);
  await name(page, "损坏合成猫");
  await demand(page, "合成回应");
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("cat-letters-pages-v1");
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve) => {
      const t = db.transaction("participants", "readwrite"),
        s = t.objectStore("participants"),
        r = s.getAll();
      r.onsuccess = () => {
        const row = r.result[0];
        delete row.letters[0].responseId;
        row.letters[0].response = null;
        s.put(row);
      };
      t.oncomplete = () => resolve();
    });
    db.close();
  });
  const before = await snapshot(page);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "暂时无法读取本机数据" }),
  ).toBeVisible();
  await expect(page.getByText(/原数据未改写/)).toBeVisible();
  expect(await snapshot(page)).toEqual(before);
});
