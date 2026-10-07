import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { request, type APIRequestContext } from "@playwright/test";
import { pool } from "../../src/server/db";
import { requestCode, verifyCode } from "../../src/server/account-auth";
import { SyntheticMailbox } from "../../src/server/otp-delivery";
import { buildLegacyTransfer } from "../../src/shared/legacy-transfer";
import type { LocalState, Letter, Evidence } from "../../static-app/model";
import type { CalendarNode } from "../../static-app/calendar-plan";
import { cloudContentItems } from "../../src/server/cloud-content";
import frozen from "../../src/content/frozen.json";
import { freezeAccountForDeletion } from "../../src/server/account-service";

// Fixtures describe prior local history independently of the importer. They are
// never sourced from a real user archive and only enter the dedicated test DB.
const DAY = 86_400_000;
const origin = process.env.E4_TEST_ORIGIN!;
assert.ok(origin, "Run scripts/test-e4-binding.mjs");
const clients: APIRequestContext[] = [];
const mailbox = new SyntheticMailbox();
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const iso = (value: number) => new Date(value).toISOString();
after(async () => {
  await Promise.all(clients.map((client) => client.dispose()));
  await pool.end();
});

type LegacyLetter = Letter & {
  calendarNodeId?: string;
  planned_at?: string;
  effective_at?: string;
};
function complexLegacyState(): LocalState {
  const id = randomUUID(),
    firefly = randomUUID(),
    rhine = randomUUID(),
    lighthouse = randomUUID();
  const wall = Date.now(),
    base = wall - 20 * DAY,
    offset = 3 * DAY;
  const catName = "百金🐱e\u0301";
  const sourceText = "🙂陪着你，心意很珍贵。";
  const responseA = `${id}:D-03:response-v1`,
    responseB = `${id}:D-06:response-v1`;
  function letter(
    contentId: string,
    day: number,
    extra: Partial<LegacyLetter> = {},
  ): LegacyLetter {
    const content = cloudContentItems.find((item) => item.id === contentId)!;
    return {
      id: `${id}:${contentId}`,
      type: "DEMAND",
      read_at: iso(base + (day + 0.1) * DAY),
      skipped_at: null,
      delivered_at: iso(base + day * DAY + 901),
      response: null,
      snapshot: {
        title: content.title,
        body: content.body,
        contentId,
        contentVersion: content.version,
        catName,
        tip:
          frozen.items.find(
            (item) => item.id === contentId.replace("D-", "TIPS-"),
          )?.body ?? null,
        scene: content.sceneId as string | null,
        season: content.narrativeSeason as string | null,
        timeOfDay: (content.timeOfDay as string | null) ?? null,
      },
      ...extra,
    };
  }
  const sources: Evidence[] = [
    {
      claim: "companionship",
      responseId: responseA,
      revision: 1,
      start: 2,
      end: 6,
      assessment: "SUPPORTED",
      attested: true,
    },
    {
      claim: "care_value",
      responseId: responseB,
      revision: 1,
      start: 0,
      end: 6,
      assessment: "SUPPORTED",
      attested: true,
    },
  ];
  const a = letter("D-03", 1, {
    response: "更正以后：可以先观察，再交朋友。",
    responseId: responseA,
    calendarNodeId: "legacy:demand:one",
    planned_at: iso(base + DAY),
    effective_at: iso(base + DAY + 500),
  });
  const b = letter("D-06", 2, {
    responseId: responseB,
    skipped_at: iso(base + 2.1 * DAY),
  });
  // Early accepted local archives omitted content metadata; stable ID plus the
  // unchanged frozen body can identify it without rewriting the old snapshot.
  delete b.snapshot.contentId;
  delete b.snapshot.contentVersion;
  const linked = letter("L-FIREFLY", 4, {
    type: "POSTCARD",
    tripId: firefly,
    storyId: "L-FIREFLY",
    sourceRefs: sources,
    calendarNodeId: "manual:firefly:postcard",
    planned_at: iso(base + 4 * DAY),
    effective_at: iso(base + 4 * DAY + 700),
  });
  linked.snapshot.scene = "FIREFLY";
  const ordinary = letter("O-RHINE-01", 7, {
    type: "POSTCARD",
    tripId: rhine,
    storyId: "O-RHINE-01",
    read_at: null,
  });
  ordinary.snapshot.scene = "RHINE";
  ordinary.snapshot.tip = null;
  const unread = letter("D-04", 8, { read_at: null });
  const nodes: CalendarNode[] = [];
  function node(
    id: string,
    day: number,
    kind: CalendarNode["kind"],
    extra: Partial<CalendarNode>,
  ) {
    nodes.push({
      id,
      at: base + day * DAY,
      order: nodes.length,
      kind,
      origin: "FIXED",
      result: null,
      ...extra,
    });
  }
  const result = (day: number, letterId?: string) => ({
    outcome: "APPLIED" as const,
    reason: "已处理",
    writtenAt: iso(base + day * DAY + 901),
    effectiveAt: base + day * DAY + 700,
    ...(letterId ? { letterId } : {}),
  });
  node("legacy:demand:one", 1, "DEMAND", {
    origin: "LEGACY",
    contentId: "D-03",
    result: { ...result(1, a.id), effectiveAt: base + DAY + 500 },
  });
  node("manual:firefly:start", 3, "START", {
    origin: "MANUAL",
    tripId: firefly,
    scene: "FIREFLY",
    result: result(3),
  });
  node("manual:firefly:postcard", 4, "POSTCARD", {
    origin: "MANUAL",
    tripId: firefly,
    scene: "FIREFLY",
    result: { ...result(4, linked.id), reason: "有效人工来源联动投递。" },
  });
  node("manual:firefly:end", 5, "END", {
    origin: "MANUAL",
    tripId: firefly,
    scene: "FIREFLY",
    result: result(5),
  });
  node("fixed:old-skip", 9, "DEMAND", {
    contentId: "D-02",
    result: {
      ...result(9),
      outcome: "SKIPPED",
      reason: "还有未读来信，请先打开阅读；不需要回复。",
    },
  });
  node("fixed:lighthouse:start", 10, "START", {
    tripId: lighthouse,
    scene: "LIGHTHOUSE",
    result: result(10),
  });
  node("fixed:future-demand", 25, "DEMAND", { contentId: "D-01" });
  node("fixed:lighthouse:postcard", 26, "POSTCARD", {
    tripId: lighthouse,
    scene: "LIGHTHOUSE",
  });
  node("fixed:lighthouse:end", 27, "END", {
    tripId: lighthouse,
    scene: "LIGHTHOUSE",
  });
  return {
    schema: 3,
    participant: {
      id,
      cat_name: catName,
      appearanceId: "cat-02",
      status: "ACTIVE",
      safety_state: "CLEAR",
    },
    trip: { id: lighthouse },
    letters: [unread, ordinary, linked, b, a],
    responses: {
      [responseA]: {
        id: responseA,
        letterId: a.id,
        currentRevision: 2,
        status: "ACTIVE",
        lastMutation: { key: randomUUID(), expectedRevision: 1 },
        revisions: [
          { revision: 1, text: sourceText, at: null },
          { revision: 2, text: a.response, at: iso(base + 2 * DAY) },
        ],
      },
      [responseB]: {
        id: responseB,
        letterId: b.id,
        currentRevision: 2,
        status: "DELETED",
        revisions: [
          { revision: 1, text: null, at: null },
          { revision: 2, text: null, at: iso(base + 3 * DAY) },
        ],
      },
    },
    reviews: [
      {
        id: `${id}:review:delivered`,
        tripId: firefly,
        storyId: "L-FIREFLY",
        fallbackId: "O-FIREFLY-01",
        kind: "LINKED",
        status: "DELIVERED",
        sources,
        reason: "逐项人工核验通过。",
      },
      {
        id: `${id}:review:selected`,
        tripId: lighthouse,
        storyId: "L-LIGHTHOUSE",
        fallbackId: "O-LIGHTHOUSE-01",
        kind: "LINKED",
        status: "SELECTED",
        sources: [
          {
            claim: "new_friends",
            responseId: responseA,
            revision: 2,
            start: 0,
            end: a.response!.length,
            assessment: "SUPPORTED",
            attested: true,
          },
        ],
        reason: "逐项人工核验通过。",
      },
    ],
    calendar: {
      version: 1,
      initializedAt: base,
      baseAt: base,
      offsetMs: offset,
      lastEffectiveAt: wall + offset,
      processedCount: 6,
      nodes,
    },
    controlRevision: 73,
    tripCount: 3,
    drafts: {
      [unread.id]: {
        kind: "reply",
        text: "DRAFT-SECRET-不应上传",
        responseId: null,
        revision: null,
        updatedAt: iso(wall),
      },
    },
    events: [
      { event: "UNTRUSTED-REVIEW-GRANTED", at: iso(wall), simulation: true },
    ],
    requests: {
      [randomUUID()]: {
        signature: "UNTRUSTED-OLD-REQUEST",
        result: { text: "OLD-REQUEST-SECRET", admin: true },
      },
    },
  };
}

