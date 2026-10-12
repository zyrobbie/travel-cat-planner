import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { request, type APIRequestContext } from "@playwright/test";
import pg from "pg";
import { buildLegacyTransfer } from "../../src/shared/legacy-transfer";

export const origin = process.env.E4_TEST_ORIGIN!;
export const databaseName = "catletters_e4_lifecycle_test";
export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const clients: APIRequestContext[] = [];
export const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export async function assertDedicated() {
  assert.equal(
    (await db.query("SELECT current_database() AS name")).rows[0].name,
    databaseName,
  );
  assert.ok(
    origin && process.env.E4_LIFECYCLE_DIR && process.env.E4_SYNTHETIC_INBOX,
  );
}
export async function dispose() {
  await Promise.all(clients.map((c) => c.dispose()));
  await db.end();
}
export async function client() {
  const c = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
  });
  clients.push(c);
  return c;
}
export async function json(
  c: APIRequestContext,
  method: "get" | "post",
  path: string,
  data?: unknown,
  status = 200,
): Promise<any> {
  const r = await c[method](path, data === undefined ? {} : { data });
  assert.equal(r.status(), status, `${method} ${path}: unexpected HTTP status`);
  assert.match(r.headers()["cache-control"] ?? "", /no-store/);
  return r.json();
}
export async function login(
  address = `lifecycle-${randomUUID()}@example.test`,
) {
  const c = await client();
  const asked = await json(c, "post", "/api/e4/auth/request-code", {
    email: address,
  });
  assert.equal("code" in asked, false);
  const otp = JSON.parse(
    await readFile(
      join(process.env.E4_SYNTHETIC_INBOX!, `${asked.challengeId}.json`),
      "utf8",
    ),
  );
  const verified = await json(c, "post", "/api/e4/auth/verify-code", {
    email: address,
    challengeId: asked.challengeId,
    code: otp.code,
  });
  return {
    client: c,
    accountId: verified.accountId as string,
    email: address,
    challengeId: asked.challengeId as string,
  };
}
export type Identity = Awaited<ReturnType<typeof login>>;
export async function allowResend(address: string) {
  await db.query(
    "UPDATE email_challenges SET created_at=now()-interval '2 hours' WHERE email_normalized=$1",
    [address],
  );
}
export async function child(
  argv: string[],
  extra: Record<string, string | undefined> = {},
  timeout = 30000,
) {
  const p = spawn(process.execPath, argv, {
    env: { ...process.env, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    error = "";
  p.stdout.on("data", (d) => (output += d));
  p.stderr.on("data", (d) => (error += d));
  const code = await new Promise<number | null>((resolve, reject) => {
    const t = setTimeout(() => {
      p.kill("SIGKILL");
      reject(Error("Lifecycle child exceeded bound"));
    }, timeout);
    p.once("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.once("exit", (c) => {
      clearTimeout(t);
      resolve(c);
    });
  });
  return { code, output, error };
}
export async function lifecycle(
  action = "tick",
  extra: Record<string, string | undefined> = {},
) {
  return child(["--import", "tsx", "scripts/lifecycle.ts", action], extra);
}
export async function tick() {
  const result = await lifecycle();
  assert.equal(
    result.code,
    0,
    `lifecycle tick failed (${result.code}); output omitted to protect private fixture`,
  );
}
export async function reconcile(
  extra: Record<string, string | undefined> = {},
) {
  const result = await lifecycle("reconcile", extra);
  assert.equal(result.code, 0, "reconcile failed; private output omitted");
}
export async function job(a: Identity, id: string) {
  return (await json(a.client, "get", `/api/e4/privacy/exports/${id}`)).job;
}
export async function requestExport(a: Identity, key = randomUUID()) {
  return (await json(a.client, "post", "/api/e4/privacy/exports", { key })).job;
}
export async function prepare(a: Identity, key = randomUUID()) {
  const response = await a.client.post("/api/e4/privacy/deletions/prepare", {
    data: { key },
  });
  assert.equal(response.status(), 200);
  assert.match(response.headers()["set-cookie"] ?? "", /HttpOnly/i);
  return (await response.json()).deletion;
}
export async function confirm(a: Identity, requestId: string) {
  return (
    await json(a.client, "post", "/api/e4/privacy/deletions/confirm", {
      requestId,
      confirm: true,
    })
  ).deletion;
}
export async function status(a: Identity) {
  return (await json(a.client, "get", "/api/e4/privacy/deletions/status"))
    .deletion;
}
export async function adopt(a: Identity, name = "合成隐私猫") {
  const result = await json(a.client, "post", "/api/e4/cat/adopt", {
    key: randomUUID(),
    name,
    appearanceId: "cat-02",
  });
  return result.cat as { id: string; participant_id: string };
}
export function oldArchive() {
  const id = randomUUID(),
    now = Date.now();
  return buildLegacyTransfer({
    schema: 3,
    participant: {
      id,
      cat_name: "合成原档猫",
      appearanceId: "cat-02",
      status: "ACTIVE",
      safety_state: "CLEAR",
    },
    trip: null,
    letters: [],
    responses: {},
    reviews: [],
    calendar: {
      version: 1,
      initializedAt: now,
      baseAt: now,
      offsetMs: 0,
      lastEffectiveAt: now,
      processedCount: 0,
      nodes: [],
    },
    controlRevision: 3,
    tripCount: 0,
    drafts: {},
    requests: {},
    events: [],
  });
}
export async function bind(a: Identity, bundle = oldArchive()) {
  const preview = await json(a.client, "post", "/api/e4/legacy/preflight", {
    bundle,
  });
  const receipt = await json(a.client, "post", "/api/e4/legacy/confirm", {
    bundle,
    key: randomUUID(),
    bundleHash: preview.bundleHash,
  });
  const cat = (
    await db.query(
      "SELECT id,participant_id FROM cat_profiles WHERE account_id=$1",
      [a.accountId],
    )
  ).rows[0];
  return { cat, bundle, receipt };
}
export async function files(
  dir = process.env.E4_LIFECYCLE_DIR!,
): Promise<string[]> {
  const paths: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) paths.push(...(await files(path)));
    else if (e.isFile()) paths.push(path);
  }
  return paths.sort();
}
/** Independent complete data inventory, not the deletion implementation's table list. */
export async function snapshot() {
  const names = (
    await db.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows.map((r) => String(r.tablename));
  const data: Record<string, unknown[]> = Object.create(null);
  for (const table of names) {
    assert.match(table, /^[a-z_0-9]+$/);
    const rows = (
      await db.query(`SELECT to_jsonb(t) AS row FROM "${table}" t`)
    ).rows.map((r) => r.row);
    data[table] = rows.sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  }
  return data;
}
export async function markerAbsent(markers: string[]) {
  const text = JSON.stringify(await snapshot());
  for (const marker of markers)
    assert.equal(
      text.includes(marker),
      false,
      "Private fixture marker survived database erasure",
    );
  for (const path of await files()) {
    const body = await readFile(path, "utf8");
    for (const marker of markers)
      assert.equal(
        body.includes(marker),
        false,
        "Private fixture marker survived filesystem erasure",
      );
  }
}

export async function richFixture() {
  const a = await login(),
    bound = await bind(a);
  const cat = bound.cat as { id: string; participant_id: string };
  const marker = `PRIVATE-${randomUUID()}`,
    first = `${marker}-old`,
    current = `${marker}-current`;
  const letter = `${cat.id}:fixture-demand`,
    removedLetter = `${cat.id}:fixture-removed`,
    postcard = `${cat.id}:fixture-postcard`;
  const response = randomUUID(),
    removedResponse = randomUUID(),
    trip = randomUUID(),
    review = randomUUID();
  const sql = await db.connect();
  try {
    await sql.query("BEGIN");
    await sql.query(
      "INSERT INTO cloud_trips(id,cat_id,account_id,scene,status,started_at) VALUES($1,$2,$3,'RHINE','COMPLETE',now())",
      [trip, cat.id, a.accountId],
    );
    for (const [id, type] of [
      [letter, "DEMAND"],
      [removedLetter, "DEMAND"],
      [postcard, "POSTCARD"],
    ])
      await sql.query(
        "INSERT INTO cloud_letters(id,cat_id,account_id,type,snapshot,trip_id,read_at,origin) VALUES($1,$2,$3,$4,$5,$6,now(),'LEGACY')",
        [
          id,
          cat.id,
          a.accountId,
          type,
          {
            title: "合成隐私测试信",
            body: `${marker}-snapshot`,
            catName: marker.slice(0, 10),
          },
          type === "POSTCARD" ? trip : null,
        ],
      );
    for (const [id, lid, deleted] of [
      [response, letter, false],
      [removedResponse, removedLetter, true],
    ] as const) {
      await sql.query(
        "INSERT INTO cloud_responses(id,cat_id,account_id,letter_id,current_revision,status,created_at,deleted_at) VALUES($1,$2,$3,$4,2,$5,now(),$6)",
        [
          id,
          cat.id,
          a.accountId,
          lid,
          deleted ? "DELETED" : "ACTIVE",
          deleted ? new Date() : null,
        ],
      );
      await sql.query(
        "INSERT INTO cloud_response_revisions(cat_id,account_id,response_id,revision,text,at) VALUES($1,$2,$3,1,$4,now()),($1,$2,$3,2,$5,now())",
        [
          cat.id,
          a.accountId,
          id,
          deleted ? null : first,
          deleted ? null : current,
        ],
      );
    }
    await sql.query(
      "INSERT INTO cloud_reviews(id,cat_id,account_id,trip_id,story_id,fallback_id,kind,status,reason) VALUES($1,$2,$3,$4,'L-RHINE','O-RHINE-01','LINKED','DELIVERED','逐项人工核验通过。')",
      [review, cat.id, a.accountId, trip],
    );
    await sql.query(
      "INSERT INTO cloud_letter_sources(cat_id,account_id,letter_id,source_order,response_id,revision,claim,start_offset,end_offset,assessment,attested) VALUES($1,$2,$3,0,$4,1,'rest',0,7,'SUPPORTED',true)",
      [cat.id, a.accountId, postcard, response],
    );
    await sql.query(
      "INSERT INTO cloud_review_sources(cat_id,account_id,review_id,source_order,response_id,revision,claim,start_offset,end_offset,assessment,attested) VALUES($1,$2,$3,0,$4,1,'rest',0,7,'SUPPORTED',true)",
      [cat.id, a.accountId, review, response],
    );
    await sql.query(
      "INSERT INTO cloud_review_requests(cat_id,account_id,key,payload_hash,review_id) VALUES($1,$2,$3,$4,$5)",
      [cat.id, a.accountId, randomUUID(), hash("review"), review],
    );
    await sql.query(
      "INSERT INTO cloud_requests(account_id,cat_id,operation,key,payload_hash,result) VALUES($1,$2,'EDIT_RESPONSE',$3,$4,$5)",
      [
        a.accountId,
        cat.id,
        randomUUID(),
        hash("request"),
        {
          message: "送出去啦。",
          responseId: response,
          revision: 2,
          stateRevision: 3,
        },
      ],
    );
    await sql.query(
      "INSERT INTO legacy_binding_cancellations(account_id,key,bundle_hash) VALUES($1,$2,$3)",
      [a.accountId, randomUUID(), hash("cancel")],
    );
    await sql.query(
      "INSERT INTO account_requests(account_id,operation,key,payload_hash,result) VALUES($1,'ADOPT',$2,$3,$4)",
      [
        a.accountId,
        randomUUID(),
        hash("adopt"),
        { cat: { id: cat.id, name: marker } },
      ],
    );
    const oldTrip = randomUUID(),
      oldLetter = randomUUID(),
      content = (
        await sql.query(
          "SELECT id FROM content_versions WHERE type='DEMAND' ORDER BY id LIMIT 1",
        )
      ).rows[0].id;
    await sql.query(
      "INSERT INTO trips(id,participant_id,simulation,ended_at) VALUES($1,$2,true,now())",
      [oldTrip, cat.participant_id],
    );
    await sql.query(
      "INSERT INTO letters(id,participant_id,content_id,type,snapshot,simulation) VALUES($1,$2,$3,'DEMAND',$4,true)",
      [oldLetter, cat.participant_id, content, { title: marker, body: marker }],
    );
    await sql.query(
      "INSERT INTO responses(id,participant_id,letter_id,text,idempotency_key) VALUES($1,$2,$3,$4,$5)",
      [
        randomUUID(),
        cat.participant_id,
        oldLetter,
        `${marker}-legacy`,
        randomUUID(),
      ],
    );
    await sql.query(
      "INSERT INTO safety_cases(id,participant_id,adapter_version,fixture_id) VALUES($1,$2,'synthetic-v1',$3)",
      [randomUUID(), cat.participant_id, marker],
    );
    await sql.query(
      "INSERT INTO audit_events(participant_id,event,object_id,actor,simulation) VALUES($1,'SYNTHETIC',$2,'TEST',true)",
      [cat.participant_id, marker],
    );
    await sql.query(
      "INSERT INTO admin_requests(participant_id,request_key,action,result) VALUES($1,$2,'SYNTHETIC',$3)",
      [cat.participant_id, randomUUID(), { body: marker }],
    );
    await sql.query(
      "INSERT INTO invites(token_hash,participant_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [hash(randomUUID()), cat.participant_id],
    );
    await sql.query(
      "INSERT INTO sessions(token_hash,participant_id,role,expires_at) VALUES($1,$2,'USER',now()+interval '1 hour')",
      [hash(randomUUID()), cat.participant_id],
    );
    await sql.query("COMMIT");
  } catch (e) {
    await sql.query("ROLLBACK");
    throw e;
  } finally {
    sql.release();
  }
  return {
    ...a,
    ...bound,
    marker,
    first,
    current,
    letter,
    response,
    removedResponse,
    postcard,
  };
}
export const accountTables = [
  "account_requests",
  "account_sessions",
  "cat_profiles",
  "legacy_bindings",
  "legacy_binding_requests",
  "legacy_binding_cancellations",
  "cloud_state",
  "cloud_trips",
  "cloud_letters",
  "cloud_responses",
  "cloud_response_revisions",
  "cloud_reviews",
  "cloud_letter_sources",
  "cloud_review_sources",
  "cloud_requests",
  "cloud_calendars",
  "cloud_calendar_nodes",
  "cloud_jobs",
  "cloud_review_requests",
];
export const participantTables = [
  "invites",
  "sessions",
  "trips",
  "letters",
  "responses",
  "safety_cases",
  "audit_events",
  "admin_requests",
];
export async function assertPurged(
  accountId: string,
  participantId: string,
  email: string,
) {
  for (const table of accountTables)
    assert.equal(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE account_id=$1`,
          [accountId],
        )
      ).rows[0].n,
      0,
      `${table} retains deleted owner`,
    );
  for (const table of participantTables)
    assert.equal(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE participant_id=$1`,
          [participantId],
        )
      ).rows[0].n,
      0,
      `${table} retains deleted participant`,
    );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM participants WHERE id=$1",
        [participantId],
      )
    ).rows[0].n,
    0,
  );
  const account = (
    await db.query("SELECT * FROM accounts WHERE id=$1", [accountId])
  ).rows[0];
  if (account) {
    assert.equal(account.status, "DELETED");
    assert.notEqual(account.email_normalized, email);
  }
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM email_challenges WHERE subject_account_id=$1",
        [accountId],
      )
    ).rows[0].n,
    0,
  );
}
