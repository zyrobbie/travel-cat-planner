import type { PoolClient } from "pg";
import { ensure } from "./errors";
import { assertInternal } from "./safety";
import { lockCloudCat, ownedCloudResponse } from "./cloud-repository";
import {
  appendLedger,
  deleteExportFilesForJob,
  guardedLifecycleTx,
  lifecycleTx,
  readLedger,
  saveLedgerWatermark,
  withLifecycleLock,
  type LedgerEvent,
  type ResponseDeletionIntent,
} from "./lifecycle-ledger";

const receipt = (e: ResponseDeletionIntent) => ({
  message: "已删除。",
  responseId: e.responseId,
  revision: e.throughRevision,
  stateRevision: e.stateRevision,
});
/** Exclusive lifecycle lock is held; no file IO occurs inside the SQL transaction. */
export async function replayResponseDeletion(
  db: PoolClient,
  event: LedgerEvent & ResponseDeletionIntent,
) {
  const exports = await db.query(
    "SELECT id FROM account_exports WHERE account_id=$1",
    [event.accountId],
  );
  for (const id of new Set([
    ...event.exportIds,
    ...exports.rows.map((r) => r.id as string),
  ]))
    deleteExportFilesForJob(id);
  await lifecycleTx(db, async () => {
    const a = await db.query(
      "SELECT status FROM accounts WHERE id=$1 FOR UPDATE",
      [event.accountId],
    );
    const cat = await db.query(
      "SELECT id FROM cat_profiles WHERE id=$1 AND account_id=$2 FOR UPDATE",
      [event.catId, event.accountId],
    );
    // A restore may predate the cat, or its entire account may already have been erased.
    if (!a.rows[0] || a.rows[0].status === "DELETED" || !cat.rows[0]) return;
    await db.query(
      "SELECT id FROM cloud_responses WHERE account_id=$1 AND cat_id=$2 AND id=$3 FOR UPDATE",
      [event.accountId, event.catId, event.responseId],
    );
    await db.query(
      "UPDATE cloud_response_revisions SET text=NULL WHERE account_id=$1 AND cat_id=$2 AND response_id=$3",
      [event.accountId, event.catId, event.responseId],
    );
    await db.query(
      "UPDATE cloud_responses SET status='DELETED',deleted_at=CASE WHEN status='DELETED' THEN deleted_at ELSE COALESCE(deleted_at,$4) END WHERE account_id=$1 AND cat_id=$2 AND id=$3",
      [event.accountId, event.catId, event.responseId, event.at],
    );
    await db.query(
      "UPDATE cloud_reviews r SET status='NEEDS_REVIEW',reason='来源已更正或删除，请重新核验或选择普通故事。' WHERE r.account_id=$1 AND r.cat_id=$2 AND r.kind='LINKED' AND r.status='SELECTED' AND EXISTS(SELECT 1 FROM cloud_review_sources s WHERE (s.account_id,s.cat_id,s.review_id)=(r.account_id,r.cat_id,r.id) AND s.response_id=$3)",
      [event.accountId, event.catId, event.responseId],
    );
    await db.query(
      "UPDATE cloud_state SET revision=GREATEST(revision,$3) WHERE account_id=$1 AND cat_id=$2",
      [event.accountId, event.catId, event.stateRevision],
    );
    await db.query(
      "UPDATE account_exports SET status='REVOKED',lease_token=NULL,lease_until=NULL WHERE account_id=$1",
      [event.accountId],
    );
    const old = await db.query(
      "SELECT payload_hash,result FROM cloud_requests WHERE account_id=$1 AND operation='DELETE_RESPONSE' AND key=$2",
      [event.accountId, event.requestId],
    );
    if (old.rows[0]) {
      const actual = old.rows[0].result,
        expected = receipt(event);
      ensure(
        old.rows[0].payload_hash === event.payloadHash &&
          Object.keys(actual).length === 4 &&
          actual.message === expected.message &&
          actual.responseId === expected.responseId &&
          actual.revision === expected.revision &&
          actual.stateRevision === expected.stateRevision,
        503,
        "回应删除回执与账本不一致。",
      );
    } else
      await db.query(
        "INSERT INTO cloud_requests(account_id,cat_id,operation,key,payload_hash,result) VALUES($1,$2,'DELETE_RESPONSE',$3,$4,$5)",
        [
          event.accountId,
          event.catId,
          event.requestId,
          event.payloadHash,
          receipt(event),
        ],
      );
  });
}
export async function deleteResponseWithLedger(
  accountId: string,
  responseId: string,
  value: { key: string; expectedRevision: number },
  hash: string,
) {
  assertInternal();
  return withLifecycleLock(async (db) => {
    const prepared = await guardedLifecycleTx(db, async (db) => {
      const cat = await lockCloudCat(db, accountId);
      const old = await db.query(
        "SELECT payload_hash,result FROM cloud_requests WHERE account_id=$1 AND cat_id=$2 AND operation='DELETE_RESPONSE' AND key=$3",
        [accountId, cat.catId, value.key],
      );
      if (old.rows[0]) {
        ensure(
          old.rows[0].payload_hash === hash,
          409,
          "这次请求的内容已改变，请使用新请求。",
        );
        return { old: old.rows[0].result };
      }
      const r = await ownedCloudResponse(db, cat, responseId);
      ensure(
        r.current_revision === value.expectedRevision,
        409,
        "回应已被更正，请重新载入。",
      );
      ensure(
        cat.stateRevision < Number.MAX_SAFE_INTEGER || r.status === "DELETED",
        409,
        "记录版本已达安全上限。",
      );
      const exports = await db.query(
        "SELECT id FROM account_exports WHERE account_id=$1",
        [accountId],
      );
      const intent: ResponseDeletionIntent = {
        kind: "RESPONSE_DELETED",
        requestId: value.key,
        accountId,
        catId: cat.catId,
        responseId,
        throughRevision: r.current_revision,
        payloadHash: hash,
        stateRevision: cat.stateRevision + (r.status === "DELETED" ? 0 : 1),
        exportIds: exports.rows.map((r) => r.id),
      };
      return { intent };
    });
    if (prepared.old) return prepared.old;
    const ledger = appendLedger(prepared.intent!);
    const event = ledger.events.find(
      (e): e is LedgerEvent & ResponseDeletionIntent =>
        e.kind === "RESPONSE_DELETED" &&
        e.accountId === accountId &&
        e.requestId === value.key,
    )!;
    await replayResponseDeletion(db, event);
    await saveLedgerWatermark(db, readLedger(), true);
    return receipt(event);
  });
}
