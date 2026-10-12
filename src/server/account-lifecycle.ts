import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "./db";
import { digest, token, sameSecret } from "./auth";
import { lockActiveAccount } from "./account-service";
import { ensure, HttpError } from "./errors";
import { assertInternal } from "./safety";
import { eraseInMemoryOtpRecords } from "./otp-delivery";
import {
  appendLedger,
  clearRestoreLock,
  deleteExportFilesForJob,
  deletionReceiptToken,
  guardLifecycleTransaction,
  initializeLedger,
  lifecycleDirectory,
  lifecycleTx,
  readLedger,
  saveLedgerWatermark,
  sourceFingerprint,
  validateLedgerWatermark,
  withLifecycleLock,
  type DeletionIntent,
  type Ledger,
  type LedgerEvent,
} from "./lifecycle-ledger";
import { replayResponseDeletion } from "./response-erasure";

export const DELETION_COOKIE = "cat_deletion_receipt";
export const DELETION_RECEIPT_SECONDS = 30 * 24 * 60 * 60;
export type DeletionTask = {
  requestId: string;
  accountId: string;
  status: "PREPARED" | "PENDING" | "FAILED" | "COMPLETE";
  requestedAt: string | null;
  completedAt: string | null;
  error: string | null;
  finished: boolean;
};
const date = (v: Date | string | null | undefined) =>
  v ? new Date(v).toISOString() : null;
const task = (row: Record<string, unknown>): DeletionTask => ({
  requestId: String(row.request_id),
  accountId: String(row.account_id),
  status: (row.status ?? "PREPARED") as DeletionTask["status"],
  requestedAt: date(row.requested_at as Date),
  completedAt: date(row.completed_at as Date),
  error: row.last_error ? "注销尚未完成，可继续重试。" : null,
  finished: row.receipt_closed === true,
});

export async function prepareAccountDeletion(
  accountId: string,
  key: string,
  existingCookie?: string,
) {
  assertInternal();
  z.uuid().parse(key);
  return transaction(async (db) => {
    await lockActiveAccount(db, accountId);
    const prior = await db.query(
      "SELECT p.*,d.status FROM deletion_preparations p LEFT JOIN account_deletions d USING(account_id) WHERE p.account_id=$1 FOR UPDATE OF p",
      [accountId],
    );
    ensure(!prior.rows[0]?.status, 409, "此账号已开始注销，请查看处理进度。");
    const old = prior.rows[0],
      requestId = old?.request_id ?? key;
    // Authenticated prepare retries/devices recover the same capability, never revoke one another.
    const raw = deletionReceiptToken(requestId, accountId);
    await db.query(
      "INSERT INTO deletion_preparations(request_id,account_id,request_key,receipt_hash) VALUES($1,$2,$3,$4) ON CONFLICT(account_id) DO UPDATE SET receipt_hash=EXCLUDED.receipt_hash",
      [requestId, accountId, key, digest(raw)],
    );
    return {
      deletion: task({ request_id: requestId, account_id: accountId }),
      receipt: `${requestId}.${raw}`,
    };
  });
}

