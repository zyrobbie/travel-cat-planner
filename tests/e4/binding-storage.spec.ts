import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { resolve } from "node:path";
const sharedModule = "/@fs" + resolve("src/shared/legacy-transfer.ts");

const local = "http://127.0.0.1:18994";
const account = `${process.env.E4_TEST_ORIGIN}/account-app/`;

async function blank(context: BrowserContext) {
  const page = await context.newPage();
  await page.route(`${local}/__binding-storage`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Isolated binding storage test</title><main>Storage fixture</main>",
    }),
  );
  await page.goto(`${local}/__binding-storage`);
  return page;
}
async function seed(page: Page) {
  return page.evaluate(async () => {
    const path = "/store.ts",
      store = await import(/* @vite-ignore */ path);
    let state = await store.createParticipant("门闩合成猫", "cat-02");
    const id = state.participant.id;
    await store.control(
      id,
      "deliver-demand",
      "",
      state.controlRevision,
      crypto.randomUUID(),
    );
    state = await store.readState(id);
    const letterId = state.letters[0].id;
    await store.letterAction(id, letterId, "read");
    await store.letterAction(id, letterId, "respond", "存储测试合成回应", null);
    state = await store.readState(id);
    const responseId = state.letters[0].responseId;
    await store.saveDraft(
      id,
      letterId,
      "edit",
      "LOCAL_PRIVATE_DRAFT",
      responseId,
      1,
    );
    const dbPath = "/database.ts",
      database = await import(/* @vite-ignore */ dbPath);
    state = await database.readState(id);
    return { id, letterId, responseId, state };
  });
}
async function raw(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("cat-letters-pages-v1");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return new Promise<{ version: number; rows: unknown[]; gates: unknown[] }>(
      (resolve, reject) => {
        const stores = [
          "participants",
          ...(db.objectStoreNames.contains("accountBindings")
            ? ["accountBindings"]
            : []),
        ];
        const tx = db.transaction(stores, "readonly");
        const rows = tx.objectStore("participants").getAll();
        const gates = stores.includes("accountBindings")
          ? tx.objectStore("accountBindings").getAll()
          : null;
        tx.oncomplete = () => {
          resolve({
            version: db.version,
            rows: rows.result,
            gates: gates?.result ?? [],
          });
          db.close();
        };
        tx.onabort = () => {
          reject(tx.error);
          db.close();
        };
      },
    );
  });
}
async function expected(page: Page, id: string) {
  return page.evaluate(
    async ({ id, account, sharedModule }) => {
      const a = "/database.ts";
      const database = await import(/* @vite-ignore */ a);
      const path = "/binding-storage.ts",
        storage = await import(/* @vite-ignore */ path);
      const shared = await import(/* @vite-ignore */ sharedModule);
      const bundle = shared.buildLegacyTransfer(await database.readState(id));
      return {
        bundle,
        meta: {
          targetUrl: account,
          accountId: crypto.randomUUID(),
          key: crypto.randomUUID(),
          bundleHash: await storage.hashBindingBundle(bundle),
        },
      };
    },
    { id, account, sharedModule },
  );
}

