import pg from "pg";
import type { FinalitySnapshot } from "./finalityEvaluator.js";

const { Pool } = pg;

let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required for semantic graph");
    _pool = new Pool({ connectionString: url, max: 5 });
  }
  return _pool;
}

export interface SemanticNode {
  node_id: string;
  scope_id: string;
  type: string;
  content: string;
  confidence: number;
  status: string;
  source_ref: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  version: number;
}

export interface SemanticEdge {
  edge_id: string;
  scope_id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  weight: number;
  metadata: Record<string, unknown>;
  created_at: string;
  created_by: string | null;
}

export interface AppendNodeInput {
  scope_id: string;
  type: string;
  content: string;
  confidence?: number;
  status?: string;
  source_ref?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  created_by?: string;
  embedding?: number[] | null;
}

type Queryable = pg.Pool | pg.PoolClient;

export async function runInTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
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

/** Delete nodes (and their edges via FK CASCADE) by scope and created_by. Returns deleted count. */
export async function deleteNodesBySource(
  scopeId: string,
  createdBy: string,
  client?: pg.PoolClient,
): Promise<number> {
  const q = client ?? getPool();
  const res = await q.query(
    "DELETE FROM nodes WHERE scope_id = $1 AND created_by = $2",
    [scopeId, createdBy],
  );
  return res.rowCount ?? 0;
}

export async function appendNode(
  input: AppendNodeInput,
  client?: pg.PoolClient,
): Promise<string> {
  const p: Queryable = client ?? getPool();
  const embeddingParam =
    input.embedding && input.embedding.length > 0
      ? `[${input.embedding.join(",")}]`
      : null;
  const res = await p.query(
    `INSERT INTO nodes (scope_id, type, content, confidence, status, source_ref, metadata, created_by, embedding)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::vector)
     RETURNING node_id`,
    [
      input.scope_id,
      input.type,
      input.content,
      input.confidence ?? 1.0,
      input.status ?? "active",
      JSON.stringify(input.source_ref ?? {}),
      JSON.stringify(input.metadata ?? {}),
      input.created_by ?? null,
      embeddingParam,
    ],
  );
  return res.rows[0].node_id;
}

export interface AppendEdgeInput {
  scope_id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  weight?: number;
  metadata?: Record<string, unknown>;
  created_by?: string;
}

export async function appendEdge(
  input: AppendEdgeInput,
  client?: pg.PoolClient,
): Promise<string> {
  const p: Queryable = client ?? getPool();
  const res = await p.query(
    `INSERT INTO edges (scope_id, source_id, target_id, edge_type, weight, metadata, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING edge_id`,
    [
      input.scope_id,
      input.source_id,
      input.target_id,
      input.edge_type,
      input.weight ?? 1.0,
      JSON.stringify(input.metadata ?? {}),
      input.created_by ?? null,
    ],
  );
  return res.rows[0].edge_id;
}

export interface QueryNodesOptions {
  scope_id: string;
  type?: string;
  status?: string;
  limit?: number;
}

export async function queryNodes(opts: QueryNodesOptions): Promise<SemanticNode[]> {
  const p = getPool();
  const conditions: string[] = ["scope_id = $1"];
  const params: unknown[] = [opts.scope_id];
  let i = 2;
  if (opts.type) {
    conditions.push(`type = $${i++}`);
    params.push(opts.type);
  }
  if (opts.status) {
    conditions.push(`status = $${i++}`);
    params.push(opts.status);
  }
  const limit = Math.min(opts.limit ?? 500, 5000);
  params.push(limit);
  const res = await p.query(
    `SELECT node_id, scope_id, type, content, confidence, status, source_ref, metadata, created_at, updated_at, created_by, version
     FROM nodes WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC LIMIT $${i}`,
    params,
  );
  return res.rows.map((r) => ({
    node_id: r.node_id,
    scope_id: r.scope_id,
    type: r.type,
    content: r.content,
    confidence: Number(r.confidence),
    status: r.status,
    source_ref: (r.source_ref as Record<string, unknown>) ?? {},
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: r.created_by,
    version: Number(r.version),
  }));
}

export interface QueryEdgesOptions {
  scope_id: string;
  edge_type?: string;
  source_id?: string;
  target_id?: string;
  limit?: number;
}

export async function queryEdges(opts: QueryEdgesOptions): Promise<SemanticEdge[]> {
  const p = getPool();
  const conditions: string[] = ["scope_id = $1"];
  const params: unknown[] = [opts.scope_id];
  let i = 2;
  if (opts.edge_type) {
    conditions.push(`edge_type = $${i++}`);
    params.push(opts.edge_type);
  }
  if (opts.source_id) {
    conditions.push(`source_id = $${i++}`);
    params.push(opts.source_id);
  }
  if (opts.target_id) {
    conditions.push(`target_id = $${i++}`);
    params.push(opts.target_id);
  }
  const limit = Math.min(opts.limit ?? 500, 5000);
  params.push(limit);
  const res = await p.query(
    `SELECT edge_id, scope_id, source_id, target_id, edge_type, weight, metadata, created_at, created_by
     FROM edges WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC LIMIT $${i}`,
    params,
  );
  return res.rows.map((r) => ({
    edge_id: r.edge_id,
    scope_id: r.scope_id,
    source_id: r.source_id,
    target_id: r.target_id,
    edge_type: r.edge_type,
    weight: Number(r.weight),
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    created_at: r.created_at,
    created_by: r.created_by,
  }));
}

