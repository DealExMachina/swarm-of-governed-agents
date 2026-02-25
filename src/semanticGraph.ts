import pg from "pg";
import type { FinalitySnapshot } from "./finalityEvaluator.js";
import { getPool } from "./db.js";

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
  /** Bitemporal: valid time interval (optional; null = atemporal). */
  valid_from?: string | null;
  valid_to?: string | null;
}

type Queryable = pg.Pool | pg.PoolClient;

/** Bitemporal "current" view: not superseded and (valid now or open-ended). Use in node/edge SELECTs when migration 011 is applied. */
const CURRENT_VIEW_NODES = "superseded_at IS NULL AND (valid_to IS NULL OR valid_to > now())";
const CURRENT_VIEW_EDGES = "superseded_at IS NULL AND (valid_to IS NULL OR valid_to > now())";

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
  const hasBitemporal = input.valid_from !== undefined || input.valid_to !== undefined;
  const validFrom = input.valid_from ?? null;
  const validTo = input.valid_to ?? null;
  if (hasBitemporal) {
    const res = await p.query(
      `INSERT INTO nodes (scope_id, type, content, confidence, status, source_ref, metadata, created_by, embedding, valid_from, valid_to)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::vector, $10::timestamptz, $11::timestamptz)
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
        validFrom,
        validTo,
      ],
    );
    return res.rows[0].node_id;
  }
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
  /** Bitemporal: valid time interval (optional; null = atemporal). */
  valid_from?: string | null;
  valid_to?: string | null;
}

export async function appendEdge(
  input: AppendEdgeInput,
  client?: pg.PoolClient,
): Promise<string> {
  const p: Queryable = client ?? getPool();
  const hasBitemporal = input.valid_from !== undefined || input.valid_to !== undefined;
  const validFrom = input.valid_from ?? null;
  const validTo = input.valid_to ?? null;
  if (hasBitemporal) {
    const res = await p.query(
      `INSERT INTO edges (scope_id, source_id, target_id, edge_type, weight, metadata, created_by, valid_from, valid_to)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz, $9::timestamptz)
       RETURNING edge_id`,
      [
        input.scope_id,
        input.source_id,
        input.target_id,
        input.edge_type,
        input.weight ?? 1.0,
        JSON.stringify(input.metadata ?? {}),
        input.created_by ?? null,
        validFrom,
        validTo,
      ],
    );
    return res.rows[0].edge_id;
  }
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

/**
 * Append-over-update: mark the current row as superseded (sets superseded_at).
 * Call this before inserting a new version of the same logical node.
 * No-op if the row is already superseded. Requires migration 011.
 */
export async function supersedeNode(
  scopeId: string,
  nodeId: string,
  client?: pg.PoolClient,
): Promise<number> {
  const q: Queryable = client ?? getPool();
  const res = await q.query(
    `UPDATE nodes SET superseded_at = now() WHERE scope_id = $1 AND node_id = $2 AND superseded_at IS NULL`,
    [scopeId, nodeId],
  );
  return res.rowCount ?? 0;
}

/**
 * Append-over-update: mark the current edge row as superseded.
 * Requires migration 011.
 */
export async function supersedeEdge(
  scopeId: string,
  edgeId: string,
  client?: pg.PoolClient,
): Promise<number> {
  const q: Queryable = client ?? getPool();
  const res = await q.query(
    `UPDATE edges SET superseded_at = now() WHERE scope_id = $1 AND edge_id = $2 AND superseded_at IS NULL`,
    [scopeId, edgeId],
  );
  return res.rowCount ?? 0;
}

export interface QueryNodesOptions {
  scope_id: string;
  type?: string;
  status?: string;
  limit?: number;
  /** Time-travel: as-of valid time (ISO). When set, only rows valid at this time. */
  asOfValidTime?: string;
  /** Time-travel: as-of transaction time (ISO). When set, only rows recorded and not superseded at this time. */
  asOfRecordedAt?: string;
}

function buildNodeViewCondition(opts: QueryNodesOptions, params: unknown[], startIdx: number): { clause: string; nextIdx: number } {
  let idx = startIdx;
  if (opts.asOfValidTime || opts.asOfRecordedAt) {
    const parts: string[] = [];
    if (opts.asOfValidTime) {
      parts.push(`valid_from <= $${idx}::timestamptz AND (valid_to IS NULL OR valid_to > $${idx}::timestamptz)`);
      params.push(opts.asOfValidTime);
      idx++;
    }
    if (opts.asOfRecordedAt) {
      parts.push(`recorded_at <= $${idx}::timestamptz AND (superseded_at IS NULL OR superseded_at > $${idx}::timestamptz)`);
      params.push(opts.asOfRecordedAt);
      idx++;
    }
    return { clause: "(" + parts.join(" AND ") + ")", nextIdx: idx };
  }
  return { clause: `(${CURRENT_VIEW_NODES})`, nextIdx: idx };
}

function buildEdgeViewCondition(opts: QueryEdgesOptions, params: unknown[], startIdx: number): { clause: string; nextIdx: number } {
  let idx = startIdx;
  if (opts.asOfValidTime || opts.asOfRecordedAt) {
    const parts: string[] = [];
    if (opts.asOfValidTime) {
      parts.push(`valid_from <= $${idx}::timestamptz AND (valid_to IS NULL OR valid_to > $${idx}::timestamptz)`);
      params.push(opts.asOfValidTime);
      idx++;
    }
    if (opts.asOfRecordedAt) {
      parts.push(`recorded_at <= $${idx}::timestamptz AND (superseded_at IS NULL OR superseded_at > $${idx}::timestamptz)`);
      params.push(opts.asOfRecordedAt);
      idx++;
    }
    return { clause: "(" + parts.join(" AND ") + ")", nextIdx: idx };
  }
  return { clause: `(${CURRENT_VIEW_EDGES})`, nextIdx: idx };
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
  const { clause, nextIdx } = buildNodeViewCondition(opts, params, i);
  i = nextIdx;
  conditions.push(clause);
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
  /** Time-travel: as-of valid time (ISO). */
  asOfValidTime?: string;
  /** Time-travel: as-of transaction time (ISO). */
  asOfRecordedAt?: string;
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
  const edgeView = buildEdgeViewCondition(opts, params, i);
  i = edgeView.nextIdx;
  conditions.push(edgeView.clause);
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
     FROM nodes WHERE scope_id = $1 AND (${CURRENT_VIEW_NODES})`,
    [scopeId],
  );
  const row = nodeRes.rows[0] ?? {};

  const claimsCount = Number(row.claims_active_count ?? 0);

  const goalRes = await p.query(
    `SELECT
       COUNT(*) FILTER (WHERE type = 'goal' AND status = 'resolved')::int AS resolved,
       COUNT(*) FILTER (WHERE type = 'goal')::int AS total
     FROM nodes WHERE scope_id = $1 AND (${CURRENT_VIEW_NODES})`,
    [scopeId],
  );
  const goalRow = goalRes.rows[0] ?? {};
  const goalsTotal = Number(goalRow.total ?? 0);
  const goalsCompletionRatio = goalsTotal === 0 ? 1 : Number(goalRow.resolved ?? 0) / goalsTotal;

  if (claimsCount === 0) {
    const evidence_coverage = await getEvidenceCoverageForScope(scopeId, p);
    return {
      claims_active_min_confidence: 0,
      claims_active_count: 0,
      claims_active_avg_confidence: 0,
      contradictions_unresolved_count: 0,
      contradictions_total_count: 0,
      risks_critical_active_count: 0,
      goals_completion_ratio: goalsCompletionRatio,
      scope_risk_score: 0,
      contradiction_mass: 0,
      evidence_coverage,
    };
  }

  const assessmentRes = await p.query(
    `SELECT COALESCE(SUM((metadata->>'risk_delta')::float), 0)::float AS risk_score
     FROM nodes WHERE scope_id = $1 AND type = 'assessment' AND status = 'active' AND (${CURRENT_VIEW_NODES})`,
    [scopeId],
  );
  const scopeRiskScore = Math.min(1, Math.max(0, Number(assessmentRes.rows[0]?.risk_score ?? 0)));

  // Contradiction count from edges (linked contradiction pairs)
  const contraEdgeRes = await p.query(
    `SELECT COUNT(*)::int AS total FROM edges e
     JOIN nodes n1 ON n1.node_id = e.source_id AND n1.scope_id = e.scope_id AND n1.superseded_at IS NULL
     JOIN nodes n2 ON n2.node_id = e.target_id AND n2.scope_id = e.scope_id AND n2.superseded_at IS NULL
     WHERE e.scope_id = $1 AND e.edge_type = 'contradicts' AND e.superseded_at IS NULL AND (e.valid_to IS NULL OR e.valid_to > now())
     AND (
       (n1.valid_from IS NULL AND n1.valid_to IS NULL) OR (n2.valid_from IS NULL AND n2.valid_to IS NULL)
       OR (n1.valid_from < COALESCE(n2.valid_to, 'infinity'::timestamptz) AND n2.valid_from < COALESCE(n1.valid_to, 'infinity'::timestamptz))
     )`,
    [scopeId],
  );
  const edgeContradictions = Number(contraEdgeRes.rows[0]?.total ?? 0);

  // Also count contradiction nodes that couldn't be linked as edges (text-only contradictions from LLM)
  const contraNodeRes = await p.query(
    `SELECT COUNT(*)::int AS total FROM nodes
     WHERE scope_id = $1 AND type = 'contradiction' AND status = 'active' AND (${CURRENT_VIEW_NODES})`,
    [scopeId],
  );
  const nodeContradictions = Number(contraNodeRes.rows[0]?.total ?? 0);

  const contradictionsTotal = Math.max(edgeContradictions, nodeContradictions);

  // Unresolved: edge-based contradictions without resolving edges + all unresolved contradiction nodes
  const unresolvedEdgeRes = await p.query(
    `SELECT COUNT(*)::int AS c FROM edges e
     JOIN nodes n1 ON n1.node_id = e.source_id AND n1.scope_id = e.scope_id AND n1.superseded_at IS NULL
     JOIN nodes n2 ON n2.node_id = e.target_id AND n2.scope_id = e.scope_id AND n2.superseded_at IS NULL
     WHERE e.scope_id = $1 AND e.edge_type = 'contradicts' AND e.superseded_at IS NULL AND (e.valid_to IS NULL OR e.valid_to > now())
     AND (
       (n1.valid_from IS NULL AND n1.valid_to IS NULL) OR (n2.valid_from IS NULL AND n2.valid_to IS NULL)
       OR (n1.valid_from < COALESCE(n2.valid_to, 'infinity'::timestamptz) AND n2.valid_from < COALESCE(n1.valid_to, 'infinity'::timestamptz))
     )
     AND NOT EXISTS (SELECT 1 FROM edges r WHERE r.scope_id = e.scope_id AND r.edge_type = 'resolves' AND r.superseded_at IS NULL AND (r.valid_to IS NULL OR r.valid_to > now()) AND (r.target_id = e.source_id OR r.target_id = e.target_id))`,
    [scopeId],
  );
  const unresolvedEdges = Number(unresolvedEdgeRes.rows[0]?.c ?? edgeContradictions);
  const contradictionsUnresolved = Math.max(unresolvedEdges, nodeContradictions);

  // Gate B: contradiction mass (severity weight per unresolved; default 1.0 each).
  const contradiction_mass = contradictionsUnresolved * 1.0;

  // Gate B: evidence coverage from schema (default 1 if no schema or no required types).
  const evidence_coverage = await getEvidenceCoverageForScope(scopeId, p);

  return {
    claims_active_min_confidence: Number(row.claims_active_min_confidence ?? 1),
    claims_active_count: Number(row.claims_active_count ?? 0),
    claims_active_avg_confidence: Number(row.claims_active_avg_confidence ?? 1),
    contradictions_unresolved_count: contradictionsUnresolved,
    contradictions_total_count: contradictionsTotal,
    risks_critical_active_count: Number(row.risks_critical_active_count ?? 0),
    goals_completion_ratio: goalsCompletionRatio,
    scope_risk_score: scopeRiskScore,
    contradiction_mass,
    evidence_coverage,
  };
}

