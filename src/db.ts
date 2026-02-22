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
      options: "-c statement_timeout=30000", // 30s max query time — prevents pool exhaustion
    });
    _pool.on("error", (err) => {
      console.error("[db] pool error (connection lost; new queries may reconnect):", err.message);
    });
  }
  return _pool;
}

/**
 * Drain and close the pool. Call this during graceful shutdown.
 * Safe to call multiple times.
 */
export async function drainPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/** Test only: reset the shared pool (e.g. to inject a mock). */
export function _resetPoolForTest(): void {
  if (_pool) {
    _pool.end().catch(() => {});
    _pool = null;
  }
}

/**
 * Run `fn` inside a Postgres transaction with proper ROLLBACK on error
 * and connection release in all cases. Shared across modules.
 */
export async function runInTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  pool?: pg.Pool,
): Promise<T> {
  const p = pool ?? getPool();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    const msg = e instanceof Error ? e.message : (e as Record<string, unknown>)?.message;
    const code = (e as Record<string, unknown>)?.code;
    throw new Error(`runInTransaction: ${msg ?? code ?? String(e)}`);
  } finally {
    client.release();
  }
}