// The test invokes production storage APIs, while assertions inspect raw IDB values.
test("v3 upgrade closes old connections, leaves every row byte-equivalent, and only reads the selected cat", async ({
  browser,
}) => {
  const producer = await browser.newContext(),
    p = await blank(producer),
    fixture = await seed(p);
  await producer.close();
  const context = await browser.newContext(),
    old = await blank(context);
  const bad = {
    schema: 3,
    participant: { id: crypto.randomUUID() },
    corruptUnrelated: "MUST_NOT_VALIDATE_OR_REWRITE",
  };
  await old.evaluate(
    async ({ good, bad }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open("cat-letters-pages-v1", 3);
        r.onupgradeneeded = () =>
          r.result.createObjectStore("participants", {
            keyPath: "participant.id",
          });
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("participants", "readwrite");
        tx.objectStore("participants").put(good);
        tx.objectStore("participants").put(bad);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      (window as any).legacyDb = db;
      (window as any).versionChangeClosed = false;
      db.onversionchange = () => {
        db.close();
        (window as any).versionChangeClosed = true;
      };
    },
    {
      good: { ...fixture.state, unknownFrozenField: { keep: "exactly" } },
      bad,
    },
  );
  const before = await raw(old);
  expect(before.version).toBe(3);
  const current = await blank(context);
  const selected = await current.evaluate(async (id) => {
    const path = "/database.ts",
      database = await import(/* @vite-ignore */ path);
    return database.readState(id);
  }, fixture.id);
  expect(selected.participant.id).toBe(fixture.id);
  expect(await old.evaluate(() => (window as any).versionChangeClosed)).toBe(
    true,
  );
  const after = await raw(current);
  expect(after.version).toBe(4);
  expect(after.rows).toEqual(before.rows);
  expect(after.gates).toEqual([]);
  const stale = await old.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const r = indexedDB.open("cat-letters-pages-v1", 3);
        r.onerror = () => resolve(r.error!.name);
        r.onsuccess = () => {
          r.result.close();
          resolve("unexpected-success");
        };
      }),
  );
  expect(stale).toBe("VersionError");
  expect((await raw(current)).rows).toEqual(before.rows);
  await context.close();
});

