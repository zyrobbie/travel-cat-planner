import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request, type APIRequestContext } from "@playwright/test";
import {
  db,
  clients,
  dispose,
  origin,
  child,
  lifecycle,
  assertPurged,
  markerAbsent,
  hash,
  snapshot,
} from "./helpers";
const variant = process.env.E4_RESTORE_VARIANT!;
let fixture: any, a: APIRequestContext, b: APIRequestContext;
before(async () => {
  assert.equal(
    (await db.query("SELECT current_database() AS name")).rows[0].name,
    "catletters_e4_lifecycle_restore_test",
  );
  assert.ok(["old", "new"].includes(variant));
  fixture = JSON.parse(await readFile(process.env.E4_RESTORE_FIXTURE!, "utf8"));
  a = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
    storageState: { cookies: fixture.a.cookies, origins: [] },
  });
  b = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
    storageState: { cookies: fixture.b.cookies, origins: [] },
  });
  clients.push(a, b);
});
after(dispose);

test(`RESTORE ${variant}: production restore lock blocks even a matching-watermark backup before HTTP or worker can expose restored data`, async () => {
  const before = await snapshot();
  for (const path of [
    "/api/e4/account",
    "/api/e4/v1/state",
    `/api/e4/privacy/exports/${fixture.exportId}/download`,
  ])
    assert.equal(
      (await a.get(path)).status(),
      503,
      `Restore gate did not block ${path}`,
    );
  assert.equal(
    (await b.get("/api/e4/account")).status(),
    503,
    "Unrelated survivor must wait for reconciliation too",
  );
  const worker = await child([
    "--import",
    "tsx",
    "scripts/cloud-worker.ts",
    "--once",
  ]);
  assert.notEqual(worker.code, 0);
  assert.notEqual(
    (await child(["--import", "tsx", "scripts/lifecycle-worker.ts", "--once"]))
      .code,
    0,
    "Lifecycle worker must refuse an unreconciled database",
  );
  const after = await snapshot();
  for (const table of [
    "cloud_letters",
    "cloud_calendar_nodes",
    "cloud_response_revisions",
    "accounts",
  ])
    assert.deepEqual(
      after[table],
      before[table],
      `Closed restore gate changed ${table}`,
    );
});

