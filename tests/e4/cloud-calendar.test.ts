import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { request, type APIRequestContext } from "@playwright/test";
import { pool, transaction } from "../../src/server/db";
import { requestCode, verifyCode } from "../../src/server/account-auth";
import {
  adoptCat,
  freezeAccountForDeletion,
} from "../../src/server/account-service";
import { SyntheticMailbox } from "../../src/server/otp-delivery";
import {
  withCloudCat,
  cloudState,
  readCloudLetter,
} from "../../src/server/cloud-repository";
import {
  sendCloudResponse,
  editCloudResponse,
  deleteCloudResponse,
} from "../../src/server/cloud-responses";
import {
  cloudContentItems,
  cloudContentHash,
} from "../../src/server/cloud-content";
import { initializeCloudCalendar } from "../../src/server/cloud-calendar";
import {
  claimCloudJob,
  runClaimedCloudJob,
  CLOUD_JOB_LEASE_SECONDS,
} from "../../src/server/cloud-worker";

// All acceleration below changes timestamps in the disposable test database.
// No production time override, fake timers, browser storage, or HTTP fast-forward.
const DAY = 86_400_000;
const EXPECTED = [
  [1, "DEMAND", "D-03", null],
  [3, "DEMAND", "D-04", null],
  [5, "DEMAND", "D-02", null],
  [6, "START", null, "FIREFLY"],
  [7, "POSTCARD", null, "FIREFLY"],
  [8, "END", null, "FIREFLY"],
  [9, "DEMAND", "D-05", null],
  [10, "DEMAND", "D-01", null],
  [11, "DEMAND", "D-06", null],
  [12, "START", null, "LIGHTHOUSE"],
  [13, "POSTCARD", null, "LIGHTHOUSE"],
  [14, "END", null, "LIGHTHOUSE"],
] as const;
const origin = process.env.E4_TEST_ORIGIN!;
assert.ok(origin, "Run scripts/test-e4-calendar.mjs");
const clients: APIRequestContext[] = [];
const mailbox = new SyntheticMailbox();
type Cat = {
  accountId: string;
  rawToken: string;
  catId: string;
  participantId: string;
  adoptionKey: string;
};
after(async () => {
  await Promise.all(clients.map((client) => client.dispose()));
  await pool.end();
});
async function one(sql: string, values: unknown[] = []) {
  const result = await pool.query(sql, values);
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}
async function newAccount() {
  const email = `calendar-${randomUUID()}@example.test`,
    challenge = await requestCode(email, mailbox);
  return verifyCode(
    challenge.challengeId,
    email,
    mailbox.messages.get(challenge.challengeId)!.code,
  );
}
async function newCat(): Promise<Cat> {
  const login = await newAccount(),
    adoptionKey = randomUUID();
  const adopted = await adoptCat(login.accountId, {
    name: "日历合成",
    appearanceId: "cat-01",
    key: adoptionKey,
  });
  return {
    ...login,
    adoptionKey,
    catId: adopted.cat.id,
    participantId: adopted.cat.participant_id,
  };
}
// Hold a real account row lock, observe both independent transactions waiting
// in PostgreSQL, then release them in the requested acquisition order.
async function raceAtAccountLock(
  cat: Cat,
  first: () => Promise<unknown>,
  second: () => Promise<unknown>,
) {
  const blocker = await pool.connect();
  const pending: Promise<PromiseSettledResult<unknown>>[] = [];
  async function waitForBlocked(count: number) {
    const deadline = Date.now() + 3000;
    do {
      const row = await one(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname=current_database() AND wait_event_type='Lock'
         AND query='SELECT * FROM accounts WHERE id=$1 FOR UPDATE'`,
      );
      if (row.n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.fail(`Expected ${count} actual PostgreSQL account-lock waiters`);
  }
  function start(fn: () => Promise<unknown>) {
    pending.push(
      fn().then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      ),
    );
  }
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [
      cat.accountId,
    ]);
    start(first);
    await waitForBlocked(1);
    start(second);
    await waitForBlocked(2);
    await blocker.query("COMMIT");
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await Promise.all(pending);
  }
  return (await Promise.all(pending)).map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}
async function apiClient(cat: Cat) {
  const client = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
    storageState: {
      cookies: [
        {
          name: "cat_account_session",
          value: cat.rawToken,
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Strict",
        },
      ],
      origins: [],
    },
  });
  clients.push(client);
  return client;
}
async function body(
  response: Awaited<ReturnType<APIRequestContext["get"]>>,
  status = 200,
): Promise<any> {
  const value = await response.json();
  assert.equal(response.status(), status, JSON.stringify(value));
  return value;
}
async function nodes(cat: Cat) {
  return (
    await pool.query(
      "SELECT * FROM cloud_calendar_nodes WHERE cat_id=$1 ORDER BY planned_at,node_order",
      [cat.catId],
    )
  ).rows;
}
async function letters(cat: Cat) {
  return (
    await pool.query(
      "SELECT * FROM cloud_letters WHERE cat_id=$1 ORDER BY delivered_at,id",
      [cat.catId],
    )
  ).rows;
}
async function job(cat: Cat) {
  return one("SELECT * FROM cloud_jobs WHERE cat_id=$1", [cat.catId]);
}
async function due(cat: Cat, ids: string[]) {
  await pool.query(
    `UPDATE cloud_calendar_nodes SET planned_at=clock_timestamp()-interval '10 seconds'+node_order*interval '1 millisecond'
    WHERE cat_id=$1 AND id=ANY($2::text[]) AND result_outcome IS NULL`,
    [cat.catId, ids],
  );
  await pool.query(
    "UPDATE cloud_jobs SET next_run_at=clock_timestamp()-interval '1 second' WHERE cat_id=$1 AND status<>'COMPLETE'",
    [cat.catId],
  );
}
async function allDue(cat: Cat) {
  await pool.query(
    `UPDATE cloud_calendar_nodes SET planned_at=clock_timestamp()-interval '1 day'+(planned_at-c.base_at)/1000
    FROM cloud_calendars c WHERE cloud_calendar_nodes.cat_id=$1 AND c.cat_id=cloud_calendar_nodes.cat_id AND result_outcome IS NULL`,
    [cat.catId],
  );
  await pool.query(
    "UPDATE cloud_jobs SET next_run_at=clock_timestamp()-interval '1 second' WHERE cat_id=$1 AND status<>'COMPLETE'",
    [cat.catId],
  );
}
async function runNode(
  argv: string[],
  extraEnv: Record<string, string | undefined> = {},
) {
  const child = spawn(process.execPath, argv, {
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    error = "";
  child.stdout.on("data", (value) => {
    output += value;
  });
  child.stderr.on("data", (value) => {
    error += value;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error("Worker child exceeded 15-second test bound"));
    }, 15000);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  return { code, output, error };
}
async function cli(extraEnv: Record<string, string | undefined> = {}) {
  return runNode(
    ["--import", "tsx", "scripts/cloud-worker.ts", "--once"],
    extraEnv,
  );
}
async function successfulWorker() {
  const result = await cli();
  assert.equal(result.code, 0, `${result.output}\n${result.error}`);
  return result;
}
async function claimAndExit() {
  const result = await runNode([
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    "import {claimCloudJob} from './src/server/cloud-worker.ts'; import {pool} from './src/server/db.ts'; const claim=await claimCloudJob(); console.log(JSON.stringify(claim)); await pool.end(); process.exit(0);",
  ]);
  assert.equal(result.code, 0, result.error);
  return JSON.parse(result.output.trim());
}
async function temporaryResponse(cat: Cat, text = "可以休息，也可以陪着你。") {
  const id = `${cat.catId}:synthetic-demand:${randomUUID()}`;
  await pool.query(
    "INSERT INTO cloud_letters(id,cat_id,account_id,type,snapshot,read_at,origin) VALUES($1,$2,$3,'DEMAND',$4,now(),'LEGACY')",
    [
      id,
      cat.catId,
      cat.accountId,
      { title: "合成依据", body: "仅测试fixture", catName: "日历合成" },
    ],
  );
  const sent = await sendCloudResponse(cat.accountId, id, {
    text,
    key: randomUUID(),
    expectedResponseId: null,
  });
  assert.ok(sent.responseId);
  return { id: sent.responseId, letterId: id, text };
}

test("OFFLINE 01: persisted approved 13-node plan and worker delivery while HTTP is stopped", async () => {
  assert.equal(
    (await one("SELECT current_database() AS name")).name,
    "catletters_e4_calendar_test",
  );
  await assert.rejects(
    fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) }),
  );
  const cat = await newCat(),
    initial = await nodes(cat);
  const cal = await one("SELECT * FROM cloud_calendars WHERE cat_id=$1", [
    cat.catId,
  ]);
  assert.equal(initial.length, 13);
  assert.equal(Number(cal.offset_ms), 0);
  assert.equal(cal.processed_count, 0);
  const welcome = initial.find((n) => n.id === "welcome:d0")!;
  const delay = welcome.planned_at.getTime() - cal.initialized_at.getTime();
  assert.ok(delay >= 300000 && delay <= 600000);
  assert.equal(welcome.content_id, "D-07");
  for (const [day, kind, content, scene] of EXPECTED) {
    const node = initial.find((n) => n.id === `fixed:d${day}`)!;
    assert.equal(node.planned_at.getTime() - cal.base_at.getTime(), day * DAY);
    assert.equal(node.kind, kind);
    assert.equal(node.content_id, content);
    assert.equal(node.scene, scene);
  }
  for (const [start, post, end] of [
    [6, 7, 8],
    [12, 13, 14],
  ]) {
    const get = (day: number) =>
      initial.find((n) => n.id === `fixed:d${day}`)!.trip_id;
    assert.equal(get(start), get(post));
    assert.equal(get(post), get(end));
  }
  assert.notEqual(
    initial.find((n) => n.id === "fixed:d6")!.trip_id,
    initial.find((n) => n.id === "fixed:d12")!.trip_id,
  );
  await adoptCat(cat.accountId, {
    name: "日历合成",
    appearanceId: "cat-01",
    key: cat.adoptionKey,
  });
  await withCloudCat(cat.accountId, (db, context) =>
    initializeCloudCalendar(db, context),
  );
  assert.deepEqual(
    await nodes(cat),
    initial,
    "Retry must retain D0 delay, node IDs, trip IDs and dates",
  );
  await due(cat, ["welcome:d0"]);
  await successfulWorker();
  const delivered = await letters(cat);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].content_id, "D-07");
  assert.equal(delivered[0].read_at, null);
  const expected = cloudContentItems.find((c) => c.id === "D-07")!;
  assert.equal(delivered[0].snapshot.body, expected.body);
  assert.equal(delivered[0].snapshot.tip, expected.tip);
  assert.equal(
    (await nodes(cat)).find((n) => n.id === "welcome:d0")!.result_outcome,
    "APPLIED",
  );
  await successfulWorker();
  assert.equal(
    (await letters(cat)).length,
    1,
    "After-commit rerun must not duplicate delivery",
  );
  await assert.rejects(
    fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) }),
  );
  // All elapsed nodes still move the world to HOME with zero responses; unread
  // D0 permanently occupies the slot for all later demand/postcard attempts.
  await allDue(cat);
  await successfulWorker();
  assert.equal(
    (await nodes(cat)).filter((n) => n.result_outcome !== null).length,
    13,
  );
  assert.equal((await letters(cat)).length, 1);
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM cloud_trips WHERE cat_id=$1 AND status='COMPLETE'",
        [cat.catId],
      )
    ).n,
    2,
  );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM cloud_responses WHERE cat_id=$1",
        [cat.catId],
      )
    ).n,
    0,
  );
  assert.equal((await job(cat)).status, "COMPLETE");
});

test("OFFLINE 02: exited claimant, expired leases, stale token and stale completion cannot commit", async () => {
  const cat = await newCat();
  await due(cat, ["welcome:d0"]);
  assert.equal(CLOUD_JOB_LEASE_SECONDS, 60);
  const original = await claimAndExit();
  assert.equal(original.catId, cat.catId);
  assert.equal((await job(cat)).status, "LEASED");
  assert.equal((await letters(cat)).length, 0);
  await pool.query(
    "UPDATE cloud_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE cat_id=$1",
    [cat.catId],
  );
  const replacement = await claimCloudJob();
  assert.ok(replacement);
  assert.equal(replacement.catId, cat.catId);
  assert.notEqual(replacement.leaseToken, original.leaseToken);
  assert.equal((await runClaimedCloudJob(original)).status, "STALE");
  assert.equal((await letters(cat)).length, 0);
  assert.equal((await runClaimedCloudJob(replacement)).status, "SETTLED");
  assert.equal((await runClaimedCloudJob(original)).status, "STALE");
  assert.equal((await letters(cat)).length, 1);
  const expiring = await newCat();
  await due(expiring, ["welcome:d0"]);
  const lease = await claimCloudJob();
  assert.ok(lease);
  assert.equal(lease.catId, expiring.catId);
  await pool.query(
    `CREATE FUNCTION e4_calendar_slow_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$`,
  );
  await pool.query(
    "CREATE TRIGGER e4_calendar_slow BEFORE INSERT ON cloud_letters FOR EACH ROW EXECUTE FUNCTION e4_calendar_slow_insert()",
  );
  await pool.query(
    "UPDATE cloud_jobs SET lease_until=clock_timestamp()+interval '150 milliseconds' WHERE cat_id=$1",
    [expiring.catId],
  );
  try {
    assert.equal((await runClaimedCloudJob(lease)).status, "STALE");
  } finally {
    await pool.query("DROP TRIGGER e4_calendar_slow ON cloud_letters");
    await pool.query("DROP FUNCTION e4_calendar_slow_insert()");
  }
  assert.equal(
    (await letters(expiring)).length,
    0,
    "Lease expiry during SQL work must roll back the letter",
  );
  assert.equal(
    (await nodes(expiring)).find((n) => n.id === "welcome:d0")!.result_outcome,
    null,
  );
  await successfulWorker();
  assert.equal((await letters(expiring)).length, 1);
});

test("OFFLINE 03: SQL fault rolls back letters and node outcomes; restart retry and bounded failure ledger", async () => {
  const cat = await newCat();
  await due(cat, ["welcome:d0"]);
  await pool.query(
    `CREATE FUNCTION e4_calendar_fail_node() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.result_outcome IS NULL AND NEW.result_outcome IS NOT NULL THEN RAISE EXCEPTION 'synthetic node commit failure'; END IF; RETURN NEW; END $$`,
  );
  await pool.query(
    "CREATE TRIGGER e4_calendar_fail BEFORE UPDATE ON cloud_calendar_nodes FOR EACH ROW EXECUTE FUNCTION e4_calendar_fail_node()",
  );
  try {
    const failed = await cli();
    assert.equal(failed.code, 1, failed.output);
    assert.equal((await letters(cat)).length, 0);
    assert.equal(
      (await nodes(cat)).find((n) => n.id === "welcome:d0")!.result_outcome,
      null,
    );
    const state = await job(cat);
    assert.equal(state.status, "READY");
    assert.equal(state.attempts, 1);
    assert.ok(state.last_error);
    assert.equal(state.lease_token, null);
  } finally {
    await pool.query("DROP TRIGGER e4_calendar_fail ON cloud_calendar_nodes");
  }
  await pool.query(
    "UPDATE cloud_jobs SET next_run_at=clock_timestamp()-interval '1 second' WHERE cat_id=$1",
    [cat.catId],
  );
  await successfulWorker();
  assert.equal((await letters(cat)).length, 1);
  assert.equal(
    (await nodes(cat)).find((n) => n.id === "welcome:d0")!.result_outcome,
    "APPLIED",
  );
  const bounded = await newCat();
  await due(bounded, ["welcome:d0"]);
  await pool.query(
    "CREATE TRIGGER e4_calendar_fail BEFORE UPDATE ON cloud_calendar_nodes FOR EACH ROW EXECUTE FUNCTION e4_calendar_fail_node()",
  );
  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      await pool.query(
        "UPDATE cloud_jobs SET next_run_at=clock_timestamp()-interval '1 second' WHERE cat_id=$1",
        [bounded.catId],
      );
      const result = await cli();
      assert.equal(result.code, 1);
      assert.equal((await job(bounded)).attempts, attempt);
    }
  } finally {
    await pool.query("DROP TRIGGER e4_calendar_fail ON cloud_calendar_nodes");
    await pool.query("DROP FUNCTION e4_calendar_fail_node()");
  }
  assert.equal((await job(bounded)).status, "FAILED");
  assert.equal((await letters(bounded)).length, 0);
  assert.equal(
    (await nodes(bounded)).find((n) => n.id === "welcome:d0")!.result_outcome,
    null,
    "Technical failures are not permanent business SKIPPED results",
  );
  const wrongKind = await newCat();
  await pool.query(
    "INSERT INTO cloud_letters(id,cat_id,account_id,type,snapshot,origin) VALUES($1,$2,$3,'DEMAND',$4,'LEGACY')",
    [
      `${wrongKind.catId}:old:unread`,
      wrongKind.catId,
      wrongKind.accountId,
      {
        title: "合成旧信",
        body: "占位不应掩盖内容类型错误",
        catName: "日历合成",
      },
    ],
  );
  await due(wrongKind, ["welcome:d0"]);
  await pool.query(
    "UPDATE cloud_calendar_nodes SET content_id='L-FIREFLY' WHERE cat_id=$1 AND id='welcome:d0'",
    [wrongKind.catId],
  );
  const wrongTypeResult = await cli();
  assert.equal(wrongTypeResult.code, 1, wrongTypeResult.output);
  assert.equal((await letters(wrongKind)).length, 1);
  assert.equal(
    (await nodes(wrongKind)).find((n) => n.id === "welcome:d0")!.result_outcome,
    null,
    "A corrupt content kind must roll back even when an unread letter would otherwise skip delivery",
  );
  assert.equal((await job(wrongKind)).attempts, 1);
  await pool.query(
    "UPDATE cloud_calendar_nodes SET content_id='D-07' WHERE cat_id=$1 AND id='welcome:d0'",
    [wrongKind.catId],
  );
  await pool.query(
    "UPDATE cloud_jobs SET next_run_at=clock_timestamp()-interval '1 second' WHERE cat_id=$1",
    [wrongKind.catId],
  );
  await successfulWorker();
  assert.equal((await letters(wrongKind)).length, 1);
  assert.equal(
    (await nodes(wrongKind)).find((n) => n.id === "welcome:d0")!.result_outcome,
    "SKIPPED",
    "After repairing the fixture, the occupied unread slot may be skipped normally",
  );
});

test("OFFLINE 04: unavailable database exits boundedly; healthy restart delivers; PUBLIC worker refuses", async () => {
  const cat = await newCat();
  await due(cat, ["welcome:d0"]);
  const bad = new URL(process.env.DATABASE_URL!);
  bad.port = new URL(origin).port;
  const failed = await cli({ DATABASE_URL: bad.href });
  assert.notEqual(failed.code, 0);
  assert.equal((await letters(cat)).length, 0);
  assert.equal((await job(cat)).attempts, 0);
  const blocked = await cli({ APP_MODE: "PUBLIC" });
  assert.notEqual(blocked.code, 0);
  assert.equal((await letters(cat)).length, 0);
  await successfulWorker();
  assert.equal((await letters(cat)).length, 1);
});

test("ONLINE 01: adoption initializes atomically, retries do not replan, old cats are not backfilled", async () => {
  const account = await newAccount(),
    key = randomUUID();
  const oldParticipants = (
    await one("SELECT count(*)::int AS n FROM participants")
  ).n;
  await pool.query(
    `CREATE FUNCTION e4_calendar_fail_init() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic calendar init failure'; END $$`,
  );
  await pool.query(
    "CREATE TRIGGER e4_calendar_fail BEFORE INSERT ON cloud_jobs FOR EACH ROW EXECUTE FUNCTION e4_calendar_fail_init()",
  );
  try {
    await assert.rejects(
      adoptCat(account.accountId, {
        name: "初始化合成",
        appearanceId: "cat-03",
        key,
      }),
      /synthetic calendar init/,
    );
  } finally {
    await pool.query("DROP TRIGGER e4_calendar_fail ON cloud_jobs");
    await pool.query("DROP FUNCTION e4_calendar_fail_init()");
  }
  assert.equal(
    (
      await pool.query("SELECT id FROM cat_profiles WHERE account_id=$1", [
        account.accountId,
      ])
    ).rowCount,
    0,
  );
  for (const table of [
    "cloud_state",
    "cloud_calendars",
    "cloud_calendar_nodes",
    "cloud_jobs",
    "account_requests",
  ]) {
    assert.equal(
      (
        await pool.query(`SELECT 1 FROM ${table} WHERE account_id=$1`, [
          account.accountId,
        ])
      ).rowCount,
      0,
    );
  }
  assert.equal(
    (await one("SELECT count(*)::int AS n FROM participants")).n,
    oldParticipants,
  );
  const adopted = await adoptCat(account.accountId, {
    name: "初始化合成",
    appearanceId: "cat-03",
    key,
  });
  const cat = {
    ...account,
    adoptionKey: key,
    catId: adopted.cat.id,
    participantId: adopted.cat.participant_id,
  };
  const before = await nodes(cat);
  await adoptCat(account.accountId, {
    name: "初始化合成",
    appearanceId: "cat-03",
    key,
  });
  assert.deepEqual(await nodes(cat), before);
  assert.equal(before.length, 13);
  // Represent an existing A/B1 cat lacking a calendar; the public reads must not
  // invent D0 for this legacy profile. The normal adoption above is already proven.
  const legacy = await newCat();
  await transaction(async (db) => {
    await db.query("DELETE FROM cloud_jobs WHERE cat_id=$1", [legacy.catId]);
    await db.query("DELETE FROM cloud_calendar_nodes WHERE cat_id=$1", [
      legacy.catId,
    ]);
    await db.query("DELETE FROM cloud_calendars WHERE cat_id=$1", [
      legacy.catId,
    ]);
  });
  const client = await apiClient(legacy);
  assert.equal(
    (await body(await client.get("/api/e4/v1/state"))).cat.id,
    legacy.catId,
  );
  assert.equal((await nodes(legacy)).length, 0);
  assert.equal((await letters(legacy)).length, 0);
});

test("ONLINE 02: complete ordinary fallback, missing ordinary skips without fake content, no public time or review override", async () => {
  const cat = await newCat(),
    client = await apiClient(cat);
  await due(cat, ["fixed:d12"]);
  await successfulWorker();
  const version = await one(
    "SELECT * FROM cloud_content_versions WHERE content_id='O-LIGHTHOUSE-01'",
  );
  await pool.query(
    "DELETE FROM cloud_content_versions WHERE content_id=$1 AND version=$2",
    [version.content_id, version.version],
  );
  try {
    await due(cat, ["fixed:d13"]);
    await successfulWorker();
  } finally {
    await pool.query(
      "INSERT INTO cloud_content_versions(content_id,version,type,payload,body_checksum,payload_checksum) VALUES($1,$2,$3,$4,$5,$6)",
      [
        version.content_id,
        version.version,
        version.type,
        version.payload,
        version.body_checksum,
        version.payload_checksum,
      ],
    );
  }
  assert.equal((await letters(cat)).length, 0);
  const skipped = (await nodes(cat)).find((n) => n.id === "fixed:d13")!;
  assert.equal(skipped.result_outcome, "SKIPPED");
  assert.match(skipped.result_reason, /正文/);
  await body(
    await client.post("/api/e4/v1/fast-forward", { data: { days: 14 } }),
    404,
  );
  await body(
    await client.post("/api/e4/v1/deliver", {
      data: { storyId: "L-FIREFLY", attested: true },
    }),
    404,
  );
  await body(
    await client.post("/api/e4/admin/reviews", {
      data: { accountId: cat.accountId, attested: true },
    }),
    401,
  );
});

test("ONLINE 03: sequential zero-response calendar sends seven demands and two full ordinary postcards then exhausts", async () => {
  const cat = await newCat(),
    client = await apiClient(cat);
  const schedule = ["welcome:d0", ...EXPECTED.map(([day]) => `fixed:d${day}`)];
  for (const id of schedule) {
    await due(cat, [id]);
    await successfulWorker();
    const node = (await nodes(cat)).find((n) => n.id === id)!;
    assert.equal(node.result_outcome, "APPLIED", node.result_reason);
    const state = await body(await client.get("/api/e4/v1/state"));
    if (node.kind === "START") assert.equal(state.world.status, "TRAVEL");
    if (node.kind === "END") assert.equal(state.world.status, "HOME");
    if (node.letter_id) {
      const letter = await one(
        "SELECT * FROM cloud_letters WHERE cat_id=$1 AND id=$2",
        [cat.catId, node.letter_id],
      );
      const expected = cloudContentItems.find(
        (c) => c.id === letter.content_id,
      )!;
      assert.ok(expected);
      assert.equal(letter.snapshot.body, expected.body);
      assert.equal(letter.snapshot.title, expected.title);
      assert.equal(letter.snapshot.contentVersion, expected.version);
      assert.equal(letter.planned_at.getTime(), node.planned_at.getTime());
      assert.ok(letter.effective_at);
      assert.ok(letter.delivered_at);
      assert.equal(letter.read_at, null);
      const opened = await body(
        await client.post(
          `/api/e4/v1/letters/${encodeURIComponent(letter.id)}/read`,
        ),
      );
      assert.equal(opened.firstRead, true);
      assert.equal(opened.letter.snapshot.body, expected.body);
    }
  }
  const delivered = await letters(cat);
  assert.deepEqual(
    delivered
      .filter((l) => l.type === "DEMAND")
      .map((l) => l.content_id)
      .sort(),
    ["D-01", "D-02", "D-03", "D-04", "D-05", "D-06", "D-07"],
  );
  assert.deepEqual(
    delivered
      .filter((l) => l.type === "POSTCARD")
      .map((l) => l.content_id)
      .sort(),
    ["O-FIREFLY-01", "O-LIGHTHOUSE-01"],
  );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM cloud_responses WHERE cat_id=$1",
        [cat.catId],
      )
    ).n,
    0,
  );
  assert.equal(
    (
      await one("SELECT processed_count FROM cloud_calendars WHERE cat_id=$1", [
        cat.catId,
      ])
    ).processed_count,
    13,
  );
  assert.equal((await job(cat)).status, "COMPLETE");
  assert.equal((await job(cat)).next_run_at, null);
  await successfulWorker();
  assert.equal((await letters(cat)).length, 9);
  assert.equal(
    (await body(await client.get("/api/e4/v1/letters"))).letters.length,
    9,
  );
  assert.equal(
    (
      await body(
        await client.post(
          `/api/e4/v1/letters/${encodeURIComponent(delivered[0].id)}/read`,
        ),
      )
    ).firstRead,
    false,
  );
});

