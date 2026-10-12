import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  db,
  clients,
  assertDedicated,
  dispose,
  client,
  json,
  login,
  allowResend,
  richFixture,
  requestExport,
  job,
  tick,
  prepare,
  confirm,
  status,
  assertPurged,
  markerAbsent,
  hash,
  snapshot,
  bind,
  lifecycle,
  origin,
} from "./helpers";

before(assertDedicated);
after(dispose);
const privacy = "/api/e4/privacy";
async function download(
  a: Awaited<ReturnType<typeof login>>,
  id: string,
  expected = 200,
) {
  const r = await a.client.get(`${privacy}/exports/${id}/download`);
  assert.equal(r.status(), expected, "Export download HTTP status");
  assert.match(r.headers()["cache-control"] ?? "", /no-store/);
  if (expected === 200) {
    assert.match(r.headers()["content-disposition"] ?? "", /attachment/);
    assert.match(r.headers()["content-type"] ?? "", /json/);
    return r.json();
  }
  return null;
}
async function finish(a: Awaited<ReturnType<typeof login>>, id: string) {
  await tick();
  const result = await status(a);
  assert.equal(result.requestId, id);
  assert.equal(result.status, "COMPLETE");
  return result;
}

test("C01 private export is a read-only consistent owner snapshot; anonymous and other accounts cannot access it", async () => {
  const a = await richFixture(),
    other = await login(),
    anonymous = await client();
  const key = randomUUID();
  const beforeRows = await snapshot();
  const [first, repeated] = await Promise.all([
    requestExport(a, key),
    requestExport(a, key),
  ]);
  assert.equal(first.id, repeated.id);
  assert.equal(first.status, "QUEUED");
  await tick();
  const ready = await job(a, first.id);
  assert.equal(ready.status, "READY");
  const duration = Date.parse(ready.expiresAt) - Date.parse(ready.createdAt);
  assert.ok(
    duration > 23.9 * 3600000 && duration <= 24.1 * 3600000,
    "Export expiry must be explicit and near 24 hours",
  );
  const payload = await download(a, first.id),
    serialized = JSON.stringify(payload);
  assert.ok(serialized.includes(a.first));
  assert.ok(serialized.includes(a.current));
  assert.ok(serialized.includes(a.response));
  assert.ok(serialized.includes(a.removedResponse));
  assert.equal(payload.format, "cat-letters-account-export");
  assert.equal(payload.version, 1);
  assert.equal(payload.account.id, a.accountId);
  assert.equal(payload.cat.logicalId, a.bundle.sourceExperienceId);
  assert.equal(payload.letters.length, 3);
  for (const original of beforeRows.cloud_letters as any[]) {
    if (original.account_id !== a.accountId) continue;
    const exported = payload.letters.find(
      (entry: any) => entry.id === original.id,
    );
    assert.ok(exported, "An owned letter is missing from export");
    assert.deepEqual(exported.snapshot, original.snapshot);
    assert.equal(
      Date.parse(exported.delivered_at),
      Date.parse(original.delivered_at),
    );
    assert.equal(Date.parse(exported.read_at), Date.parse(original.read_at));
  }
  assert.deepEqual(
    payload.responseRevisions
      .filter((r: any) => r.response_id === a.response)
      .map((r: any) => [r.revision, r.text]),
    [
      [1, a.first],
      [2, a.current],
    ],
  );
  assert.deepEqual(
    payload.responseRevisions
      .filter((r: any) => r.response_id === a.removedResponse)
      .map((r: any) => [r.revision, r.text]),
    [
      [1, null],
      [2, null],
    ],
  );
  assert.equal(payload.letterSources[0].response_id, a.response);
  assert.equal(payload.letterSources[0].revision, 1);
  assert.equal(payload.trips.length, 1);
  assert.deepEqual(payload.calendar.nodes, []);
  assert.equal(
    /code_hash|token_hash|OTP_HASH_SECRET|rawToken/.test(serialized),
    false,
  );
  const afterRows = await snapshot();
  for (const table of [
    "cloud_state",
    "cloud_calendar_nodes",
    "cloud_letters",
    "cloud_response_revisions",
    "cloud_letter_sources",
  ])
    assert.deepEqual(
      afterRows[table],
      beforeRows[table],
      `Export changed ${table}`,
    );
  const otherList = await json(other.client, "get", `${privacy}/exports`);
  assert.equal(JSON.stringify(otherList).includes(first.id), false);
  for (const path of [`exports/${first.id}`, `exports/${first.id}/download`]) {
    assert.equal((await anonymous.get(`${privacy}/${path}`)).status(), 401);
    assert.equal((await other.client.get(`${privacy}/${path}`)).status(), 404);
  }
  assert.equal((await a.client.get(`/exports/${first.id}.json`)).status(), 404);
  const mismatch = await a.client.get(`${privacy}/exports/${first.id}`, {
    headers: { "X-Catletters-Account": other.accountId },
  });
  assert.equal(mismatch.status(), 401);
});