/**
 * Single-query aggregation for finality evaluation. Returns scope-level aggregates.
 */
export async function loadFinalitySnapshot(scopeId: string): Promise<FinalitySnapshot> {
  const p = getPool();
  const nodeRes = await p.query(
    `SELECT
       COALESCE(MIN(confidence) FILTER (WHERE type = 'claim' AND status = 'active'), 1) AS claims_active_min_confidence,
       COUNT(*) FILTER (WHERE type = 'claim' AND status = 'active')::int AS claims_active_count,
       COALESCE(AVG(confidence) FILTER (WHERE type = 'claim' AND status = 'active'), 1)::float AS claims_active_avg_confidence,
       COUNT(*) FILTER (WHERE type = 'risk' AND status = 'active' AND (metadata->>'severity') = 'critical')::int AS risks_critical_active_count
     FROM nodes WHERE scope_id = $1`,
    [scopeId],
  );
  const row = nodeRes.rows[0] ?? {};

  const goalRes = await p.query(
    `SELECT
       COUNT(*) FILTER (WHERE type = 'goal' AND status = 'resolved')::int AS resolved,
       COUNT(*) FILTER (WHERE type = 'goal')::int AS total
     FROM nodes WHERE scope_id = $1`,
    [scopeId],
  );
  const goalRow = goalRes.rows[0] ?? {};
  const goalsTotal = Number(goalRow.total ?? 0);
  const goalsCompletionRatio = goalsTotal === 0 ? 1 : Number(goalRow.resolved ?? 0) / goalsTotal;

  const assessmentRes = await p.query(
    `SELECT COALESCE(SUM((metadata->>'risk_delta')::float), 0)::float AS risk_score
     FROM nodes WHERE scope_id = $1 AND type = 'assessment' AND status = 'active'`,
    [scopeId],
  );
  const scopeRiskScore = Math.min(1, Math.max(0, Number(assessmentRes.rows[0]?.risk_score ?? 0)));

  const contraRes = await p.query(
    `SELECT COUNT(*)::int AS total FROM edges WHERE scope_id = $1 AND edge_type = 'contradicts'`,
    [scopeId],
  );
  const contradictionsTotal = Number(contraRes.rows[0]?.total ?? 0);

  const unresolvedRes = await p.query(
    `SELECT COUNT(*)::int AS c FROM edges e
     WHERE e.scope_id = $1 AND e.edge_type = 'contradicts'
     AND NOT EXISTS (SELECT 1 FROM edges r WHERE r.scope_id = e.scope_id AND r.edge_type = 'resolves' AND (r.target_id = e.source_id OR r.target_id = e.target_id))`,
    [scopeId],
  );
  const contradictionsUnresolved = Number(unresolvedRes.rows[0]?.c ?? contradictionsTotal);

  return {
    claims_active_min_confidence: Number(row.claims_active_min_confidence ?? 1),
    claims_active_count: Number(row.claims_active_count ?? 0),
    claims_active_avg_confidence: Number(row.claims_active_avg_confidence ?? 1),
    contradictions_unresolved_count: contradictionsUnresolved,
    contradictions_total_count: contradictionsTotal,
    risks_critical_active_count: Number(row.risks_critical_active_count ?? 0),
    goals_completion_ratio: goalsCompletionRatio,
    scope_risk_score: scopeRiskScore,
  };
}

/**
 * Insert a single goal node for a user resolution so finality's goals_completion_ratio can increase.
 * Content uses summary or a truncated decision; status is "resolved", created_by "resolution".
 */
export async function appendResolutionGoal(
  scopeId: string,
  decision: string,
  summary: string,
  client?: pg.PoolClient,
): Promise<string> {
  const content = summary.trim() || decision.trim().slice(0, 500);
  return appendNode(
    {
      scope_id: scopeId,
      type: "goal",
      content,
      confidence: 1.0,
      status: "resolved",
      source_ref: { source: "resolution", decision_preview: decision.trim().slice(0, 200) },
      metadata: {},
      created_by: "resolution",
    },
    client,
  );
}

/** Lightweight counts by type for feed / state graph display. */
export async function getGraphSummary(scopeId: string): Promise<{ nodes: Record<string, number>; edges: Record<string, number> }> {
  const p = getPool();
  const nodeRes = await p.query(
    `SELECT type, COUNT(*)::int AS c FROM nodes WHERE scope_id = $1 GROUP BY type`,
    [scopeId],
  );
  const nodes: Record<string, number> = {};
  for (const r of nodeRes.rows) nodes[String(r.type)] = Number(r.c ?? 0);

  const edgeRes = await p.query(
    `SELECT edge_type, COUNT(*)::int AS c FROM edges WHERE scope_id = $1 GROUP BY edge_type`,
    [scopeId],
  );
  const edges: Record<string, number> = {};
  for (const r of edgeRes.rows) edges[String(r.edge_type)] = Number(r.c ?? 0);

  return { nodes, edges };
}