test("pending and bound gates reject all local writers; only exact server receipts can finish or cancel", async ({
  browser,
}) => {
  const context = await browser.newContext(),
    page = await blank(context),
    fixture = await seed(page),
    plan = await expected(page, fixture.id);
  const before = await raw(page);
  const result = await page.evaluate(
    async ({ fixture, plan }) => {
      const p = "/binding-storage.ts",
        s = await import(/* @vite-ignore */ p),
        q = "/store.ts",
        store = await import(/* @vite-ignore */ q);
      const first = await s.freezeForAccountBinding(
        fixture.id,
        plan.bundle,
        plan.meta,
      );
      const again = await s.freezeForAccountBinding(
        fixture.id,
        plan.bundle,
        plan.meta,
      );
      const reject = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
          return "UNEXPECTED_SUCCESS";
        } catch (e) {
          return (e as Error).message;
        }
      };
      const errors = [];
      for (const op of [
        () => store.readState(fixture.id),
        () => store.letterAction(fixture.id, fixture.letterId, "read"),
        () => store.letterAction(fixture.id, fixture.letterId, "skip"),
        () =>
          store.letterAction(
            fixture.id,
            fixture.letterId,
            "respond",
            "偷偷发送",
            fixture.responseId,
          ),
        () =>
          store.saveDraft(
            fixture.id,
            fixture.letterId,
            "edit",
            "偷偷写草稿",
            fixture.responseId,
            1,
          ),
        () =>
          store.control(
            fixture.id,
            "deliver-demand",
            "",
            plan.bundle.controlRevision,
            crypto.randomUUID(),
          ),
        () =>
          store.fastForward(
            fixture.id,
            "END",
            plan.bundle.controlRevision,
            crypto.randomUUID(),
          ),
        () =>
          store.editResponse(
            fixture.id,
            fixture.responseId,
            "偷偷更正",
            1,
            crypto.randomUUID(),
          ),
        () =>
          store.deleteResponse(
            fixture.id,
            fixture.responseId,
            1,
            crypto.randomUUID(),
          ),
        () =>
          store.selectReview(
            fixture.id,
            "L-RHINE",
            [],
            plan.bundle.controlRevision,
            crypto.randomUUID(),
          ),
        () =>
          store.deliverReview(
            fixture.id,
            crypto.randomUUID(),
            crypto.randomUUID(),
          ),
      ])
        errors.push(await reject(op));
      const wrongTuple = await reject(() =>
        s.freezeForAccountBinding(fixture.id, plan.bundle, {
          ...plan.meta,
          key: crypto.randomUUID(),
        }),
      );
      const receipt = {
        logicalCatId: fixture.id,
        bundleHash: plan.meta.bundleHash,
        catId: crypto.randomUUID(),
        importBatchId: crypto.randomUUID(),
        stateRevision: plan.bundle.controlRevision,
      };
      const wrongReceipt = await reject(() =>
        s.markBindingComplete(fixture.id, plan.meta.key, {
          ...receipt,
          logicalCatId: crypto.randomUUID(),
        }),
      );
      const wrongCancel = await reject(() =>
        s.releaseBindingGate(fixture.id, plan.meta.key, plan.meta.bundleHash, {
          cancelled: true,
          key: crypto.randomUUID(),
          bundleHash: plan.meta.bundleHash,
        }),
      );
      const pending = await s.readBindingGate(fixture.id);
      const bound = await s.markBindingComplete(
        fixture.id,
        plan.meta.key,
        receipt,
      );
      const boundAgain = await s.markBindingComplete(
        fixture.id,
        plan.meta.key,
        receipt,
      );
      const boundWrite = await reject(() =>
        store.letterAction(fixture.id, fixture.letterId, "read"),
      );
      const boundCancel = await reject(() =>
        s.releaseBindingGate(fixture.id, plan.meta.key, plan.meta.bundleHash, {
          cancelled: true,
          key: plan.meta.key,
          bundleHash: plan.meta.bundleHash,
        }),
      );
      return {
        first,
        again,
        errors,
        wrongTuple,
        wrongReceipt,
        wrongCancel,
        pending,
        bound,
        boundAgain,
        boundWrite,
        boundCancel,
      };
    },
    { fixture, plan },
  );
  expect(result.first).toEqual(result.again);
  expect(result.pending.phase).toBe("PENDING");
  expect(result.errors).toHaveLength(11);
  for (const message of result.errors) expect(message).toMatch(/绑定/);
  for (const message of [
    result.wrongTuple,
    result.wrongReceipt,
    result.wrongCancel,
    result.boundCancel,
  ])
    expect(message).not.toBe("UNEXPECTED_SUCCESS");
  expect(result.bound.phase).toBe("BOUND");
  expect(result.boundAgain).toEqual(result.bound);
  expect(result.boundWrite).toMatch(/绑定/);
  const after = await raw(page);
  expect(after.rows).toEqual(before.rows);
  expect(Object.keys(after.gates[0] as object).sort()).toEqual(
    ["sourceId", "targetUrl", "accountId", "key", "bundleHash", "phase"].sort(),
  );
  expect(JSON.stringify(after.gates)).not.toMatch(
    /LOCAL_PRIVATE_DRAFT|存储测试合成回应|letters|responses|calendar/,
  );
  await context.close();
});