type Login = Awaited<ReturnType<typeof verifyCode>>;
async function newAccount() {
  const email = `binding-${randomUUID()}@example.test`;
  const challenge = await requestCode(email, mailbox);
  return verifyCode(
    challenge.challengeId,
    email,
    mailbox.messages.get(challenge.challengeId)!.code,
  );
}
async function clientFor(login: Login) {
  const client = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
    storageState: {
      cookies: [
        {
          name: "cat_account_session",
          value: login.rawToken,
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
async function json(
  response: Awaited<ReturnType<APIRequestContext["get"]>>,
  status = 200,
): Promise<any> {
  const value = await response.json();
  assert.equal(response.status(), status, JSON.stringify(value));
  return value;
}
async function one(sql: string, values: unknown[] = []) {
  const result = await pool.query(sql, values);
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}
const stamp = (value: Date | null) => value?.toISOString() ?? null;
async function preflight(client: APIRequestContext, bundle: unknown) {
  return json(
    await client.post("/api/e4/legacy/preflight", { data: { bundle } }),
  );
}
async function confirm(
  client: APIRequestContext,
  bundle: unknown,
  key = randomUUID(),
) {
  const checked = await preflight(client, bundle);
  return json(
    await client.post("/api/e4/legacy/confirm", {
      data: { bundle, key, bundleHash: checked.bundleHash },
    }),
  );
}
async function worker() {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/cloud-worker.ts", "--once"],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  }).finally(() => clearTimeout(timeout));
  assert.equal(code, 0, output);
}

test("B3 export: one explicit schema3 archive is projected without drafts, old requests, events or local mutation keys", () => {
  const state = complexLegacyState(),
    before = digest(state);
  const bundle = buildLegacyTransfer(state);
  assert.equal(digest(state), before, "Export must not mutate the old archive");
  assert.equal(bundle.sourceExperienceId, state.participant.id);
  assert.equal(bundle.sourceNamespace, "cat-letters-pages-v1");
  assert.equal(bundle.letters.length, state.letters.length);
  assert.equal(bundle.responses.length, 2);
  const encoded = JSON.stringify(bundle);
  for (const forbidden of [
    "DRAFT-SECRET",
    "OLD-REQUEST-SECRET",
    "UNTRUSTED-REVIEW-GRANTED",
    "lastMutation",
    '"drafts"',
    '"requests"',
    '"events"',
  ])
    assert.equal(encoded.includes(forbidden), false, forbidden);
  assert.equal(
    bundle.calendar.nodes.some((node) => node.id === "welcome:d0"),
    false,
  );
});

async function assertArchivePreserved(
  catId: string,
  accountId: string,
  state: LocalState,
) {
  const profile = await one("SELECT * FROM cat_profiles WHERE id=$1", [catId]);
  assert.equal(profile.account_id, accountId);
  assert.equal(profile.name, state.participant.cat_name);
  assert.equal(profile.appearance_id, state.participant.appearanceId);
  assert.notEqual(
    profile.participant_id,
    state.participant.id,
    "A client UUID cannot take over a PG participant",
  );
  const binding = await one("SELECT * FROM legacy_bindings WHERE cat_id=$1", [
    catId,
  ]);
  assert.equal(binding.source_experience_id, state.participant.id);
  assert.equal(binding.logical_cat_id, state.participant.id);
  assert.equal(binding.source_namespace, "cat-letters-pages-v1");
  assert.equal(binding.provenance.controlRevision, state.controlRevision);
  assert.equal(binding.provenance.tripCount, state.tripCount);
  for (const tripId of new Set([
    state.trip!.id,
    ...state.letters.flatMap((letter) =>
      letter.tripId ? [letter.tripId] : [],
    ),
  ])) {
    const saved = await one(
      "SELECT * FROM cloud_trips WHERE cat_id=$1 AND id=$2",
      [catId, tripId],
    );
    const start = state.calendar.nodes.find(
      (node) => node.tripId === tripId && node.kind === "START",
    );
    const end = state.calendar.nodes.find(
      (node) => node.tripId === tripId && node.kind === "END",
    );
    assert.equal(
      saved.status,
      state.trip?.id === tripId ? "ACTIVE" : "COMPLETE",
    );
    assert.equal(
      stamp(saved.started_at),
      start?.result?.outcome === "APPLIED" ? start.result.writtenAt : null,
    );
    assert.equal(
      stamp(saved.ended_at),
      end?.result?.outcome === "APPLIED" ? end.result.writtenAt : null,
    );
    assert.equal(stamp(saved.planned_start_at), start ? iso(start.at) : null);
    assert.equal(stamp(saved.planned_end_at), end ? iso(end.at) : null);
    assert.equal(saved.origin, "LEGACY");
  }
  const rows = await pool.query(
    "SELECT * FROM cloud_letters WHERE cat_id=$1 ORDER BY id",
    [catId],
  );
  assert.equal(rows.rowCount, state.letters.length);
  for (const old of state.letters as LegacyLetter[]) {
    const saved = rows.rows.find((row) => row.id === old.id);
    assert.ok(saved, old.id);
    assert.deepEqual(saved.snapshot, old.snapshot);
    assert.equal(saved.type, old.type);
    assert.equal(saved.origin, "LEGACY");
    assert.equal(saved.trip_id, old.tripId ?? null);
    assert.equal(saved.story_id, old.storyId ?? null);
    assert.equal(saved.calendar_node_id, old.calendarNodeId ?? null);
    for (const key of [
      "delivered_at",
      "read_at",
      "skipped_at",
      "planned_at",
      "effective_at",
    ] as const)
      assert.equal(stamp(saved[key]), old[key] ?? null, `${old.id} ${key}`);
    const refs = await pool.query(
      "SELECT * FROM cloud_letter_sources WHERE cat_id=$1 AND letter_id=$2 ORDER BY source_order",
      [catId, old.id],
    );
    assert.deepEqual(refs.rows.map(sourceProjection), old.sourceRefs ?? []);
  }
  const responses = await pool.query(
    "SELECT * FROM cloud_responses WHERE cat_id=$1 ORDER BY id",
    [catId],
  );
  assert.equal(responses.rowCount, Object.keys(state.responses).length);
  for (const old of Object.values(state.responses)) {
    const saved = responses.rows.find((row) => row.id === old.id);
    assert.ok(saved);
    assert.equal(saved.letter_id, old.letterId);
    assert.equal(saved.current_revision, old.currentRevision);
    assert.equal(saved.status, old.status);
    assert.equal(
      saved.created_at,
      null,
      "Unknown historical created time must not become import time",
    );
    assert.equal(
      saved.deleted_at,
      null,
      "Unknown historical deleted time must not become import time",
    );
    const versions = await pool.query(
      "SELECT revision,text,at FROM cloud_response_revisions WHERE cat_id=$1 AND response_id=$2 ORDER BY revision",
      [catId, old.id],
    );
    assert.deepEqual(
      versions.rows.map((row) => ({
        revision: row.revision,
        text: row.text,
        at: stamp(row.at),
      })),
      old.revisions,
    );
  }
  for (const old of state.reviews) {
    const saved = await one(
      "SELECT * FROM cloud_reviews WHERE cat_id=$1 AND id=$2",
      [catId, old.id],
    );
    assert.deepEqual(
      {
        id: saved.id,
        tripId: saved.trip_id,
        storyId: saved.story_id,
        fallbackId: saved.fallback_id,
        kind: saved.kind,
        status: saved.status,
        reason: saved.reason,
      },
      {
        id: old.id,
        tripId: old.tripId,
        storyId: old.storyId,
        fallbackId: old.fallbackId,
        kind: old.kind,
        status: old.status,
        reason: old.reason,
      },
    );
    assert.equal(saved.review_authority, "UNVERIFIED");
    assert.equal(saved.reviewed_by, null);
    assert.equal(saved.reviewed_at, null);
    const refs = await pool.query(
      "SELECT * FROM cloud_review_sources WHERE cat_id=$1 AND review_id=$2 ORDER BY source_order",
      [catId, old.id],
    );
    assert.deepEqual(refs.rows.map(sourceProjection), old.sources);
  }
  const calendar = await one("SELECT * FROM cloud_calendars WHERE cat_id=$1", [
    catId,
  ]);
  assert.deepEqual(
    {
      version: calendar.version,
      initializedAt: calendar.initialized_at.getTime(),
      baseAt: calendar.base_at.getTime(),
      offsetMs: Number(calendar.offset_ms),
      lastEffectiveAt: calendar.last_effective_at.getTime(),
      processedCount: calendar.processed_count,
      nodeCount: calendar.node_count,
    },
    {
      version: 1,
      initializedAt: state.calendar.initializedAt,
      baseAt: state.calendar.baseAt,
      offsetMs: state.calendar.offsetMs,
      lastEffectiveAt: state.calendar.lastEffectiveAt,
      processedCount: state.calendar.processedCount,
      nodeCount: state.calendar.nodes.length,
    },
  );
  const nodes = await pool.query(
    "SELECT * FROM cloud_calendar_nodes WHERE cat_id=$1 ORDER BY node_order",
    [catId],
  );
  assert.deepEqual(
    nodes.rows.map((row) => ({
      id: row.id,
      at: row.planned_at.getTime(),
      order: row.node_order,
      kind: row.kind,
      origin: row.origin,
      ...(row.content_id ? { contentId: row.content_id } : {}),
      ...(row.trip_id ? { tripId: row.trip_id } : {}),
      ...(row.scene ? { scene: row.scene } : {}),
      result: row.result_outcome
        ? {
            outcome: row.result_outcome,
            reason: row.result_reason,
            writtenAt: stamp(row.written_at),
            effectiveAt: row.effective_at.getTime(),
            ...(row.letter_id ? { letterId: row.letter_id } : {}),
          }
        : null,
    })),
    state.calendar.nodes,
  );
  assert.equal(
    nodes.rows.some((row) => row.id === "welcome:d0"),
    false,
  );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM cloud_requests WHERE cat_id=$1",
        [catId],
      )
    ).n,
    0,
  );
  const encoded = JSON.stringify(binding);
  assert.equal(encoded.includes("DRAFT-SECRET"), false);
  assert.equal(encoded.includes("OLD-REQUEST-SECRET"), false);
  assert.equal(encoded.includes("UNTRUSTED-REVIEW-GRANTED"), false);
}
function sourceProjection(row: any) {
  return {
    claim: row.claim,
    responseId: row.response_id,
    revision: row.revision,
    start: row.start_offset,
    end: row.end_offset,
    assessment: row.assessment,
    attested: row.attested,
  };
}

test("B3 field preservation: preflight does not reserve; confirmed import retains IDs, snapshots, null times, revisions, tombstones, sources and complete calendar", async () => {
  assert.equal(
    (await one("SELECT current_database() AS name")).name,
    "catletters_e4_binding_test",
  );
  const state = complexLegacyState(),
    before = digest(state),
    bundle = buildLegacyTransfer(state);
  const login = await newAccount(),
    client = await clientFor(login);
  const checked = await preflight(client, bundle);
  assert.ok(checked.bundleHash);
  assert.ok(checked.summary);
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM cat_profiles WHERE account_id=$1",
        [login.accountId],
      )
    ).n,
    0,
  );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM legacy_bindings WHERE account_id=$1",
        [login.accountId],
      )
    ).n,
    0,
  );
  const key = randomUUID();
  const imported = await json(
    await client.post("/api/e4/legacy/confirm", {
      data: { bundle, key, bundleHash: checked.bundleHash },
    }),
  );
  assert.equal(imported.logicalCatId, state.participant.id);
  assert.equal(imported.bundleHash, checked.bundleHash);
  await assertArchivePreserved(imported.catId, login.accountId, state);
  assert.equal(digest(state), before);
  const recovered = await json(
    await client.get(`/api/e4/legacy/requests/${key}`),
  );
  assert.ok(JSON.stringify(recovered).includes(imported.catId));
  assert.equal(
    JSON.stringify(recovered).includes(state.letters[0].snapshot.body),
    false,
  );
  const retried = await json(
    await client.post("/api/e4/legacy/confirm", {
      data: { bundle, key, bundleHash: checked.bundleHash },
    }),
  );
  assert.deepEqual(retried, imported);
  await assertArchivePreserved(imported.catId, login.accountId, state);
});

