import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "@playwright/test";
import { pool, transaction } from "../../src/server/db";
import { digest, newParticipant } from "../../src/server/auth";
import {
  requestCode,
  verifyCode,
  accountIdentity,
  accountCookieSecure,
  logoutAccount,
} from "../../src/server/account-auth";
import {
  adoptCat,
  accountState,
  adoptionResult,
  freezeAccountForDeletion,
  countAccountCatName,
} from "../../src/server/account-service";
import { countCatName } from "../../static-app/model";
import { SyntheticMailbox } from "../../src/server/otp-delivery";

const mailbox = new SyntheticMailbox();
const email = () => `synthetic-${randomUUID()}@example.test`;
async function challenge(address = email()) {
  const result = await requestCode(address, mailbox);
  return { ...mailbox.messages.get(result.challengeId)!, address };
}
async function login(address = email()) {
  const c = await challenge(address);
  return { ...(await verifyCode(c.challengeId, address, c.code)), address };
}
async function allowResend(address: string) {
  await pool.query(
    "UPDATE email_challenges SET created_at=now()-interval '2 hours' WHERE email_normalized=$1",
    [address],
  );
}
after(async () => {
  await pool.end();
});

test("A01: incorrect OTP attempts survive failure, expire, revoke, rate-limit and fail closed", async () => {
  const c = await challenge();
  const wrong = c.code === "000000" ? "999999" : "000000";
  for (let count = 1; count <= 5; count++) {
    await assert.rejects(
      verifyCode(c.challengeId, c.address, wrong),
      /验证码无效/,
    );
    const r = await pool.query(
      "SELECT failures FROM email_challenges WHERE id=$1",
      [c.challengeId],
    );
    assert.equal(r.rows[0].failures, count);
  }
  await assert.rejects(
    verifyCode(c.challengeId, c.address, c.code),
    /验证码无效/,
  );
  await assert.rejects(requestCode(c.address, mailbox), /过于频繁/);
  await allowResend(c.address);
  const replacement = await challenge(c.address);
  await assert.rejects(
    verifyCode(c.challengeId, c.address, c.code),
    /验证码无效/,
  );
  await pool.query(
    "UPDATE email_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",
    [replacement.challengeId],
  );
  await assert.rejects(
    verifyCode(replacement.challengeId, c.address, replacement.code),
    /验证码无效/,
  );
  const absentSecret = process.env.OTP_HASH_SECRET;
  delete process.env.OTP_HASH_SECRET;
  try {
    await assert.rejects(requestCode(email(), mailbox), /尚未配置/);
  } finally {
    process.env.OTP_HASH_SECRET = absentSecret;
  }
  const failedEmail = email();
  await assert.rejects(
    requestCode(failedEmail, {
      async send() {
        throw Error("synthetic delivery failure");
      },
    }),
    /未能就绪/,
  );
  const failed = await pool.query(
    "SELECT delivery_status,revoked_at FROM email_challenges WHERE email_normalized=$1",
    [failedEmail],
  );
  assert.equal(failed.rows[0].delivery_status, "FAILED");
  assert.ok(failed.rows[0].revoked_at);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM accounts WHERE email_normalized=$1",
        [failedEmail],
      )
    ).rows[0].n,
    0,
  );
});

test("A02: a correct challenge is consumed once across eight concurrent verifications", async () => {
  const c = await challenge();
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      verifyCode(c.challengeId, c.address, c.code),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const sessions = await pool.query(
    "SELECT s.* FROM account_sessions s JOIN accounts a ON a.id=s.account_id WHERE a.email_normalized=$1",
    [c.address],
  );
  assert.equal(sessions.rowCount, 1);
  assert.equal(sessions.rows[0].token_hash.length, 64);
  const stored = await pool.query(
    "SELECT code_hash FROM email_challenges WHERE id=$1",
    [c.challengeId],
  );
  assert.notEqual(stored.rows[0].code_hash, digest(c.code));
  await assert.rejects(
    verifyCode(c.challengeId, c.address, c.code),
    /验证码无效/,
  );
});

