// Disposable loopback databases only. Database dumps, exported bodies, OTP and
// cookies are private temporary material, never evidence or CI artifacts.
import {
  readFile,
  mkdir,
  mkdtemp,
  writeFile,
  rm,
  realpath,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { parse } from "dotenv";
import pg from "pg";
const args = process.argv.slice(2),
  value = (name) => args[args.indexOf(name) + 1],
  apiOnly = args.includes("--api-only");
if (args.includes("--env-file") === args.includes("--from-env"))
  throw Error("Choose --env-file or --from-env");
const config = args.includes("--from-env")
  ? process.env
  : parse(await readFile(value("--env-file"), "utf8"));
const source = new URL(config.DATABASE_URL);
if (!["127.0.0.1", "localhost", "[::1]"].includes(source.hostname))
  throw Error("Only loopback PostgreSQL allowed");
const names = [
  "catletters_e4_lifecycle_test",
  "catletters_e4_lifecycle_restore_test",
];
const urls = names.map((name) => {
  const u = new URL(source);
  u.pathname = `/${name}`;
  return u;
});
const adminUrl = new URL(source);
adminUrl.pathname = "/postgres";
const evidence = resolve(
  args.includes("--evidence-dir")
    ? value("--evidence-dir")
    : ".local/e4-lifecycle-evidence",
);
await mkdir(evidence, { recursive: true });
const privateDir = await realpath(
  await mkdtemp(join(tmpdir(), "catletters-e4-lifecycle-")),
);
const lifecycleDir = join(privateDir, "lifecycle"),
  mailbox = join(privateDir, "mailbox"),
  fixture = join(privateDir, "restore-fixture.json");
await mkdir(lifecycleDir, { mode: 0o700 });
await mkdir(mailbox, { mode: 0o700 });
const env = {
  ...process.env,
  ...config,
  DATABASE_URL: urls[0].href,
  APP_MODE: "INTERNAL",
  SAFETY_ADAPTER: "synthetic-v1",
  OTP_ADAPTER: "synthetic-v1",
  OTP_HASH_SECRET: randomBytes(32).toString("hex"),
  E4_LEDGER_SECRET: randomBytes(32).toString("hex"),
  E4_LIFECYCLE_DIR: lifecycleDir,
  E4_LIFECYCLE_BOOTSTRAP: "true",
  E4_SYNTHETIC_MAILBOX_DIR: mailbox,
  E4_SYNTHETIC_INBOX: mailbox,
  E4_EVIDENCE_DIR: evidence,
  E4_RESTORE_FIXTURE: fixture,
  COOKIE_SECURE: "false",
};
const admin = new pg.Client({ connectionString: adminUrl.href });
let server,
  log = "E4-C synthetic loopback lifecycle and restore test\n",
  passed = false,
  browserExecuted = false,
  databaseReached = false,
  httpReached = false;
const steps = [];
function safe(s) {
  return String(s)
    .replace(
      /(?:lifecycle|synthetic)-[^\s"'<>]+@example\.test/g,
      "[synthetic-email]",
    )
    .replace(/PRIVATE-[a-zA-Z0-9-]+/g, "[private-marker]")
    .replace(
      /(code|rawToken|cookie|password|secret)(["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      "$1$2[redacted]",
    );
}
function append(s) {
  const v = safe(s);
  log += v;
  process.stdout.write(v);
}
async function run(
  argv,
  command = process.execPath,
  extra = {},
  label = argv.join(" "),
) {
  const p = spawn(command, argv, {
    env: { ...env, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", append);
  p.stderr.on("data", append);
  const code = await new Promise((resolve, reject) => {
    p.once("error", reject);
    p.once("exit", resolve);
  });
  steps.push({ label, exitCode: code });
  if (code !== 0) throw Error(`${label} failed (${code})`);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const current = server;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      current.kill("SIGKILL");
      resolve();
    }, 5000);
    current.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    current.kill("SIGTERM");
  });
  server = undefined;
}
async function start(extra = {}) {
  const actual = { ...env, ...extra };
  server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      new URL(env.APP_ORIGIN).port,
    ],
    { env: actual, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout.on("data", (d) => append(`[HTTP] ${d}`));
  server.stderr.on("data", (d) => append(`[HTTP] ${d}`));
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw Error("Next exited before readiness");
    try {
      const r = await fetch(`${env.APP_ORIGIN}/api/health`, {
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) return;
      if (
        r.status === 503 &&
        /no-store/.test(r.headers.get("cache-control") ?? "")
      ) {
        const body = await r.json();
        if (typeof body.error === "string") return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error("HTTP readiness timeout");
}
async function reset(url, name) {
  const c = new pg.Client({ connectionString: url.href });
  await c.connect();
  try {
    if (
      (await c.query("SELECT current_database() AS name")).rows[0].name !== name
    )
      throw Error("Unexpected test database");
    await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  } finally {
    await c.end();
  }
}
function pgEnv(url) {
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  };
}
const dumpBin = config.PG_DUMP_BIN || process.env.PG_DUMP_BIN || "pg_dump",
  restoreBin =
    config.PG_RESTORE_BIN || process.env.PG_RESTORE_BIN || "pg_restore";
const backupMetadata = [];
try {
  await admin.connect();
  await admin.query("SELECT pg_advisory_lock(74041011)");
  for (let i = 0; i < names.length; i++) {
    if (
      !(
        await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [
          names[i],
        ])
      ).rowCount
    )
      await admin.query(`CREATE DATABASE ${names[i]}`);
    await reset(urls[i], names[i]);
  }
  databaseReached = true;
  await run(["--import", "tsx", "scripts/migrate.ts"]);
  await run(["--import", "tsx", "scripts/migrate.ts"]);
  const port = await new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
  env.APP_ORIGIN = `http://127.0.0.1:${port}`;
  env.E4_TEST_ORIGIN = env.APP_ORIGIN;
  env.VITE_ACCOUNT_APP_URL = `${env.APP_ORIGIN}/account-app/`;
  env.VITE_LEGACY_SOURCE_ORIGINS = "http://127.0.0.1:18995";
  if (!apiOnly) await run(["run", "account:build"], "npm");
  await start();
  const closed = await fetch(`${env.APP_ORIGIN}/api/e4/account`);
  httpReached = true;
  if (closed.status !== 503)
    throw Error("New lifecycle gate did not fail closed");
  await run(["--import", "tsx", "scripts/lifecycle.ts", "reconcile"]);
  env.E4_LIFECYCLE_BOOTSTRAP = "false";
  await run([
    "--import",
    "tsx",
    "--test",
    "tests/e4-lifecycle/lifecycle.test.ts",
    "tests/e4-lifecycle-directory.test.ts",
  ]);
  if (!apiOnly) {
    browserExecuted = true;
    await run([
      "node_modules/@playwright/test/cli.js",
      "test",
      "--config",
      "playwright.e4-lifecycle.config.ts",
    ]);
  }
  await run([
    "--import",
    "tsx",
    "tests/e4-lifecycle/restore-fixture.ts",
    "seed",
  ]);
  const before = join(privateDir, "before-deletion.dump"),
    after = join(privateDir, "after-deletion.dump");
  await run(
    ["--format=custom", "--no-owner", "--no-acl", "--file", before],
    dumpBin,
    pgEnv(urls[0]),
    "pg_dump before deletion",
  );
  await chmod(before, 0o600);
  await run([
    "--import",
    "tsx",
    "tests/e4-lifecycle/restore-fixture.ts",
    "delete",
  ]);
  await run(
    ["--format=custom", "--no-owner", "--no-acl", "--file", after],
    dumpBin,
    pgEnv(urls[0]),
    "pg_dump after deletion and new account",
  );
  await chmod(after, 0o600);
  await stop();
  for (const [variant, dump] of [
    ["old", before],
    ["new", after],
  ]) {
    const content = await readFile(dump);
    backupMetadata.push({
      variant,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: content.length,
    });
    // The production restore lock is outside PostgreSQL and survives pg_restore.
    await run(
      ["--import", "tsx", "scripts/lifecycle.ts", "restore-lock"],
      process.execPath,
      {},
      `restore-lock ${variant}`,
    );
    await reset(urls[1], names[1]);
    await run(
      ["--no-owner", "--no-acl", "--exit-on-error", "--dbname", names[1], dump],
      restoreBin,
      pgEnv(urls[1]),
      `pg_restore ${variant}`,
    );
    const extra = {
      DATABASE_URL: urls[1].href,
      E4_LIFECYCLE_BOOTSTRAP: "false",
      E4_RESTORE_VARIANT: variant,
    };
    await start(extra);
    await run(
      ["--import", "tsx", "--test", "tests/e4-lifecycle/restore.test.ts"],
      process.execPath,
      extra,
      `restore behavior ${variant}`,
    );
    await stop();
  }
  await start({
    APP_MODE: "PUBLIC",
    DATABASE_URL: urls[1].href,
    E4_LIFECYCLE_BOOTSTRAP: "false",
  });
  const publicResponse = await fetch(
    `${env.APP_ORIGIN}/api/e4/privacy/exports`,
  );
  if (publicResponse.status !== 503)
    throw Error("PUBLIC lifecycle HTTP guard failed");
  append("PUBLIC lifecycle HTTP 503 PASS\n");
  passed = true;
} catch (e) {
  append(`E4-C FAIL: ${e.message}\n`);
  process.exitCode = 1;
} finally {
  await stop();
  await admin.end();
  await rm(privateDir, { recursive: true, force: true });
  await writeFile(join(evidence, "test.log"), log);
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        status: passed ? "PASS" : "FAIL",
        timestamp: new Date().toISOString(),
        databases: names,
        steps,
        backupMetadata,
        browserExecuted,
        realPostgres: databaseReached,
        realHttp: httpReached,
        realPgDumpRestore: steps.some(
          (step) => step.label.startsWith("pg_restore ") && step.exitCode === 0,
        ),
        syntheticOtp: true,
        actualEmailSent: false,
        naturalTimeEvidence: false,
        privateFilesRemoved: true,
        deviceCoverage:
          "isolated Chromium only; no real device or production deployment",
        node: process.version,
      },
      null,
      2,
    ),
  );
}