test("B3 rejection: malformed ownership, version, source, tombstone, calendar and permission fields fail before any reservation", async () => {
  const login = await newAccount(),
    client = await clientFor(login);
  const valid = buildLegacyTransfer(complexLegacyState());
  const cases: [string, (bundle: any) => void][] = [
    [
      "duplicate letters",
      (bundle) => bundle.letters.push(structuredClone(bundle.letters[0])),
    ],
    [
      "foreign letter prefix",
      (bundle) => {
        bundle.letters[0].id = `${randomUUID()}:D-04`;
      },
    ],
    [
      "source experience mismatch",
      (bundle) => {
        bundle.sourceExperienceId = randomUUID();
      },
    ],
    [
      "unknown declared version",
      (bundle) => {
        bundle.letters[0].snapshot.contentVersion = "invented-v999";
      },
    ],
    [
      "frozen content altered",
      (bundle) => {
        bundle.letters[0].snapshot.body += "伪造内容";
      },
    ],
    [
      "dangling response letter",
      (bundle) => {
        bundle.responses[0].letterId = `${bundle.sourceExperienceId}:missing`;
      },
    ],
    [
      "version gap",
      (bundle) => {
        const active = bundle.responses.find(
          (response: any) => response.status === "ACTIVE",
        );
        active.currentRevision = 3;
        active.revisions[1].revision = 3;
      },
    ],
    [
      "deleted text remains",
      (bundle) => {
        bundle.responses.find(
          (response: any) => response.status === "DELETED",
        ).revisions[0].text = "不可复活的原文";
      },
    ],
    [
      "dangling source",
      (bundle) => {
        bundle.reviews[0].sources[0].responseId = "other-cat-response";
      },
    ],
    [
      "source out of UTF16 bounds",
      (bundle) => {
        bundle.reviews[1].sources[0].end = 9000;
      },
    ],
    [
      "wrong processed count",
      (bundle) => {
        bundle.calendar.processedCount++;
      },
    ],
    [
      "duplicate node order",
      (bundle) => {
        bundle.calendar.nodes[1].order = bundle.calendar.nodes[0].order;
      },
    ],
    [
      "result references absent letter",
      (bundle) => {
        bundle.calendar.nodes[0].result.letterId = "missing-letter";
      },
    ],
    [
      "unsafe time",
      (bundle) => {
        bundle.calendar.offsetMs = Number.MAX_SAFE_INTEGER;
      },
    ],
    [
      "revision without increment headroom",
      (bundle) => {
        bundle.controlRevision = Number.MAX_SAFE_INTEGER;
      },
    ],
    [
      "unknown origin",
      (bundle) => {
        bundle.calendar.nodes[0].origin = "ADMIN";
      },
    ],
    [
      "permission field",
      (bundle) => {
        bundle.accountId = randomUUID();
      },
    ],
    [
      "review authority",
      (bundle) => {
        bundle.reviews[0].review_authority = "INTERNAL_ADMIN";
      },
    ],
    [
      "draft injection",
      (bundle) => {
        bundle.drafts = { secret: "DRAFT-SECRET" };
      },
    ],
    [
      "2001 UTF16 response",
      (bundle) => {
        const active = bundle.responses.find(
          (response: any) => response.status === "ACTIVE",
        );
        active.revisions[1].text = "猫".repeat(2001);
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    const response = await client.post("/api/e4/legacy/preflight", {
      data: { bundle: invalid },
    });
    const value = await response.json();
    assert.ok(
      [400, 409].includes(response.status()),
      `${label}: ${response.status()} ${JSON.stringify(value)}`,
    );
    assert.equal(
      (
        await one(
          "SELECT count(*)::int AS n FROM cat_profiles WHERE account_id=$1",
          [login.accountId],
        )
      ).n,
      0,
      label,
    );
    assert.equal(
      (
        await one(
          "SELECT count(*)::int AS n FROM legacy_bindings WHERE account_id=$1",
          [login.accountId],
        )
      ).n,
      0,
      label,
    );
  }
  const checked = await preflight(client, valid);
  const modified = structuredClone(valid);
  modified.participant.cat_name = "另一只";
  await json(
    await client.post("/api/e4/legacy/confirm", {
      data: {
        bundle: modified,
        key: randomUUID(),
        bundleHash: checked.bundleHash,
      },
    }),
    409,
  );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM cat_profiles WHERE account_id=$1",
        [login.accountId],
      )
    ).n,
    0,
  );
});