/** Load evidence_schemas and compute coverage ratio for scope (0-1). Returns 1 if no schema. Uses max_age_days for staleness when set. */
async function getEvidenceCoverageForScope(
  scopeId: string,
  p: pg.Pool,
): Promise<number> {
  try {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const { parse: parseYaml } = await import("yaml");
    const path = join(process.cwd(), "evidence_schemas.yaml");
    const raw = readFileSync(path, "utf-8");
    const schemas = parseYaml(raw) as {
      schemas?: Record<string, { evidence_types?: string[]; temporal_constraint?: { max_age_days?: number | null } }>;
    };
    const defaultSchema = schemas?.schemas?.default;
    const required = defaultSchema?.evidence_types ?? [];
    if (required.length === 0) return 1;
    const maxAgeDays = defaultSchema?.temporal_constraint?.max_age_days;
    let sql = `SELECT type, COUNT(*)::int AS c FROM nodes WHERE scope_id = $1 AND (${CURRENT_VIEW_NODES})`;
    const params: unknown[] = [scopeId];
    if (maxAgeDays != null && maxAgeDays > 0) {
      sql += ` AND (valid_to IS NULL OR valid_to >= now() - ($2 || ' days')::interval)`;
      params.push(String(maxAgeDays));
    }
    sql += " GROUP BY type";
    const typeRes = await p.query(sql, params);
    const present = new Set(typeRes.rows.map((r) => String(r.type)));
    const found = required.filter((t) => present.has(t)).length;
    return found / required.length;
  } catch {
    return 1;
  }
}

