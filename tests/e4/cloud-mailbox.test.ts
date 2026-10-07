import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { request, type APIRequestContext } from "@playwright/test";
import { pool, transaction } from "../../src/server/db";
import { freezeAccountForDeletion } from "../../src/server/account-service";
import {
  cloudContentItems,
  cloudContentManifest,
  cloudContentHash,
  registerCloudContent,
} from "../../src/server/cloud-content";
import { LIGHT_DEMAND } from "../../src/content/supplemental";
import { LIGHT_DEMAND as frontendLight } from "../../static-app/content";
import frozen from "../../src/content/frozen.json";

// This suite is only run by the disposable-database harness. Fixtures are direct
// test SQL, never a public administration endpoint or a production login bypass.
const origin = process.env.E4_TEST_ORIGIN;
const mailboxDirectory = process.env.E4_SYNTHETIC_MAILBOX_DIR;
assert.ok(origin && mailboxDirectory, "Use scripts/test-e4-cloud.mjs");
const clients: APIRequestContext[] = [];
type Identity = {
  client: APIRequestContext;
  accountId: string;
  email: string;
  catId: string;
};
const api = (tail: string) => `/api/e4/v1/${tail}`;
const encoded = (id: string) => encodeURIComponent(id);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

after(async () => {
  await Promise.all(clients.map((client) => client.dispose()));
  await pool.end();
});

async function json(
  response: Awaited<ReturnType<APIRequestContext["get"]>>,
  status = 200,
): Promise<any> {
  const body = await response.json();
  assert.equal(
    response.status(),
    status,
    `${response.url()}: ${JSON.stringify(body)}`,
  );
  assert.equal(response.headers()["cache-control"], "no-store");
  return body;
}
async function login(
  address = `cloud-${randomUUID()}@example.test`,
  existingCatId?: string,
  name = "合成云猫",
): Promise<Identity> {
  const initial = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin! },
  });
  clients.push(initial);
  const asked = await json(
    await initial.post("/api/e4/auth/request-code", {
      data: { email: address },
    }),
  );
  assert.equal("code" in asked, false);
  const message = JSON.parse(
    await readFile(
      join(mailboxDirectory!, `${asked.challengeId}.json`),
      "utf8",
    ),
  );
  const verification = await initial.post("/api/e4/auth/verify-code", {
    data: {
      email: address,
      challengeId: asked.challengeId,
      code: message.code,
    },
  });
  const verified = await json(verification);
  assert.match(verification.headers()["set-cookie"], /HttpOnly/i);
  assert.match(verification.headers()["set-cookie"], /Secure/i);
  const cookie = (await initial.storageState()).cookies.find(
    (c) => c.name === "cat_account_session",
  );
  assert.ok(cookie);
  // Preserve production Secure assertions but exercise API jars on HTTP loopback.
  // This explicit test-only import is not browser enforcement or device evidence.
  const client = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin! },
    storageState: { cookies: [{ ...cookie, secure: false }], origins: [] },
  });
  clients.push(client);
  const catId =
    existingCatId ??
    (
      await json(
        await client.post("/api/e4/cat/adopt", {
          data: { name, appearanceId: "cat-02", key: randomUUID() },
        }),
      )
    ).cat.id;
  return { client, catId, accountId: verified.accountId, email: address };
}
async function secondSession(identity: Identity) {
  await pool.query(
    "UPDATE email_challenges SET created_at=now()-interval '2 hours' WHERE email_normalized=$1",
    [identity.email],
  );
  const result = await login(identity.email, identity.catId);
  assert.equal(result.accountId, identity.accountId);
  return result;
}
async function one(sql: string, values: unknown[] = []) {
  const result = await pool.query(sql, values);
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}
async function seedLetter(
  identity: Identity,
  type: "DEMAND" | "POSTCARD" = "DEMAND",
  suffix = "D-07",
  tripId: string | null = null,
) {
  const id = `${identity.catId}:${suffix}:${randomUUID()}:合成 /?%`;
  const content =
    type === "DEMAND"
      ? LIGHT_DEMAND
      : frozen.items.find((item) => item.id === "L-FIREFLY")!;
  const snapshot = {
    title: content.title,
    body: content.body,
    catName: "合成云猫",
  };
  await pool.query(
    `INSERT INTO cloud_letters(id,cat_id,account_id,type,snapshot,trip_id,planned_at,effective_at,origin)
    VALUES($1,$2,$3,$4,$5,$6,NULL,NULL,'LEGACY')`,
    [id, identity.catId, identity.accountId, type, snapshot, tripId],
  );
  return { id, snapshot };
}
async function seedTrip(identity: Identity, active = false) {
  const id = `${identity.catId}:trip:${randomUUID()}`;
  await pool.query(
    "INSERT INTO cloud_trips(id,cat_id,account_id,scene,status,origin) VALUES($1,$2,$3,'FIREFLY',$4,'LEGACY')",
    [id, identity.catId, identity.accountId, active ? "ACTIVE" : "COMPLETE"],
  );
  return id;
}
async function read(identity: Identity, letterId: string) {
  return json(
    await identity.client.post(api(`letters/${encoded(letterId)}/read`)),
  );
}
async function send(
  identity: Identity,
  letterId: string,
  text = "合成回应：可以慢慢来。",
  key = randomUUID(),
) {
  return json(
    await identity.client.post(api(`letters/${encoded(letterId)}/respond`), {
      data: { text, key, expectedResponseId: null },
    }),
  );
}
async function stateRevision(identity: Identity) {
  return (await json(await identity.client.get(api("state")))).stateRevision;
}

