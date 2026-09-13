import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, transaction } from "./db";
import { ensure, HttpError } from "./errors";
import { checkInput } from "./safety";
export async function audit(
  db: PoolClient,
  pid: string,
  event: string,
  object: string | null,
  actor = "USER",
  simulation = false,
) {
  await db.query(
    "INSERT INTO audit_events(participant_id,event,object_id,actor,simulation) VALUES($1,$2,$3,$4,$5)",
    [pid, event, object, actor, simulation],
  );
}
async function lockParticipant(db: PoolClient, pid: string) {
  const r = await db.query(
    "SELECT * FROM participants WHERE id=$1 FOR UPDATE",
    [pid],
  );
  ensure(r.rows[0], 404, "没有找到参与者。");
  return r.rows[0];
}
export async function state(pid: string) {
  const [p, t, l] = await Promise.all([
    pool.query(
      "SELECT id,cat_name,relation_term,status,safety_state FROM participants WHERE id=$1",
      [pid],
    ),
    pool.query(
      "SELECT id,started_at FROM trips WHERE participant_id=$1 AND ended_at IS NULL",
      [pid],
    ),
    pool.query(
      `SELECT l.*,r.text AS response FROM letters l LEFT JOIN responses r ON r.letter_id=l.id AND r.participant_id=l.participant_id WHERE l.participant_id=$1 ORDER BY l.delivered_at DESC,l.id`,
      [pid],
    ),
  ]);
  ensure(p.rows[0], 404, "没有找到参与者。");
  return { participant: p.rows[0], trip: t.rows[0] ?? null, letters: l.rows };
}
export async function start(pid: string, name: string) {
  return transaction(async (db) => {
    const p = await lockParticipant(db, pid);
    if (p.status === "NEW") {
      await db.query(
        "UPDATE participants SET cat_name=$2,status='ACTIVE' WHERE id=$1",
        [pid, name],
      );
      await audit(db, pid, "NAMED", pid);
    }
    return { ok: true };
  });
}
export async function readLetter(pid: string, id: string) {
  return transaction(async (db) => {
    const r = await db.query(
      "UPDATE letters SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND participant_id=$2 RETURNING *",
      [id, pid],
    );
    ensure(r.rows[0], 404, "没有找到这封信。");
    return r.rows[0];
  });
}
export async function skip(pid: string, id: string) {
  return transaction(async (db) => {
    await lockParticipant(db, pid);
    const r = await db.query(
      "UPDATE letters SET skipped_at=COALESCE(skipped_at,now()),read_at=COALESCE(read_at,now()) WHERE id=$1 AND participant_id=$2 AND type='DEMAND' RETURNING id",
      [id, pid],
    );
    ensure(r.rows[0], 404, "没有找到这封信。");
    await audit(db, pid, "SKIPPED", id);
    return { ok: true };
  });
}
export async function respond(
  pid: string,
  id: string,
  text: string,
  key: string,
) {
  return transaction(async (db) => {
    const p = await lockParticipant(db, pid);
    const existing = await db.query(
      "SELECT * FROM responses WHERE participant_id=$1 AND (idempotency_key=$2 OR letter_id=$3)",
      [pid, key, id],
    );
    if (existing.rows[0]) {
      ensure(
        existing.rows[0].letter_id === id && existing.rows[0].text === text,
        409,
        "这封信已有回应，请重新载入。",
      );
      return { message: "送出去啦。", id: existing.rows[0].id };
    }
    const l = await db.query(
      "SELECT id FROM letters WHERE id=$1 AND participant_id=$2 AND type='DEMAND'",
      [id, pid],
    );
    ensure(l.rows[0], 404, "没有找到这封信。");
    ensure(
      p.status === "ACTIVE" && p.safety_state === "CLEAR",
      409,
      "当前不能发送普通回应。",
    );
    const checked = checkInput(text);
    if (checked.status === "UNAVAILABLE")
      throw new HttpError(503, "输入检查暂不可用，尚未完成发送，请稍后再试。");
    if (checked.status === "INTERCEPTED") {
      await db.query(
        "UPDATE participants SET safety_state='INTERCEPTED' WHERE id=$1",
        [pid],
      );
      await db.query(
        "INSERT INTO safety_cases(id,participant_id,adapter_version,fixture_id) VALUES($1,$2,$3,$4)",
        [randomUUID(), pid, checked.adapter, "INTERCEPT"],
      );
      await audit(db, pid, "SAFETY_INTERCEPTED", null, "SYNTHETIC", true);
      return {
        safety: "INTERCEPTED",
        message: "内部合成测试已进入独立安全路径，未保存为普通回应。",
      };
    }
    const rid = randomUUID();
    await db.query(
      "INSERT INTO responses(id,participant_id,letter_id,text,idempotency_key) VALUES($1,$2,$3,$4,$5)",
      [rid, pid, id, text, key],
    );
    await db.query(
      "UPDATE letters SET read_at=COALESCE(read_at,now()) WHERE id=$1",
      [id],
    );
    await audit(db, pid, "RESPONSE_SENT", rid);
    return { message: "送出去啦。", id: rid };
  });
}
export async function adminAction(
  pid: string,
  action: string,
  contentId?: string,
  requestKey: string = randomUUID(),
) {
  return transaction(async (db) => {
    const p = await lockParticipant(db, pid);
    const old = (
      await db.query(
        "SELECT * FROM admin_requests WHERE participant_id=$1 AND request_key=$2",
        [pid, requestKey],
      )
    ).rows[0];
    if (old) {
      ensure(
        old.action === action && old.content_id === (contentId ?? null),
        409,
        "请求键已用于不同操作。",
      );
      return old.result as { ok: boolean; id?: string };
    }
    async function done(result: { ok: boolean; id?: string }) {
      await db.query(
        "INSERT INTO admin_requests(participant_id,request_key,action,content_id,result) VALUES($1,$2,$3,$4,$5)",
        [pid, requestKey, action, contentId ?? null, result],
      );
      return result;
    }
    ensure(p.status === "ACTIVE", 409, "参与者需要先完成命名。");
    const trip = (
      await db.query(
        "SELECT * FROM trips WHERE participant_id=$1 AND ended_at IS NULL",
        [pid],
      )
    ).rows[0];
    if (action === "end-trip") {
      ensure(trip, 409, "当前不在旅行。");
      await db.query("UPDATE trips SET ended_at=now() WHERE id=$1", [trip.id]);
      await audit(db, pid, "TRIP_ENDED", trip.id, "ADMIN", true);
      return done({ ok: true });
    }
    ensure(p.safety_state === "CLEAR", 409, "安全覆盖期间不能投递或开始旅行。");
    if (action === "start-trip") {
      ensure(!trip, 409, "已经在旅行中。");
      const id = randomUUID();
      await db.query(
        "INSERT INTO trips(id,participant_id,simulation) VALUES($1,$2,true)",
        [id, pid],
      );
      await audit(db, pid, "TRIP_STARTED", id, "ADMIN", true);
      return done({ ok: true });
    }
    let c;
    if (action === "deliver-demand") {
      ensure(!trip, 409, "旅行中不投递日常需求卡。");
      c = (
        await db.query(
          "SELECT payload FROM content_versions WHERE type='DEMAND' AND id NOT IN(SELECT content_id FROM letters WHERE participant_id=$1) ORDER BY id LIMIT 1",
          [pid],
        )
      ).rows[0]?.payload;
      ensure(c, 409, "冻结需求卡已全部投递。");
    } else if (action === "deliver-postcard") {
      ensure(trip, 409, "请先独立开始旅行。");
      ensure(
        !(await db.query("SELECT id FROM letters WHERE trip_id=$1", [trip.id]))
          .rows.length,
        409,
        "本次旅行已经投递过明信片。",
      );
      c = (
        await db.query(
          "SELECT payload FROM content_versions WHERE id=$1 AND type='ORDINARY'",
          [contentId],
        )
      ).rows[0]?.payload;
      ensure(c, 400, "本阶段只能投递冻结 ordinary。");
      ensure(
        !(
          await db.query(
            "SELECT id FROM letters WHERE participant_id=$1 AND content_id=$2",
            [pid, contentId],
          )
        ).rows.length,
        409,
        "这封故事已经寄过。",
      );
    } else throw new HttpError(400, "不支持的操作。");
    const id = randomUUID();
    const tip =
      action === "deliver-demand"
        ? (
            await db.query("SELECT payload FROM content_versions WHERE id=$1", [
              c.id.replace("D-", "TIPS-"),
            ])
          ).rows[0]?.payload.body
        : null;
    const snapshot = {
      title: c.title,
      body: c.body,
      catName: p.cat_name,
      relationTerm: p.relation_term,
      contentVersion: c.version,
      tip,
      scene: c.sceneId,
      season: c.narrativeSeason,
      timeOfDay: c.timeOfDay,
      visualId: c.visualId,
    };
    await db.query(
      "INSERT INTO letters(id,participant_id,content_id,type,snapshot,trip_id,simulation) VALUES($1,$2,$3,$4,$5,$6,true)",
      [
        id,
        pid,
        c.id,
        action === "deliver-demand" ? "DEMAND" : "POSTCARD",
        snapshot,
        action === "deliver-postcard" ? trip.id : null,
      ],
    );
    await audit(
      db,
      pid,
      action === "deliver-demand" ? "DEMAND_DELIVERED" : "POSTCARD_DELIVERED",
      id,
      "ADMIN",
      true,
    );
    return done({ ok: true, id });
  });
}