test("A03/A06: two sessions share account identity, logout is local, foreign/legacy/expired sessions fail", async () => {
  const a = await login();
  await allowResend(a.address);
  const b = await login(a.address.toUpperCase());
  assert.equal(a.accountId, b.accountId);
  assert.notEqual(a.rawToken, b.rawToken);
  const other = await login();
  assert.notEqual(a.accountId, other.accountId);
  assert.equal(await accountIdentity(a.rawToken), a.accountId);
  await logoutAccount(a.rawToken);
  await logoutAccount(a.rawToken);
  await assert.rejects(accountIdentity(a.rawToken), /会话已过期/);
  assert.equal(await accountIdentity(b.rawToken), b.accountId);
  const invite = await newParticipant();
  await assert.rejects(accountIdentity(invite.invite), /会话已过期/);
  await pool.query(
    "UPDATE account_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
    [digest(b.rawToken)],
  );
  await assert.rejects(accountIdentity(b.rawToken), /会话已过期/);
});

test("A04: two-device adoption race creates one stable cat and enforces idempotency ownership", async () => {
  const a = await login();
  const inputs = [
    { name: "合成甲", appearanceId: "cat-01", key: randomUUID() },
    { name: "合成乙", appearanceId: "cat-02", key: randomUUID() },
  ];
  const results = await Promise.allSettled(
    inputs.map((input) => adoptCat(a.accountId, input)),
  );
  const winner = results.findIndex((r) => r.status === "fulfilled");
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const original = (results[winner] as PromiseFulfilledResult<any>).value;
  assert.deepEqual(await adoptCat(a.accountId, inputs[winner]), original);
  await assert.rejects(
    adoptCat(a.accountId, { ...inputs[winner], name: "合成变更" }),
    /内容已改变/,
  );
  const state = await accountState(a.accountId);
  assert.equal(state.cat.id, original.cat.id);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM cat_profiles WHERE account_id=$1",
        [a.accountId],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM participants WHERE id=$1",
        [original.cat.participant_id],
      )
    ).rows[0].n,
    1,
  );
  const other = await login();
  assert.deepEqual(await adoptionResult(other.accountId, inputs[winner].key), {
    pending: true,
  });
  assert.deepEqual(
    await adoptionResult(a.accountId, inputs[winner].key),
    original,
  );
});

test("A05: real SQL failure after participant creation rolls back every adoption write", async () => {
  const a = await login();
  const input = { name: "回滚合成", appearanceId: "cat-03", key: randomUUID() };
  const count = (
    await pool.query("SELECT count(*)::int AS n FROM participants")
  ).rows[0].n;
  await pool.query(`CREATE FUNCTION e4_test_fail_adoption() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic failure after participant insert'; END; $$`);
  await pool.query(
    "CREATE TRIGGER e4_test_fail BEFORE INSERT ON cat_profiles FOR EACH ROW EXECUTE FUNCTION e4_test_fail_adoption()",
  );
  try {
    await assert.rejects(adoptCat(a.accountId, input), /synthetic failure/);
  } finally {
    await pool.query("DROP TRIGGER e4_test_fail ON cat_profiles");
    await pool.query("DROP FUNCTION e4_test_fail_adoption()");
  }
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM participants")).rows[0].n,
    count,
  );
  assert.equal((await accountState(a.accountId)).cat, null);
  assert.deepEqual(await adoptionResult(a.accountId, input.key), {
    pending: true,
  });
  assert.ok((await adoptCat(a.accountId, input)).cat.id);
});

test("A04 names: accepted 12-grapheme Chinese/ZWJ/combining names survive PostgreSQL", async () => {
  for (const name of ["猫".repeat(12), "👨‍👩‍👧‍👦".repeat(12), "e\u0301".repeat(12)]) {
    assert.equal(countAccountCatName(name), 12);
    assert.equal(countAccountCatName(name), countCatName(name));
    const a = await login();
    const result = await adoptCat(a.accountId, {
      name: ` ${name} `,
      appearanceId: "cat-01",
      key: randomUUID(),
    });
    assert.equal(result.cat.name, name);
    assert.equal((await accountState(a.accountId)).cat.name, name);
  }
  const b = await login();
  await assert.rejects(
    adoptCat(b.accountId, {
      name: "猫".repeat(13),
      appearanceId: "cat-02",
      key: randomUUID(),
    }),
  );
  assert.equal((await accountState(b.accountId)).cat, null);
});