for (const first of ["freeze", "write"] as const)
  test(`real IDB transaction competition: ${first} commits first`, async ({
    browser,
  }) => {
    const context = await browser.newContext(),
      keeper = await blank(context),
      fixture = await seed(keeper),
      plan = await expected(keeper, fixture.id);
    const writer = await blank(context),
      freezer = await blank(context),
      before = await raw(keeper);
    // Hold the same stores as both production transactions. get requests keep this real transaction alive.
    await keeper.evaluate(async () => {
      const path = "/database.ts",
        database = await import(/* @vite-ignore */ path),
        db = await database.openLocalDatabase();
      const tx = db.transaction(
        ["participants", "accountBindings"],
        "readwrite",
      );
      (window as any).releaseLock = false;
      (window as any).lockDone = false;
      const pump = () => {
        const r = tx.objectStore("participants").get("__lock__");
        r.onsuccess = () => {
          if (!(window as any).releaseLock) pump();
        };
      };
      pump();
      tx.oncomplete = () => {
        (window as any).lockDone = true;
      };
    });
    for (const page of [writer, freezer])
      await page.evaluate(() => {
        const original = IDBDatabase.prototype.transaction;
        (window as any).queued = false;
        IDBDatabase.prototype.transaction = function (
          ...args: Parameters<IDBDatabase["transaction"]>
        ) {
          const tx = original.apply(this, args);
          if (args[1] === "readwrite") (window as any).queued = true;
          return tx;
        };
      });
    const start = async (kind: "freeze" | "write") => {
      const page = kind === "freeze" ? freezer : writer;
      await page.evaluate(
        async ({ kind, fixture, plan }) => {
          const p = "/binding-storage.ts",
            s = await import(/* @vite-ignore */ p),
            q = "/database.ts",
            database = await import(/* @vite-ignore */ q);
          const promise =
            kind === "freeze"
              ? s.freezeForAccountBinding(fixture.id, plan.bundle, plan.meta)
              : database.write(fixture.id, (state: any) => ({
                  state: {
                    ...state,
                    controlRevision: state.controlRevision + 1,
                  },
                  result: true,
                }));
          (window as any).operation = promise.then(
            () => ({ ok: true }),
            (error: Error) => ({ ok: false, error: error.message }),
          );
        },
        { kind, fixture, plan },
      );
      await expect
        .poll(() => page.evaluate(() => (window as any).queued))
        .toBe(true);
    };
    await start(first);
    await start(first === "freeze" ? "write" : "freeze");
    await keeper.evaluate(() => {
      (window as any).releaseLock = true;
    });
    const w = await writer.evaluate(() => (window as any).operation),
      f = await freezer.evaluate(() => (window as any).operation),
      after = await raw(keeper);
    if (first === "freeze") {
      expect(f.ok).toBe(true);
      expect(w.ok).toBe(false);
      expect(w.error).toMatch(/绑定/);
      expect(after.rows).toEqual(before.rows);
      expect(after.gates).toHaveLength(1);
    } else {
      expect(w.ok).toBe(true);
      expect(f.ok).toBe(false);
      expect(f.error).toMatch(/预检后已变化/);
      expect(after.gates).toEqual([]);
      expect((after.rows[0] as any).controlRevision).toBe(
        (before.rows[0] as any).controlRevision + 1,
      );
      const { controlRevision: afterRevision, ...afterRest } = after
        .rows[0] as any;
      const { controlRevision: beforeRevision, ...beforeRest } = before
        .rows[0] as any;
      expect(afterRest).toEqual(beforeRest);
    }
    await context.close();
  });

test("matching cancellation removes only the pending gate and permits later local writes", async ({
  browser,
}) => {
  const context = await browser.newContext(),
    page = await blank(context),
    fixture = await seed(page),
    plan = await expected(page, fixture.id),
    before = await raw(page);
  const released = await page.evaluate(
    async ({ fixture, plan }) => {
      const p = "/binding-storage.ts",
        s = await import(/* @vite-ignore */ p);
      await s.freezeForAccountBinding(fixture.id, plan.bundle, plan.meta);
      await s.releaseBindingGate(
        fixture.id,
        plan.meta.key,
        plan.meta.bundleHash,
        {
          cancelled: true,
          key: plan.meta.key,
          bundleHash: plan.meta.bundleHash,
        },
      );
      return s.readBindingGate(fixture.id);
    },
    { fixture, plan },
  );
  expect(released).toBeNull();
  expect(await raw(page)).toEqual(before);
  await page.evaluate(async ({ id, letterId, responseId }) => {
    const p = "/store.ts",
      s = await import(/* @vite-ignore */ p);
    await s.saveDraft(
      id,
      letterId,
      "edit",
      "取消后可以继续本机草稿",
      responseId,
      1,
    );
  }, fixture);
  expect(JSON.stringify((await raw(page)).rows)).toContain(
    "取消后可以继续本机草稿",
  );
  await context.close();
});
