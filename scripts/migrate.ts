import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pool, transaction } from "../src/server/db";
import { content, validateContent } from "../src/content/validate";
validateContent();
try {
  await transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(82109013)");
    await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const file of (await readdir("db/migrations"))
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(`db/migrations/${file}`, "utf8");
      const hash = createHash("sha256").update(sql).digest("hex");
      const old = await db.query(
        "SELECT checksum FROM schema_migrations WHERE version=$1",
        [file],
      );
      if (old.rows.length) {
        if (old.rows[0].checksum !== hash)
          throw Error(`Migration changed: ${file}`);
        continue;
      }
      await db.query(sql);
      await db.query(
        "INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",
        [file, hash],
      );
    }
    for (const item of content.items) {
      const old = await db.query(
        "SELECT checksum FROM content_versions WHERE id=$1",
        [item.id],
      );
      if (old.rows.length && old.rows[0].checksum !== item.sha256)
        throw Error(`Frozen content changed: ${item.id}`);
      await db.query(
        "INSERT INTO content_versions(id,version,type,payload,checksum) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING",
        [item.id, item.version, item.type, item, item.sha256],
      );
    }
  });
  console.log("Migrations + complete frozen content import PASS");
} finally {
  await pool.end();
}