test("A07: lifecycle freeze revokes all credentials; old deletion identity never targets a new account", async () => {
  const old = await login();
  await allowResend(old.address);
  const pending = await challenge(old.address);
  const requestId = randomUUID();
  const freeze = await freezeAccountForDeletion(old.accountId, requestId);
  assert.equal(freeze.requestId, requestId);
  await pool.query(
    "UPDATE account_deletions SET status='FAILED' WHERE account_id=$1",
    [old.accountId],
  );
  const repeated = await freezeAccountForDeletion(old.accountId, randomUUID());
  assert.equal(repeated.requestId, requestId);
  assert.equal(repeated.status, "FAILED");
  await assert.rejects(accountIdentity(old.rawToken), /会话已过期/);
  await assert.rejects(
    verifyCode(pending.challengeId, old.address, pending.code),
    /验证码无效/,
  );
  await assert.rejects(
    adoptCat(old.accountId, {
      name: "冻结合成",
      appearanceId: "cat-01",
      key: randomUUID(),
    }),
    /账号当前不可用/,
  );
  // Simulate the future erasure worker's terminal state only; A implements no erasure endpoint.
  await transaction(async (db) => {
    await db.query(
      "UPDATE accounts SET status='DELETED',deleted_at=now() WHERE id=$1",
      [old.accountId],
    );
    await db.query(
      "UPDATE account_deletions SET status='COMPLETE',completed_at=now() WHERE account_id=$1",
      [old.accountId],
    );
  });
  await allowResend(old.address);
  const fresh = await login(old.address);
  assert.notEqual(fresh.accountId, old.accountId);
  assert.deepEqual(await freezeAccountForDeletion(old.accountId, requestId), {
    requestId,
    status: "COMPLETE",
  });
  assert.equal(await accountIdentity(fresh.rawToken), fresh.accountId);
  assert.equal((await accountState(fresh.accountId)).cat, null);
  assert.equal(
    (
      await pool.query(
        "SELECT account_id FROM account_deletions WHERE request_id=$1",
        [requestId],
      )
    ).rows[0].account_id,
    old.accountId,
  );
});

