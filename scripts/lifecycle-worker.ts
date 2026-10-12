import "dotenv/config";
import { pool } from "../src/server/db";
import { assertInternal } from "../src/server/safety";
import { assertLifecycleReady } from "../src/server/lifecycle-ledger";
import { runDeletionWorkerOnce } from "../src/server/account-lifecycle";
import {
  runExportWorkerOnce,
  cleanupAccountExports,
} from "../src/server/account-export";
import { cloudWorkerErrorCode } from "../src/server/cloud-worker";

const args = process.argv.slice(2);
const once = args.length === 1 && args[0] === "--once";
if (args.length && !once)
  throw new Error(
    "Usage: node --import tsx scripts/lifecycle-worker.ts [--once]",
  );
const pollMs = Number(process.env.LIFECYCLE_WORKER_POLL_MS ?? 1000);
if (!Number.isInteger(pollMs) || pollMs < 500 || pollMs > 60000)
  throw new Error("LIFECYCLE_WORKER_POLL_MS must be between 500 and 60000");

let stopping = false;
let wake: (() => void) | undefined;
function stop() {
  stopping = true;
  wake?.();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
async function delay(ms: number) {
  if (stopping) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      wake = undefined;
      resolve();
    }
    wake = done;
  });
}

try {
  assertInternal();
  let failures = 0;
  while (!stopping) {
    try {
      // This worker must never clear the persistent restore lock or bootstrap a ledger.
      await assertLifecycleReady();
      const deletion = await runDeletionWorkerOnce();
      const exported = await runExportWorkerOnce();
      const cleanup = await cleanupAccountExports();
      failures = 0;
      if (once || deletion.status !== "IDLE" || exported.status !== "IDLE")
        console.log(
          JSON.stringify({
            deletion: deletion.status,
            export: exported.status,
            cleaned: cleanup.cleaned,
          }),
        );
      if (once) break;
      await delay(pollMs);
    } catch (error) {
      failures++;
      console.error(
        JSON.stringify({
          status: "LIFECYCLE_WORKER_ERROR",
          code: cloudWorkerErrorCode(error),
          failures,
        }),
      );
      if (once || failures >= 5) {
        process.exitCode = 1;
        break;
      }
      await delay(Math.min(60000, 1000 * 2 ** (failures - 1)));
    }
  }
} finally {
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  await pool.end();
}