test("C02 response deletion invalidates old export and a replacement never recovers tombstoned source text", async () => {
  const a = await richFixture(),
    old = await requestExport(a);
  await tick();
  assert.equal((await job(a, old.id)).status, "READY");
  await json(
    a.client,
    "post",
    `/api/e4/v1/responses/${encodeURIComponent(a.response)}/delete`,
    { key: randomUUID(), expectedRevision: 2 },
  );
  const rejected = await a.client.get(`${privacy}/exports/${old.id}/download`);
  assert.ok([409, 410].includes(rejected.status()));
  const fresh = await requestExport(a);
  await tick();
  const payload = JSON.stringify(await download(a, fresh.id));
  assert.equal(payload.includes(a.first), false);
  assert.equal(payload.includes(a.current), false);
  assert.ok(payload.includes(a.removedResponse));
});

test("C03 prepare is not consent, cannot authorize business, and missing confirmation or foreign Origin cannot delete", async () => {
  const a = await richFixture(),
    beforeRows = await snapshot(),
    prepared = await prepare(a);
  assert.equal(prepared.status, "PREPARED");
  assert.equal((await a.client.get("/api/e4/account")).status(), 200);
  assert.equal(
    (
      await a.client.post(`${privacy}/deletions/confirm`, {
        data: { requestId: prepared.requestId, confirm: false },
      })
    ).status(),
    400,
  );
  assert.equal(
    (
      await a.client.post(`${privacy}/deletions/confirm`, {
        data: { requestId: prepared.requestId, confirm: true },
        headers: { Origin: "https://foreign.invalid" },
      })
    ).status(),
    403,
  );
  const afterRows = await snapshot();
  for (const table of [
    "accounts",
    "cat_profiles",
    "cloud_letters",
    "cloud_response_revisions",
  ])
    assert.deepEqual(afterRows[table], beforeRows[table]);
  const recovery = (await a.client.storageState()).cookies.filter(
    (c) => c.name !== "cat_account_session",
  );
  assert.ok(recovery.length > 0);
  const onlyRecovery = await client();
  await onlyRecovery.dispose();
  const { request } = await import("@playwright/test");
  const limited = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
    storageState: { cookies: recovery, origins: [] },
  });
  clients.push(limited);
  assert.equal((await limited.get("/api/e4/account")).status(), 401);
  assert.equal(
    (await limited.get(`${privacy}/deletions/status`)).status(),
    200,
  );
  assert.equal(
    (
      await limited.post(`${privacy}/exports`, { data: { key: randomUUID() } })
    ).status(),
    401,
  );
});