test("ONLINE 04: earliest due wins; read settles before clearing slot; existing multiple unread are preserved", async () => {
  const cat = await newCat(),
    client = await apiClient(cat);
  await due(cat, ["welcome:d0"]);
  await successfulWorker();
  const welcome = (await letters(cat))[0];
  await due(cat, ["fixed:d1", "fixed:d3", "fixed:d5"]);
  const read = await body(
    await client.post(
      `/api/e4/v1/letters/${encodeURIComponent(welcome.id)}/read`,
    ),
  );
  assert.equal(read.firstRead, true);
  for (const id of ["fixed:d1", "fixed:d3", "fixed:d5"])
    assert.equal(
      (await nodes(cat)).find((n) => n.id === id)!.result_outcome,
      "SKIPPED",
    );
  assert.equal((await letters(cat)).length, 1);
  await body(await client.get("/api/e4/v1/state"));
  assert.equal(
    (await letters(cat)).length,
    1,
    "Reading must not backfill skipped nodes",
  );
  const batch = await newCat();
  await due(batch, ["fixed:d1", "fixed:d3", "fixed:d5"]);
  await successfulWorker();
  assert.deepEqual(
    (await letters(batch)).map((l) => l.content_id),
    ["D-03"],
  );
  assert.equal(
    (await nodes(batch)).find((n) => n.id === "fixed:d3")!.result_outcome,
    "SKIPPED",
  );
  const multi = await newCat();
  for (const type of ["DEMAND", "POSTCARD"])
    await pool.query(
      "INSERT INTO cloud_letters(id,cat_id,account_id,type,snapshot,origin) VALUES($1,$2,$3,$4,$5,'LEGACY')",
      [
        `${multi.catId}:old:${type}`,
        multi.catId,
        multi.accountId,
        type,
        { title: "合成旧信", body: "已有多未读保留", catName: "日历合成" },
      ],
    );
  await due(multi, ["welcome:d0", "fixed:d1"]);
  await successfulWorker();
  assert.equal((await letters(multi)).length, 2);
  assert.equal(
    (await letters(multi)).filter((l) => l.read_at === null).length,
    2,
  );
  assert.equal(
    (await nodes(multi)).filter((n) => n.result_outcome === "SKIPPED").length,
    2,
  );
});