function parseReceipt(raw: string | undefined) {
  ensure(raw, 401, "注销进度凭证已失效。");
  const parts = raw.split(".");
  ensure(
    parts.length === 2 &&
      z.uuid().safeParse(parts[0]).success &&
      /^[a-f0-9]{64}$/.test(parts[1]),
    401,
    "注销进度凭证已失效。",
  );
  return { requestId: parts[0], hash: digest(parts[1]) };
}
async function receiptIdentity(
  db: PoolClient,
  raw: string | undefined,
  ledger: Ledger,
) {
  const parsed = parseReceipt(raw);
  const intent = ledger.events.find(
    (e): e is LedgerEvent & DeletionIntent =>
      e.kind === "DELETE_REQUESTED" && e.requestId === parsed.requestId,
  );
  const r = await db.query(
    "SELECT * FROM deletion_preparations WHERE request_id=$1",
    [parsed.requestId],
  );
  const stored = intent?.receiptHash ?? r.rows[0]?.receipt_hash;
  ensure(
    stored && sameSecret(stored, parsed.hash),
    401,
    "注销进度凭证已失效。",
  );
  return {
    requestId: parsed.requestId,
    accountId: intent?.accountId ?? r.rows[0].account_id,
    intent,
  };
}
async function statusFor(
  db: PoolClient,
  identity: {
    requestId: string;
    accountId: string;
    intent?: LedgerEvent & DeletionIntent;
  },
) {
  const r = await db.query(
    "SELECT * FROM account_deletions WHERE account_id=$1 AND request_id=$2",
    [identity.accountId, identity.requestId],
  );
  if (r.rows[0]) return task(r.rows[0]);
  return task({
    account_id: identity.accountId,
    request_id: identity.requestId,
    status: identity.intent ? "PENDING" : "PREPARED",
    requested_at: identity.intent?.at ?? null,
  });
}
export async function deletionStatus(raw: string | undefined) {
  assertInternal();
  if (!raw) return { deletion: null };
  return withLifecycleLock(async (db) => {
    const ledger = readLedger();
    const identity = await receiptIdentity(db, raw, ledger);
    return { deletion: await statusFor(db, identity) };
  });
}
export async function finishAccountDeletion(
  requestId: string,
  raw: string | undefined,
) {
  assertInternal();
  z.uuid().parse(requestId);
  return withLifecycleLock(async (db) => {
    const identity = await receiptIdentity(db, raw, readLedger());
    ensure(identity.requestId === requestId, 401, "注销进度凭证已失效。");
    const status = await statusFor(db, identity);
    ensure(
      status.status === "COMPLETE",
      409,
      "注销尚未完成，暂时不能结束查询。",
    );
    await db.query(
      "UPDATE account_deletions SET receipt_closed=true WHERE account_id=$1 AND request_id=$2 AND status='COMPLETE'",
      [identity.accountId, requestId],
    );
    return { finished: true };
  });
}

async function collectIntent(
  db: PoolClient,
  accountId: string,
  requestId: string,
): Promise<DeletionIntent> {
  const a = await lockActiveAccount(db, accountId);
  const prep = await db.query(
    "SELECT * FROM deletion_preparations WHERE account_id=$1 AND request_id=$2",
    [accountId, requestId],
  );
  ensure(prep.rows[0], 409, "注销准备已改变，请重新确认。");
  const cats = await db.query(
    "SELECT id,participant_id FROM cat_profiles WHERE account_id=$1 ORDER BY id FOR UPDATE",
    [accountId],
  );
  const challenges = await db.query(
    "SELECT id FROM email_challenges WHERE subject_account_id=$1 OR email_normalized=$2 ORDER BY id",
    [accountId, a.email_normalized],
  );
  const sources = await db.query(
    "SELECT source_namespace,source_experience_id FROM legacy_bindings WHERE account_id=$1",
    [accountId],
  );
  const exports = await db.query(
    "SELECT id FROM account_exports WHERE account_id=$1",
    [accountId],
  );
  return {
    kind: "DELETE_REQUESTED",
    requestId,
    accountId,
    receiptHash: prep.rows[0].receipt_hash,
    catIds: cats.rows.map((r) => r.id),
    participantIds: cats.rows.map((r) => r.participant_id),
    otpIds: challenges.rows.map((r) => r.id),
    exportIds: exports.rows.map((r) => r.id),
    sourceHashes: sources.rows.map((r) =>
      sourceFingerprint(r.source_namespace, r.source_experience_id),
    ),
  };
}
/** Global exclusive lifecycle lock is already held. Replay never selects by email. */
async function freezeIntent(
  db: PoolClient,
  intent: DeletionIntent,
  at: string,
) {
  const found = await db.query("SELECT * FROM accounts WHERE id=$1", [
    intent.accountId,
  ]);
  if (found.rows[0]) {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,4))", [
      found.rows[0].email_normalized,
    ]);
    await db.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [
      intent.accountId,
    ]);
  } else {
    await db.query(
      "INSERT INTO accounts(id,email_normalized,status,deleted_at) VALUES($1,$2,'DELETED',clock_timestamp())",
      [intent.accountId, `deleted+${intent.accountId}@invalid.invalid`],
    );
  }
  await db.query(
    "UPDATE accounts SET status='DELETING' WHERE id=$1 AND status='ACTIVE'",
    [intent.accountId],
  );
  await db.query(
    "UPDATE account_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE account_id=$1",
    [intent.accountId],
  );
  await db.query(
    "UPDATE email_challenges SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=ANY($1::uuid[]) OR subject_account_id=$2",
    [intent.otpIds, intent.accountId],
  );
  await db.query("DELETE FROM sessions WHERE participant_id=ANY($1::uuid[])", [
    intent.participantIds,
  ]);
  await db.query("DELETE FROM invites WHERE participant_id=ANY($1::uuid[])", [
    intent.participantIds,
  ]);
  await db.query(
    "UPDATE account_exports SET status='REVOKED',lease_token=NULL,lease_until=NULL WHERE account_id=$1",
    [intent.accountId],
  );
  await db.query(
    "UPDATE cloud_jobs SET status='COMPLETE',next_run_at=NULL,lease_token=NULL,lease_until=NULL WHERE account_id=$1",
    [intent.accountId],
  );
  await db.query(
    "INSERT INTO account_deletions(account_id,request_id,status,requested_at) VALUES($1,$2,'PENDING',$3) ON CONFLICT(account_id) DO NOTHING",
    [intent.accountId, intent.requestId, at],
  );
  const d = await db.query(
    "SELECT request_id FROM account_deletions WHERE account_id=$1",
    [intent.accountId],
  );
  ensure(
    d.rows[0].request_id === intent.requestId,
    503,
    "注销任务与恢复账本不一致。",
  );
  for (const hash of intent.sourceHashes)
    await db.query(
      "INSERT INTO erased_legacy_sources(source_hash,account_id,request_id) VALUES($1,$2,$3) ON CONFLICT(source_hash) DO NOTHING",
      [hash, intent.accountId, intent.requestId],
    );
}

