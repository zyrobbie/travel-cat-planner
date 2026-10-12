import "dotenv/config";
import { pool } from "../src/server/db";
import { assertInternal } from "../src/server/safety";
import {
  reconcileLifecycle,
  runDeletionWorkerOnce,
} from "../src/server/account-lifecycle";
import {
  closeLifecycleForRestore,
  assertLifecycleReady,
} from "../src/server/lifecycle-ledger";
import {
  runExportWorkerOnce,
  cleanupAccountExports,
} from "../src/server/account-export";
try {
  assertInternal();
  const command = process.argv[2];
  if (command === "reconcile")
    console.log(JSON.stringify(await reconcileLifecycle()));
  else if (command === "restore-lock")
    console.log(JSON.stringify(await closeLifecycleForRestore()));
  else if (command === "check") {
    await assertLifecycleReady();
    console.log(JSON.stringify({ ready: true }));
  } else if (command === "tick") {
    await assertLifecycleReady();
    console.log(
      JSON.stringify({
        deletion: await runDeletionWorkerOnce(),
        export: await runExportWorkerOnce(),
        cleanup: await cleanupAccountExports(),
      }),
    );
  } else
    throw new Error(
      "Usage: tsx scripts/lifecycle.ts reconcile|restore-lock|check|tick",
    );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Lifecycle operation failed",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