test("ONLINE 05: two CLI workers race foreground settlement without duplicate letters or node results", async () => {
  const cat = await newCat(),
    client = await apiClient(cat);
  await due(cat, ["welcome:d0"]);
  const results = await Promise.all([
    cli(),
    cli(),
    client.get("/api/e4/v1/state").then((response) => body(response)),
  ]);
  assert.equal((results[0] as any).code, 0);
  assert.equal((results[1] as any).code, 0);
  assert.equal((await letters(cat)).length, 1);
  assert.equal(
    (
      await one("SELECT processed_count FROM cloud_calendars WHERE cat_id=$1", [
        cat.catId,
      ])
    ).processed_count,
    1,
  );
  const node = (await nodes(cat)).find((n) => n.id === "welcome:d0")!;
  assert.equal(node.result_outcome, "APPLIED");
  assert.equal(node.letter_id, (await letters(cat))[0].id);
  const before = await nodes(cat);
  await Promise.all([cli(), client.get("/api/e4/v1/letters")]);
  assert.deepEqual(await nodes(cat), before);
});

async function adminClient() {
  const initial = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
  });
  clients.push(initial);
  const login = await initial.post("/api/admin/login", {
    data: { secret: process.env.ADMIN_SECRET },
  });
  assert.equal(login.status(), 200);
  const cookies = (await initial.storageState()).cookies.map((cookie) => ({
    ...cookie,
    secure: false,
  }));
  const client = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
    storageState: { cookies, origins: [] },
  });
  clients.push(client);
  return client;
}
async function linkedFixture() {
  const cat = await newCat(),
    source = await temporaryResponse(cat, "我愿意陪着你，小小的心意也有价值。");
  await due(cat, ["fixed:d6"]);
  await successfulWorker();
  const trip = await one(
    "SELECT * FROM cloud_trips WHERE cat_id=$1 AND status='ACTIVE'",
    [cat.catId],
  );
  const state = await cloudState(cat.accountId);
  const sources = ["companionship", "care_value"].map((claim) => ({
    claim,
    responseId: source.id,
    revision: 1,
    start: 0,
    end: source.text.length,
    assessment: "SUPPORTED",
    attested: true,
  }));
  return {
    cat,
    source,
    trip,
    input: {
      accountId: cat.accountId,
      tripId: trip.id,
      storyId: "L-FIREFLY",
      sources,
      expectedStateRevision: state.stateRevision,
      key: randomUUID(),
    },
  };
}
test("ONLINE 06: only protected complete human review authorizes linked; unverified or incomplete evidence uses full ordinary", async () => {
  const admin = await adminClient(),
    valid = await linkedFixture(),
    user = await apiClient(valid.cat);
  await body(
    await user.post("/api/e4/admin/reviews", { data: valid.input }),
    401,
  );
  const chosen = await body(
    await admin.post("/api/e4/admin/reviews", { data: valid.input }),
  );
  assert.ok(chosen.reviewId);
  assert.deepEqual(
    await body(
      await admin.post("/api/e4/admin/reviews", { data: valid.input }),
    ),
    chosen,
  );
  assert.equal(
    (
      await one("SELECT review_authority FROM cloud_reviews WHERE id=$1", [
        chosen.reviewId,
      ])
    ).review_authority,
    "INTERNAL_ADMIN",
  );
  await due(valid.cat, ["fixed:d7"]);
  await successfulWorker();
  const linked = (await letters(valid.cat)).find((l) => l.type === "POSTCARD")!;
  assert.equal(linked.content_id, "L-FIREFLY");
  assert.equal(
    linked.snapshot.body,
    cloudContentItems.find((c) => c.id === "L-FIREFLY")!.body,
  );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM cloud_letter_sources WHERE cat_id=$1 AND letter_id=$2",
        [valid.cat.catId, linked.id],
      )
    ).n,
    2,
  );
  const incomplete = await linkedFixture();
  await body(
    await admin.post("/api/e4/admin/reviews", {
      data: {
        ...incomplete.input,
        sources: incomplete.input.sources.slice(0, 1),
      },
    }),
  );
  await due(incomplete.cat, ["fixed:d7"]);
  await successfulWorker();
  const ordinary = (await letters(incomplete.cat)).find(
    (l) => l.type === "POSTCARD",
  )!;
  assert.equal(ordinary.content_id, "O-FIREFLY-01");
  assert.equal(
    ordinary.snapshot.body,
    cloudContentItems.find((c) => c.id === "O-FIREFLY-01")!.body,
  );
  const legacy = await linkedFixture(),
    reviewId = randomUUID();
  await pool.query(
    "INSERT INTO cloud_reviews(id,cat_id,account_id,trip_id,story_id,fallback_id,kind,status) VALUES($1,$2,$3,$4,'L-FIREFLY','O-FIREFLY-01','LINKED','SELECTED')",
    [reviewId, legacy.cat.catId, legacy.cat.accountId, legacy.trip.id],
  );
  for (const [index, source] of legacy.input.sources.entries())
    await pool.query(
      "INSERT INTO cloud_review_sources(cat_id,account_id,review_id,source_order,response_id,revision,claim,start_offset,end_offset,assessment,attested) VALUES($1,$2,$3,$4,$5,1,$6,0,$7,'SUPPORTED',true)",
      [
        legacy.cat.catId,
        legacy.cat.accountId,
        reviewId,
        index,
        source.responseId,
        source.claim,
        source.end,
      ],
    );
  await due(legacy.cat, ["fixed:d7"]);
  await successfulWorker();
  assert.equal(
    (await letters(legacy.cat)).find((l) => l.type === "POSTCARD")!.content_id,
    "O-FIREFLY-01",
  );
});

