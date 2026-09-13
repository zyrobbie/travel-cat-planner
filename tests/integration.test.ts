import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../src/server/db";
import { newParticipant } from "../src/server/auth";
import * as service from "../src/server/service";
test("Real PostgreSQL: T1/T2/T3/T7, concurrency, isolation, safety, content integrity", async () => {
  const ids: string[] = [];
  try {
    const a = await newParticipant(),
      b = await newParticipant();
    ids.push(a.id, b.id);
    await service.start(a.id, "合成猫甲");
    await service.start(b.id, "合成猫乙");
    const adminKey = randomUUID();
    const one = await service.adminAction(
      a.id,
      "deliver-demand",
      undefined,
      adminKey,
    );
    const again = await service.adminAction(
      a.id,
      "deliver-demand",
      undefined,
      adminKey,
    );
    assert.equal(one.id, again.id);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.respond(a.id, one.id!, "合成测试：可以歇一会。", key),
      ),
    );
    assert.equal(
      new Set(results.map((r) => ("id" in r ? r.id : null))).size,
      1,
    );
    assert.equal(results[0].message, "送出去啦。");
    let aState = await service.state(a.id);
    assert.equal(aState.letters.length, 1);
    assert.equal(aState.trip, null);
    const two = await service.adminAction(a.id, "deliver-demand");
    await service.respond(a.id, two.id!, "合成测试：陪着就好。", randomUUID());
    aState = await service.state(a.id);
    assert.equal(aState.letters.length, 2);
    assert.equal(aState.trip, null);
    assert.equal(aState.letters.filter((l) => l.type === "POSTCARD").length, 0);
    assert.equal(
      (
        await pool.query(
          "SELECT * FROM audit_events WHERE participant_id=$1 AND event LIKE $2",
          [a.id, "%CAT_REPLY%"],
        )
      ).rowCount,
      0,
    );
    console.log("T1 PASS; T2 PASS; duplicate 8 concurrent sends PASS");
    await assert.rejects(() => service.readLetter(b.id, one.id!), /没有找到/);
    await assert.rejects(
      () => service.respond(b.id, one.id!, "跨用户合成输入", randomUUID()),
      /没有找到/,
    );
    const skip = await service.adminAction(a.id, "deliver-demand");
    await service.skip(a.id, skip.id!);
    await service.adminAction(a.id, "start-trip");
    await service.adminAction(a.id, "deliver-postcard", "O-RHINE-01");
    await service.adminAction(a.id, "end-trip");
    assert.equal((await service.state(a.id)).trip, null);
    assert.equal((await service.state(a.id)).letters.length, 4);
    console.log("T7 PASS: skip then trip/postcard/home");
    await service.adminAction(b.id, "start-trip");
    await service.adminAction(b.id, "deliver-postcard", "O-FIREFLY-01");
    const bs = await service.state(b.id);
    assert.equal(bs.letters.length, 1);
    assert.equal(bs.letters[0].type, "POSTCARD");
    assert.match(bs.letters[0].snapshot.body, /怕把它们吓跑喵~/);
    assert.equal(
      (
        await pool.query("SELECT * FROM responses WHERE participant_id=$1", [
          b.id,
        ])
      ).rowCount,
      0,
    );
    console.log("T3 PASS: zero responses with complete ordinary");
    await assert.rejects(
      () => service.adminAction(b.id, "deliver-postcard", "L-RHINE"),
      /已经投递/,
    );
    const safetyLetter = await service.adminAction(a.id, "deliver-demand");
    await assert.rejects(
      () =>
        service.respond(
          a.id,
          safetyLetter.id!,
          "[SYNTHETIC:UNAVAILABLE]",
          randomUUID(),
        ),
      /暂不可用/,
    );
    await service.respond(
      a.id,
      safetyLetter.id!,
      "[SYNTHETIC:INTERCEPT]",
      randomUUID(),
    );
    assert.equal(
      (await service.state(a.id)).participant.safety_state,
      "INTERCEPTED",
    );
    assert.equal(
      (
        await pool.query("SELECT * FROM responses WHERE participant_id=$1", [
          a.id,
        ])
      ).rowCount,
      2,
    );
    await assert.rejects(
      () => service.adminAction(a.id, "start-trip"),
      /安全覆盖/,
    );
    console.log("Isolation + synthetic safety failure/intercept PASS");
  } finally {
    for (const id of ids) {
      for (const table of [
        "admin_requests",
        "responses",
        "letters",
        "trips",
        "safety_cases",
        "audit_events",
        "sessions",
        "invites",
      ])
        await pool.query(`DELETE FROM ${table} WHERE participant_id=$1`, [id]);
      await pool.query("DELETE FROM participants WHERE id=$1", [id]);
    }
    await pool.end();
  }
});