test("B1-01 registry: seven demands and complete approved travel payloads survive repeated seeding", async () => {
  assert.equal(
    (await one("SELECT current_database() AS name")).name,
    "catletters_e4_cloud_test",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT version FROM schema_migrations WHERE version='005_cloud_mailbox.sql'",
      )
    ).rowCount,
    1,
  );
  assert.equal(cloudContentItems.length, 13);
  assert.equal(cloudContentItems.filter((c) => c.type === "DEMAND").length, 7);
  assert.strictEqual(LIGHT_DEMAND, frontendLight);
  const expected = [
    ...frozen.items.filter((item) =>
      ["DEMAND", "ORDINARY", "LINKED"].includes(item.type),
    ),
    LIGHT_DEMAND,
  ];
  assert.deepEqual(cloudContentItems, expected);
  assert.deepEqual(await registerCloudContent(), cloudContentManifest);
  assert.deepEqual(await registerCloudContent(), cloudContentManifest);
  for (const item of expected) {
    const row = await one(
      "SELECT * FROM cloud_content_versions WHERE content_id=$1 AND version=$2",
      [item.id, item.version],
    );
    assert.deepEqual(row.payload, item);
    assert.equal(row.body_checksum, sha(item.body));
    assert.equal(row.payload_checksum, cloudContentHash(item));
  }
  assert.equal(
    (await one("SELECT count(*)::int AS n FROM cloud_content_versions")).n,
    13,
  );
  await assert.rejects(
    pool.query(
      "UPDATE cloud_content_versions SET payload=jsonb_set(payload,'{title}','\"tampered\"') WHERE content_id='D-07'",
    ),
    /immutable/,
  );
  await assert.rejects(
    transaction(async (db) => {
      // A database restore with a forged old row must fail closed even if both
      // stored checksums were copied unchanged. All preceding new rows roll back.
      await db.query("DELETE FROM cloud_content_versions");
      const expected = cloudContentManifest.items.find(
        (item) => item.contentId === "D-07",
      )!;
      await db.query(
        `INSERT INTO cloud_content_versions(content_id,version,type,payload,body_checksum,payload_checksum)
      VALUES($1,$2,'DEMAND',$3,$4,$5)`,
        [
          LIGHT_DEMAND.id,
          LIGHT_DEMAND.version,
          { ...LIGHT_DEMAND, title: "碰撞合成" },
          expected.bodySha256,
          expected.payloadSha256,
        ],
      );
      await registerCloudContent(db);
    }),
    /collision/,
  );
  assert.equal(
    (await one("SELECT count(*)::int AS n FROM cloud_content_versions")).n,
    13,
  );
  assert.deepEqual(
    (
      await one(
        "SELECT payload FROM cloud_content_versions WHERE content_id='D-07'",
      )
    ).payload,
    LIGHT_DEMAND,
  );
});