test("ONLINE 07: corrections/deletion before send invalidate linked; after send preserve body and hide deleted source", async () => {
  const admin = await adminClient();
  for (const mode of ["edit", "delete"] as const) {
    const item = await linkedFixture();
    await body(await admin.post("/api/e4/admin/reviews", { data: item.input }));
    await due(item.cat, ["fixed:d7"]);
    if (mode === "edit")
      await editCloudResponse(item.cat.accountId, item.source.id, {
        text: "更正后的表达",
        expectedRevision: 1,
        key: randomUUID(),
      });
    else
      await deleteCloudResponse(item.cat.accountId, item.source.id, {
        expectedRevision: 1,
        key: randomUUID(),
      });
    assert.equal(
      (await letters(item.cat)).filter((l) => l.type === "POSTCARD").length,
      0,
      "Changing a response must not implicitly settle the due postcard first",
    );
    await successfulWorker();
    assert.equal(
      (await letters(item.cat)).find((l) => l.type === "POSTCARD")!.content_id,
      "O-FIREFLY-01",
    );
  }
  const sent = await linkedFixture();
  await body(await admin.post("/api/e4/admin/reviews", { data: sent.input }));
  await due(sent.cat, ["fixed:d7"]);
  await successfulWorker();
  const letter = (await letters(sent.cat)).find((l) => l.type === "POSTCARD")!,
    hash = cloudContentHash(letter.snapshot);
  await deleteCloudResponse(sent.cat.accountId, sent.source.id, {
    expectedRevision: 1,
    key: randomUUID(),
  });
  assert.equal(
    cloudContentHash(
      (
        await one(
          "SELECT snapshot FROM cloud_letters WHERE cat_id=$1 AND id=$2",
          [sent.cat.catId, letter.id],
        )
      ).snapshot,
    ),
    hash,
  );
  const client = await apiClient(sent.cat),
    sources = await body(
      await client.get(
        `/api/e4/v1/letters/${encodeURIComponent(letter.id)}/sources`,
      ),
    );
  assert.equal(sources.sources.length, 2);
  sources.sources.forEach((source: any) => {
    assert.equal(source.status, "DELETED");
    assert.equal("excerpt" in source, false);
  });
});