test("B3 concurrency: same key, copied archives across accounts, distinct archives and adoption all preserve one-cat ownership", async () => {
  const bundle = buildLegacyTransfer(complexLegacyState()),
    login = await newAccount(),
    client = await clientFor(login);
  const checked = await preflight(client, bundle),
    key = randomUUID();
  const attempts = await Promise.all(
    Array.from({ length: 8 }, () =>
      client.post("/api/e4/legacy/confirm", {
        data: { bundle, key, bundleHash: checked.bundleHash },
      }),
    ),
  );
  const outcomes = await Promise.all(attempts.map((attempt) => json(attempt)));
  outcomes.forEach((outcome) => assert.deepEqual(outcome, outcomes[0]));
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM cat_profiles WHERE account_id=$1",
        [login.accountId],
      )
    ).n,
    1,
  );
  const changed = structuredClone(bundle);
  changed.participant.cat_name = "改名";
  await json(
    await client.post("/api/e4/legacy/confirm", {
      data: { bundle: changed, key, bundleHash: checked.bundleHash },
    }),
    409,
  );
  await json(
    await client.post("/api/e4/legacy/confirm", {
      data: { bundle, key: randomUUID(), bundleHash: checked.bundleHash },
    }),
    409,
  );

  const copy = buildLegacyTransfer(complexLegacyState());
  const pair = await Promise.all([newAccount(), newAccount()]);
  const pairClients = await Promise.all(pair.map(clientFor));
  const checks = await Promise.all(
    pairClients.map((item) => preflight(item, copy)),
  );
  const copied = await Promise.all(
    pairClients.map((item, i) =>
      item.post("/api/e4/legacy/confirm", {
        data: {
          bundle: copy,
          key: randomUUID(),
          bundleHash: checks[i].bundleHash,
        },
      }),
    ),
  );
  assert.deepEqual(
    copied.map((response) => response.status()).sort(),
    [200, 409],
  );
  const winner = copied.findIndex((response) => response.status() === 200),
    loser = 1 - winner;
  const failed = await copied[loser].json();
  assert.equal(
    JSON.stringify(failed).includes(pair[winner].accountId),
    false,
    "Source collision must not leak the other account",
  );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM cat_profiles WHERE account_id=$1",
        [pair[loser].accountId],
      )
    ).n,
    0,
  );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM legacy_bindings WHERE source_experience_id=$1",
        [copy.sourceExperienceId],
      )
    ).n,
    1,
  );

  const adopter = await newAccount(),
    adopterClient = await clientFor(adopter),
    old = buildLegacyTransfer(complexLegacyState());
  const adoptionCheck = await preflight(adopterClient, old);
  const race = await Promise.all([
    adopterClient.post("/api/e4/cat/adopt", {
      data: { name: "新领养", appearanceId: "cat-01", key: randomUUID() },
    }),
    adopterClient.post("/api/e4/legacy/confirm", {
      data: {
        bundle: old,
        key: randomUUID(),
        bundleHash: adoptionCheck.bundleHash,
      },
    }),
  ]);
  assert.deepEqual(
    race.map((response) => response.status()).sort(),
    [200, 409],
  );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM cat_profiles WHERE account_id=$1",
        [adopter.accountId],
      )
    ).n,
    1,
  );

  const shared = await newAccount(),
    sharedClient = await clientFor(shared),
    two = [
      buildLegacyTransfer(complexLegacyState()),
      buildLegacyTransfer(complexLegacyState()),
    ];
  const prepared = await Promise.all(
    two.map((item) => preflight(sharedClient, item)),
  );
  const sameAccount = await Promise.all(
    two.map((item, i) =>
      sharedClient.post("/api/e4/legacy/confirm", {
        data: {
          bundle: item,
          key: randomUUID(),
          bundleHash: prepared[i].bundleHash,
        },
      }),
    ),
  );
  assert.deepEqual(
    sameAccount.map((response) => response.status()).sort(),
    [200, 409],
  );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM legacy_bindings WHERE account_id=$1",
        [shared.accountId],
      )
    ).n,
    1,
  );
});

