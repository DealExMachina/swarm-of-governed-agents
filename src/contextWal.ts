import pg from "pg";
import { getPool } from "./db.js";

export interface ContextEvent {
  seq: number;
  ts: string;
  data: Record<string, unknown>;
}

let _tableEnsured = false;

export function _resetTableEnsured(): void {
  _tableEnsured = false;
}

const SCHEMA_REQUIRED_MSG =
  "Table context_events does not exist. Run schema migrations first (e.g. pnpm run ensure-schema or pnpm run swarm:all).";

export async function ensureContextTable(pool?: pg.Pool): Promise<void> {
  if (_tableEnsured) return;
  const p = pool ?? getPool();
  const res = await p.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'context_events'",
  );
  if ((res.rowCount ?? 0) === 0) {
    throw new Error(SCHEMA_REQUIRED_MSG);
  }
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

/** Event types that represent pipeline progress (new content/state). Used so governance rejections do not retrigger facts. */
const PIPELINE_EVENT_TYPES = [
  "bootstrap",
  "state_transition",
  "facts_extracted",
  "drift_analyzed",
  "actions_planned",
  "status_summarized",
];

/**
 * Event types that represent new context for the facts agent. Facts run only when one of these
 * appears in the WAL, so the loop suspends after a full cycle until new docs, bootstrap, or a manual resolution.
 */
const PIPELINE_EVENT_TYPES_FOR_FACTS = ["bootstrap", "context_doc", "resolution"];

/**
 * Returns the latest WAL seq among events that represent pipeline progress (not governance decisions).
 * Prevents proposal_rejected from retriggering the facts agent and causing a proposal loop.
 */
export async function getLatestPipelineWalSeq(pool?: pg.Pool): Promise<number> {
  const p = pool ?? getPool();
  await ensureContextTable(p);
  const placeholders = PIPELINE_EVENT_TYPES.map((_, i) => `$${i + 1}`).join(", ");
  const res = await p.query(
    `SELECT seq FROM context_events WHERE data->>'type' IN (${placeholders}) ORDER BY seq DESC LIMIT 1`,
    PIPELINE_EVENT_TYPES,
  );
  if (!res.rowCount || !res.rows[0]) return 0;
  return parseInt(res.rows[0].seq, 10);
}

/**
 * Latest WAL seq for facts agent only: only bootstrap and context_doc. Ensures the pipeline
 * runs when new context is added and suspends after a full cycle (no re-trigger on state_transition).
 */
export async function getLatestPipelineWalSeqForFacts(pool?: pg.Pool): Promise<number> {
  const p = pool ?? getPool();
  await ensureContextTable(p);
  const placeholders = PIPELINE_EVENT_TYPES_FOR_FACTS.map((_, i) => `$${i + 1}`).join(", ");
  const res = await p.query(
    `SELECT seq FROM context_events WHERE data->>'type' IN (${placeholders}) ORDER BY seq DESC LIMIT 1`,
    PIPELINE_EVENT_TYPES_FOR_FACTS,
  );
  if (!res.rowCount || !res.rows[0]) return 0;
  return parseInt(res.rows[0].seq, 10);
}