test("ONLINE 08: safety and frozen accounts cannot receive; zero-reply trips still settle; account isolation holds", async () => {
  const unsafe = await newCat();
  const source = await temporaryResponse(unsafe);
  const blocked = await editCloudResponse(unsafe.accountId, source.id, {
    text: "[SYNTHETIC:INTERCEPT]",
    expectedRevision: 1,
    key: randomUUID(),
  });
  assert.equal(blocked.safety, "INTERCEPTED");
  assert.equal(
    (
      await one("SELECT safety_state FROM participants WHERE id=$1", [
        unsafe.participantId,
      ])
    ).safety_state,
    "INTERCEPTED",
  );
  await due(unsafe, ["welcome:d0", "fixed:d6"]);
  await successfulWorker();
  assert.equal(
    (await nodes(unsafe)).find((n) => n.id === "welcome:d0")!.result_outcome,
    "SKIPPED",
  );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM cloud_trips WHERE cat_id=$1 AND status='ACTIVE'",
        [unsafe.catId],
      )
    ).n,
    1,
  );
  await due(unsafe, ["fixed:d7", "fixed:d8"]);
  await successfulWorker();
  assert.equal(
    (await letters(unsafe)).filter((l) => l.type === "POSTCARD").length,
    0,
  );
  assert.equal((await cloudState(unsafe.accountId)).world.status, "HOME");
  const frozen = await newCat(),
    other = await newCat();
  await due(frozen, ["welcome:d0"]);
  const claim = await claimCloudJob();
  assert.ok(claim);
  assert.equal(claim.catId, frozen.catId);
  await freezeAccountForDeletion(frozen.accountId, randomUUID());
  assert.equal((await runClaimedCloudJob(claim)).status, "INACTIVE");
  assert.equal((await letters(frozen)).length, 0);
  await due(other, ["welcome:d0"]);
  await successfulWorker();
  assert.equal((await letters(other)).length, 1);
  const client = await apiClient(other);
  await body(
    await client.post(
      `/api/e4/v1/letters/${encodeURIComponent(`${frozen.catId}:D-07`)}/read`,
    ),
    404,
  );
});