/**
 * Process a user resolution: one submission may contain multiple resolutions.
 *
 * Uses an LLM matching agent when available: sends the resolution text + active goals,
 * gets back which goals are addressed (fully/partially/not).
 * Falls back to deterministic tokenization + synonym matching when no LLM is configured.
 */
export async function appendResolutionGoal(
  scopeId: string,
  decision: string,
  summary: string,
  client?: pg.PoolClient,
): Promise<string> {
  const q: Queryable = client ?? getPool();

  const activeGoals = await q.query(
    `SELECT node_id, content FROM nodes
     WHERE scope_id = $1 AND type = 'goal' AND status = 'active'
     AND superseded_at IS NULL AND (valid_to IS NULL OR valid_to > now())`,
    [scopeId],
  );

  const goals = activeGoals.rows.map((r) => ({
    node_id: (r as { node_id: string }).node_id,
    content: (r as { content: string }).content,
  }));

  let matches: GoalMatch[];
  try {
    matches = await matchGoalsWithLLM(decision, goals);
  } catch {
    matches = matchGoalsDeterministic(decision, goals);
  }

  const matched: string[] = [];
  for (const m of matches) {
    if (m.status === "not_addressed") continue;
    const newStatus = m.status === "fully_resolved" ? "resolved" : "in_progress";
    await q.query(
      `UPDATE nodes SET status = $2, updated_at = now(), version = version + 1,
       source_ref = source_ref || $3::jsonb
       WHERE node_id = $1`,
      [m.node_id, newStatus, JSON.stringify({
        resolved_by: "resolution",
        match_confidence: m.confidence,
        decision_preview: decision.trim().slice(0, 200),
      })],
    );
    matched.push(m.node_id);
  }

  if (matched.length > 0) {
    return matched[0];
  }

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

interface GoalMatch {
  node_id: string;
  status: "fully_resolved" | "partially_resolved" | "not_addressed";
  confidence: number;
}

async function matchGoalsWithLLM(
  decision: string,
  goals: Array<{ node_id: string; content: string }>,
): Promise<GoalMatch[]> {
  const { getChatModelConfig } = await import("./modelConfig.js");
  const config = getChatModelConfig();
  if (!config || goals.length === 0) return matchGoalsDeterministic(decision, goals);

  const goalsText = goals.map((g, i) => `${i + 1}. [${g.node_id}] ${g.content}`).join("\n");
  const prompt = `A user submitted this resolution:\n"${decision.trim()}"\n\nHere are the active goals:\n${goalsText}\n\nFor each goal, decide if the resolution addresses it. Reply with ONLY a JSON array, one object per goal:\n[{"id":"<node_id>","status":"fully_resolved"|"partially_resolved"|"not_addressed","confidence":0.0-1.0}]\n\n- "fully_resolved": the resolution clearly answers or completes this goal\n- "partially_resolved": the resolution provides relevant information but doesn't fully close the goal\n- "not_addressed": the resolution is unrelated to this goal\n\nBe generous: if the resolution mentions a topic related to the goal, mark it at least partially_resolved. Reply with ONLY the JSON array, no other text.`;

  const url = `${config.url.replace(/\/+$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.id.replace(/^openai\//, ""),
      messages: [{ role: "user", content: prompt }],
      max_tokens: 500,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content ?? "";

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("No JSON array in LLM response");

  const parsed = JSON.parse(jsonMatch[0]) as Array<{ id: string; status: string; confidence: number }>;
  const validStatuses = ["fully_resolved", "partially_resolved", "not_addressed"];
  const goalIds = new Set(goals.map(g => g.node_id));

  return parsed
    .filter(p => goalIds.has(p.id) && validStatuses.includes(p.status))
    .map(p => ({
      node_id: p.id,
      status: p.status as GoalMatch["status"],
      confidence: typeof p.confidence === "number" ? p.confidence : 0.5,
    }));
}

function matchGoalsDeterministic(
  decision: string,
  goals: Array<{ node_id: string; content: string }>,
): GoalMatch[] {
  const MATCH_THRESHOLD = 0.12;
  const sentences = splitIntoSentences(decision);
  const fullTokens = expandSynonyms(tokenize(decision));
  const sentenceTokenSets = sentences.map(s => expandSynonyms(tokenize(s)));
  const results: GoalMatch[] = [];

  for (const goal of goals) {
    const goalTokens = expandSynonyms(tokenize(goal.content));
    const score = bestMatchScore(fullTokens, sentenceTokenSets, goalTokens);
    if (score >= MATCH_THRESHOLD) {
      results.push({
        node_id: goal.node_id,
        status: score >= 0.3 ? "fully_resolved" : "partially_resolved",
        confidence: score,
      });
    }
  }
  return results;
}

const SYNONYMS: Record<string, string[]> = {
  ip: ["patents", "patent", "intellectual", "property"],
  patents: ["ip", "patent", "intellectual"],
  patent: ["ip", "patents", "intellectual"],
  cto: ["technical", "team", "chief", "officer"],
  technical: ["cto", "tech", "engineering"],
  retention: ["retain", "retaining", "departure", "departing"],
  arr: ["revenue", "recurring", "annual"],
  revenue: ["arr", "recurring", "financial"],
  compliance: ["regulatory", "regulation", "posture"],
  regulatory: ["compliance", "regulation"],
  ownership: ["own", "co-ownership", "ip"],
  valuation: ["value", "pricing", "worth"],
  due: ["diligence"],
  diligence: ["due"],
};

function expandSynonyms(tokens: Set<string>): Set<string> {
  const expanded = new Set(tokens);
  for (const t of tokens) {
    const syns = SYNONYMS[t];
    if (syns) for (const s of syns) expanded.add(s);
  }
  return expanded;
}

/**
 * Combined match score: max of Jaccard and coverage (fraction of goal tokens found in resolution).
 * Checks both the full text and individual sentences.
 */
function bestMatchScore(
  fullTokens: Set<string>,
  sentenceTokenSets: Set<string>[],
  goalTokens: Set<string>,
): number {
  const coverage = (src: Set<string>, goal: Set<string>) => {
    if (goal.size === 0) return 0;
    let hit = 0;
    for (const w of goal) if (src.has(w)) hit++;
    return hit / goal.size;
  };

  const fullJaccard = jaccardSimilarity(fullTokens, goalTokens);
  const fullCoverage = coverage(fullTokens, goalTokens);
  let best = Math.max(fullJaccard, fullCoverage);

  for (const st of sentenceTokenSets) {
    const j = jaccardSimilarity(st, goalTokens);
    const c = coverage(st, goalTokens);
    const s = Math.max(j, c);
    if (s > best) best = s;
  }
  return best;
}

function splitIntoSentences(text: string): string[] {
  return text
    .split(/[.!?;,]+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 5);
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "has", "have", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "this", "that", "these",
  "those", "it", "its", "not", "no", "all", "any", "each", "every",
  "both", "few", "more", "most", "other", "some", "such", "than",
  "too", "very", "just", "about", "above", "after", "before", "between",
  "into", "through", "during", "until", "against", "among", "out", "up",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9àâäéèêëïîôùûüÿçæœ€%]+/gi, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Update a node's confidence (monotonic upsert: only if new confidence >= existing). */
export async function updateNodeConfidence(
  nodeId: string,
  confidence: number,
  client?: pg.PoolClient,
): Promise<void> {
  const q: Queryable = client ?? getPool();
  await q.query(
    `UPDATE nodes SET confidence = $2, updated_at = now(), version = version + 1
     WHERE node_id = $1 AND confidence <= $2`,
    [nodeId, confidence],
  );
}

/** Update a node's status. */
export async function updateNodeStatus(
  nodeId: string,
  status: string,
  client?: pg.PoolClient,
): Promise<void> {
  const q: Queryable = client ?? getPool();
  await q.query(
    `UPDATE nodes SET status = $2, updated_at = now(), version = version + 1
     WHERE node_id = $1`,
    [nodeId, status],
  );
}

/** Check if a resolving edge exists for either side of a contradiction pair. */
export async function hasResolvingEdge(
  scopeId: string,
  sourceId: string,
  targetId: string,
  client?: pg.PoolClient,
): Promise<boolean> {
  const q: Queryable = client ?? getPool();
  const res = await q.query(
    `SELECT 1 FROM edges
     WHERE scope_id = $1 AND edge_type = 'resolves' AND (${CURRENT_VIEW_EDGES})
     AND (target_id = $2 OR target_id = $3)
     LIMIT 1`,
    [scopeId, sourceId, targetId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Query nodes by creator, optionally filtered by type. Returns all matching nodes. */
export async function queryNodesByCreator(
  scopeId: string,
  createdBy: string,
  type?: string,
  client?: pg.PoolClient,
): Promise<SemanticNode[]> {
  const q: Queryable = client ?? getPool();
  const conditions = ["scope_id = $1", "created_by = $2"];
  const params: unknown[] = [scopeId, createdBy];
  if (type) {
    conditions.push("type = $3");
    params.push(type);
  }
  conditions.push(`(${CURRENT_VIEW_NODES})`);
  const res = await q.query(
    `SELECT node_id, scope_id, type, content, confidence, status, source_ref, metadata, created_at, updated_at, created_by, version
     FROM nodes WHERE ${conditions.join(" AND ")}
     ORDER BY created_at ASC`,
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

/** Lightweight counts by type for feed / state graph display. */
export async function getGraphSummary(scopeId: string): Promise<{ nodes: Record<string, number>; edges: Record<string, number> }> {
  const p = getPool();
  const nodeRes = await p.query(
    `SELECT type, COUNT(*)::int AS c FROM nodes WHERE scope_id = $1 AND (${CURRENT_VIEW_NODES}) GROUP BY type`,
    [scopeId],
  );
  const nodes: Record<string, number> = {};
  for (const r of nodeRes.rows) nodes[String(r.type)] = Number(r.c ?? 0);

  const edgeRes = await p.query(
    `SELECT edge_type, COUNT(*)::int AS c FROM edges WHERE scope_id = $1 AND (${CURRENT_VIEW_EDGES}) GROUP BY edge_type`,
    [scopeId],
  );
  const edges: Record<string, number> = {};
  for (const r of edgeRes.rows) edges[String(r.edge_type)] = Number(r.c ?? 0);

  return { nodes, edges };
}
