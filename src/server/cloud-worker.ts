import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { transaction } from "./db";
import { lockCloudCat } from "./cloud-repository";
import { settleCloudCalendar } from "./cloud-calendar";
import { assertInternal } from "./safety";
import { HttpError } from "./errors";

export const CLOUD_JOB_LEASE_SECONDS = 60;
export const CLOUD_JOB_MAX_ATTEMPTS = 5;

export interface CloudJobClaim {
  jobId: string;
  accountId: string;
  catId: string;
  leaseToken: string;
  leaseUntil: string;
  attempts: number;
}
export type CloudJobOutcome = {
  status: "SETTLED" | "STALE" | "INACTIVE" | "RETRY" | "FAILED";
  jobId: string;
  attempts?: number;
  retryAt?: string;
};

function errorCode(error: unknown) {
  const value = error as { code?: unknown; name?: unknown } | null;
  // SQL details, response text and credentials must not enter the job ledger.
  const candidate = value?.code ?? value?.name;
  return typeof candidate === "string" && /^[A-Za-z0-9_]{1,48}$/.test(candidate)
    ? candidate
    : "UNKNOWN";
}
export const cloudWorkerErrorCode = errorCode;

async function boundedTransaction(db: PoolClient) {
  await db.query("SET LOCAL lock_timeout = '5s'");
  await db.query("SET LOCAL statement_timeout = '15s'");
}

/** A claim owns only the job row, for a short transaction. No account/cat locks
 * or calendar work are taken here; a business transaction acquires those later.
 */
export async function claimCloudJob(): Promise<CloudJobClaim | null> {
  assertInternal();
  const leaseToken = randomUUID();
  return transaction(async (db) => {
    await boundedTransaction(db);
    // A process killed on its last attempt cannot record an error itself. Mark
    // exhausted, expired jobs explicitly FAILED rather than dropping nodes.
    await db.query(
      `WITH exhausted AS (
        SELECT j.id FROM cloud_jobs j JOIN accounts a ON a.id=j.account_id
        WHERE a.status='ACTIVE' AND j.status IN ('READY','LEASED')
          AND j.attempts >= $1 AND j.next_run_at <= clock_timestamp()
          AND (j.lease_until IS NULL OR j.lease_until <= clock_timestamp())
        ORDER BY j.next_run_at,j.id LIMIT 100 FOR UPDATE OF j SKIP LOCKED
      ) UPDATE cloud_jobs j SET status='FAILED',lease_token=NULL,lease_until=NULL,
          last_error=COALESCE(j.last_error,'LEASE_EXPIRED_AFTER_MAX_ATTEMPTS')
        FROM exhausted e WHERE j.id=e.id`,
      [CLOUD_JOB_MAX_ATTEMPTS],
    );
    const result = await db.query(
      `WITH eligible AS (
        SELECT j.id FROM cloud_jobs j JOIN accounts a ON a.id=j.account_id
        WHERE a.status='ACTIVE' AND j.status IN ('READY','LEASED')
          AND j.attempts < $1 AND j.next_run_at <= clock_timestamp()
          AND (j.lease_until IS NULL OR j.lease_until <= clock_timestamp())
        ORDER BY j.next_run_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED
      ) UPDATE cloud_jobs j SET status='LEASED',lease_token=$2,
          lease_until=clock_timestamp()+($3::int * interval '1 second'),attempts=j.attempts+1
        FROM eligible e WHERE j.id=e.id
        RETURNING j.id,j.account_id,j.cat_id,j.lease_token,j.lease_until,j.attempts`,
      [CLOUD_JOB_MAX_ATTEMPTS, leaseToken, CLOUD_JOB_LEASE_SECONDS],
    );
    const row = result.rows[0];
    return row
      ? {
          jobId: row.id,
          accountId: row.account_id,
          catId: row.cat_id,
          leaseToken: row.lease_token,
          leaseUntil: row.lease_until.toISOString(),
          attempts: row.attempts,
        }
      : null;
  });
}

