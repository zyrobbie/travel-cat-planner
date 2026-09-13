// Requires PostgreSQL's initdb/pg_ctl/psql executables on PATH. Credentials never printed.
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";
mkdirSync(".local", { recursive: true });
if (!existsSync(".env")) {
  const password = randomBytes(24).toString("hex");
  writeFileSync(".local/db-password", password, { mode: 0o600 });
  writeFileSync(
    ".env",
    `DATABASE_URL=postgresql://catletters:${password}@127.0.0.1:55432/catletters\nAPP_ORIGIN=http://127.0.0.1:3100\nADMIN_SECRET=${randomBytes(32).toString("hex")}\nAPP_MODE=INTERNAL\nSAFETY_ADAPTER=synthetic-v1\nCOOKIE_SECURE=false\n`,
    { mode: 0o600 },
  );
}
function run(cmd, args) {
  const p = spawnSync(cmd, args, { stdio: "inherit" });
  if (p.error) throw p.error;
  if (p.status !== 0) throw Error(`${cmd} failed`);
}
if (!existsSync(".local/postgres/PG_VERSION")) {
  if (!existsSync(".local/db-password"))
    throw Error(
      "Existing .env: configure DATABASE_URL or initialize PostgreSQL yourself; will not overwrite credentials.",
    );
  run("initdb", [
    "-D",
    ".local/postgres",
    "-U",
    "catletters",
    "--pwfile=.local/db-password",
    "--auth=scram-sha-256",
    "--encoding=UTF8",
    "--locale=C",
  ]);
}
const status = spawnSync("pg_ctl", ["-D", ".local/postgres", "status"], {
  stdio: "ignore",
});
if (status.status !== 0)
  run("pg_ctl", [
    "-D",
    ".local/postgres",
    "-l",
    ".local/postgres.log",
    "-o",
    "-h 127.0.0.1 -p 55432 -k /tmp",
    "start",
  ]);
const text = readFileSync(".env", "utf8");
const url = new URL(text.match(/^DATABASE_URL=(.+)$/m)[1]);
url.pathname = "/postgres";
const client = new pg.Client({ connectionString: url.href });
await client.connect();
if (
  !(await client.query("SELECT 1 FROM pg_database WHERE datname='catletters'"))
    .rowCount
)
  await client.query("CREATE DATABASE catletters");
await client.end();
console.log(
  "Local PostgreSQL ready. Credentials remain in ignored .env and .local.",
);
