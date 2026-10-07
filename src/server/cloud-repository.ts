import type { PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "./db";
import { lockActiveAccount } from "./account-service";
import { ensure } from "./errors";

export const cloudId = z.string().min(1).max(1024);
export const cloudOperation = z.enum([
  "SEND_RESPONSE",
  "EDIT_RESPONSE",
  "DELETE_RESPONSE",
]);
export type CloudOperation = z.infer<typeof cloudOperation>;
export interface CloudCat {
  accountId: string;
  catId: string;
  participantId: string;
  name: string;
  appearanceId: string;
  safety: "CLEAR" | "INTERCEPTED";
  stateRevision: number;
}

/** Every business read and mutation uses account -> cat -> state lock order.
 * A successful identity lookup alone is insufficient if account deletion races it.
 */
export function withCloudCat<T>(
  accountId: string,
  fn: (db: PoolClient, cat: CloudCat) => Promise<T>,
) {
  return transaction(async (db) => {
    await lockActiveAccount(db, accountId);
    const c = await db.query(
      "SELECT * FROM cat_profiles WHERE account_id=$1 FOR UPDATE",
      [accountId],
    );
    ensure(c.rows[0], 409, "请先领养一只小猫。");
    const row = c.rows[0];
    const p = await db.query(
      "SELECT safety_state FROM participants WHERE id=$1 FOR UPDATE",
      [row.participant_id],
    );
    await db.query(
      "INSERT INTO cloud_state(cat_id,account_id) VALUES($1,$2) ON CONFLICT(cat_id) DO NOTHING",
      [row.id, accountId],
    );
    const state = await db.query(
      "SELECT revision FROM cloud_state WHERE cat_id=$1 AND account_id=$2 FOR UPDATE",
      [row.id, accountId],
    );
    return fn(db, {
      accountId,
      catId: row.id,
      participantId: row.participant_id,
      name: row.name,
      appearanceId: row.appearance_id,
      safety: p.rows[0].safety_state,
      stateRevision: Number(state.rows[0].revision),
    });
  });
}

export async function bumpCloudRevision(db: PoolClient, cat: CloudCat) {
  const r = await db.query(
    "UPDATE cloud_state SET revision=revision+1 WHERE cat_id=$1 AND account_id=$2 RETURNING revision",
    [cat.catId, cat.accountId],
  );
  cat.stateRevision = Number(r.rows[0].revision);
  return cat.stateRevision;
}

export async function ownedCloudLetter(
  db: PoolClient,
  cat: CloudCat,
  id: string,
) {
  const r = await db.query(
    "SELECT * FROM cloud_letters WHERE cat_id=$1 AND account_id=$2 AND id=$3",
    [cat.catId, cat.accountId, id],
  );
  ensure(r.rows[0], 404, "没有找到这封信。");
  return r.rows[0];
}
export async function ownedCloudResponse(
  db: PoolClient,
  cat: CloudCat,
  id: string,
) {
  const r = await db.query(
    "SELECT * FROM cloud_responses WHERE cat_id=$1 AND account_id=$2 AND id=$3",
    [cat.catId, cat.accountId, id],
  );
  ensure(r.rows[0], 404, "没有找到这条回应。");
  return r.rows[0];
}

export async function cloudState(accountId: string) {
  return withCloudCat(accountId, async (db, cat) => {
    const trip = await db.query(
      "SELECT id,scene FROM cloud_trips WHERE cat_id=$1 AND account_id=$2 AND status='ACTIVE'",
      [cat.catId, cat.accountId],
    );
    const unread = await db.query(
      "SELECT id,type,delivered_at FROM cloud_letters WHERE cat_id=$1 AND account_id=$2 AND read_at IS NULL ORDER BY delivered_at,id LIMIT 1",
      [cat.catId, cat.accountId],
    );
    const t = trip.rows[0],
      l = unread.rows[0];
    return {
      cat: { id: cat.catId, name: cat.name, appearanceId: cat.appearanceId },
      world: {
        status: t ? "TRAVEL" : "HOME",
        tripId: t?.id ?? null,
        scene: t?.scene ?? null,
      },
      unread: l
        ? { id: l.id, type: l.type, deliveredAt: l.delivered_at }
        : null,
      stateRevision: cat.stateRevision,
      safety: cat.safety,
    };
  });
}

export async function listCloudLetters(accountId: string) {
  return withCloudCat(accountId, async (db, cat) => {
    const r = await db.query(
      `SELECT l.id,l.type,l.delivered_at,l.read_at,l.skipped_at,
      EXISTS(SELECT 1 FROM cloud_responses r WHERE r.cat_id=l.cat_id AND r.account_id=l.account_id AND r.letter_id=l.id AND r.status='ACTIVE') AS has_response
      FROM cloud_letters l WHERE l.cat_id=$1 AND l.account_id=$2 ORDER BY l.delivered_at DESC,l.id`,
      [cat.catId, cat.accountId],
    );
    return {
      letters: r.rows.map((l) => ({
        id: l.id,
        type: l.type,
        deliveredAt: l.delivered_at,
        readAt: l.read_at,
        skippedAt: l.skipped_at,
        hasResponse: l.has_response,
      })),
      stateRevision: cat.stateRevision,
    };
  });
}

export async function readCloudLetter(accountId: string, letterId: string) {
  cloudId.parse(letterId);
  return withCloudCat(accountId, async (db, cat) => {
    let l = await ownedCloudLetter(db, cat, letterId);
    const firstRead = l.read_at === null;
    if (firstRead) {
      const r = await db.query(
        "UPDATE cloud_letters SET read_at=now() WHERE cat_id=$1 AND account_id=$2 AND id=$3 RETURNING *",
        [cat.catId, cat.accountId, letterId],
      );
      l = r.rows[0];
      await bumpCloudRevision(db, cat);
    }
    const r = await db.query(
      `SELECT r.id,r.status,r.current_revision,v.text,v.at FROM cloud_responses r
      JOIN cloud_response_revisions v ON (v.account_id,v.cat_id,v.response_id,v.revision)=(r.account_id,r.cat_id,r.id,r.current_revision)
      WHERE r.cat_id=$1 AND r.account_id=$2 AND r.letter_id=$3`,
      [cat.catId, cat.accountId, letterId],
    );
    const response = r.rows[0];
    return {
      letter: {
        id: l.id,
        type: l.type,
        snapshot: l.snapshot,
        deliveredAt: l.delivered_at,
        plannedAt: l.planned_at,
        effectiveAt: l.effective_at,
        readAt: l.read_at,
        skippedAt: l.skipped_at,
        tripId: l.trip_id,
        storyId: l.story_id,
        response:
          response?.status === "ACTIVE"
            ? {
                id: response.id,
                revision: response.current_revision,
                text: response.text,
                at: response.at,
              }
            : null,
        responseStatus: response?.status ?? null,
      },
      firstRead,
      stateRevision: cat.stateRevision,
    };
  });
}

export async function skipCloudLetter(accountId: string, letterId: string) {
  cloudId.parse(letterId);
  return withCloudCat(accountId, async (db, cat) => {
    const l = await ownedCloudLetter(db, cat, letterId);
    ensure(l.type === "DEMAND", 409, "这封信不需要回应。");
    if (!l.skipped_at || !l.read_at) {
      await db.query(
        "UPDATE cloud_letters SET skipped_at=COALESCE(skipped_at,now()),read_at=COALESCE(read_at,now()) WHERE cat_id=$1 AND account_id=$2 AND id=$3",
        [cat.catId, cat.accountId, letterId],
      );
      await bumpCloudRevision(db, cat);
    }
    return { ok: true, stateRevision: cat.stateRevision };
  });
}

export async function cloudRequestResult(
  accountId: string,
  operation: string,
  key: string,
) {
  cloudOperation.parse(operation);
  z.uuid().parse(key);
  return withCloudCat(accountId, async (db, cat) => {
    const r = await db.query(
      "SELECT result FROM cloud_requests WHERE account_id=$1 AND cat_id=$2 AND operation=$3 AND key=$4",
      [accountId, cat.catId, operation, key],
    );
    return r.rows[0]?.result ?? { pending: true };
  });
}