test("C04 actual erasure removes all cloud and old participant records, OTP and private artifacts, preserving unrelated owner and shared content", async () => {
  const a = await richFixture(),
    other = await richFixture();
  const otherData = await snapshot(),
    exported = await requestExport(a);
  await tick();
  assert.equal((await job(a, exported.id)).status, "READY");
  await allowResend(a.email);
  const asked = await json(a.client, "post", "/api/e4/auth/request-code", {
    email: a.email,
  });
  const oldOtp = JSON.parse(
    await readFile(
      join(process.env.E4_SYNTHETIC_INBOX!, `${asked.challengeId}.json`),
      "utf8",
    ),
  );
  const challengeIds = (
    await db.query(
      "SELECT id FROM email_challenges WHERE email_normalized=$1",
      [a.email],
    )
  ).rows.map((r) => r.id);
  assert.ok(
    challengeIds.includes(a.challengeId),
    "Original registration OTP is part of erasure fixture",
  );
  const prepared = await prepare(a),
    accepted = await confirm(a, prepared.requestId);
  assert.ok(["PENDING", "COMPLETE"].includes(accepted.status));
  assert.equal((await a.client.get("/api/e4/account")).status(), 401);
  assert.equal(
    (await a.client.get(`${privacy}/exports/${exported.id}/download`)).status(),
    401,
  );
  await finish(a, prepared.requestId);
  await assertPurged(a.accountId, a.cat.participant_id, a.email);
  await markerAbsent([a.marker, a.email]);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM email_challenges WHERE id=ANY($1::uuid[])",
        [challengeIds],
      )
    ).rows[0].n,
    0,
  );
  const anonymous = await client();
  assert.equal(
    (
      await anonymous.post("/api/e4/auth/verify-code", {
        data: {
          email: a.email,
          challengeId: asked.challengeId,
          code: oldOtp.code,
        },
      })
    ).status(),
    401,
  );
  const afterRows = await snapshot();
  for (const table of ["content_versions", "cloud_content_versions"])
    assert.deepEqual(afterRows[table], otherData[table]);
  assert.equal((await other.client.get("/api/e4/account")).status(), 200);
  assert.equal(
    (
      await db.query(
        "SELECT text FROM cloud_response_revisions WHERE account_id=$1 AND response_id=$2 AND revision=2",
        [other.accountId, other.response],
      )
    ).rows[0].text,
    other.current,
  );
  const unknown = await client();
  assert.deepEqual(await json(unknown, "get", `${privacy}/deletions/status`), {
    deletion: null,
  });
});

test("C05 same email creates a new UUID; old deletion retries and a copied legacy archive cannot resurrect or erase it", async () => {
  const old = await richFixture(),
    prepared = await prepare(old);
  await confirm(old, prepared.requestId);
  await finish(old, prepared.requestId);
  const fresh = await login(old.email);
  assert.notEqual(fresh.accountId, old.accountId);
  assert.equal((await json(fresh.client, "get", "/api/e4/account")).cat, null);
  const oldImport = await fresh.client.post("/api/e4/legacy/preflight", {
    data: { bundle: old.bundle },
  });
  assert.ok([409, 410].includes(oldImport.status()));
  const newBinding = await bind(fresh);
  await allowResend(fresh.email);
  const newChallenge = await json(
    fresh.client,
    "post",
    "/api/e4/auth/request-code",
    { email: fresh.email },
  );
  await json(old.client, "post", `${privacy}/deletions/retry`, {
    requestId: prepared.requestId,
  });
  await tick();
  assert.equal((await fresh.client.get("/api/e4/account")).status(), 200);
  assert.equal(
    (
      await db.query("SELECT account_id FROM cat_profiles WHERE id=$1", [
        newBinding.cat.id,
      ])
    ).rows[0].account_id,
    fresh.accountId,
  );
  assert.equal(
    (
      await db.query("SELECT revoked_at FROM email_challenges WHERE id=$1", [
        newChallenge.challengeId,
      ])
    ).rows[0].revoked_at,
    null,
  );
  assert.equal((await status(old)).status, "COMPLETE");
});

test("C06 a real SQL erasure failure rolls back business deletion and remains frozen until explicit retry completes", async () => {
  const a = await richFixture(),
    other = await richFixture(),
    prepared = await prepare(a);
  await db.query(
    "CREATE FUNCTION e4_c_fail_erase() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic erasure failure'; END $$",
  );
  await db.query(
    "CREATE TRIGGER e4_c_fail_erase BEFORE DELETE ON cloud_letters FOR EACH ROW EXECUTE FUNCTION e4_c_fail_erase()",
  );
  try {
    await confirm(a, prepared.requestId);
    await lifecycle();
    const s = await status(a);
    assert.ok(["FAILED", "PENDING"].includes(s.status));
    assert.equal(s.completedAt, null);
    assert.equal((await a.client.get("/api/e4/account")).status(), 401);
    assert.equal(
      (await other.client.get("/api/e4/account")).status(),
      200,
      "A frozen account cleanup failure must not block unrelated accounts",
    );
    assert.equal((await other.client.get("/api/e4/v1/state")).status(), 200);
    assert.equal(
      (
        await db.query(
          "SELECT text FROM cloud_response_revisions WHERE account_id=$1 AND response_id=$2 AND revision=2",
          [a.accountId, a.response],
        )
      ).rows[0].text,
      a.current,
      "Partial erasure escaped SQL rollback",
    );
    assert.equal(JSON.stringify(s).includes(a.current), false);
  } finally {
    await db.query("DROP TRIGGER e4_c_fail_erase ON cloud_letters");
    await db.query("DROP FUNCTION e4_c_fail_erase()");
  }
  await json(a.client, "post", `${privacy}/deletions/retry`, {
    requestId: prepared.requestId,
  });
  await finish(a, prepared.requestId);
  await markerAbsent([a.marker, a.email]);
});