test("B1-02 two sessions: private summaries, one first-read transition, complete atomic read result and skip rules", async () => {
  const name = "👨‍👩‍👧‍👦".repeat(12);
  const a = await login(undefined, undefined, name);
  const b = await secondSession(a);
  const letter = await seedLetter(a);
  const before = await json(await a.client.get(api("state")));
  assert.equal(before.cat.id, a.catId);
  assert.equal(before.cat.name, name);
  assert.equal(before.unread.id, letter.id);
  const list = await json(await b.client.get(api("letters")));
  assert.equal(list.letters[0].id, letter.id);
  for (const summary of [before, list]) {
    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes(letter.snapshot.body), false);
    assert.equal(serialized.includes(letter.snapshot.title), false);
    assert.equal(
      /"(?:body|title|snapshot|image|illustration|contentId)"/.test(serialized),
      false,
    );
  }
  assert.equal(
    (
      await one(
        "SELECT read_at,planned_at,effective_at FROM cloud_letters WHERE cat_id=$1 AND id=$2",
        [a.catId, letter.id],
      )
    ).read_at,
    null,
  );
  const results = await Promise.all([read(a, letter.id), read(b, letter.id)]);
  assert.equal(results.filter((r) => r.firstRead).length, 1);
  for (const result of results) {
    assert.deepEqual(result.letter.snapshot, letter.snapshot);
    assert.equal(result.letter.id, letter.id);
    assert.equal(result.letter.plannedAt, null);
    assert.equal(result.letter.effectiveAt, null);
    assert.equal(result.stateRevision, before.stateRevision + 1);
  }
  // A first-read success already holds all display data. A later failed request
  // does not require or erase it; the client need not GET details again.
  const firstResult = results.find((r) => r.firstRead)!;
  await pool.query(
    "ALTER TABLE cloud_letters RENAME TO cloud_letters_synthetic_unavailable",
  );
  try {
    await json(
      await b.client.post(api(`letters/${encoded(letter.id)}/read`)),
      503,
    );
  } finally {
    await pool.query(
      "ALTER TABLE cloud_letters_synthetic_unavailable RENAME TO cloud_letters",
    );
  }
  assert.equal(firstResult.letter.snapshot.body, LIGHT_DEMAND.body);
  const persisted = await one(
    "SELECT read_at FROM cloud_letters WHERE cat_id=$1 AND id=$2",
    [a.catId, letter.id],
  );
  assert.ok(persisted.read_at);
  assert.equal((await read(b, letter.id)).firstRead, false);
  assert.equal(
    (
      await one("SELECT read_at FROM cloud_letters WHERE cat_id=$1 AND id=$2", [
        a.catId,
        letter.id,
      ])
    ).read_at.toISOString(),
    persisted.read_at.toISOString(),
  );
  const skipped = await seedLetter(a, "DEMAND", "skip");
  await json(await a.client.post(api(`letters/${encoded(skipped.id)}/skip`)));
  const skippedOnce = await stateRevision(a);
  await json(await b.client.post(api(`letters/${encoded(skipped.id)}/skip`)));
  assert.equal(await stateRevision(a), skippedOnce);
  const skippedRow = await one(
    "SELECT skipped_at,read_at FROM cloud_letters WHERE cat_id=$1 AND id=$2",
    [a.catId, skipped.id],
  );
  assert.ok(skippedRow.skipped_at && skippedRow.read_at);
  assert.deepEqual(
    (await read(a, skipped.id)).letter.snapshot,
    skipped.snapshot,
  );
  const postcard = await seedLetter(a, "POSTCARD", "postcard");
  await json(
    await a.client.post(api(`letters/${encoded(postcard.id)}/skip`)),
    409,
  );
  assert.equal(
    (
      await one(
        "SELECT skipped_at FROM cloud_letters WHERE cat_id=$1 AND id=$2",
        [a.catId, postcard.id],
      )
    ).skipped_at,
    null,
  );
});

test("B1-03 HTTP races: one send per key, payload conflict, two-session revision conflict and recovery lookup", async () => {
  const a = await login();
  const b = await secondSession(a);
  const letter = await seedLetter(a);
  await read(a, letter.id);
  const input = {
    text: "合成回应：今天可以歇一会。",
    key: randomUUID(),
    expectedResponseId: null,
  };
  const replies = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? a : b).client
        .post(api(`letters/${encoded(letter.id)}/respond`), { data: input })
        .then((r) => json(r)),
    ),
  );
  replies.forEach((reply) => assert.deepEqual(reply, replies[0]));
  const result = replies[0];
  assert.equal(result.message, "送出去啦。");
  assert.equal(result.revision, 1);
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM cloud_responses WHERE cat_id=$1",
        [a.catId],
      )
    ).n,
    1,
  );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM cloud_response_revisions WHERE cat_id=$1",
        [a.catId],
      )
    ).n,
    1,
  );
  // If the caller loses the successful reply, it queries the stable result;
  // no second write or retry delivery is required.
  assert.deepEqual(
    await json(await b.client.get(api(`requests/SEND_RESPONSE/${input.key}`))),
    result,
  );
  await json(
    await b.client.post(api(`letters/${encoded(letter.id)}/respond`), {
      data: { ...input, text: "合成变更" },
    }),
    409,
  );
  const corrections = await Promise.all(
    [a, b].map((identity, index) =>
      identity.client.post(
        api(`responses/${encoded(result.responseId)}/edit`),
        {
          data: {
            text: `合成更正${index}`,
            key: randomUUID(),
            expectedRevision: 1,
          },
        },
      ),
    ),
  );
  assert.deepEqual(corrections.map((r) => r.status()).sort(), [200, 409]);
  const current = (
    await json(
      await b.client.get(api(`responses/${encoded(result.responseId)}`)),
    )
  ).response;
  assert.equal(current.currentRevision, 2);
  assert.equal(current.revisions.length, 2);
  assert.equal(current.revisions[0].text, input.text);
  assert.ok(["合成更正0", "合成更正1"].includes(current.revisions[1].text));
});

