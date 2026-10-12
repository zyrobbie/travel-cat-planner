import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "./db";
import { lockActiveAccount } from "./account-service";
import { ensure } from "./errors";
import { assertInternal } from "./safety";
import {
  deletePrivateFile,
  deleteExportFilesForJob,
  guardedLifecycleTx,
  lifecycleDirectory,
  withLifecycleLock,
  withLifecycleReadLock,
  writePrivateAtomic,
} from "./lifecycle-ledger";

export type ExportJob = {
  id: string;
  status: "QUEUED" | "BUILDING" | "READY" | "FAILED" | "EXPIRED" | "REVOKED";
  createdAt: string;
  expiresAt: string | null;
  filename: string | null;
  error: string | null;
};
export type ExportClaim = { id: string; accountId: string; leaseToken: string };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const date = (v: Date | string | null) =>
  v ? new Date(v).toISOString() : null;
const filename = (id: string) => `cat-letters-${id}.json`;
const project = (r: Record<string, unknown>): ExportJob => ({
  id: String(r.id),
  status: r.status as ExportJob["status"],
  createdAt: date(r.created_at as Date)!,
  expiresAt: date(r.expires_at as Date),
  filename: r.status === "READY" ? filename(String(r.id)) : null,
  error: r.last_error ? "导出未完成，请重试。" : null,
});
function exportDirectory() {
  const path = join(lifecycleDirectory(), "exports");
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  ensure(
    lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(),
    503,
    "私有导出目录不安全。",
  );
  return path;
}
async function snapshotVersion(db: PoolClient, accountId: string) {
  const r = await db.query(
    "SELECT c.id,s.revision FROM cat_profiles c LEFT JOIN cloud_state s ON s.cat_id=c.id AND s.account_id=c.account_id WHERE c.account_id=$1 FOR UPDATE OF c",
    [accountId],
  );
  return {
    catId: r.rows[0]?.id ?? null,
    revision: r.rows[0]?.revision ?? null,
  };
}
async function invalidateOld(db: PoolClient, accountId: string) {
  const version = await snapshotVersion(db, accountId);
  await db.query(
    "UPDATE account_exports SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE 'REVOKED' END,lease_token=NULL,lease_until=NULL WHERE account_id=$1 AND status='READY' AND (expires_at<=clock_timestamp() OR cat_id IS DISTINCT FROM $2::uuid OR captured_revision IS DISTINCT FROM $3::bigint)",
    [accountId, version.catId, version.revision],
  );
  return version;
}
export async function requestAccountExport(accountId: string, key: string) {
  assertInternal();
  z.uuid().parse(key);
  return transaction(async (db) => {
    await lockActiveAccount(db, accountId);
    await invalidateOld(db, accountId);
    const existing = await db.query(
      "SELECT * FROM account_exports WHERE account_id=$1 AND request_key=$2",
      [accountId, key],
    );
    if (existing.rows[0]) return { job: project(existing.rows[0]) };
    const busy = await db.query(
      "SELECT count(*)::int AS n FROM account_exports WHERE account_id=$1 AND status IN ('QUEUED','BUILDING')",
      [accountId],
    );
    ensure(busy.rows[0].n < 2, 429, "已有导出正在处理，请稍后再试。");
    const id = randomUUID();
    const r = await db.query(
      "INSERT INTO account_exports(id,account_id,request_key,status) VALUES($1,$2,$3,'QUEUED') RETURNING *",
      [id, accountId, key],
    );
    return { job: project(r.rows[0]) };
  });
}
export async function listAccountExports(accountId: string) {
  return transaction(async (db) => {
    await lockActiveAccount(db, accountId);
    await invalidateOld(db, accountId);
    return {
      exports: (
        await db.query(
          "SELECT * FROM account_exports WHERE account_id=$1 ORDER BY created_at DESC LIMIT 20",
          [accountId],
        )
      ).rows.map(project),
    };
  });
}
export async function accountExportStatus(accountId: string, id: string) {
  z.uuid().parse(id);
  return transaction(async (db) => {
    await lockActiveAccount(db, accountId);
    await invalidateOld(db, accountId);
    const r = await db.query(
      "SELECT * FROM account_exports WHERE account_id=$1 AND id=$2",
      [accountId, id],
    );
    ensure(r.rows[0], 404, "没有找到这份导出。");
    return { job: project(r.rows[0]) };
  });
}
export async function retryAccountExport(accountId: string, id: string) {
  z.uuid().parse(id);
  return transaction(async (db) => {
    await lockActiveAccount(db, accountId);
    await invalidateOld(db, accountId);
    const r = await db.query(
      "SELECT * FROM account_exports WHERE account_id=$1 AND id=$2 FOR UPDATE",
      [accountId, id],
    );
    ensure(r.rows[0], 404, "没有找到这份导出。");
    if (["FAILED", "REVOKED", "EXPIRED"].includes(r.rows[0].status)) {
      const n = await db.query(
        "UPDATE account_exports SET status='QUEUED',lease_token=NULL,lease_until=NULL,attempts=0,last_error=NULL,expires_at=NULL,captured_revision=NULL,cat_id=NULL WHERE account_id=$1 AND id=$2 RETURNING *",
        [accountId, id],
      );
      return { job: project(n.rows[0]) };
    }
    return { job: project(r.rows[0]) };
  });
}
export async function claimAccountExport(
  options: { leaseSeconds?: number } = {},
): Promise<ExportClaim | null> {
  assertInternal();
  const seconds = options.leaseSeconds ?? 60;
  ensure(
    Number.isInteger(seconds) && seconds >= 1 && seconds <= 300,
    400,
    "导出租约无效。",
  );
  return transaction(async (db) => {
    await db.query(
      "UPDATE account_exports SET status='FAILED',lease_token=NULL,lease_until=NULL,last_error='RETRIES_EXHAUSTED' WHERE status='BUILDING' AND lease_until<=clock_timestamp() AND attempts>=5",
    );
    const r = await db.query(
      "SELECT e.* FROM account_exports e JOIN accounts a ON a.id=e.account_id AND a.status='ACTIVE' WHERE e.attempts<5 AND (e.status='QUEUED' OR (e.status='BUILDING' AND e.lease_until<=clock_timestamp())) ORDER BY e.created_at FOR UPDATE OF e SKIP LOCKED LIMIT 1",
    );
    if (!r.rows[0]) return null;
    const leaseToken = randomUUID();
    await db.query(
      "UPDATE account_exports SET status='BUILDING',lease_token=$2,lease_until=clock_timestamp()+$3*interval '1 second',attempts=attempts+1,last_error=NULL WHERE id=$1",
      [r.rows[0].id, leaseToken, seconds],
    );
    return { id: r.rows[0].id, accountId: r.rows[0].account_id, leaseToken };
  });
}
/** Deliberate white-list: no sessions, OTPs, command payloads, drafts or private review authority. */
async function collectExport(db: PoolClient, accountId: string) {
  const account = await lockActiveAccount(db, accountId),
    version = await snapshotVersion(db, accountId);
  const q = async (sql: string) => (await db.query(sql, [accountId])).rows;
  const cat =
    (
      await q(
        "SELECT id,appearance_id,appearance_version,name,adopted_at FROM cat_profiles WHERE account_id=$1",
      )
    )[0] ?? null;
  const letters = await q(
    "SELECT id,type,snapshot,trip_id,story_id,calendar_node_id,delivered_at,planned_at,effective_at,read_at,skipped_at,origin FROM cloud_letters WHERE account_id=$1 ORDER BY delivered_at,id",
  );
  const responses = await q(
    "SELECT id,letter_id,current_revision,status,created_at,deleted_at,origin FROM cloud_responses WHERE account_id=$1 ORDER BY id",
  );
  const revisions = await q(
    "SELECT r.response_id,r.revision,CASE WHEN p.status='DELETED' THEN NULL ELSE r.text END AS text,r.at FROM cloud_response_revisions r JOIN cloud_responses p ON (p.account_id,p.cat_id,p.id)=(r.account_id,r.cat_id,r.response_id) WHERE r.account_id=$1 ORDER BY r.response_id,r.revision",
  );
  const sources = await q(
    "SELECT letter_id,source_order,response_id,revision,claim,start_offset,end_offset,assessment FROM cloud_letter_sources WHERE account_id=$1 ORDER BY letter_id,source_order",
  );
  const trips = await q(
    "SELECT id,scene,status,started_at,ended_at,planned_start_at,planned_end_at,origin FROM cloud_trips WHERE account_id=$1 ORDER BY id",
  );
  const calendar =
    (
      await q(
        "SELECT version,initialized_at,base_at,offset_ms,last_effective_at,processed_count,node_count FROM cloud_calendars WHERE account_id=$1",
      )
    )[0] ?? null;
  const nodes = await q(
    "SELECT id,planned_at,node_order,kind,trip_id,scene,content_id,origin,result_outcome,result_reason,written_at,effective_at,letter_id FROM cloud_calendar_nodes WHERE account_id=$1 ORDER BY node_order",
  );
  const logical =
    (
      await q("SELECT logical_cat_id FROM legacy_bindings WHERE account_id=$1")
    )[0]?.logical_cat_id ??
    cat?.id ??
    null;
  const legacyHistory = {
    letters: await q(
      "SELECT l.id,l.content_id,l.type,l.snapshot,l.trip_id,l.delivered_at,l.read_at,l.skipped_at,l.simulation FROM letters l JOIN cat_profiles c ON c.participant_id=l.participant_id WHERE c.account_id=$1 ORDER BY l.delivered_at,l.id",
    ),
    responses: await q(
      "SELECT r.id,r.letter_id,r.text,r.created_at FROM responses r JOIN cat_profiles c ON c.participant_id=r.participant_id WHERE c.account_id=$1 ORDER BY r.created_at,r.id",
    ),
    trips: await q(
      "SELECT t.id,t.started_at,t.ended_at,t.simulation FROM trips t JOIN cat_profiles c ON c.participant_id=t.participant_id WHERE c.account_id=$1 ORDER BY t.started_at,t.id",
    ),
  };
  return {
    version,
    data: {
      format: "cat-letters-account-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      account: {
        id: account.id,
        email: account.email_normalized,
        createdAt: account.created_at,
      },
      cat: cat ? { ...cat, logicalId: logical } : null,
      stateRevision:
        version.revision === null ? null : Number(version.revision),
      letters,
      responses,
      responseRevisions: revisions,
      letterSources: sources,
      trips,
      calendar: calendar ? { ...calendar, nodes } : null,
      legacyHistory,
      omitted: ["本机草稿", "验证码与登录凭证", "内部操作记录"],
    },
  };
}
export async function runClaimedAccountExport(claim: ExportClaim) {
  assertInternal();
  return withLifecycleReadLock(async (connection) => {
    const tx = <T>(fn: (db: PoolClient) => Promise<T>) =>
      guardedLifecycleTx(connection, fn);
    const artifact = `${claim.id}.${randomUUID()}.json`;
    try {
      const snapshot = await tx(async (db) => {
        await lockActiveAccount(db, claim.accountId);
        const r = await db.query(
          "SELECT * FROM account_exports WHERE id=$1 AND account_id=$2 AND status='BUILDING' AND lease_token=$3 AND lease_until>clock_timestamp() FOR UPDATE",
          [claim.id, claim.accountId, claim.leaseToken],
        );
        if (!r.rows[0]) return null;
        return collectExport(db, claim.accountId);
      });
      if (!snapshot) return { status: "STALE" };
      const bytes = Buffer.from(JSON.stringify(snapshot.data, null, 2));
      ensure(
        bytes.byteLength <= 32 * 1024 * 1024,
        503,
        "导出超过本轮处理范围。",
      );
      writePrivateAtomic(join(exportDirectory(), artifact), bytes);
      const result = await tx(async (db) => {
        await lockActiveAccount(db, claim.accountId);
        const now = await snapshotVersion(db, claim.accountId);
        const same =
          now.catId === snapshot.version.catId &&
          now.revision === snapshot.version.revision;
        const r = await db.query(
          "UPDATE account_exports SET status=$4,cat_id=$5,captured_revision=$6,expires_at=clock_timestamp()+interval '24 hours',artifact_hash=$7,artifact_bytes=$8,artifact_name=$9,lease_token=NULL,lease_until=NULL WHERE id=$1 AND account_id=$2 AND status='BUILDING' AND lease_token=$3 AND lease_until>clock_timestamp() RETURNING *",
          [
            claim.id,
            claim.accountId,
            claim.leaseToken,
            same ? "READY" : "REVOKED",
            snapshot.version.catId,
            snapshot.version.revision,
            sha(bytes),
            bytes.byteLength,
            artifact,
          ],
        );
        return r.rows[0]
          ? { status: r.rows[0].status, job: project(r.rows[0]) }
          : { status: "STALE" };
      });
      if (result.status !== "READY") deletePrivateFile(artifact);
      return result;
    } catch (error) {
      let cleanupFailed = false;
      try {
        deletePrivateFile(artifact);
      } catch {
        cleanupFailed = true;
      }
      await tx(async (db) => {
        await lockActiveAccount(db, claim.accountId);
        await db.query(
          "UPDATE account_exports SET status='FAILED',lease_token=NULL,lease_until=NULL,last_error=$4 WHERE id=$1 AND account_id=$2 AND lease_token=$3",
          [claim.id, claim.accountId, claim.leaseToken, cleanupFailed ? 'EXPORT_FILE_CLEANUP_FAILED' : 'EXPORT_FAILED'],
        );
      }).catch(() => {});
      throw error;
    }
  });
}
export async function downloadAccountExport(accountId: string, id: string) {
  z.uuid().parse(id);
  const result = await transaction(async (db) => {
    await lockActiveAccount(db, accountId);
    const v = await snapshotVersion(db, accountId);
    const r = await db.query(
      "SELECT *,expires_at>clock_timestamp() AS valid FROM account_exports WHERE id=$1 AND account_id=$2 FOR UPDATE",
      [id, accountId],
    );
    const job = r.rows[0];
    ensure(job, 404, "没有找到这份导出。");
    ensure(
      job.status === "READY",
      409,
      "这份导出尚未就绪或已失效，请重新导出。",
    );
    ensure(job.valid, 410, "这份导出已过期，请重新导出。");
    ensure(
      job.cat_id === v.catId && job.captured_revision === v.revision,
      409,
      "记录已经改变，请重新导出当前内容。",
    );
    try {
      ensure(
        typeof job.artifact_name === "string" &&
          job.artifact_name.startsWith(`${id}.`) &&
          /^[a-f0-9-]{36}\.[a-f0-9-]{36}\.json$/.test(job.artifact_name),
        503,
        "导出文件校验失败。",
      );
      const path = join(exportDirectory(), job.artifact_name);
      ensure(
        existsSync(path) && !lstatSync(path).isSymbolicLink(),
        503,
        "导出文件暂不可用，请重试。",
      );
      const bytes = readFileSync(path);
      ensure(
        bytes.byteLength === Number(job.artifact_bytes) &&
          sha(bytes) === job.artifact_hash,
        503,
        "导出文件校验失败。",
      );
      return { failed: false as const, bytes, filename: filename(id) };
    } catch {
      await db.query(
        "UPDATE account_exports SET status='FAILED',last_error='EXPORT_FILE_UNAVAILABLE',lease_token=NULL,lease_until=NULL WHERE id=$1 AND account_id=$2",
        [id, accountId],
      );
      // Commit the recoverable task status before returning the download error.
      return { failed: true as const };
    }
  });
  ensure(!result.failed, 503, "导出文件暂不可用，请重试准备。");
  return { bytes: result.bytes, filename: result.filename };
}
export async function cleanupAccountExports() {
  return withLifecycleLock(async (connection) => {
    const jobs = await guardedLifecycleTx(connection, async (db) => {
      // Rate-limit keys have no payloads and are temporary; do not erase a new same-email account's live bucket.
      await db.query(
        "DELETE FROM account_rate_limits WHERE window_at<clock_timestamp()-interval '24 hours'",
      );
      await db.query(
        "DELETE FROM rate_limits WHERE window_at<clock_timestamp()-interval '24 hours'",
      );
      await db.query(
        "UPDATE account_exports SET status='EXPIRED',lease_token=NULL,lease_until=NULL WHERE status='READY' AND expires_at<=clock_timestamp()",
      );
      await db.query(
        "UPDATE account_exports e SET status='REVOKED' WHERE e.status='READY' AND NOT EXISTS(SELECT 1 FROM accounts a LEFT JOIN cat_profiles c ON c.account_id=a.id LEFT JOIN cloud_state s ON s.cat_id=c.id AND s.account_id=a.id WHERE a.id=e.account_id AND a.status='ACTIVE' AND e.cat_id IS NOT DISTINCT FROM c.id AND e.captured_revision IS NOT DISTINCT FROM s.revision)",
      );
      return (
        await db.query(
          "SELECT id,status,artifact_name,lease_until>clock_timestamp() AS lease_valid FROM account_exports",
        )
      ).rows;
    });
    const byId = new Map(jobs.map((r) => [r.id, r])),
      dir = exportDirectory();
    let cleaned = 0;
    for (const name of readdirSync(dir)) {
      const parsed = name.match(
        /^([a-f0-9-]{36})\.[a-f0-9-]{36}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/,
      );
      if (!parsed) continue;
      const job = byId.get(parsed[1]);
      if (job?.status === "READY" && name === job.artifact_name) continue;
      if (job?.status === "BUILDING" && job.lease_valid) continue;
      unlinkSync(join(dir, name));
      cleaned++;
    }
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { cleaned };
  });
}
export async function runExportWorkerOnce() {
  const claim = await claimAccountExport();
  return claim ? runClaimedAccountExport(claim) : { status: "IDLE" };
}