test("B3 rollback: mid-import SQL error removes every partial write and original key can retry to one result", async () => {
  const state = complexLegacyState(),
    bundle = buildLegacyTransfer(state),
    login = await newAccount(),
    client = await clientFor(login);
  const checked = await preflight(client, bundle),
    key = randomUUID();
  const before = (await one("SELECT count(*)::int AS n FROM participants")).n;
  await pool.query(
    "CREATE FUNCTION e4_binding_fail_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.revision=2 THEN RAISE EXCEPTION 'synthetic binding transaction failure'; END IF; RETURN NEW; END $$",
  );
  await pool.query(
    "CREATE TRIGGER e4_binding_fail BEFORE INSERT ON cloud_response_revisions FOR EACH ROW EXECUTE FUNCTION e4_binding_fail_revision()",
  );
  try {
    await json(
      await client.post("/api/e4/legacy/confirm", {
        data: { bundle, key, bundleHash: checked.bundleHash },
      }),
      503,
    );
  } finally {
    await pool.query(
      "DROP TRIGGER e4_binding_fail ON cloud_response_revisions",
    );
    await pool.query("DROP FUNCTION e4_binding_fail_revision()");
  }
  for (const table of [
    "cat_profiles",
    "legacy_bindings",
    "legacy_binding_requests",
    "cloud_state",
    "cloud_trips",
    "cloud_letters",
    "cloud_responses",
    "cloud_response_revisions",
    "cloud_reviews",
    "cloud_letter_sources",
    "cloud_review_sources",
    "cloud_calendars",
    "cloud_calendar_nodes",
    "cloud_jobs",
  ])
    assert.equal(
      (
        await one(
          `SELECT count(*)::int AS n FROM ${table} WHERE account_id=$1`,
          [login.accountId],
        )
      ).n,
      0,
      table,
    );
  assert.equal(
    (await one("SELECT count(*)::int AS n FROM participants")).n,
    before,
  );
  const pending = await json(
    await client.get(`/api/e4/legacy/requests/${key}`),
  );
  assert.equal(JSON.stringify(pending).includes("catId"), false);
  const imported = await json(
    await client.post("/api/e4/legacy/confirm", {
      data: { bundle, key, bundleHash: checked.bundleHash },
    }),
  );
  await assertArchivePreserved(imported.catId, login.accountId, state);
  const recovered = await json(
    await client.get(`/api/e4/legacy/requests/${key}`),
  );
  assert.ok(JSON.stringify(recovered).includes(imported.catId));
});