test("B1-03 text boundary: 2000 Chinese UTF-16 units accepted, 2001 units rejected without a write", async () => {
  const a = await login();
  const valid = await seedLetter(a);
  await read(a, valid.id);
  const text = "猫".repeat(2000);
  assert.ok(Buffer.byteLength(text) > 4096);
  const sent = await send(a, valid.id, text);
  assert.equal(
    (
      await one(
        "SELECT text FROM cloud_response_revisions WHERE cat_id=$1 AND response_id=$2",
        [a.catId, sent.responseId],
      )
    ).text,
    text,
  );
  const invalid = await seedLetter(a, "DEMAND", "too-long");
  await read(a, invalid.id);
  const key = randomUUID(),
    before = await stateRevision(a);
  await json(
    await a.client.post(api(`letters/${encoded(invalid.id)}/respond`), {
      data: { text: `${"🐈".repeat(1000)}x`, key, expectedResponseId: null },
    }),
    400,
  );
  assert.equal(await stateRevision(a), before);
  assert.deepEqual(
    await json(await a.client.get(api(`requests/SEND_RESPONSE/${key}`))),
    { pending: true },
  );
  assert.equal(
    (
      await pool.query(
        "SELECT id FROM cloud_responses WHERE cat_id=$1 AND letter_id=$2",
        [a.catId, invalid.id],
      )
    ).rowCount,
    0,
  );
});