async function activeCat(db: PoolClient, claim: CloudJobClaim) {
  try {
    return await lockCloudCat(db, claim.accountId);
  } catch (error) {
    // lockCloudCat checks ACTIVE immediately after locking the account. Its
    // business rejection performs no writes and is not a database SQL error.
    if (error instanceof HttpError && error.status === 401) return null;
    throw error;
  }
}
async function ownedLease(db: PoolClient, claim: CloudJobClaim) {
  const result = await db.query(
    `SELECT *,lease_until>clock_timestamp() AS valid FROM cloud_jobs
      WHERE id=$1 AND account_id=$2 AND cat_id=$3 FOR UPDATE`,
    [claim.jobId, claim.accountId, claim.catId],
  );
  const job = result.rows[0];
  return job?.status === "LEASED" &&
    job.lease_token === claim.leaseToken &&
    job.valid
    ? job
    : null;
}

class StaleLease extends Error {}

async function recordFailure(
  claim: CloudJobClaim,
  failure: unknown,
): Promise<CloudJobOutcome> {
  // The failed business transaction has already rolled back. Do not take the
  // job lock before account/cat locks, and never overwrite a newer lease.
  return transaction<CloudJobOutcome>(async (db) => {
    await boundedTransaction(db);
    const cat = await activeCat(db, claim);
    if (!cat) return { status: "INACTIVE", jobId: claim.jobId };
    if (cat.catId !== claim.catId) throw new StaleLease();
    const job = await ownedLease(db, claim);
    if (!job) throw new StaleLease();
    const failed = job.attempts >= CLOUD_JOB_MAX_ATTEMPTS;
    const backoff = Math.min(300, 5 * 2 ** (job.attempts - 1));
    const result = await db.query(
      `UPDATE cloud_jobs SET status=$2,lease_token=NULL,lease_until=NULL,last_error=$3,
        next_run_at=CASE WHEN $2='FAILED' THEN next_run_at
          ELSE clock_timestamp()+($4::int * interval '1 second') END
        WHERE id=$1 AND status='LEASED' AND lease_token=$5
          AND lease_until>clock_timestamp() RETURNING next_run_at`,
      [
        claim.jobId,
        failed ? "FAILED" : "READY",
        `TECHNICAL:${errorCode(failure)}`,
        backoff,
        claim.leaseToken,
      ],
    );
    if (!result.rows[0]) throw new StaleLease();
    return {
      status: failed ? "FAILED" : "RETRY",
      jobId: claim.jobId,
      attempts: job.attempts,
      ...(failed ? {} : { retryAt: result.rows[0].next_run_at.toISOString() }),
    };
  }).catch((error) => {
    if (error instanceof StaleLease)
      return { status: "STALE", jobId: claim.jobId };
    throw error;
  });
}

/** Uses the same durable calendar settlement as foreground access. The token is
 * checked after account/cat locking and its original DB expiry before commit.
 */
export async function runClaimedCloudJob(
  claim: CloudJobClaim,
): Promise<CloudJobOutcome> {
  assertInternal();
  try {
    return await transaction(async (db) => {
      await boundedTransaction(db);
      const cat = await activeCat(db, claim);
      if (!cat) return { status: "INACTIVE", jobId: claim.jobId };
      if (cat.catId !== claim.catId) throw new StaleLease();
      const job = await ownedLease(db, claim);
      if (!job) throw new StaleLease();
      await settleCloudCalendar(db, cat);
      // Settlement clears the persisted lease. Check the previously locked DB
      // value rather than trusting expiry supplied by the caller.
      const completed = await db.query(
        "SELECT status,lease_token,lease_until FROM cloud_jobs WHERE id=$1",
        [claim.jobId],
      );
      const after = completed.rows[0];
      if (
        !after ||
        !["READY", "COMPLETE"].includes(after.status) ||
        after.lease_token !== null ||
        after.lease_until !== null
      )
        throw new Error("Calendar settlement did not finish the job");
      const validity = await db.query(
        "SELECT clock_timestamp()<$1::timestamptz AS valid",
        [job.lease_until],
      );
      if (!validity.rows[0].valid) throw new StaleLease();
      return { status: "SETTLED", jobId: claim.jobId, attempts: job.attempts };
    });
  } catch (error) {
    if (error instanceof StaleLease)
      return { status: "STALE", jobId: claim.jobId };
    // If DB access is unavailable, this recording also fails: propagate the
    // infrastructure error, keep the durable lease and recover after its expiry.
    return recordFailure(claim, error);
  }
}

export async function runCloudWorkerOnce(): Promise<
  CloudJobOutcome | { status: "IDLE" }
> {
  const claim = await claimCloudJob();
  return claim ? runClaimedCloudJob(claim) : { status: "IDLE" };
}
