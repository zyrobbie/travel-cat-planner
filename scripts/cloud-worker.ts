import "dotenv/config";
import { pool } from "../src/server/db";
import { assertInternal } from "../src/server/safety";
import {
  cloudWorkerErrorCode,
  runCloudWorkerOnce,
} from "../src/server/cloud-worker";

const args = process.argv.slice(2);
const once = args.length === 1 && args[0] === "--once";
if (args.length && !once)
  throw new Error("Usage: node --import tsx scripts/cloud-worker.ts [--once]");
const pollMs = Number(process.env.CLOUD_WORKER_POLL_MS ?? 1000);
if (!Number.isInteger(pollMs) || pollMs < 100 || pollMs > 60000)
  throw new Error("CLOUD_WORKER_POLL_MS must be an integer from 100 to 60000");

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

let consecutiveErrors = 0;
try {
  assertInternal();
  while (!stopping) {
    try {
      const result = await runCloudWorkerOnce();
      consecutiveErrors = 0;
      if (once || result.status !== "IDLE") console.log(JSON.stringify(result));
      if (once) {
        if (result.status === "FAILED" || result.status === "RETRY")
          process.exitCode = 1;
        break;
      }
      if (result.status === "IDLE") await delay(pollMs);
    } catch (error) {
      consecutiveErrors++;
      console.error(
        JSON.stringify({
          status: "INFRASTRUCTURE_ERROR",
          code: cloudWorkerErrorCode(error),
          consecutiveErrors,
        }),
      );
      if (once || consecutiveErrors >= 5) {
        process.exitCode = 1;
        break;
      }
      await delay(Math.min(60000, 1000 * 2 ** (consecutiveErrors - 1)));
    }
  }
} catch (error) {
  console.error(
    JSON.stringify({
      status: "CONFIGURATION_ERROR",
      code: cloudWorkerErrorCode(error),
    }),
  );
  process.exitCode = 1;
} finally {
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  await pool.end();
}