test("B1-03 SQL failure at final receipt insert rolls back send/edit and retry recovers once", async () => {
  const a = await login();
  const letter = await seedLetter(a);
  await read(a, letter.id);
  const key = randomUUID(),
    before = await stateRevision(a);
  await pool.query(
    `CREATE FUNCTION e4_cloud_fail_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic final receipt failure'; END $$`,
  );
  await pool.query(
    "CREATE TRIGGER e4_cloud_fail BEFORE INSERT ON cloud_requests FOR EACH ROW EXECUTE FUNCTION e4_cloud_fail_request()",
  );
  try {
    await json(
      await a.client.post(api(`letters/${encoded(letter.id)}/respond`), {
        data: { text: "合成回滚", key, expectedResponseId: null },
      }),
      503,
    );
  } finally {
    await pool.query("DROP TRIGGER e4_cloud_fail ON cloud_requests");
  }
  assert.equal(await stateRevision(a), before);
  assert.equal(
    (
      await pool.query("SELECT id FROM cloud_responses WHERE cat_id=$1", [
        a.catId,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT revision FROM cloud_response_revisions WHERE cat_id=$1",
        [a.catId],
      )
    ).rowCount,
    0,
  );
  assert.deepEqual(
    await json(await a.client.get(api(`requests/SEND_RESPONSE/${key}`))),
    { pending: true },
  );
  const sent = await send(a, letter.id, "合成回滚", key);
  const editKey = randomUUID(),
    beforeEdit = await stateRevision(a);
  await pool.query(
    "CREATE TRIGGER e4_cloud_fail BEFORE INSERT ON cloud_requests FOR EACH ROW EXECUTE FUNCTION e4_cloud_fail_request()",
  );
  try {
    await json(
      await a.client.post(api(`responses/${encoded(sent.responseId)}/edit`), {
        data: { text: "不应写入", key: editKey, expectedRevision: 1 },
      }),
      503,
    );
  } finally {
    await pool.query("DROP TRIGGER e4_cloud_fail ON cloud_requests");
    await pool.query("DROP FUNCTION e4_cloud_fail_request()");
  }
  assert.equal(await stateRevision(a), beforeEdit);
  const response = (
    await json(await a.client.get(api(`responses/${encoded(sent.responseId)}`)))
  ).response;
  assert.equal(response.currentRevision, 1);
  assert.equal(response.revisions.length, 1);
  assert.equal(response.revisions[0].text, "合成回滚");
  assert.deepEqual(
    await json(await a.client.get(api(`requests/EDIT_RESPONSE/${editKey}`))),
    { pending: true },
  );
});

test("B1-04 frozen UTF-16 sources retain original revisions; edit/delete invalidate pending reviews and erase all text", async () => {
  const a = await login();
  const original = await seedLetter(a);
  await read(a, original.id);
  const firstText = "前🐈愿意陪着你。后",
    secondText = "甲🦋心意有自己的价值。乙";
  const sendKey = randomUUID(),
    editKey = randomUUID();
  const sent = await send(a, original.id, firstText, sendKey);
  const revised = await json(
    await a.client.post(api(`responses/${encoded(sent.responseId)}/edit`), {
      data: { text: secondText, key: editKey, expectedRevision: 1 },
    }),
  );
  assert.equal(revised.revision, 2);
  const trip = await seedTrip(a);
  const postcard = await seedLetter(a, "POSTCARD", "linked", trip);
  const immutableBefore = await one(
    "SELECT snapshot FROM cloud_letters WHERE cat_id=$1 AND id=$2",
    [a.catId, postcard.id],
  );
  const sources = [
    { revision: 1, start: 1, end: 3, claim: "陪伴表达关心", text: firstText },
    { revision: 2, start: 3, end: 11, claim: "心意的价值", text: secondText },
  ];
  for (const [index, source] of sources.entries()) {
    await pool.query(
      `INSERT INTO cloud_letter_sources(cat_id,account_id,letter_id,source_order,response_id,revision,claim,start_offset,end_offset,assessment,attested)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'SUPPORTED',true)`,
      [
        a.catId,
        a.accountId,
        postcard.id,
        index,
        sent.responseId,
        source.revision,
        source.claim,
        source.start,
        source.end,
      ],
    );
  }
  const futureTrip = await seedTrip(a, true),
    reviewId = `review:${randomUUID()}`;
  await pool.query(
    `INSERT INTO cloud_reviews(id,cat_id,account_id,trip_id,story_id,fallback_id,kind,status)
    VALUES($1,$2,$3,$4,'L-FIREFLY','O-FIREFLY-01','LINKED','SELECTED')`,
    [reviewId, a.catId, a.accountId, futureTrip],
  );
  await pool.query(
    `INSERT INTO cloud_review_sources(cat_id,account_id,review_id,source_order,response_id,revision,claim,start_offset,end_offset,assessment,attested)
    VALUES($1,$2,$3,0,$4,2,'心意的价值',3,11,'SUPPORTED',true)`,
    [a.catId, a.accountId, reviewId, sent.responseId],
  );
  const before = await json(
    await a.client.get(api(`letters/${encoded(postcard.id)}/sources`)),
  );
  assert.equal(before.sources.length, 2);
  for (const [index, source] of sources.entries()) {
    assert.equal(
      before.sources[index].excerpt,
      source.text.slice(source.start, source.end),
    );
    assert.equal(before.sources[index].title, original.snapshot.title);
    assert.equal(before.sources[index].revision, source.revision);
    assert.ok(before.sources[index].at);
  }
  assert.equal(before.sources[0].status, "CORRECTED");
  assert.equal(before.sources[1].status, "ACTIVE");
  await assert.rejects(
    pool.query(
      "UPDATE cloud_letter_sources SET start_offset=0 WHERE cat_id=$1 AND letter_id=$2 AND source_order=0",
      [a.catId, postcard.id],
    ),
    /immutable/,
  );
  await json(
    await a.client.post(api(`responses/${encoded(sent.responseId)}/edit`), {
      data: {
        text: "新版本不能覆盖已经寄出的依据。",
        key: randomUUID(),
        expectedRevision: 2,
      },
    }),
  );
  assert.equal(
    (
      await one("SELECT status FROM cloud_reviews WHERE cat_id=$1 AND id=$2", [
        a.catId,
        reviewId,
      ])
    ).status,
    "NEEDS_REVIEW",
  );
  const afterEdit = await json(
    await a.client.get(api(`letters/${encoded(postcard.id)}/sources`)),
  );
  afterEdit.sources.forEach((source: any, index: number) => {
    assert.equal(source.status, "CORRECTED");
    assert.equal(
      source.excerpt,
      sources[index].text.slice(sources[index].start, sources[index].end),
    );
  });
  assert.equal(
    cloudContentHash(
      (
        await one(
          "SELECT snapshot FROM cloud_letters WHERE cat_id=$1 AND id=$2",
          [a.catId, postcard.id],
        )
      ).snapshot,
    ),
    cloudContentHash(immutableBefore.snapshot),
  );
  await assert.rejects(
    pool.query(
      "UPDATE cloud_letters SET snapshot=jsonb_set(snapshot,'{body}','\"rewrite\"') WHERE cat_id=$1 AND id=$2",
      [a.catId, postcard.id],
    ),
    /immutable/,
  );
  // Re-review is an explicitly synthetic SQL fixture; public callers have no
  // review operation. Deletion must invalidate this unposted review too.
  await pool.query(
    "UPDATE cloud_reviews SET status='SELECTED' WHERE cat_id=$1 AND id=$2",
    [a.catId, reviewId],
  );
  const deleteKey = randomUUID();
  const deleted = await json(
    await a.client.post(api(`responses/${encoded(sent.responseId)}/delete`), {
      data: { key: deleteKey, expectedRevision: 3 },
    }),
  );
  assert.equal(deleted.message, "已删除。");
  assert.equal(
    (
      await one("SELECT status FROM cloud_reviews WHERE cat_id=$1 AND id=$2", [
        a.catId,
        reviewId,
      ])
    ).status,
    "NEEDS_REVIEW",
  );
  const versions = await pool.query(
    "SELECT text FROM cloud_response_revisions WHERE cat_id=$1 AND response_id=$2",
    [a.catId, sent.responseId],
  );
  assert.equal(versions.rowCount, 3);
  versions.rows.forEach((row) => assert.equal(row.text, null));
  const afterDelete = await json(
    await a.client.get(api(`letters/${encoded(postcard.id)}/sources`)),
  );
  afterDelete.sources.forEach((source: any) => {
    assert.equal(source.status, "DELETED");
    assert.equal(source.label, "已删除");
    assert.equal("excerpt" in source, false);
  });
  const response = await json(
    await a.client.get(api(`responses/${encoded(sent.responseId)}`)),
  );
  const recovered = await json(
    await a.client.get(api(`requests/SEND_RESPONSE/${sendKey}`)),
  );
  const replay = await json(
    await a.client.post(api(`letters/${encoded(original.id)}/respond`), {
      data: { text: firstText, key: sendKey, expectedResponseId: null },
    }),
  );
  assert.deepEqual(replay, recovered);
  for (const payload of [
    response,
    recovered,
    replay,
    afterDelete,
    await json(await a.client.get(api(`requests/EDIT_RESPONSE/${editKey}`))),
  ]) {
    assert.equal(JSON.stringify(payload).includes(firstText), false);
    assert.equal(JSON.stringify(payload).includes(secondText), false);
    assert.equal(JSON.stringify(payload).includes("新版本不能覆盖"), false);
  }
  await json(
    await a.client.post(api(`letters/${encoded(original.id)}/respond`), {
      data: { text: "不可复活", key: randomUUID(), expectedResponseId: null },
    }),
    409,
  );
  await json(
    await a.client.post(api(`responses/${encoded(sent.responseId)}/edit`), {
      data: { text: "不可复活", key: randomUUID(), expectedRevision: 3 },
    }),
    409,
  );
  assert.deepEqual(
    await json(
      await a.client.post(api(`responses/${encoded(sent.responseId)}/delete`), {
        data: { key: deleteKey, expectedRevision: 3 },
      }),
    ),
    deleted,
  );
  assert.deepEqual(
    (await read(a, postcard.id)).letter.snapshot,
    immutableBefore.snapshot,
  );
});

test("B1-03 safety: unavailable rolls back; interception blocks response but retains read/delete access", async () => {
  const a = await login();
  const original = await seedLetter(a);
  await read(a, original.id);
  const sent = await send(a, original.id);
  const unsafe = await seedLetter(a, "DEMAND", "unsafe");
  await read(a, unsafe.id);
  const before = await stateRevision(a),
    sendKey = randomUUID(),
    editKey = randomUUID();
  await json(
    await a.client.post(api(`letters/${encoded(unsafe.id)}/respond`), {
      data: {
        text: "[SYNTHETIC:UNAVAILABLE]",
        key: sendKey,
        expectedResponseId: null,
      },
    }),
    503,
  );
  await json(
    await a.client.post(api(`responses/${encoded(sent.responseId)}/edit`), {
      data: {
        text: "[SYNTHETIC:UNAVAILABLE]",
        key: editKey,
        expectedRevision: 1,
      },
    }),
    503,
  );
  assert.equal(await stateRevision(a), before);
  assert.deepEqual(
    await json(await a.client.get(api(`requests/SEND_RESPONSE/${sendKey}`))),
    { pending: true },
  );
  assert.deepEqual(
    await json(await a.client.get(api(`requests/EDIT_RESPONSE/${editKey}`))),
    { pending: true },
  );
  assert.equal(
    (
      await one(
        "SELECT count(*)::int AS n FROM cloud_response_revisions WHERE cat_id=$1",
        [a.catId],
      )
    ).n,
    1,
  );
  const intercepted = await json(
    await a.client.post(api(`letters/${encoded(unsafe.id)}/respond`), {
      data: {
        text: "[SYNTHETIC:INTERCEPT]",
        key: randomUUID(),
        expectedResponseId: null,
      },
    }),
  );
  assert.equal(intercepted.safety, "INTERCEPTED");
  assert.equal(
    (await json(await a.client.get(api("state")))).safety,
    "INTERCEPTED",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT id FROM cloud_responses WHERE cat_id=$1 AND letter_id=$2",
        [a.catId, unsafe.id],
      )
    ).rowCount,
    0,
  );
  assert.deepEqual((await read(a, unsafe.id)).letter.snapshot, unsafe.snapshot);
  await json(
    await a.client.post(api(`letters/${encoded(unsafe.id)}/respond`), {
      data: { text: "后来发送", key: randomUUID(), expectedResponseId: null },
    }),
    409,
  );
  await json(
    await a.client.post(api(`responses/${encoded(sent.responseId)}/delete`), {
      data: { key: randomUUID(), expectedRevision: 1 },
    }),
  );
  assert.equal(
    (
      await one(
        "SELECT text FROM cloud_response_revisions WHERE cat_id=$1 AND response_id=$2",
        [a.catId, sent.responseId],
      )
    ).text,
    null,
  );
});

