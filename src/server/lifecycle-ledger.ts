import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { PoolClient } from "pg";
import { pool } from "./db";
import { ensure } from "./errors";

export const LIFECYCLE_LOCK = 82101008;
export type DeletionIntent = {
  kind: "DELETE_REQUESTED";
  requestId: string;
  accountId: string;
  receiptHash: string;
  participantIds: string[];
  catIds: string[];
  otpIds: string[];
  exportIds: string[];
  sourceHashes: string[];
};
export type ResponseDeletionIntent = {
  kind: "RESPONSE_DELETED";
  requestId: string;
  accountId: string;
  catId: string;
  responseId: string;
  throughRevision: number;
  payloadHash: string;
  stateRevision: number;
  exportIds: string[];
};
export type LedgerPayload =
  | DeletionIntent
  | ResponseDeletionIntent
  | { kind: "DELETE_COMPLETE"; requestId: string; accountId: string };
export type LedgerEvent = LedgerPayload & {
  sequence: number;
  previous: string;
  hash: string;
  at: string;
};
export type Ledger = {
  id: string;
  sequence: number;
  hash: string;
  events: LedgerEvent[];
};
function secret() {
  const s = process.env.E4_LEDGER_SECRET;
  ensure(s && s.length >= 32, 503, "恢复账本尚未配置。");
  return s;
}
export function lifecycleDirectory() {
  const path = process.env.E4_LIFECYCLE_DIR;
  ensure(path && isAbsolute(path), 503, "私有数据目录尚未配置。");
  const normalized = resolve(path);
  const privatePath = (value: string) =>
    !value
      .split(/[\\/]/)
      .some((x) =>
        ["public", "dist", "pages-dist", ".git", ".next"].includes(x),
      );
  ensure(privatePath(normalized), 503, "私有数据目录配置无效。");
  if (existsSync(normalized)) {
    ensure(
      lstatSync(normalized).isDirectory() &&
        !lstatSync(normalized).isSymbolicLink(),
      503,
      "私有数据目录不安全。",
    );
    const real = realpathSync(normalized);
    ensure(privatePath(real), 503, "私有数据目录配置无效。");
    return real;
  }
  let ancestor = normalized;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const resolved = resolve(realpathSync(ancestor), ...missing);
  ensure(privatePath(resolved), 503, "私有数据目录配置无效。");
  return resolved;
}
export function sourceFingerprint(namespace: string, id: string) {
  return createHmac("sha256", secret())
    .update(JSON.stringify(["SOURCE", namespace, id]))
    .digest("hex");
}
export function deletionReceiptToken(requestId: string, accountId: string) {
  return createHmac("sha256", secret())
    .update(JSON.stringify(["DELETION_RECEIPT", requestId, accountId]))
    .digest("hex");
}
const sha = (value: unknown) =>
  createHmac("sha256", secret()).update(JSON.stringify(value)).digest("hex");