export async function confirmAccountDeletion(
  accountId: string,
  requestId: string,
  raw: string | undefined,
) {
  assertInternal();
  z.uuid().parse(requestId);
  return withLifecycleLock(async (db) => {
    let ledger = readLedger();
    const identity = await receiptIdentity(db, raw, ledger);
    ensure(
      identity.requestId === requestId && identity.accountId === accountId,
      401,
      "注销请求不属于当前账号。",
    );
    if (!identity.intent) {
      const intent = await lifecycleTx(db, async () => {
        await guardLifecycleTransaction(db);
        return collectIntent(db, accountId, requestId);
      });
      ledger = appendLedger(intent);
    }
    const intent = ledger.events.find(
      (e): e is LedgerEvent & DeletionIntent =>
        e.kind === "DELETE_REQUESTED" && e.requestId === requestId,
    )!;
    await lifecycleTx(db, async () => {
      await freezeIntent(db, intent, intent.at);
      await saveLedgerWatermark(db, ledger, true);
    });
    return { deletion: await statusFor(db, { ...identity, intent }) };
  });
}

const cloudDeleteOrder = [
  "cloud_review_requests",
  "cloud_review_sources",
  "cloud_letter_sources",
  "cloud_requests",
  "cloud_calendar_nodes",
  "cloud_jobs",
  "cloud_calendars",
  "cloud_reviews",
  "cloud_response_revisions",
  "cloud_responses",
  "cloud_letters",
  "cloud_trips",
  "cloud_state",
  "legacy_binding_requests",
  "legacy_binding_cancellations",
  "legacy_bindings",
  "account_requests",
] as const;
async function eraseRows(db: PoolClient, intent: DeletionIntent) {
  // Deferred current-revision FK permits deleting both sides in one transaction.
  await db.query("SET CONSTRAINTS ALL DEFERRED");
  for (const table of cloudDeleteOrder)
    await db.query(`DELETE FROM ${table} WHERE account_id=$1`, [
      intent.accountId,
    ]);
  for (const table of [
    "admin_requests",
    "responses",
    "letters",
    "trips",
    "invites",
    "sessions",
    "safety_cases",
    "audit_events",
  ] as const)
    await db.query(
      `DELETE FROM ${table} WHERE participant_id=ANY($1::uuid[])`,
      [intent.participantIds],
    );
  await db.query("DELETE FROM cat_profiles WHERE account_id=$1", [
    intent.accountId,
  ]);
  await db.query("DELETE FROM participants WHERE id=ANY($1::uuid[])", [
    intent.participantIds,
  ]);
  await db.query("DELETE FROM account_sessions WHERE account_id=$1", [
    intent.accountId,
  ]);
  await db.query("DELETE FROM account_rate_limits WHERE key=$1", [
    `privacy:${intent.accountId}`,
  ]);
  for (const pid of intent.participantIds)
    await db.query("DELETE FROM rate_limits WHERE key=$1", [`user:${pid}`]);
  await db.query(
    "DELETE FROM email_challenges WHERE id=ANY($1::uuid[]) OR subject_account_id=$2",
    [intent.otpIds, intent.accountId],
  );
  await db.query("DELETE FROM account_exports WHERE account_id=$1", [
    intent.accountId,
  ]);
  await db.query("DELETE FROM deletion_preparations WHERE account_id=$1", [
    intent.accountId,
  ]);
  await db.query(
    "UPDATE account_deletions SET status='PENDING',phase='ERASING',completed_at=NULL,last_error=NULL WHERE account_id=$1",
    [intent.accountId],
  );
}
async function eraseIntent(
  db: PoolClient,
  intent: LedgerEvent & DeletionIntent,
) {
  await lifecycleTx(db, async () => {
    await freezeIntent(db, intent, intent.at);
    await db.query(
      "UPDATE account_deletions SET status='PENDING',phase='ERASING',attempts=attempts+1,last_error=NULL WHERE account_id=$1 AND status<>'COMPLETE'",
      [intent.accountId],
    );
  });
  const files = await db.query(
    "SELECT id FROM account_exports WHERE account_id=$1",
    [intent.accountId],
  );
  for (const id of new Set([
    ...files.rows.map((f) => f.id as string),
    ...intent.exportIds,
  ]))
    deleteExportFilesForJob(id);
  const mailbox = process.env.E4_SYNTHETIC_MAILBOX_DIR;
  if (mailbox && existsSync(mailbox)) {
    ensure(
      lstatSync(mailbox).isDirectory() && !lstatSync(mailbox).isSymbolicLink(),
      503,
      "合成验证码目录不安全。",
    );
    for (const id of intent.otpIds) {
      z.uuid().parse(id);
      const path = join(mailbox, `${id}.json`);
      if (existsSync(path)) unlinkSync(path);
    }
    const fd = openSync(mailbox, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  eraseInMemoryOtpRecords(intent.otpIds);
  await lifecycleTx(db, () => eraseRows(db, intent));
  const ledger = appendLedger({
    kind: "DELETE_COMPLETE",
    requestId: intent.requestId,
    accountId: intent.accountId,
  });
  await lifecycleTx(db, async () => {
    // Release the email only after the complete marker is durable and together
    // with the task's terminal commit. Cleanup failures remain DELETING.
    await db.query(
      "UPDATE accounts SET email_normalized=$2,status='DELETED',deleted_at=COALESCE(deleted_at,clock_timestamp()) WHERE id=$1",
      [intent.accountId, `deleted+${intent.accountId}@invalid.invalid`],
    );
    await db.query(
      "UPDATE account_deletions SET status='COMPLETE',phase='COMPLETE',completed_at=COALESCE(completed_at,clock_timestamp()),last_error=NULL WHERE account_id=$1",
      [intent.accountId],
    );
    await saveLedgerWatermark(db, ledger, false);
  });
  return ledger;
}
async function recordDeleteFailure(db: PoolClient, accountId: string) {
  await db.query(
    "UPDATE account_deletions SET status='FAILED',last_error='ERASURE_FAILED' WHERE account_id=$1 AND status<>'COMPLETE'",
    [accountId],
  );
  // A frozen account's recoverable cleanup failure must not lock out unrelated accounts.
  try {
    const ledger = readLedger(),
      control = (
        await db.query("SELECT * FROM lifecycle_control WHERE singleton=true")
      ).rows[0];
    if (
      control?.status === "READY" &&
      control.ledger_id === ledger.id &&
      Number(control.ledger_sequence) === ledger.sequence &&
      control.ledger_hash === ledger.hash &&
      !existsSync(join(lifecycleDirectory(), "RESTORE_LOCK"))
    ) {
      await saveLedgerWatermark(db, ledger, true);
      return;
    }
  } catch {}
  await db.query(
    "UPDATE lifecycle_control SET status='CLOSED' WHERE singleton=true",
  );
}
export async function retryAccountDeletion(
  requestId: string,
  raw: string | undefined,
) {
  assertInternal();
  z.uuid().parse(requestId);
  return withLifecycleLock(async (db) => {
    ensure(
      !existsSync(join(lifecycleDirectory(), "RESTORE_LOCK")),
      503,
      "数据恢复尚未核验，请等待维护者恢复服务。",
    );
    const ledger = readLedger(true);
    await validateLedgerWatermark(db, ledger);
    const identity = await receiptIdentity(db, raw, ledger);
    ensure(
      identity.requestId === requestId && identity.intent,
      409,
      "尚未确认注销，请先回到确认页。",
    );
    const current = await statusFor(db, identity);
    if (current.status === "COMPLETE") return { deletion: current };
    try {
      const next = await eraseIntent(db, identity.intent);
      await saveLedgerWatermark(db, next, true);
    } catch (e) {
      await recordDeleteFailure(db, identity.accountId);
      throw e;
    }
    return { deletion: await statusFor(db, identity) };
  });
}

/** Explicit operator entry: process every independent intent, including incomplete ones. */
export async function reconcileLifecycle() {
  assertInternal();
  return withLifecycleLock(async (db) => {
    const control = (
      await db.query("SELECT * FROM lifecycle_control WHERE singleton=true")
    ).rows[0];
    ensure(control, 503, "请先完成迁移。");
    await db.query(
      "UPDATE lifecycle_control SET status='CLOSED' WHERE singleton=true",
    );
    const hasLedger = existsSync(join(lifecycleDirectory(), "ledger"));
    ensure(
      hasLedger ||
        (!control.ledger_id && process.env.E4_LIFECYCLE_BOOTSTRAP === "true"),
      503,
      "恢复账本缺失；禁止重建空账本。",
    );
    let ledger = hasLedger ? readLedger(true) : initializeLedger();
    ensure(
      !control.ledger_id || control.ledger_id === ledger.id,
      503,
      "恢复账本不属于当前实例。",
    );
    ensure(
      Number(control.ledger_sequence) <= ledger.sequence &&
        (Number(control.ledger_sequence) === 0 ||
          ledger.events[Number(control.ledger_sequence) - 1]?.hash ===
            control.ledger_hash),
      503,
      "账本落后于业务库，不能开放服务。",
    );
    const intents = ledger.events.filter(
      (e): e is LedgerEvent & DeletionIntent => e.kind === "DELETE_REQUESTED",
    );
    for (const event of ledger.events) {
      if (event.kind === "RESPONSE_DELETED")
        await replayResponseDeletion(db, event);
      if (event.kind === "DELETE_REQUESTED") {
        try {
          ledger = await eraseIntent(db, event);
        } catch (e) {
          await recordDeleteFailure(db, event.accountId);
          throw e;
        }
      }
    }
    // File restore lock remains until all replay and database watermark commits succeed.
    await saveLedgerWatermark(db, ledger, true);
    clearRestoreLock();
    return {
      ready: true,
      ledgerId: ledger.id,
      sequence: ledger.sequence,
      replayed: intents.length,
      responseDeletions: ledger.events.filter(
        (e) => e.kind === "RESPONSE_DELETED",
      ).length,
    };
  });
}

export async function runDeletionWorkerOnce() {
  assertInternal();
  return withLifecycleLock(async (db) => {
    await lifecycleTx(db, async () => guardLifecycleTransaction(db));
    const ledger = readLedger(),
      intents = ledger.events.filter(
        (e): e is LedgerEvent & DeletionIntent => e.kind === "DELETE_REQUESTED",
      );
    const pending = await db.query(
      "SELECT request_id FROM account_deletions WHERE status<>'COMPLETE' ORDER BY requested_at LIMIT 1",
    );
    const intent = intents.find(
      (e) => e.requestId === pending.rows[0]?.request_id,
    );
    if (!intent) return { status: "IDLE" };
    try {
      const next = await eraseIntent(db, intent);
      await saveLedgerWatermark(db, next, true);
      return { status: "COMPLETE", requestId: intent.requestId };
    } catch (e) {
      await recordDeleteFailure(db, intent.accountId);
      throw e;
    }
  });
}