test("B3 revision limit: due settlement plus first read rolls back together before unsafe integer overflow", async () => {
  const state = complexLegacyState();
  state.controlRevision = Number.MAX_SAFE_INTEGER - 1;
  const login = await newAccount(),
    client = await clientFor(login),
    imported = await confirm(client, buildLegacyTransfer(state));
  assert.equal(imported.stateRevision, Number.MAX_SAFE_INTEGER - 1);
  const unread = state.letters.find((letter) => letter.read_at === null)!;
  await pool.query(
    "UPDATE cloud_calendar_nodes SET planned_at=clock_timestamp()+($2::bigint*interval '1 millisecond')-interval '1 second' WHERE cat_id=$1 AND id='fixed:future-demand'",
    [imported.catId, state.calendar.offsetMs],
  );
  async function archiveRows() {
    const saved: Record<string, unknown> = {};
    for (const table of [
      "cloud_state",
      "cloud_calendars",
      "cloud_calendar_nodes",
      "cloud_letters",
      "cloud_jobs",
    ]) {
      saved[table] = (
        await pool.query(
          `SELECT to_jsonb(t) AS row FROM ${table} t WHERE cat_id=$1 ORDER BY to_jsonb(t)::text`,
          [imported.catId],
        )
      ).rows;
    }
    return saved;
  }
  const before = await archiveRows();
  await json(
    await client.post(
      `/api/e4/v1/letters/${encodeURIComponent(unread.id)}/read`,
      { data: {} },
    ),
    409,
  );
  assert.deepEqual(
    await archiveRows(),
    before,
    "The first increment during settlement, skipped node, first-read timestamp and all calendar state must roll back when the second increment would overflow",
  );
  assert.equal(
    (
      await one("SELECT revision FROM cloud_state WHERE cat_id=$1", [
        imported.catId,
      ])
    ).revision,
    String(Number.MAX_SAFE_INTEGER - 1),
  );
});

