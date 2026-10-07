// Only a disposable, explicitly named loopback database may be reset by this harness.
import { readFile, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { parse } from "dotenv";
import pg from "pg";

const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
if (args.includes("--env-file") === args.includes("--from-env")) {
  throw Error(
    "Choose --env-file <local ignored .env> or --from-env (CI), not both",
  );
}
const values = args.includes("--from-env")
  ? process.env
  : parse(await readFile(value("--env-file"), "utf8"));
const source = new URL(values.DATABASE_URL);
if (!["127.0.0.1", "localhost", "[::1]"].includes(source.hostname))
  throw Error("Only loopback PostgreSQL is allowed");
const target = new URL(source);
target.pathname = "/catletters_e4_cloud_test";
const adminUrl = new URL(source);
adminUrl.pathname = "/postgres";
const evidence = resolve(
  args.includes("--evidence-dir")
    ? value("--evidence-dir")
    : ".local/e4-cloud-evidence",
);
await mkdir(evidence, { recursive: true });
const mailbox = await mkdtemp(join(tmpdir(), "catletters-e4-cloud-mailbox-"));
const env = {
  ...process.env,
  ...values,
  DATABASE_URL: target.href,
  APP_MODE: "INTERNAL",
  SAFETY_ADAPTER: "synthetic-v1",
  OTP_ADAPTER: "synthetic-v1",
  OTP_HASH_SECRET: randomBytes(32).toString("hex"),
  E4_SYNTHETIC_MAILBOX_DIR: mailbox,
  COOKIE_SECURE: "true",
};
let log = "E4-B1 isolated PostgreSQL test database: catletters_e4_cloud_test\n";
const admin = new pg.Client({ connectionString: adminUrl.href });
let server;
const append = (data) => {
  const s = data.toString();
  log += s;
  process.stdout.write(s);
};
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await new Promise((done) => {
    const timer = setTimeout(() => {
      server.kill("SIGKILL");
      done();
    }, 5000);
    server.once("exit", () => {
      clearTimeout(timer);
      done();
    });
  });
}
async function run(argv) {
  const child = spawn(process.execPath, argv, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const code = await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("exit", accept);
  });
  if (code !== 0)
    throw Error(`Command failed (${code}): node ${argv.join(" ")}`);
}
let passed = false;
try {
  await admin.connect();
  await admin.query("SELECT pg_advisory_lock(74041008)");
  const exists = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname='catletters_e4_cloud_test'",
  );
  if (!exists.rowCount)
    await admin.query("CREATE DATABASE catletters_e4_cloud_test");
  const testDb = new pg.Client({ connectionString: target.href });
  await testDb.connect();
  try {
    const name = (await testDb.query("SELECT current_database() AS name"))
      .rows[0].name;
    if (name !== "catletters_e4_cloud_test")
      throw Error("Refusing to reset an unexpected database");
    await testDb.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  } finally {
    await testDb.end();
  }
  await run(["node_modules/tsx/dist/cli.mjs", "scripts/migrate.ts"]);
  await run(["node_modules/tsx/dist/cli.mjs", "scripts/migrate.ts"]);
  const port = await new Promise((accept, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const port = socket.address().port;
      socket.close(() => accept(port));
    });
  });
  env.APP_ORIGIN = `http://127.0.0.1:${port}`;
  env.E4_TEST_ORIGIN = env.APP_ORIGIN;
  server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout.on("data", (data) => append(`[INTERNAL HTTP] ${data}`));
  server.stderr.on("data", (data) => append(`[INTERNAL HTTP] ${data}`));
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null)
      throw Error("Isolated Next server exited before readiness");
    try {
      const response = await fetch(`${env.APP_ORIGIN}/api/health`, {
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((done) => setTimeout(done, 500));
  }
  if (!ready) throw Error("Isolated HTTP server did not become ready");
  await run([
    "node_modules/tsx/dist/cli.mjs",
    "--test",
    "tests/e4/cloud-content.test.ts",
    "tests/e4/cloud-mailbox.test.ts",
  ]);
  await run([
    "node_modules/tsx/dist/cli.mjs",
    "--test",
    "tests/integration.test.ts",
  ]);
  await stopServer();
  server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      env: { ...env, APP_MODE: "PUBLIC" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout.on("data", (data) => append(`[PUBLIC HTTP] ${data}`));
  server.stderr.on("data", (data) => append(`[PUBLIC HTTP] ${data}`));
  let guardResponse;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null)
      throw Error("Guard-test server exited before readiness");
    try {
      guardResponse = await fetch(`${env.APP_ORIGIN}/api/e4/v1/state`, {
        method: "GET",
        signal: AbortSignal.timeout(10000),
      });
      break;
    } catch {}
    await new Promise((done) => setTimeout(done, 500));
  }
  if (
    guardResponse?.status !== 503 ||
    (await guardResponse.json()).error !== "服务暂不可用，请稍后再试。"
  ) {
    throw Error("PUBLIC-mode E4 HTTP guard did not reject");
  }
  append(
    "B1 PUBLIC-mode real HTTP guard PASS: received status=503 and expected error JSON\n",
  );
  passed = true;
} catch (error) {
  append(`E4-B1 FAIL: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await stopServer();
  await admin.end();
  await rm(mailbox, { recursive: true, force: true });
  log += `E4-B1 ${passed ? "PASS" : "FAIL"}; private synthetic OTP files removed\n`;
  await writeFile(join(evidence, "test.log"), log);
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        status: passed ? "PASS" : "FAIL",
        timestamp: new Date().toISOString(),
        database: "catletters_e4_cloud_test",
        realPostgres: true,
        realHttp: true,
        deviceCoverage:
          "Two HTTP API cookie jars; no browser rendering or real-device claim",
        syntheticOtp: true,
        actualEmailSent: false,
        naturalTimeEvidence: false,
        testBoundary:
          "Synthetic fixtures inserted only into the disposable database; no browser UI, worker or cloud-host acceptance",
        node: process.version,
      },
      null,
      2,
    ),
  );
}