test("ONLINE 09: actual PostgreSQL lock races serialize read, deletion and safety against delivery in both orders", async () => {
  const admin = await adminClient();
  for (const mutationFirst of [true, false]) {
    const reading = await newCat();
    await due(reading, ["welcome:d0"]);
    await successfulWorker();
    const original = (await letters(reading))[0];
    await due(reading, ["fixed:d1"]);
    const readClaim = await claimCloudJob();
    assert.equal(readClaim?.catId, reading.catId);
    const read = () => readCloudLetter(reading.accountId, original.id);
    const deliverForRead = () => runClaimedCloudJob(readClaim!);
    const readResults = await raceAtAccountLock(
      reading,
      mutationFirst ? read : deliverForRead,
      mutationFirst ? deliverForRead : read,
    );
    assert.equal(
      (readResults[mutationFirst ? 0 : 1] as { firstRead: boolean }).firstRead,
      true,
    );
    assert.equal(
      (readResults[mutationFirst ? 1 : 0] as { status: string }).status,
      mutationFirst ? "STALE" : "SETTLED",
    );
    assert.equal((await letters(reading)).length, 1);
    assert.ok((await letters(reading))[0].read_at);
    assert.equal(
      (await nodes(reading)).find((node) => node.id === "fixed:d1")!
        .result_outcome,
      "SKIPPED",
      "A read racing a due worker cannot reopen the old unread slot for backfill",
    );

    const deletion = await linkedFixture();
    await body(
      await admin.post("/api/e4/admin/reviews", { data: deletion.input }),
    );
    await due(deletion.cat, ["fixed:d7"]);
    const deleteClaim = await claimCloudJob();
    assert.equal(deleteClaim?.catId, deletion.cat.catId);
    const remove = () =>
      deleteCloudResponse(deletion.cat.accountId, deletion.source.id, {
        expectedRevision: 1,
        key: randomUUID(),
      });
    const deliverForDelete = () => runClaimedCloudJob(deleteClaim!);
    await raceAtAccountLock(
      deletion.cat,
      mutationFirst ? remove : deliverForDelete,
      mutationFirst ? deliverForDelete : remove,
    );
    const postcard = (await letters(deletion.cat)).find(
      (letter) => letter.type === "POSTCARD",
    )!;
    assert.equal(
      postcard.content_id,
      mutationFirst ? "O-FIREFLY-01" : "L-FIREFLY",
    );
    assert.equal(
      postcard.snapshot.body,
      cloudContentItems.find((item) => item.id === postcard.content_id)!.body,
    );
    const deletionClient = await apiClient(deletion.cat);
    const sources = await body(
      await deletionClient.get(
        `/api/e4/v1/letters/${encodeURIComponent(postcard.id)}/sources`,
      ),
    );
    assert.equal(sources.sources.length, mutationFirst ? 0 : 2);
    sources.sources.forEach((source: any) => {
      assert.equal(source.status, "DELETED");
      assert.equal("excerpt" in source, false);
    });

    const safetyCat = await newCat();
    const safetySource = await temporaryResponse(safetyCat);
    await due(safetyCat, ["welcome:d0"]);
    const safetyClaim = await claimCloudJob();
    assert.equal(safetyClaim?.catId, safetyCat.catId);
    const intercept = () =>
      editCloudResponse(safetyCat.accountId, safetySource.id, {
        text: "[SYNTHETIC:INTERCEPT]",
        expectedRevision: 1,
        key: randomUUID(),
      });
    const deliverForSafety = () => runClaimedCloudJob(safetyClaim!);
    const safetyResults = await raceAtAccountLock(
      safetyCat,
      mutationFirst ? intercept : deliverForSafety,
      mutationFirst ? deliverForSafety : intercept,
    );
    assert.equal(
      (safetyResults[mutationFirst ? 0 : 1] as { safety: string }).safety,
      "INTERCEPTED",
    );
    assert.equal(
      (await nodes(safetyCat)).find((node) => node.id === "welcome:d0")!
        .result_outcome,
      mutationFirst ? "SKIPPED" : "APPLIED",
    );
    assert.equal((await letters(safetyCat)).length, mutationFirst ? 1 : 2);
    assert.equal(
      (
        await one("SELECT safety_state FROM participants WHERE id=$1", [
          safetyCat.participantId,
        ])
      ).safety_state,
      "INTERCEPTED",
    );
  }
});