test("B1-05 ownership and permissions: cross-account IDs/FKs denied, invalid path is 400, no review bypass, frozen account denied", async () => {
  const a = await login(),
    b = await login();
  const letter = await seedLetter(a);
  await read(a, letter.id);
  const sendKey = randomUUID();
  const sent = await send(a, letter.id, "合成回应", sendKey);
  assert.deepEqual(
    await json(await b.client.get(api(`requests/SEND_RESPONSE/${sendKey}`))),
    { pending: true },
  );
  for (const tail of [
    `letters/${encoded(letter.id)}/sources`,
    `responses/${encoded(sent.responseId)}`,
  ]) {
    await json(await b.client.get(api(tail)), 404);
  }
  for (const tail of [
    `letters/${encoded(letter.id)}/read`,
    `letters/${encoded(letter.id)}/skip`,
  ]) {
    await json(await b.client.post(api(tail)), 404);
  }
  await json(
    await b.client.post(api(`letters/${encoded(letter.id)}/respond`), {
      data: { text: "跨账号", key: randomUUID(), expectedResponseId: null },
    }),
    404,
  );
  await json(
    await b.client.post(api(`responses/${encoded(sent.responseId)}/edit`), {
      data: { text: "跨账号", key: randomUUID(), expectedRevision: 1 },
    }),
    404,
  );
  await json(
    await b.client.post(api(`responses/${encoded(sent.responseId)}/delete`), {
      data: { key: randomUUID(), expectedRevision: 1 },
    }),
    404,
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO cloud_letters(id,cat_id,account_id,type,snapshot) VALUES($1,$2,$3,'DEMAND',$4)`,
      [randomUUID(), a.catId, b.accountId, letter.snapshot],
    ),
    (e: any) => e.code === "23503",
  );
  for (const snapshot of [
    { body: "不能缺少标题和猫名" },
    { ...letter.snapshot, tip: { text: "不接受嵌套对象" } },
    { ...letter.snapshot, body: null },
  ]) {
    const invalidId = `bad-snapshot:${randomUUID()}`;
    await assert.rejects(
      pool.query(
        `INSERT INTO cloud_letters(id,cat_id,account_id,type,snapshot) VALUES($1,$2,$3,'DEMAND',$4)`,
        [invalidId, a.catId, a.accountId, snapshot],
      ),
      (e: any) => e.code === "23514",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT id FROM cloud_letters WHERE cat_id=$1 AND id=$2",
          [a.catId, invalidId],
        )
      ).rowCount,
      0,
    );
  }
  const foreignLetter = await seedLetter(b);
  await assert.rejects(
    pool.query(
      `INSERT INTO cloud_letter_sources(cat_id,account_id,letter_id,source_order,response_id,revision,claim,start_offset,end_offset,assessment,attested)
    VALUES($1,$2,$3,0,$4,1,'合成',0,1,'SUPPORTED',true)`,
      [b.catId, b.accountId, foreignLetter.id, sent.responseId],
    ),
    (e: any) => e.code === "23503",
  );
  assert.equal(
    (await a.client.post(api("letters/%E0%A4%A/read"))).status(),
    400,
  );
  await json(
    await a.client.post(api(`responses/${encoded(sent.responseId)}/edit`), {
      data: {
        text: "伪造审核",
        key: randomUUID(),
        expectedRevision: 1,
        attested: true,
      },
    }),
    400,
  );
  await json(
    await a.client.post(api("reviews"), {
      data: { attested: true, accountId: a.accountId },
    }),
    404,
  );
  await json(
    await a.client.post(api("deliver"), { data: { storyId: "L-FIREFLY" } }),
    404,
  );
  const foreignOrigin = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: "https://foreign.invalid" },
    storageState: await a.client.storageState(),
  });
  clients.push(foreignOrigin);
  await json(
    await foreignOrigin.post(api(`letters/${encoded(letter.id)}/read`)),
    403,
  );
  await freezeAccountForDeletion(a.accountId, randomUUID());
  await json(await a.client.get(api("state")), 401);
  await json(
    await a.client.get(api(`responses/${encoded(sent.responseId)}`)),
    401,
  );
  await json(
    await a.client.post(api(`letters/${encoded(letter.id)}/read`)),
    401,
  );
  await json(
    await a.client.post(api(`responses/${encoded(sent.responseId)}/delete`), {
      data: { key: randomUUID(), expectedRevision: 1 },
    }),
    401,
  );
  assert.equal((await json(await b.client.get(api("state")))).cat.id, b.catId);
});

test("B1-03 edit interception commits safety without a partial new version", async () => {
  const a = await login(),
    letter = await seedLetter(a);
  await read(a, letter.id);
  const sent = await send(a, letter.id, "原回应保持不变");
  const key = randomUUID(),
    before = await stateRevision(a);
  const intercepted = await json(
    await a.client.post(api(`responses/${encoded(sent.responseId)}/edit`), {
      data: { text: "[SYNTHETIC:INTERCEPT]", key, expectedRevision: 1 },
    }),
  );
  assert.equal(intercepted.safety, "INTERCEPTED");
  assert.equal(intercepted.stateRevision, before + 1);
  const response = (
    await json(await a.client.get(api(`responses/${encoded(sent.responseId)}`)))
  ).response;
  assert.equal(response.currentRevision, 1);
  assert.equal(response.revisions.length, 1);
  assert.equal(response.revisions[0].text, "原回应保持不变");
  assert.deepEqual(
    await json(await a.client.get(api(`requests/EDIT_RESPONSE/${key}`))),
    intercepted,
  );
  assert.equal(
    (await read(a, letter.id)).letter.response.text,
    "原回应保持不变",
  );
  await json(
    await a.client.post(api(`responses/${encoded(sent.responseId)}/delete`), {
      data: { key: randomUUID(), expectedRevision: 1 },
    }),
  );
});

test("B1-05 bounded HTTP body rejects large buffered and chunked requests before business writes", async () => {
  const a = await login(),
    letter = await seedLetter(a);
  await read(a, letter.id);
  const before = await stateRevision(a);
  const bufferedKey = randomUUID(),
    chunkedKey = randomUUID();
  await json(
    await a.client.post(api(`letters/${encoded(letter.id)}/respond`), {
      data: {
        text: "x".repeat(40000),
        key: bufferedKey,
        expectedResponseId: null,
      },
    }),
    413,
  );
  const cookie = (await a.client.storageState()).cookies
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const payload = JSON.stringify({
    text: "x".repeat(40000),
    key: chunkedKey,
    expectedResponseId: null,
  });
  const bytes = new TextEncoder().encode(payload);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(offset + 4096, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
  // A stream plus duplex=half sends chunked transfer without Content-Length;
  // this exercises the accumulated byte bound, not only the early header guard.
  const response = await fetch(
    `${origin}${api(`letters/${encoded(letter.id)}/respond`)}`,
    {
      method: "POST",
      headers: {
        Origin: origin!,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: stream,
      duplex: "half",
      signal: AbortSignal.timeout(10000),
    } as RequestInit & { duplex: "half" },
  );
  assert.equal(response.status, 413);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "输入过长。" });
  assert.equal(await stateRevision(a), before);
  for (const key of [bufferedKey, chunkedKey]) {
    assert.deepEqual(
      await json(await a.client.get(api(`requests/SEND_RESPONSE/${key}`))),
      { pending: true },
    );
  }
  assert.equal(
    (
      await pool.query(
        "SELECT id FROM cloud_responses WHERE cat_id=$1 AND letter_id=$2",
        [a.catId, letter.id],
      )
    ).rowCount,
    0,
  );
});
