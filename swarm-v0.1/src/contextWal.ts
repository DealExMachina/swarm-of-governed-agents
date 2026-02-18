import pg from "pg";

const { Pool } = pg;

export interface ContextEvent {
  seq: number;
  ts: string;
  data: Record<string, unknown>;
}

let _pool: pg.Pool | null = null;
let _tableEnsured = false;

function getPool(): pg.Pool {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required for context WAL");
    _pool = new Pool({ connectionString: url, max: 5 });
  }
  return _pool;
}

export function _resetTableEnsured(): void {
  _tableEnsured = false;
}

export async function ensureContextTable(pool?: pg.Pool): Promise<void> {
  if (_tableEnsured) return;
  const p = pool ?? getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS context_events (
      seq  BIGSERIAL PRIMARY KEY,
      ts   TIMESTAMPTZ NOT NULL DEFAULT now(),
      data JSONB NOT NULL
    )
  `);
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_context_events_ts ON context_events (ts)",
  );
  _tableEnsured = true;
}

export async function appendEvent(
  data: Record<string, unknown>,
  pool?: pg.Pool,
): Promise<number> {
  const p = pool ?? getPool();
  await ensureContextTable(p);
  const res = await p.query(
    "INSERT INTO context_events (data) VALUES ($1::jsonb) RETURNING seq",
    [JSON.stringify(data)],
  );
  return parseInt(res.rows[0].seq, 10);
}

export async function tailEvents(
  limit: number = 200,
  pool?: pg.Pool,
): Promise<ContextEvent[]> {
  const p = pool ?? getPool();
  await ensureContextTable(p);
  const res = await p.query(
    "SELECT seq, ts, data FROM context_events ORDER BY seq DESC LIMIT $1",
    [limit],
  );
  return res.rows
    .map((r: any) => ({
      seq: parseInt(r.seq, 10),
      ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
      data: typeof r.data === "string" ? JSON.parse(r.data) : r.data,
    }))
    .reverse();
}

export async function eventsSince(
  afterSeq: number,
  limit: number = 1000,
  pool?: pg.Pool,
): Promise<ContextEvent[]> {
  const p = pool ?? getPool();
  await ensureContextTable(p);
  const res = await p.query(
    "SELECT seq, ts, data FROM context_events WHERE seq > $1 ORDER BY seq ASC LIMIT $2",
    [afterSeq, limit],
  );
  return res.rows.map((r: any) => ({
    seq: parseInt(r.seq, 10),
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
    data: typeof r.data === "string" ? JSON.parse(r.data) : r.data,
  }));
}
