import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { db, assertDedicated, dispose, tick, lifecycle } from "./helpers";
const origin = process.env.E4_TEST_ORIGIN!,
  shots = resolve(process.env.E4_EVIDENCE_DIR!, "screenshots");
test.beforeAll(async () => {
  await assertDedicated();
  await mkdir(shots, { recursive: true });
});
test.afterAll(dispose);
async function login(
  page: Page,
  email = `lifecycle-browser-${randomUUID()}@example.test`,
) {
  await page.goto(`${origin}/account-app/`);
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  const requested = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/e4/auth/request-code") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "获取验证码", exact: true }).click();
  const reply = await requested;
  expect(reply.status()).toBe(200);
  const { challengeId } = await reply.json(),
    otp = JSON.parse(
      await readFile(
        join(process.env.E4_SYNTHETIC_INBOX!, `${challengeId}.json`),
        "utf8",
      ),
    );
  await page.getByLabel("验证码", { exact: true }).fill(otp.code);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("radio", { name: "选择橘白猫" })).toBeVisible();
  const state = await page.evaluate(async () => {
    const r = await fetch("/api/e4/account");
    if (r.status !== 200) throw Error("account fixture unavailable");
    return r.json();
  });
  return { email, accountId: state.id as string };
}
async function adopt(page: Page) {
  const value = await page.evaluate(async (key) => {
    const r = await fetch("/api/e4/cat/adopt", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, name: "合成隐私猫", appearanceId: "cat-02" }),
    });
    if (r.status !== 200) throw Error("Synthetic adoption failed");
    return r.json();
  }, randomUUID());
  await page.reload();
  await expect(
    page.getByRole("button", { name: "账号设置", exact: true }),
  ).toBeVisible();
  return value.cat;
}
async function settings(page: Page) {
  await page.getByRole("button", { name: "账号设置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "生成个人资料文件", exact: true }),
  ).toBeVisible();
}
function errors(page: Page) {
  const failures: string[] = [];
  page.on("pageerror", (e) => failures.push(e.message));
  page.on("console", (m) => {
    if (
      m.type() === "error" &&
      !/status of (401|409|503)|net::ERR_FAILED/.test(m.text())
    )
      failures.push(m.text());
  });
  return failures;
}
async function stableBounds(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

test("browser C01 owner explicitly requests and downloads a private export; cancellation never starts erasure", async ({
  page,
}) => {
  const found = errors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const a = await login(page);
  await adopt(page);
  await settings(page);
  const queued = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/e4/privacy/exports") &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "生成个人资料文件", exact: true })
    .click();
  expect((await queued).status()).toBe(200);
  await tick();
  await page.reload();
  await settings(page);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载个人资料", exact: true }).click();
  const file = await downloading;
  const stream = await file.createReadStream();
  expect(stream).not.toBeNull();
  let text = "";
  for await (const part of stream!) text += part.toString();
  const payload = JSON.parse(text);
  expect(JSON.stringify(payload)).toContain("合成隐私猫");
  expect(text).not.toMatch(/code_hash|token_hash|rawToken/);
  await page.getByRole("button", { name: "注销账号", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "确认注销", exact: true }),
  ).toBeVisible();
  await stableBounds(page);
  await page.screenshot({ path: join(shots, "mobile-deletion-confirm.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await stableBounds(page);
  await page.screenshot({ path: join(shots, "desktop-deletion-confirm.png") });
  await page.getByRole("button", { name: "暂不注销", exact: true }).click();
  expect(
    (await db.query("SELECT status FROM accounts WHERE id=$1", [a.accountId]))
      .rows[0].status,
  ).toBe("ACTIVE");
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM account_deletions WHERE account_id=$1",
        [a.accountId],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(found).toEqual([]);
});

test("browser C02 targeted local cleanup retains other account, anonymous archive and binding gates; ordinary logout retains drafts", async ({
  page,
}) => {
  const a = await login(page),
    cat = await adopt(page),
    foreign = randomUUID();
  const ownDraft = `cat-letters:account-draft:v1:${a.accountId}:${cat.id}:synthetic:reply`,
    otherDraft = `cat-letters:account-draft:v1:${foreign}:synthetic:synthetic:reply`,
    ownRequest = `cat-letters:account-request:v1:${a.accountId}:${cat.id}:SEND_RESPONSE:synthetic`;
  await page.evaluate(
    async ({ ownDraft, otherDraft, ownRequest }) => {
      localStorage.setItem(ownDraft, "synthetic owner draft");
      localStorage.setItem(otherDraft, "synthetic other draft");
      sessionStorage.setItem(ownRequest, "synthetic owner request");
      localStorage.setItem("unrelated-preference", "kept");
      const d = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open("cat-letters-pages-v1", 4);
        r.onupgradeneeded = () => {
          r.result.createObjectStore("participants", { keyPath: "id" });
          r.result.createObjectStore("accountBindings", {
            keyPath: "sourceId",
          });
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      await new Promise<void>((resolve, reject) => {
        const t = d.transaction(
          ["participants", "accountBindings"],
          "readwrite",
        );
        t.objectStore("participants").put({
          id: "synthetic-local",
          drafts: { text: "anonymous draft retained" },
        });
        t.objectStore("accountBindings").put({
          sourceId: "synthetic-local",
          phase: "BOUND",
          accountId: "deleted-unrelated",
        });
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
      d.close();
    },
    { ownDraft, otherDraft, ownRequest },
  );
  await settings(page);
  await page
    .getByRole("button", { name: "清除此浏览器草稿", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "保留草稿", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认清除草稿", exact: true }).click();
  const local = await page.evaluate(
    async ({ ownDraft, otherDraft, ownRequest }) => {
      const d = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open("cat-letters-pages-v1");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const rows = await new Promise<any>((resolve, reject) => {
        const t = d.transaction(
            ["participants", "accountBindings"],
            "readonly",
          ),
          p = t.objectStore("participants").get("synthetic-local"),
          g = t.objectStore("accountBindings").get("synthetic-local");
        t.oncomplete = () => resolve({ p: p.result, g: g.result });
        t.onerror = () => reject(t.error);
      });
      d.close();
      return {
        own: localStorage.getItem(ownDraft),
        other: localStorage.getItem(otherDraft),
        request: sessionStorage.getItem(ownRequest),
        pref: localStorage.getItem("unrelated-preference"),
        rows,
      };
    },
    { ownDraft, otherDraft, ownRequest },
  );
  expect(local).toEqual({
    own: null,
    other: "synthetic other draft",
    request: "synthetic owner request",
    pref: "kept",
    rows: {
      p: {
        id: "synthetic-local",
        drafts: { text: "anonymous draft retained" },
      },
      g: {
        sourceId: "synthetic-local",
        phase: "BOUND",
        accountId: "deleted-unrelated",
      },
    },
  });
  await page.evaluate(
    (key) => localStorage.setItem(key, "draft retained on logout"),
    ownDraft,
  );
  await page.getByRole("button", { name: "退出账号", exact: true }).click();
  await expect(page.getByLabel("邮箱", { exact: true })).toBeVisible();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), ownDraft),
  ).toBe("draft retained on logout");
});

test("browser C03 lost deletion confirmation is recovered with the private receipt after refresh; old sessions cannot display the cat", async ({
  page,
  context,
}) => {
  const a = await login(page);
  await adopt(page);
  const localKeys = {
    ownDraft: `cat-letters:account-draft:v1:${a.accountId}:synthetic:reply`,
    ownRequest: `cat-letters:account-request:v1:${a.accountId}:synthetic:SEND_RESPONSE:reply`,
    otherRequest: `cat-letters:account-request:v1:${randomUUID()}:synthetic:SEND_RESPONSE:reply`,
  };
  await page.evaluate((keys) => {
    localStorage.setItem(keys.ownDraft, "synthetic owner draft");
    sessionStorage.setItem(keys.ownRequest, "synthetic owner request");
    sessionStorage.setItem(keys.otherRequest, "synthetic other request");
  }, localKeys);
  const second = await context.newPage();
  await second.goto(`${origin}/account-app/`);
  await expect(
    second.getByRole("button", { name: "账号设置", exact: true }),
  ).toBeVisible();
  await settings(page);
  await page.getByRole("button", { name: "注销账号", exact: true }).click();
  let committed = false;
  await page.route("**/api/e4/privacy/deletions/confirm", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed = true;
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "确认注销", exact: true }).click();
  await expect.poll(() => committed).toBe(true);
  await page.unroute("**/api/e4/privacy/deletions/confirm");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "查询注销进度", exact: true }),
  ).toBeVisible();
  expect(
    (await db.query("SELECT status FROM accounts WHERE id=$1", [a.accountId]))
      .rows[0].status,
  ).toBe("DELETING");
  expect(
    await page.evaluate(
      (keys) => ({
        draft: localStorage.getItem(keys.ownDraft),
        request: sessionStorage.getItem(keys.ownRequest),
        other: sessionStorage.getItem(keys.otherRequest),
      }),
      localKeys,
    ),
  ).toEqual({ draft: null, request: null, other: "synthetic other request" });
  await tick();
  await page.getByRole("button", { name: "查询注销进度", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "重新注册", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: join(shots, "deletion-complete.png") });
  await second.reload();
  await expect(
    second.getByRole("heading", { name: "合成隐私猫", exact: true }),
  ).toHaveCount(0);
  await second.close();
  let finishCommitted = false;
  await page.route("**/api/e4/privacy/deletions/finish", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    finishCommitted = true;
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "重新注册", exact: true }).click();
  await expect.poll(() => finishCommitted).toBe(true);
  await expect(page.getByLabel("邮箱", { exact: true })).toBeVisible();
  await page.unroute("**/api/e4/privacy/deletions/finish");
  await page.reload();
  await expect(page.getByLabel("邮箱", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "查询注销进度", exact: true }),
  ).toHaveCount(0);
});