test(`RESTORE ${variant}: failed replay never opens the gate; successful retry purges old identity before serving or scheduling`, async () => {
  if (variant === "old") {
    assert.ok(
      (
        await db.query("SELECT 1 FROM cloud_letters WHERE account_id=$1", [
          fixture.a.accountId,
        ])
      ).rowCount,
    );
    await db.query(
      "CREATE FUNCTION e4_restore_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic replay failure'; END $$",
    );
    await db.query(
      "CREATE TRIGGER e4_restore_fail BEFORE DELETE ON cloud_letters FOR EACH ROW EXECUTE FUNCTION e4_restore_fail()",
    );
    try {
      assert.notEqual((await lifecycle("reconcile")).code, 0);
      assert.equal((await b.get("/api/e4/account")).status(), 503);
    } finally {
      await db.query("DROP TRIGGER e4_restore_fail ON cloud_letters");
      await db.query("DROP FUNCTION e4_restore_fail()");
    }
  }
  const recovery = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
    storageState: { cookies: fixture.a.recoveryCookies, origins: [] },
  });
  clients.push(recovery);
  const beforeRetry = await snapshot();
  const attempted = await recovery.post("/api/e4/privacy/deletions/retry", {
    data: { requestId: fixture.a.requestId },
  });
  assert.equal(attempted.status(), 503);
  const afterRetry = await snapshot();
  assert.deepEqual(
    afterRetry,
    beforeRetry,
    "A recovery receipt must not mutate any restored database rows before reconciliation",
  );
  assert.equal(
    (await b.get("/api/e4/account")).status(),
    503,
    "Retry of one deletion must not open an unreconciled restored database",
  );
  assert.notEqual(
    (await child(["--import", "tsx", "scripts/cloud-worker.ts", "--once"]))
      .code,
    0,
  );
  assert.equal(
    (await lifecycle("reconcile")).code,
    0,
    "Real deletion replay failed",
  );
  await assertPurged(
    fixture.a.accountId,
    fixture.a.participantId,
    fixture.a.email,
  );
  // A newer backup legitimately contains this email on the distinct fresh account.
  await markerAbsent(
    variant === "old"
      ? [fixture.a.marker, fixture.a.email]
      : [fixture.a.marker],
  );
  assert.equal((await a.get("/api/e4/account")).status(), 401);
  assert.equal(
    (
      await a.get(`/api/e4/privacy/exports/${fixture.exportId}/download`)
    ).status(),
    401,
  );
  assert.equal((await b.get("/api/e4/account")).status(), 200);
  const versions = (
    await db.query(
      "SELECT text FROM cloud_response_revisions WHERE account_id=$1 AND response_id=$2 ORDER BY revision",
      [fixture.b.accountId, fixture.b.response],
    )
  ).rows;
  assert.equal(versions.length, 2);
  assert.ok(
    versions.every((row) => row.text === null),
    "Restoration resurrected a individually deleted response revision",
  );
  assert.equal(
    (
      await db.query(
        "SELECT status FROM cloud_responses WHERE account_id=$1 AND id=$2",
        [fixture.b.accountId, fixture.b.response],
      )
    ).rows[0].status,
    "DELETED",
  );
  assert.equal(
    (
      await db.query(
        "SELECT status FROM cloud_reviews WHERE account_id=$1 AND id=$2",
        [fixture.b.accountId, fixture.b.pendingReview],
      )
    ).rows[0].status,
    "NEEDS_REVIEW",
  );
  assert.equal(
    hash(
      (
        await db.query(
          "SELECT snapshot FROM cloud_letters WHERE account_id=$1 AND id=$2",
          [fixture.b.accountId, fixture.b.postcard],
        )
      ).rows[0].snapshot,
    ),
    fixture.b.snapshotHash,
    "Response erasure rewrote an already delivered letter",
  );
  const sources = await b.get(
    `/api/e4/v1/letters/${encodeURIComponent(fixture.b.postcard)}/sources`,
  );
  assert.equal(sources.status(), 200);
  const sourceDto = await sources.json();
  assert.equal(sourceDto.sources[0].status, "DELETED");
  assert.equal("excerpt" in sourceDto.sources[0], false);
  assert.ok(
    [409, 410].includes(
      (
        await b.get(`/api/e4/privacy/exports/${fixture.b.exportId}/download`)
      ).status(),
    ),
    "Restored export exposed erased response text",
  );
  await markerAbsent([fixture.b.first, fixture.b.current]);
  if (variant === "new") {
    const fresh = await request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { Origin: origin },
      storageState: { cookies: fixture.fresh.cookies, origins: [] },
    });
    clients.push(fresh);
    assert.equal((await fresh.get("/api/e4/account")).status(), 200);
    assert.equal(
      (
        await db.query("SELECT account_id FROM cat_profiles WHERE id=$1", [
          fixture.fresh.catId,
        ])
      ).rows[0].account_id,
      fixture.fresh.accountId,
    );
  } else
    assert.equal(
      (
        await db.query("SELECT count(*)::int AS n FROM accounts WHERE id=$1", [
          fixture.fresh.accountId,
        ])
      ).rows[0].n,
      0,
      "An account created after the old backup must not be fabricated",
    );
  const once = await snapshot();
  assert.equal((await lifecycle("reconcile")).code, 0);
  const twice = await snapshot();
  for (const table of [
    "accounts",
    "cat_profiles",
    "cloud_letters",
    "cloud_response_revisions",
  ])
    assert.equal(
      hash(twice[table]),
      hash(once[table]),
      `Repeated ledger replay changed ${table}`,
    );
  const worker = await child([
    "--import",
    "tsx",
    "scripts/cloud-worker.ts",
    "--once",
  ]);
  assert.equal(worker.code, 0);
  assert.equal(
    (await child(["--import", "tsx", "scripts/lifecycle-worker.ts", "--once"]))
      .code,
    0,
    "Lifecycle worker must execute after explicit reconciliation",
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM cloud_letters WHERE account_id=$1",
        [fixture.a.accountId],
      )
    ).rows[0].n,
    0,
  );
});
