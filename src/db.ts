import pg from "pg";

const { Pool } = pg;

let _pool: pg.Pool | null = null;

/**
 * Shared Postgres pool for the process. Use this instead of creating per-module pools.
 * Tests can inject a pool via the optional parameter on each module's functions.
 * Pool 'error' is handled so that idle connection drops do not crash the process.
 */
export function getPool(): pg.Pool {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    _pool = new Pool({
      connectionString: url,
      max: 15,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    _pool.on("error", (err) => {
      console.error("[db] pool error (connection lost; new queries may reconnect):", err.message);
    });
  }
  return _pool;
}

/** Test only: reset the shared pool (e.g. to inject a mock). */
export function _resetPoolForTest(): void {
  if (_pool) {
    _pool.end().catch(() => {});
    _pool = null;
  }
}