test("browser C04 real erasure failure stays incomplete and an explicit retry finishes it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const a = await login(page);
  await adopt(page);
  await settings(page);
  await page.getByRole("button", { name: "注销账号", exact: true }).click();
  await page.getByRole("button", { name: "确认注销", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "查询注销进度", exact: true }),
  ).toBeVisible();
  await db.query(
    "CREATE FUNCTION e4_c_browser_erase_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic browser erasure failure'; END $$",
  );
  await db.query(
    "CREATE TRIGGER e4_c_browser_erase_fail BEFORE DELETE ON cat_profiles FOR EACH ROW EXECUTE FUNCTION e4_c_browser_erase_fail()",
  );
  try {
    expect((await lifecycle()).code).not.toBe(0);
    await page
      .getByRole("button", { name: "查询注销进度", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "重试注销", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "重新注册", exact: true }),
    ).toHaveCount(0);
    await stableBounds(page);
    await page.screenshot({ path: join(shots, "mobile-deletion-failed.png") });
  } finally {
    await db.query("DROP TRIGGER e4_c_browser_erase_fail ON cat_profiles");
    await db.query("DROP FUNCTION e4_c_browser_erase_fail()");
  }
  await page.getByRole("button", { name: "重试注销", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "重新注册", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "重新注册", exact: true }).click();
  await expect(page.getByLabel("邮箱", { exact: true })).toBeVisible();
  const fresh = await login(page, a.email);
  expect(fresh.accountId).not.toBe(a.accountId);
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM cat_profiles WHERE account_id=$1",
        [fresh.accountId],
      )
    ).rows[0].n,
  ).toBe(0);
});