test("B3 worker continuity: imported offsets and old outcomes remain; multiple unread block new mail; unverified selected review cannot send linked", async () => {
  const state = complexLegacyState(),
    before = digest(state),
    bundle = buildLegacyTransfer(state),
    login = await newAccount(),
    client = await clientFor(login);
  const imported = await confirm(client, bundle);
  const oldResults = state.calendar.nodes.filter((node) => node.result);
  await pool.query(
    "UPDATE cloud_calendar_nodes SET planned_at=clock_timestamp()+($2::bigint*interval '1 millisecond')-interval '1 second' WHERE cat_id=$1 AND id='fixed:future-demand'",
    [imported.catId, state.calendar.offsetMs],
  );
  await pool.query(
    "UPDATE cloud_jobs SET next_run_at=clock_timestamp()-interval '1 second' WHERE cat_id=$1",
    [imported.catId],
  );
  await worker();
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM cloud_letters WHERE cat_id=$1",
        [imported.catId],
      )
    ).n,
    state.letters.length,
  );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM cloud_letters WHERE cat_id=$1 AND read_at IS NULL",
        [imported.catId],
      )
    ).n,
    2,
  );
  assert.equal(
    (
      await one(
        "SELECT result_outcome FROM cloud_calendar_nodes WHERE cat_id=$1 AND id='fixed:future-demand'",
        [imported.catId],
      )
    ).result_outcome,
    "SKIPPED",
  );
  for (const old of oldResults) {
    const saved = await one(
      "SELECT * FROM cloud_calendar_nodes WHERE cat_id=$1 AND id=$2",
      [imported.catId, old.id],
    );
    assert.equal(saved.result_outcome, old.result!.outcome);
    assert.equal(saved.result_reason, old.result!.reason);
    assert.equal(stamp(saved.written_at), old.result!.writtenAt);
    assert.equal(saved.effective_at.getTime(), old.result!.effectiveAt);
  }
  await pool.query(
    "UPDATE cloud_letters SET read_at=delivered_at WHERE cat_id=$1 AND read_at IS NULL",
    [imported.catId],
  );
  await pool.query(
    "UPDATE cloud_calendar_nodes SET planned_at=clock_timestamp()+($2::bigint*interval '1 millisecond')-interval '1 second' WHERE cat_id=$1 AND id='fixed:lighthouse:postcard'",
    [imported.catId, state.calendar.offsetMs],
  );
  await pool.query(
    "UPDATE cloud_jobs SET next_run_at=clock_timestamp()-interval '1 second' WHERE cat_id=$1",
    [imported.catId],
  );
  await worker();
  const postcard = await one(
    "SELECT * FROM cloud_letters WHERE cat_id=$1 AND trip_id=$2",
    [imported.catId, state.trip!.id],
  );
  assert.equal(postcard.content_id, "O-LIGHTHOUSE-01");
  assert.equal(
    postcard.snapshot.body,
    cloudContentItems.find((item) => item.id === "O-LIGHTHOUSE-01")!.body,
  );
  assert.equal(
    postcard.id,
    `${state.participant.id}:O-LIGHTHOUSE-01`,
    "New letters continue the preserved logical ID namespace",
  );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM cloud_calendar_nodes WHERE cat_id=$1 AND id='welcome:d0'",
        [imported.catId],
      )
    ).n,
    0,
  );
  assert.equal(
    (
      await one("SELECT offset_ms FROM cloud_calendars WHERE cat_id=$1", [
        imported.catId,
      ])
    ).offset_ms,
    String(state.calendar.offsetMs),
  );
  assert.equal(digest(state), before);
});

