import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  db,
  assertDedicated,
  dispose,
  richFixture,
  requestExport,
  tick,
  prepare,
  confirm,
  status,
  login,
  bind,
  clients,
  origin,
  hash,
  json,
} from "./helpers";

await assertDedicated();
const path = process.env.E4_RESTORE_FIXTURE!;
try {
  if (process.argv[2] === "seed") {
    const a = await richFixture(),
      b = await richFixture(),
      exportJob = await requestExport(a),
      survivorExport = await requestExport(b),
      pendingReview = randomUUID();
    await db.query(
      "INSERT INTO cloud_reviews(id,cat_id,account_id,trip_id,story_id,fallback_id,kind,status,reason) SELECT $2,cat_id,account_id,trip_id,story_id,fallback_id,kind,'SELECTED',reason FROM cloud_reviews WHERE account_id=$1 LIMIT 1",
      [b.accountId, pendingReview],
    );
    await db.query(
      "INSERT INTO cloud_review_sources(cat_id,account_id,review_id,source_order,response_id,revision,claim,start_offset,end_offset,assessment,attested) SELECT cat_id,account_id,$2,source_order,response_id,revision,claim,start_offset,end_offset,assessment,attested FROM cloud_review_sources WHERE account_id=$1 LIMIT 1",
      [b.accountId, pendingReview],
    );
    await tick();
    await tick();
    const document = {
      a: {
        accountId: a.accountId,
        email: a.email,
        participantId: a.cat.participant_id,
        catId: a.cat.id,
        marker: a.marker,
        bundle: a.bundle,
        cookies: (await a.client.storageState()).cookies,
      },
      b: {
        accountId: b.accountId,
        catId: b.cat.id,
        response: b.response,
        current: b.current,
        first: b.first,
        postcard: b.postcard,
        pendingReview,
        exportId: survivorExport.id,
        snapshotHash: hash(
          (
            await db.query(
              "SELECT snapshot FROM cloud_letters WHERE account_id=$1 AND id=$2",
              [b.accountId, b.postcard],
            )
          ).rows[0].snapshot,
        ),
        cookies: (await b.client.storageState()).cookies,
      },
      exportId: exportJob.id,
    };
    await writeFile(path, JSON.stringify(document), {
      mode: 0o600,
      flag: "wx",
    });
    console.log("Restore fixture seeded; private data is not emitted");
  } else if (process.argv[2] === "delete") {
    const f = JSON.parse(await readFile(path, "utf8"));
    const c = await request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { Origin: origin },
      storageState: { cookies: f.a.cookies, origins: [] },
    });
    clients.push(c);
    const a = {
      client: c,
      accountId: f.a.accountId,
      email: f.a.email,
      challengeId: "",
    };
    const survivor = await request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { Origin: origin },
      storageState: { cookies: f.b.cookies, origins: [] },
    });
    clients.push(survivor);
    await json(
      survivor,
      "post",
      `/api/e4/v1/responses/${encodeURIComponent(f.b.response)}/delete`,
      { key: randomUUID(), expectedRevision: 2 },
    );
    const prepared = await prepare(a);
    await confirm(a, prepared.requestId);
    await tick();
    assert.equal((await status(a)).status, "COMPLETE");
    const fresh = await login(a.email),
      binding = await bind(fresh);
    f.a.requestId = prepared.requestId;
    f.a.recoveryCookies = (await c.storageState()).cookies;
    f.fresh = {
      accountId: fresh.accountId,
      catId: binding.cat.id,
      participantId: binding.cat.participant_id,
      cookies: (await fresh.client.storageState()).cookies,
    };
    await writeFile(path, JSON.stringify(f), { mode: 0o600 });
    console.log(
      "External deletion intent durable and fresh same-email account created; private data is not emitted",
    );
  } else throw Error("Unknown restore fixture phase");
} finally {
  await dispose();
}