async function exportCall(expression: string) {
  const { child } = await import("./helpers");
  const r = await child([
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    `import * as api from './src/server/account-export.ts';import {pool} from './src/server/db.ts';try{console.log(JSON.stringify(await (${expression})));}finally{await pool.end();}`,
  ]);
  assert.equal(r.code, 0, "Export child failed; private output omitted");
  return JSON.parse(r.output.trim());
}
test("C07 two worker processes share one job; an exited claim is recoverable and a stale writer cannot destroy the newer READY bytes", async () => {
  const { spawn } = await import("node:child_process"),
    fs = await import("node:fs/promises"),
    { createHash } = await import("node:crypto");
  const a = await richFixture(),
    requested = await requestExport(a),
    claim = await exportCall("api.claimAccountExport()");
  assert.equal(claim.id, requested.id);
  const pause = join(process.env.E4_LIFECYCLE_DIR!, `pause-${randomUUID()}`),
    release = `${pause}.release`;
  const program = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=fs.openSync;let first=true;fs.openSync=function(path,...args){if(first&&String(path).includes('/exports/')&&String(path).endsWith('.tmp')){first=false;fs.writeFileSync(process.env.E4_PAUSE_PATH,'paused',{mode:0o600});const cell=new Int32Array(new SharedArrayBuffer(4));let n=0;while(!fs.existsSync(process.env.E4_RELEASE_PATH)){if(++n>300)throw Error('synthetic pause timeout');Atomics.wait(cell,0,0,50);}}return original.call(fs,path,...args);};syncBuiltinESMExports();const api=await import('./src/server/account-export.ts');const {pool}=await import('./src/server/db.ts');try{console.log(JSON.stringify(await api.runClaimedAccountExport(JSON.parse(process.env.E4_OLD_CLAIM))));}finally{await pool.end();}`;
  const p = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", program],
    {
      env: {
        ...process.env,
        E4_PAUSE_PATH: pause,
        E4_RELEASE_PATH: release,
        E4_OLD_CLAIM: JSON.stringify(claim),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  p.stdout.on("data", (d) => (output += d));
  p.stderr.on("data", () => {});
  const exited = new Promise<number | null>((resolve, reject) => {
    p.once("exit", resolve);
    p.once("error", reject);
  });
  try {
    let paused = false;
    for (let n = 0; n < 100; n++) {
      try {
        paused = (await fs.readFile(pause, "utf8")) === "paused";
      } catch {}
      if (paused) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(
      paused,
      true,
      "Old writer must pause after snapshot before artifact publication",
    );
    await db.query(
      "UPDATE account_exports SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [requested.id],
    );
    const newer = await exportCall("api.claimAccountExport()");
    assert.equal(newer.id, requested.id);
    assert.notEqual(newer.leaseToken, claim.leaseToken);
    assert.equal(
      (
        await exportCall(
          `api.runClaimedAccountExport(${JSON.stringify(newer)})`,
        )
      ).status,
      "READY",
    );
    const record = (
      await db.query(
        "SELECT artifact_name,artifact_hash,artifact_bytes FROM account_exports WHERE id=$1",
        [requested.id],
      )
    ).rows[0];
    const before = await a.client.get(
      `${privacy}/exports/${requested.id}/download`,
    );
    assert.equal(before.status(), 200);
    const beforeBytes = await before.body();
    assert.equal(
      createHash("sha256").update(beforeBytes).digest("hex"),
      record.artifact_hash,
    );
    await fs.writeFile(release, "release", { mode: 0o600 });
    assert.equal(await exited, 0);
    assert.equal(JSON.parse(output.trim()).status, "STALE");
    assert.equal((await job(a, requested.id)).status, "READY");
    const after = await a.client.get(
      `${privacy}/exports/${requested.id}/download`,
    );
    assert.equal(after.status(), 200);
    const afterBytes = await after.body();
    assert.equal(
      createHash("sha256").update(afterBytes).digest("hex"),
      record.artifact_hash,
    );
    assert.equal(afterBytes.length, Number(record.artifact_bytes));
    assert.ok(afterBytes.equals(beforeBytes));
  } finally {
    if (p.exitCode === null) p.kill("SIGKILL");
    await exited.catch(() => {});
    await fs.rm(pause, { force: true });
    await fs.rm(release, { force: true });
  }
  const repeated = await requestExport(a),
    workers = await Promise.all([lifecycle(), lifecycle()]);
  assert.ok(workers.every((r) => r.code === 0));
  assert.equal((await job(a, repeated.id)).status, "READY");
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM account_exports WHERE id=$1",
        [repeated.id],
      )
    ).rows[0].n,
    1,
  );
});

test("C08 a real artifact write failure or publication SQL failure cannot leave a downloadable READY result; explicit retry recovers", async () => {
  const fs = await import("node:fs/promises"),
    { files } = await import("./helpers");
  const a = await richFixture(),
    j = await requestExport(a),
    folder = join(process.env.E4_LIFECYCLE_DIR!, "exports"),
    saved = `${folder}.held`;
  await fs.mkdir(folder, { recursive: true });
  await fs.rename(folder, saved);
  await fs.writeFile(folder, "synthetic unavailable directory", {
    mode: 0o600,
  });
  try {
    assert.notEqual((await lifecycle()).code, 0);
  } finally {
    await fs.unlink(folder);
    await fs.rename(saved, folder);
  }
  assert.equal((await job(a, j.id)).status, "FAILED");
  assert.notEqual(
    (await a.client.get(`${privacy}/exports/${j.id}/download`)).status(),
    200,
  );
  await json(a.client, "post", `${privacy}/exports/${j.id}/retry`, {});
  await tick();
  assert.equal((await job(a, j.id)).status, "READY");
  const sqlJob = await requestExport(a);
  await db.query(
    "CREATE FUNCTION e4_c_export_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='READY' THEN RAISE EXCEPTION 'synthetic publication failure'; END IF; RETURN NEW; END $$",
  );
  await db.query(
    "CREATE TRIGGER e4_c_export_fail BEFORE UPDATE ON account_exports FOR EACH ROW EXECUTE FUNCTION e4_c_export_fail()",
  );
  try {
    assert.notEqual((await lifecycle()).code, 0);
  } finally {
    await db.query("DROP TRIGGER e4_c_export_fail ON account_exports");
    await db.query("DROP FUNCTION e4_c_export_fail()");
  }
  assert.equal((await job(a, sqlJob.id)).status, "FAILED");
  const record = (
    await db.query("SELECT artifact_name FROM account_exports WHERE id=$1", [
      sqlJob.id,
    ])
  ).rows[0];
  if (record.artifact_name)
    assert.equal(
      (await files()).includes(join(folder, record.artifact_name)),
      false,
    );
  await json(a.client, "post", `${privacy}/exports/${sqlJob.id}/retry`, {});
  await tick();
  assert.equal((await job(a, sqlJob.id)).status, "READY");
});

test("C09 expired exports fail closed; corrupted and missing artifacts become explicitly retryable before expiry cleanup", async () => {
  const fs = await import("node:fs/promises");
  const a = await richFixture(),
    j = await requestExport(a);
  await tick();
  const artifact = async () =>
    join(
      process.env.E4_LIFECYCLE_DIR!,
      "exports",
      (
        await db.query(
          "SELECT artifact_name FROM account_exports WHERE id=$1",
          [j.id],
        )
      ).rows[0].artifact_name,
    );
  for (const fault of ["corrupt", "missing"] as const) {
    const path = await artifact();
    if (fault === "corrupt")
      await fs.writeFile(path, "synthetic corruption", { mode: 0o600 });
    else await fs.unlink(path);
    assert.equal(
      (await a.client.get(`${privacy}/exports/${j.id}/download`)).status(),
      503,
    );
    assert.equal(
      (await job(a, j.id)).status,
      "FAILED",
      `${fault} artifact must not leave a falsely READY job`,
    );
    await json(a.client, "post", `${privacy}/exports/${j.id}/retry`, {});
    await tick();
    assert.equal((await job(a, j.id)).status, "READY");
    const current = await download(a, j.id);
    assert.ok(JSON.stringify(current).includes(a.current));
  }
  const path = await artifact();
  await db.query(
    "UPDATE account_exports SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [j.id],
  );
  assert.equal(
    (await a.client.get(`${privacy}/exports/${j.id}/download`)).status(),
    410,
  );
  assert.equal((await job(a, j.id)).status, "EXPIRED");
  await tick();
  await assert.rejects(fs.stat(path), { code: "ENOENT" });
});

test("C10 missing independent ledger blocks all data access and workers, and intent persisted before a failed freeze is replayed", async () => {
  const fs = await import("node:fs/promises"),
    { child, reconcile } = await import("./helpers");
  const old = await richFixture(),
    oldTask = await prepare(old);
  await confirm(old, oldTask.requestId);
  await finish(old, oldTask.requestId);
  const ledgerDir = join(process.env.E4_LIFECYCLE_DIR!, "ledger"),
    oldCopy = `${ledgerDir}.older`,
    currentCopy = `${ledgerDir}.current`;
  await fs.cp(ledgerDir, oldCopy, { recursive: true });
  const newer = await richFixture(),
    newerTask = await prepare(newer);
  await confirm(newer, newerTask.requestId);
  await finish(newer, newerTask.requestId);
  const highWater = (
    await db.query(
      "SELECT ledger_id,ledger_sequence,ledger_hash FROM lifecycle_control WHERE singleton=true",
    )
  ).rows[0];
  const rowsBeforeStaleRetry = await snapshot();
  await fs.rename(ledgerDir, currentCopy);
  await fs.rename(oldCopy, ledgerDir);
  try {
    assert.equal((await old.client.get("/api/e4/account")).status(), 503);
    assert.equal(
      (
        await old.client.post(`${privacy}/deletions/retry`, {
          data: { requestId: oldTask.requestId },
        })
      ).status(),
      503,
      "An old valid receipt must not authenticate a rolled-back independent ledger",
    );
    assert.deepEqual(
      (
        await db.query(
          "SELECT ledger_id,ledger_sequence,ledger_hash FROM lifecycle_control WHERE singleton=true",
        )
      ).rows[0],
      highWater,
      "Retry moved the database lifecycle watermark backwards",
    );
    const rowsAfterStaleRetry = await snapshot();
    for (const [table, rows] of Object.entries(rowsBeforeStaleRetry))
      if (table !== "lifecycle_control")
        assert.deepEqual(
          rowsAfterStaleRetry[table],
          rows,
          `Stale-ledger retry changed ${table}`,
        );
  } finally {
    await fs.rm(ledgerDir, { recursive: true, force: true });
    await fs.rename(currentCopy, ledgerDir);
  }
  await reconcile();
  const a = await richFixture(),
    prepared = await prepare(a),
    head = join(process.env.E4_LIFECYCLE_DIR!, "ledger", "head.json"),
    held = `${head}.held`;
  await fs.rename(head, held);
  try {
    assert.equal((await a.client.get("/api/e4/account")).status(), 503);
    assert.equal((await a.client.get(`${privacy}/exports`)).status(), 503);
    assert.notEqual(
      (await child(["--import", "tsx", "scripts/cloud-worker.ts", "--once"]))
        .code,
      0,
    );
    assert.notEqual((await lifecycle()).code, 0);
  } finally {
    await fs.rename(held, head);
  }
  await db.query(
    "CREATE FUNCTION e4_c_freeze_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='DELETING' THEN RAISE EXCEPTION 'synthetic freeze failure'; END IF; RETURN NEW; END $$",
  );
  await db.query(
    "CREATE TRIGGER e4_c_freeze_fail BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION e4_c_freeze_fail()",
  );
  try {
    assert.equal(
      (
        await a.client.post(`${privacy}/deletions/confirm`, {
          data: { requestId: prepared.requestId, confirm: true },
        })
      ).status(),
      503,
    );
    assert.equal(
      (await a.client.get("/api/e4/account")).status(),
      503,
      "Ledger intent ahead of DB must close reads",
    );
    assert.equal((await status(a)).status, "PENDING");
  } finally {
    await db.query("DROP TRIGGER e4_c_freeze_fail ON accounts");
    await db.query("DROP FUNCTION e4_c_freeze_fail()");
  }
  await reconcile();
  assert.equal((await status(a)).status, "COMPLETE");
  await assertPurged(a.accountId, a.cat.participant_id, a.email);
  await markerAbsent([a.marker, a.email]);
});