test("B3 client API projections: unread detail is closed, read-only detail never marks read, deleted summaries and cross-account views reveal no text", async () => {
  const state = complexLegacyState(),
    login = await newAccount(),
    client = await clientFor(login);
  const imported = await confirm(client, buildLegacyTransfer(state));
  const unseen = state.letters.find(
    (letter) => letter.type === "DEMAND" && !letter.read_at,
  )!;
  const mailboxView = await json(await client.get("/api/e4/v1/letters"));
  const unreadSummary = mailboxView.letters.find(
    (letter: any) => letter.id === unseen.id,
  );
  assert.ok(unreadSummary);
  assert.notEqual(unreadSummary.title, unseen.snapshot.title);
  assert.equal("body" in unreadSummary, false);
  assert.equal("snapshot" in unreadSummary, false);
  await json(
    await client.get(
      `/api/e4/v1/letters/${encodeURIComponent(unseen.id)}/detail`,
    ),
    409,
  );
  assert.equal(
    (
      await one("SELECT read_at FROM cloud_letters WHERE cat_id=$1 AND id=$2", [
        imported.catId,
        unseen.id,
      ])
    ).read_at,
    null,
  );
  const opened = await json(
    await client.post(
      `/api/e4/v1/letters/${encodeURIComponent(unseen.id)}/read`,
      { data: {} },
    ),
  );
  assert.equal(opened.firstRead, true);
  const when = (
    await one("SELECT read_at FROM cloud_letters WHERE cat_id=$1 AND id=$2", [
      imported.catId,
      unseen.id,
    ])
  ).read_at.toISOString();
  const detail = await json(
    await client.get(
      `/api/e4/v1/letters/${encodeURIComponent(unseen.id)}/detail`,
    ),
  );
  assert.deepEqual(detail.letter.snapshot, unseen.snapshot);
  assert.equal(
    (
      await one("SELECT read_at FROM cloud_letters WHERE cat_id=$1 AND id=$2", [
        imported.catId,
        unseen.id,
      ])
    ).read_at.toISOString(),
    when,
  );
  const responses = await json(await client.get("/api/e4/v1/responses"));
  assert.equal(responses.responses.length, 2);
  const deleted = responses.responses.find(
    (response: any) => response.status === "DELETED",
  );
  assert.ok(deleted);
  assert.ok(deleted.text === null || deleted.text === undefined);
  const linked = state.letters.find((letter) => letter.sourceRefs?.length)!;
  const sources = await json(
    await client.get(
      `/api/e4/v1/letters/${encodeURIComponent(linked.id)}/sources`,
    ),
  );
  assert.equal(sources.sources[0].excerpt, "陪着你，");
  assert.equal(sources.sources[0].status, "CORRECTED");
  assert.equal(sources.sources[1].status, "DELETED");
  assert.equal("excerpt" in sources.sources[1], false);
  const foreignLogin = await newAccount(),
    foreign = await clientFor(foreignLogin);
  await json(
    await foreign.post("/api/e4/cat/adopt", {
      data: { name: "另一个账号", appearanceId: "cat-04", key: randomUUID() },
    }),
  );
  await json(
    await foreign.get(
      `/api/e4/v1/letters/${encodeURIComponent(unseen.id)}/detail`,
    ),
    404,
  );
  const foreignResponses = await json(
    await foreign.get("/api/e4/v1/responses"),
  );
  assert.equal(foreignResponses.responses.length, 0);
});

test("B3 empty archive and request boundaries: no new D0, no account/header/Origin bypass, bounded buffered and chunked bodies", async () => {
  const old = complexLegacyState();
  old.letters = [];
  old.responses = {};
  old.reviews = [];
  old.trip = null;
  old.calendar.nodes = [];
  old.calendar.processedCount = 0;
  const bundle = buildLegacyTransfer(old),
    login = await newAccount(),
    client = await clientFor(login);
  const key = randomUUID(),
    checked = await preflight(client, bundle);
  await json(
    await client.post("/api/e4/legacy/confirm", {
      headers: { Origin: "https://foreign.example" },
      data: { bundle, key, bundleHash: checked.bundleHash },
    }),
    403,
  );
  await json(
    await client.post("/api/e4/legacy/preflight", {
      headers: { "x-catletters-account": randomUUID() },
      data: { bundle },
    }),
    401,
  );
  const oversized = JSON.stringify({
    bundle,
    padding: "X".repeat(4 * 1024 * 1024),
  });
  await json(
    await client.post("/api/e4/legacy/preflight", {
      data: oversized,
      headers: { "Content-Type": "application/json" },
    }),
    413,
  );
  const bytes = new TextEncoder().encode(oversized);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 16384)
        controller.enqueue(bytes.slice(i, i + 16384));
      controller.close();
    },
  });
  const chunked = await fetch(`${origin}/api/e4/legacy/preflight`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: `cat_account_session=${login.rawToken}`,
      "Content-Type": "application/json",
    },
    body: stream,
    duplex: "half",
  } as RequestInit);
  assert.equal(chunked.status, 413);
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM cat_profiles WHERE account_id=$1",
        [login.accountId],
      )
    ).n,
    0,
  );
  const imported = await json(
    await client.post("/api/e4/legacy/confirm", {
      data: { bundle, key, bundleHash: checked.bundleHash },
    }),
  );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM cloud_calendar_nodes WHERE cat_id=$1",
        [imported.catId],
      )
    ).n,
    0,
  );
  const job = await one(
    "SELECT status,next_run_at FROM cloud_jobs WHERE cat_id=$1",
    [imported.catId],
  );
  assert.equal(job.status, "COMPLETE");
  assert.equal(job.next_run_at, null);
  await worker();
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM cloud_letters WHERE cat_id=$1",
        [imported.catId],
      )
    ).n,
    0,
  );
  const foreignLogin = await newAccount(),
    foreign = await clientFor(foreignLogin);
  assert.deepEqual(
    await json(await foreign.get(`/api/e4/legacy/requests/${key}`)),
    { pending: true },
  );
  assert.equal(
    (await client.get("/api/e4/legacy/requests/%E0%A4%A")).status(),
    400,
    "Malformed percent encoding may be rejected by Next before the JSON route",
  );
  await freezeAccountForDeletion(login.accountId, randomUUID());
  await json(await client.get(`/api/e4/legacy/requests/${key}`), 401);
  await json(
    await client.post("/api/e4/legacy/confirm", {
      data: { bundle, key, bundleHash: checked.bundleHash },
    }),
    401,
  );
});
