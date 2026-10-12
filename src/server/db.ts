import "dotenv/config";
import pg from "pg";
const globalDb = globalThis as unknown as { catPool?: pg.Pool };
export const pool =
  globalDb.catPool ??
  new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 8,
    connectionTimeoutMillis: 5000,
  });
if (process.env.NODE_ENV !== "production") globalDb.catPool = pool;
export async function transaction<T>(
  fn: (db: pg.PoolClient) => Promise<T>,
  options: { trustedMigration?: boolean } = {},
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    if (!options.trustedMigration) {
      const { guardLifecycleTransaction } = await import("./lifecycle-ledger");
      await guardLifecycleTransaction(db);
    }
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