test("A07 concurrency: deletion freeze and adoption serialize on the account row", async () => {
  const a = await login();
  const results = await Promise.allSettled([
    freezeAccountForDeletion(a.accountId, randomUUID()),
    adoptCat(a.accountId, {
      name: "竞争合成",
      appearanceId: "cat-04",
      key: randomUUID(),
    }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  const row = await pool.query("SELECT status FROM accounts WHERE id=$1", [
    a.accountId,
  ]);
  assert.equal(row.rows[0].status, "DELETING");
  assert.ok(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM cat_profiles WHERE account_id=$1",
        [a.accountId],
      )
    ).rows[0].n <= 1,
  );
  await assert.rejects(
    adoptCat(a.accountId, {
      name: "更晚合成",
      appearanceId: "cat-02",
      key: randomUUID(),
    }),
    /账号当前不可用/,
  );
});

test("A08 configuration: HTTPS forces Secure; non-loopback HTTP fails closed", () => {
  assert.equal(
    accountCookieSecure("https://product.example.test", "false"),
    true,
  );
  assert.equal(accountCookieSecure("http://127.0.0.1:3100", "false"), false);
  assert.equal(accountCookieSecure("http://localhost:3100", "true"), true);
  assert.throws(
    () => accountCookieSecure("http://product.example.test", "false"),
    /需要 HTTPS/,
  );
  assert.throws(() => accountCookieSecure("not-a-url", "false"), /配置无效/);
});

test("A08 HTTP: independent cookie jars, secure attributes, ownership, Origin and no public mailbox", async () => {
  const origin = process.env.E4_TEST_ORIGIN;
  const directory = process.env.E4_SYNTHETIC_MAILBOX_DIR;
  assert.ok(
    origin && directory,
    "Run with scripts/test-e4-account.mjs so real HTTP is mandatory",
  );
  const a = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
  });
  const b = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
  });
  const foreign = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: "https://foreign.invalid" },
  });
  const address = email();
  async function httpLogin(client: typeof a, address: string) {
    const asked = await client.post("/api/e4/auth/request-code", {
      data: { email: address },
    });
    assert.equal(asked.status(), 200);
    const payload = await asked.json();
    assert.equal("code" in payload, false);
    const message = JSON.parse(
      await readFile(join(directory!, `${payload.challengeId}.json`), "utf8"),
    );
    const wrongCode = message.code === "000000" ? "999999" : "000000";
    for (let count = 1; count <= 5; count++) {
      const rejected = await client.post("/api/e4/auth/verify-code", {
        data: {
          challengeId: payload.challengeId,
          email: address,
          code: wrongCode,
        },
      });
      assert.equal(rejected.status(), 401);
      assert.deepEqual(await rejected.json(), {
        error: "验证码无效或已失效，请重新请求。",
      });
      assert.equal(rejected.headers()["cache-control"], "no-store");
      assert.equal(rejected.headers()["set-cookie"], undefined);
      const persisted = await pool.query(
        "SELECT failures FROM email_challenges WHERE id=$1",
        [payload.challengeId],
      );
      assert.equal(
        persisted.rows[0].failures,
        count,
        "HTTP failure response must not roll back the counter",
      );
    }
    const locked = await client.post("/api/e4/auth/verify-code", {
      data: {
        challengeId: payload.challengeId,
        email: address,
        code: message.code,
      },
    });
    assert.equal(
      locked.status(),
      401,
      "Correct code must stay locked after five HTTP failures",
    );
    assert.equal(locked.headers()["set-cookie"], undefined);
    await allowResend(address);
    const freshResponse = await client.post("/api/e4/auth/request-code", {
      data: { email: address },
    });
    assert.equal(freshResponse.status(), 200);
    const fresh = await freshResponse.json();
    const freshMessage = JSON.parse(
      await readFile(join(directory!, `${fresh.challengeId}.json`), "utf8"),
    );
    const verified = await client.post("/api/e4/auth/verify-code", {
      data: {
        challengeId: fresh.challengeId,
        email: address,
        code: freshMessage.code,
      },
    });
    assert.equal(verified.status(), 200);
    const header = verified.headers()["set-cookie"];
    assert.match(header, /HttpOnly/i);
    assert.match(header, /SameSite=strict/i);
    assert.match(header, /Secure/i);
    assert.equal(verified.headers()["cache-control"], "no-store");
    // Secure cookie is correct for production; this local harness explicitly imports it
    // without the flag to exercise requests over an isolated HTTP-only loopback server.
    const cookie = (await client.storageState()).cookies.find(
      (c) => c.name === "cat_account_session",
    );
    assert.ok(cookie);
    const accountId = (await verified.json()).accountId;
    await client.dispose();
    return { accountId, cookie: { ...cookie, secure: false } };
  }
  let deviceA: typeof a | undefined, deviceB: typeof b | undefined;
  try {
    const identityA = await httpLogin(a, address);
    deviceA = await request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { Origin: origin },
      storageState: { cookies: [identityA.cookie], origins: [] },
    });
    await allowResend(address);
    const identityB = await httpLogin(b, address);
    assert.equal(identityA.accountId, identityB.accountId);
    deviceB = await request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { Origin: origin },
      storageState: { cookies: [identityB.cookie], origins: [] },
    });
    assert.equal((await deviceA.get("/api/e4/account")).status(), 200);
    const input = {
      name: "HTTP合成",
      appearanceId: "cat-02",
      key: randomUUID(),
    };
    const concurrent = await Promise.all([
      deviceA.post("/api/e4/cat/adopt", { data: input }),
      deviceB.post("/api/e4/cat/adopt", {
        data: { ...input, appearanceId: "cat-04", key: randomUUID() },
      }),
    ]);
    assert.deepEqual(concurrent.map((r) => r.status()).sort(), [200, 409]);
    assert.equal(
      (
        await deviceA.post("/api/e4/cat/adopt", {
          data: { ...input, accountId: randomUUID() },
        })
      ).status(),
      400,
    );
    assert.equal(
      (
        await foreign.post("/api/e4/auth/request-code", {
          data: { email: email() },
        })
      ).status(),
      403,
    );
    assert.equal((await deviceA.get("/api/e4/mailbox")).status(), 404);
    assert.equal((await deviceA.get("/api/state")).status(), 401);
    assert.equal((await deviceA.post("/api/e4/auth/logout")).status(), 200);
    assert.equal((await deviceA.get("/api/e4/account")).status(), 401);
    assert.equal((await deviceB.get("/api/e4/account")).status(), 200);
  } finally {
    await a.dispose();
    await b.dispose();
    await foreign.dispose();
    await deviceA?.dispose();
    await deviceB?.dispose();
  }
});