function syncDir(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function writePrivateAtomic(path: string, data: string | Buffer) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  syncDir(resolve(path, ".."));
}
export function initializeLedger() {
  const root = lifecycleDirectory();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = join(root, "ledger");
  if (existsSync(dir)) return readLedger();
  const staged = join(root, `.ledger-init-${randomUUID()}`);
  mkdirSync(staged, { mode: 0o700 });
  const identity = {
    id: randomUUID(),
    version: 1,
    keyHash: createHash("sha256").update(secret()).digest("hex"),
  };
  writePrivateAtomic(join(staged, "identity.json"), JSON.stringify(identity));
  writePrivateAtomic(
    join(staged, "head.json"),
    JSON.stringify({ sequence: 0, hash: "" }),
  );
  renameSync(staged, dir);
  syncDir(root);
  return readLedger();
}
export function readLedger(repairTail = false): Ledger {
  const dir = join(lifecycleDirectory(), "ledger");
  ensure(
    existsSync(join(dir, "identity.json")) &&
      existsSync(join(dir, "head.json")),
    503,
    "恢复账本不可用，服务已暂停。",
  );
  ensure(!lstatSync(dir).isSymbolicLink(), 503, "恢复账本配置无效。");
  const identity = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8"));
  ensure(
    identity.version === 1 &&
      identity.keyHash ===
        createHash("sha256").update(secret()).digest("hex") &&
      /^[a-f0-9-]{36}$/.test(identity.id),
    503,
    "恢复账本校验失败。",
  );
  const head = JSON.parse(readFileSync(join(dir, "head.json"), "utf8"));
  const names = readdirSync(dir)
    .filter((x) => /^\d{12}\.json$/.test(x))
    .sort();
  let previous = "";
  const events: LedgerEvent[] = [];
  for (let i = 0; i < names.length; i++) {
    ensure(
      names[i] === `${String(i + 1).padStart(12, "0")}.json`,
      503,
      "恢复账本存在缺口。",
    );
    const e = JSON.parse(
      readFileSync(join(dir, names[i]), "utf8"),
    ) as LedgerEvent;
    const { hash, ...unsigned } = e;
    ensure(
      e.sequence === i + 1 &&
        e.previous === previous &&
        hash === sha(unsigned) &&
        ["DELETE_REQUESTED", "DELETE_COMPLETE", "RESPONSE_DELETED"].includes(
          e.kind,
        ),
      503,
      "恢复账本校验失败。",
    );
    if (e.kind === "DELETE_REQUESTED")
      ensure(
        Array.isArray(e.otpIds) &&
          Array.isArray(e.exportIds) &&
          Array.isArray(e.participantIds) &&
          Array.isArray(e.catIds) &&
          Array.isArray(e.sourceHashes) &&
          /^[a-f0-9]{64}$/.test(e.receiptHash),
        503,
        "恢复账本记录无效。",
      );
    if (e.kind === "RESPONSE_DELETED")
      ensure(
        Array.isArray(e.exportIds) &&
          Number.isSafeInteger(e.throughRevision) &&
          e.throughRevision > 0 &&
          Number.isSafeInteger(e.stateRevision) &&
          e.stateRevision >= 0 &&
          /^[a-f0-9]{64}$/.test(e.payloadHash),
        503,
        "回应删除账本无效。",
      );
    previous = hash;
    events.push(e);
  }
  ensure(
    Number.isSafeInteger(head.sequence) &&
      head.sequence >= 0 &&
      head.sequence <= events.length &&
      (head.sequence === 0
        ? head.hash === ""
        : events[head.sequence - 1]?.hash === head.hash),
    503,
    "恢复账本水位无效。",
  );
  if (head.sequence !== events.length) {
    ensure(repairTail, 503, "恢复账本需显式核对后恢复。");
    writePrivateAtomic(
      join(dir, "head.json"),
      JSON.stringify({ sequence: events.length, hash: previous }),
    );
  }
  return { id: identity.id, sequence: events.length, hash: previous, events };
}
/** Caller holds the exclusive lifecycle session lock; disk IO is outside SQL transactions. */
export function appendLedger(payload: LedgerPayload): Ledger {
  const ledger = readLedger(true),
    dir = join(lifecycleDirectory(), "ledger");
  const prior = ledger.events.find(
    (e) =>
      e.kind === payload.kind &&
      e.requestId === payload.requestId &&
      e.accountId === payload.accountId,
  );
  if (prior) {
    ensure(prior.accountId === payload.accountId, 409, "注销任务不一致。");
    return ledger;
  }
  const unsigned = {
    ...payload,
    sequence: ledger.sequence + 1,
    previous: ledger.hash,
    at: new Date().toISOString(),
  };
  const event = { ...unsigned, hash: sha(unsigned) } as LedgerEvent;
  writePrivateAtomic(
    join(dir, `${String(event.sequence).padStart(12, "0")}.json`),
    JSON.stringify(event),
  );
  writePrivateAtomic(
    join(dir, "head.json"),
    JSON.stringify({ sequence: event.sequence, hash: event.hash }),
  );
  return {
    ...ledger,
    sequence: event.sequence,
    hash: event.hash,
    events: [...ledger.events, event],
  };
}
export async function guardLifecycleTransaction(db: PoolClient) {
  await db.query("SELECT pg_advisory_xact_lock_shared($1)", [LIFECYCLE_LOCK]);
  ensure(
    !existsSync(join(lifecycleDirectory(), "RESTORE_LOCK")),
    503,
    "数据恢复尚未核验，服务已暂停。",
  );
  const ledger = readLedger();
  const r = await db.query(
    "SELECT * FROM lifecycle_control WHERE singleton=true",
  );
  const row = r.rows[0];
  ensure(
    row?.status === "READY" &&
      row.ledger_id === ledger.id &&
      Number(row.ledger_sequence) === ledger.sequence &&
      row.ledger_hash === ledger.hash,
    503,
    "数据恢复校验尚未完成，服务已暂停。",
  );
}
export async function closeLifecycleForRestore() {
  return withLifecycleLock(async (db) => {
    const ledger = readLedger();
    writePrivateAtomic(
      join(lifecycleDirectory(), "RESTORE_LOCK"),
      JSON.stringify({
        ledgerId: ledger.id,
        sequence: ledger.sequence,
        at: new Date().toISOString(),
      }),
    );
    await db.query(
      "UPDATE lifecycle_control SET status='CLOSED' WHERE singleton=true",
    );
    return { closed: true, ledgerId: ledger.id, sequence: ledger.sequence };
  });
}
export function clearRestoreLock() {
  const path = join(lifecycleDirectory(), "RESTORE_LOCK");
  if (existsSync(path)) {
    unlinkSync(path);
    syncDir(lifecycleDirectory());
  }
}
export async function assertLifecycleReady() {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await guardLifecycleTransaction(db);
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
export async function withLifecycleLock<T>(fn: (db: PoolClient) => Promise<T>) {
  const db = await pool.connect();
  try {
    await db.query("SELECT pg_advisory_lock($1)", [LIFECYCLE_LOCK]);
    return await fn(db);
  } finally {
    await db
      .query("SELECT pg_advisory_unlock($1)", [LIFECYCLE_LOCK])
      .catch(() => {});
    db.release();
  }
}
/** Covers private file publication without holding an SQL transaction open. */
export async function withLifecycleReadLock<T>(
  fn: (db: PoolClient) => Promise<T>,
) {
  const db = await pool.connect();
  try {
    await db.query("SELECT pg_advisory_lock_shared($1)", [LIFECYCLE_LOCK]);
    await guardedLifecycleTx(db, async () => {});
    return await fn(db);
  } finally {
    await db
      .query("SELECT pg_advisory_unlock_shared($1)", [LIFECYCLE_LOCK])
      .catch(() => {});
    db.release();
  }
}
export async function guardedLifecycleTx<T>(
  db: PoolClient,
  fn: (db: PoolClient) => Promise<T>,
) {
  return lifecycleTx(db, async () => {
    await guardLifecycleTransaction(db);
    return fn(db);
  });
}
export async function lifecycleTx<T>(db: PoolClient, fn: () => Promise<T>) {
  try {
    await db.query("BEGIN");
    const r = await fn();
    await db.query("COMMIT");
    return r;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}
export async function saveLedgerWatermark(
  db: PoolClient,
  ledger: Ledger,
  ready = false,
) {
  await validateLedgerWatermark(db, ledger);
  if (ready) {
    for (const event of ledger.events)
      if (event.kind === "DELETE_REQUESTED") {
        const a = await db.query(
          "SELECT a.status,d.request_id,d.status AS deletion_status FROM accounts a LEFT JOIN account_deletions d ON d.account_id=a.id WHERE a.id=$1",
          [event.accountId],
        );
        if (
          !a.rows[0] ||
          a.rows[0].status === "ACTIVE" ||
          a.rows[0].request_id !== event.requestId ||
          (ledger.events.some(
            (e) =>
              e.kind === "DELETE_COMPLETE" && e.requestId === event.requestId,
          ) &&
            a.rows[0].deletion_status !== "COMPLETE")
        )
          ready = false;
      }
    for (const event of ledger.events)
      if (event.kind === "RESPONSE_DELETED") {
        const r = await db.query(
          "SELECT status FROM cloud_responses WHERE account_id=$1 AND cat_id=$2 AND id=$3",
          [event.accountId, event.catId, event.responseId],
        );
        const text = await db.query(
          "SELECT 1 FROM cloud_response_revisions WHERE account_id=$1 AND cat_id=$2 AND response_id=$3 AND text IS NOT NULL LIMIT 1",
          [event.accountId, event.catId, event.responseId],
        );
        if ((r.rows[0] && r.rows[0].status !== "DELETED") || text.rowCount)
          ready = false;
      }
  }
  await db.query(
    "UPDATE lifecycle_control SET ledger_id=$1,ledger_sequence=$2,ledger_hash=$3,status=$4,reconciled_at=clock_timestamp() WHERE singleton=true",
    [ledger.id, ledger.sequence, ledger.hash, ready ? "READY" : "CLOSED"],
  );
}
export async function validateLedgerWatermark(db: PoolClient, ledger: Ledger) {
  const row = (
    await db.query("SELECT * FROM lifecycle_control WHERE singleton=true")
  ).rows[0];
  ensure(
    row &&
      (!row.ledger_id || row.ledger_id === ledger.id) &&
      Number(row.ledger_sequence) <= ledger.sequence &&
      (Number(row.ledger_sequence) === 0 ||
        ledger.events[Number(row.ledger_sequence) - 1]?.hash ===
          row.ledger_hash),
    503,
    "恢复账本身份或水位不一致，禁止回退。",
  );
}
export function deletePrivateFile(name: string) {
  ensure(
    /^[a-f0-9-]{36}\.[a-f0-9-]{36}\.json$/.test(name),
    503,
    "私有文件标识无效。",
  );
  const dir = join(lifecycleDirectory(), "exports");
  if (!existsSync(dir)) return;
  ensure(!lstatSync(dir).isSymbolicLink(), 503, "私有导出目录不安全。");
  for (const file of readdirSync(dir))
    if (
      file === name ||
      (file.startsWith(`${name}.`) &&
        /^[a-f0-9-]{36}\.tmp$/.test(file.slice(name.length + 1)))
    )
      unlinkSync(join(dir, file));
  syncDir(dir);
}
export function deleteExportFilesForJob(id: string) {
  ensure(/^[a-f0-9-]{36}$/.test(id), 503, "私有文件标识无效。");
  const dir = join(lifecycleDirectory(), "exports");
  if (!existsSync(dir)) return;
  ensure(!lstatSync(dir).isSymbolicLink(), 503, "私有导出目录不安全。");
  for (const file of readdirSync(dir))
    if (
      file.startsWith(`${id}.`) &&
      /^[a-f0-9-]{36}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/.test(
        file.slice(id.length + 1),
      )
    )
      unlinkSync(join(dir, file));
  syncDir(dir);
}
