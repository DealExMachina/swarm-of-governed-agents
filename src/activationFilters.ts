/**
 * Managed activation filters: optimizable objects stored in Postgres with stats,
 * tuned by the tuner agent. Deterministic checks (zero LLM tokens) gate agent execution.
 */

import { createHash } from "crypto";
import pg from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
import { tailEvents, getLatestPipelineWalSeqForFacts } from "./contextWal.js";
import { s3GetText, s3PutJson } from "./s3.js";

const { Pool } = pg;

export type FilterType = "hash_delta" | "sequence_delta" | "timer" | "composite";

export interface FilterStats {
  activations: number;
  productive: number;
  wasted: number;
  avgLatencyMs: number;
  lastActivatedAt: string | null;
}

export interface FilterConfig {
  agentRole: string;
  type: FilterType;
  params: Record<string, number | string | boolean>;
  stats: FilterStats;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export interface AgentMemory {
  lastProcessedSeq: number;
  lastHash: string | null;
  lastDriftHash: string | null;
  lastActivatedAt: number;
  data: Record<string, unknown>;
}

export interface ActivationResult {
  shouldActivate: boolean;
  context: Record<string, unknown>;
}

let _pool: pg.Pool | null = null;
let _tableEnsured = false;

function getPool(): pg.Pool {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required for activation filters");
    _pool = new Pool({ connectionString: url, max: 5 });
  }
  return _pool;
}

export function _resetFilterTableEnsured(): void {
  _tableEnsured = false;
}

async function ensureFilterTable(pool?: pg.Pool): Promise<void> {
  if (_tableEnsured) return;
  const p = pool ?? getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS filter_configs (
      agent_role TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      params JSONB NOT NULL DEFAULT '{}',
      stats JSONB NOT NULL DEFAULT '{"activations":0,"productive":0,"wasted":0,"avgLatencyMs":0,"lastActivatedAt":null}',
      version BIGINT NOT NULL DEFAULT 0,
      updated_by TEXT NOT NULL DEFAULT 'system',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS agent_memory (
      agent_role TEXT PRIMARY KEY,
      last_processed_seq BIGINT NOT NULL DEFAULT 0,
      last_hash TEXT,
      last_drift_hash TEXT,
      last_activated_at TIMESTAMPTZ,
      data JSONB NOT NULL DEFAULT '{}'
    )
  `);
  _tableEnsured = true;
}

const DEFAULT_FILTERS: Record<string, Omit<FilterConfig, "updatedAt">> = {
  facts: {
    agentRole: "facts",
    type: "sequence_delta",
    params: { minNewEvents: 1, cooldownMs: 2000 },
    stats: { activations: 0, productive: 0, wasted: 0, avgLatencyMs: 0, lastActivatedAt: null },
    version: 0,
    updatedBy: "system",
  },
  drift: {
    agentRole: "drift",
    type: "hash_delta",
    params: { field: "facts/latest.json", sensitivity: "exact", cooldownMs: 5000 },
    stats: { activations: 0, productive: 0, wasted: 0, avgLatencyMs: 0, lastActivatedAt: null },
    version: 0,
    updatedBy: "system",
  },
  planner: {
    agentRole: "planner",
    type: "hash_delta",
    params: { field: "drift/latest.json", sensitivity: "structural", cooldownMs: 5000 },
    stats: { activations: 0, productive: 0, wasted: 0, avgLatencyMs: 0, lastActivatedAt: null },
    version: 0,
    updatedBy: "system",
  },
  status: {
    agentRole: "status",
    type: "timer",
    params: { shortIntervalMs: 120000, fullIntervalMs: 600000, eventBurstThreshold: 10 },
    stats: { activations: 0, productive: 0, wasted: 0, avgLatencyMs: 0, lastActivatedAt: null },
    version: 0,
    updatedBy: "system",
  },
};

export async function loadFilterConfig(agentRole: string, pool?: pg.Pool): Promise<FilterConfig> {
  const p = pool ?? getPool();
  await ensureFilterTable(p);
  const res = await p.query(
    "SELECT agent_role, type, params, stats, version, updated_by, updated_at FROM filter_configs WHERE agent_role = $1",
    [agentRole],
  );
  if (res.rowCount && res.rows[0]) {
    const r = res.rows[0];
    return {
      agentRole: r.agent_role,
      type: r.type as FilterType,
      params: typeof r.params === "string" ? JSON.parse(r.params) : r.params,
      stats: typeof r.stats === "string" ? JSON.parse(r.stats) : r.stats,
      version: parseInt(r.version, 10),
      updatedBy: r.updated_by,
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    };
  }
  const def = DEFAULT_FILTERS[agentRole];
  if (def) {
    await p.query(
      `INSERT INTO filter_configs (agent_role, type, params, stats, version, updated_by)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
       ON CONFLICT (agent_role) DO NOTHING`,
      [def.agentRole, def.type, JSON.stringify(def.params), JSON.stringify(def.stats), def.version, def.updatedBy],
    );
    return { ...def, updatedAt: new Date().toISOString() };
  }
  throw new Error(`Unknown agent role for filter: ${agentRole}`);
}

export async function loadAgentMemory(agentRole: string, pool?: pg.Pool): Promise<AgentMemory> {
  const p = pool ?? getPool();
  await ensureFilterTable(p);
  const res = await p.query(
    "SELECT last_processed_seq, last_hash, last_drift_hash, last_activated_at, data FROM agent_memory WHERE agent_role = $1",
    [agentRole],
  );
  if (res.rowCount && res.rows[0]) {
    const r = res.rows[0];
    return {
      lastProcessedSeq: parseInt(r.last_processed_seq, 10) || 0,
      lastHash: r.last_hash,
      lastDriftHash: r.last_drift_hash,
      lastActivatedAt: r.last_activated_at ? new Date(r.last_activated_at).getTime() : 0,
      data: typeof r.data === "string" ? JSON.parse(r.data) : r.data ?? {},
    };
  }
  await p.query(
    "INSERT INTO agent_memory (agent_role) VALUES ($1) ON CONFLICT (agent_role) DO NOTHING",
    [agentRole],
  );
  return {
    lastProcessedSeq: 0,
    lastHash: null,
    lastDriftHash: null,
    lastActivatedAt: 0,
    data: {},
  };
}

export async function saveAgentMemory(
  agentRole: string,
  memory: Partial<AgentMemory>,
  pool?: pg.Pool,
): Promise<void> {
  const p = pool ?? getPool();
  await ensureFilterTable(p);
  const updates: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (memory.lastProcessedSeq !== undefined) {
    updates.push(`last_processed_seq = $${i++}`);
    values.push(memory.lastProcessedSeq);
  }
  if (memory.lastHash !== undefined) {
    updates.push(`last_hash = $${i++}`);
    values.push(memory.lastHash);
  }
  if (memory.lastDriftHash !== undefined) {
    updates.push(`last_drift_hash = $${i++}`);
    values.push(memory.lastDriftHash);
  }
  if (memory.lastActivatedAt !== undefined) {
    updates.push(`last_activated_at = to_timestamp($${i++} / 1000.0)`);
    values.push(memory.lastActivatedAt);
  }
  if (memory.data !== undefined) {
    updates.push(`data = $${i++}::jsonb`);
    values.push(JSON.stringify(memory.data));
  }
  if (updates.length === 0) return;
  values.push(agentRole);
  await p.query(
    `UPDATE agent_memory SET ${updates.join(", ")} WHERE agent_role = $${i}`,
    values,
  );
}

function stableHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function getLatestWalSeq(): Promise<number> {
  const events = await tailEvents(1);
  return events.length ? events[events.length - 1].seq : 0;
}

async function readHashFromS3(s3: S3Client, bucket: string, key: string): Promise<string | null> {
  const text = await s3GetText(s3, bucket, key);
  if (text === null) return null;
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (typeof parsed.hash === "string") return parsed.hash;
  return stableHash(text);
}

export interface FilterContext {
  s3: S3Client;
  bucket: string;
}

/**
 * Deterministic filter check. Zero LLM tokens. Returns whether the agent should run and context to pass to execute.
 */
export async function checkFilter(
  config: FilterConfig,
  memory: AgentMemory,
  ctx: FilterContext,
): Promise<ActivationResult> {
  const now = Date.now();
  const cooldownMs = (config.params.cooldownMs as number) ?? 5000;

  switch (config.type) {
    case "sequence_delta": {
      // Facts uses "new context" seq only (bootstrap, context_doc) so the loop suspends after a full cycle.
      const latestSeq =
        config.agentRole === "facts"
          ? await getLatestPipelineWalSeqForFacts()
          : await getLatestWalSeq();
      const minNew = (config.params.minNewEvents as number) ?? 1;
      const delta = latestSeq - memory.lastProcessedSeq;
      const shouldActivate =
        delta >= minNew && (memory.lastActivatedAt === 0 || now - memory.lastActivatedAt >= cooldownMs);
      return {
        shouldActivate,
        context: { latestSeq, previousSeq: memory.lastProcessedSeq },
      };
    }
    case "hash_delta": {
      const field = (config.params.field as string) ?? "facts/latest.json";
      const currentHash = await readHashFromS3(ctx.s3, ctx.bucket, field);
      const lastHash = field.includes("drift") ? memory.lastDriftHash : memory.lastHash;
      const changed = currentHash !== null && currentHash !== lastHash;
      const shouldActivate =
        changed && (memory.lastActivatedAt === 0 || now - memory.lastActivatedAt >= cooldownMs);
      return {
        shouldActivate,
        context: { currentHash, previousHash: lastHash, field },
      };
    }
    case "timer": {
      const shortMs = (config.params.shortIntervalMs as number) ?? 120000;
      const fullMs = (config.params.fullIntervalMs as number) ?? 600000;
      const elapsed = memory.lastActivatedAt === 0 ? Infinity : now - memory.lastActivatedAt;
      const shouldActivate = elapsed >= shortMs;
      return {
        shouldActivate,
        context: {
          lastActivatedAt: memory.lastActivatedAt,
          elapsedMs: elapsed,
          nextShortMs: shortMs,
          nextFullMs: fullMs,
        },
      };
    }
    default:
      return { shouldActivate: false, context: {} };
  }
}

/**
 * Record an activation outcome for tuner stats. Call after execute.
 */
export async function recordActivation(
  agentRole: string,
  productive: boolean,
  latencyMs: number,
  pool?: pg.Pool,
): Promise<void> {
  const p = pool ?? getPool();
  await ensureFilterTable(p);
  const res = await p.query(
    "SELECT stats FROM filter_configs WHERE agent_role = $1",
    [agentRole],
  );
  if (!res.rowCount || !res.rows[0]) return;
  const stats: FilterStats =
    typeof res.rows[0].stats === "string" ? JSON.parse(res.rows[0].stats) : res.rows[0].stats;
  const activations = (stats.activations ?? 0) + 1;
  const productiveCount = (stats.productive ?? 0) + (productive ? 1 : 0);
  const wasted = (stats.wasted ?? 0) + (productive ? 0 : 1);
  const prevAvg = stats.avgLatencyMs ?? 0;
  const avgLatencyMs = prevAvg === 0 ? latencyMs : (prevAvg * (activations - 1) + latencyMs) / activations;
  const newStats: FilterStats = {
    activations,
    productive: productiveCount,
    wasted,
    avgLatencyMs,
    lastActivatedAt: new Date().toISOString(),
  };
  await p.query(
    "UPDATE filter_configs SET stats = $1::jsonb WHERE agent_role = $2",
    [JSON.stringify(newStats), agentRole],
  );
}

export async function loadAllFilterConfigs(pool?: pg.Pool): Promise<FilterConfig[]> {
  const p = pool ?? getPool();
  await ensureFilterTable(p);
  const res = await p.query(
    "SELECT agent_role, type, params, stats, version, updated_by, updated_at FROM filter_configs",
  );
  return res.rows.map((r: any) => ({
    agentRole: r.agent_role,
    type: r.type as FilterType,
    params: typeof r.params === "string" ? JSON.parse(r.params) : r.params,
    stats: typeof r.stats === "string" ? JSON.parse(r.stats) : r.stats,
    version: parseInt(r.version, 10),
    updatedBy: r.updated_by,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  }));
}

export async function saveFilterConfig(
  config: FilterConfig,
  pool?: pg.Pool,
): Promise<void> {
  const p = pool ?? getPool();
  await ensureFilterTable(p);
  await p.query(
    `INSERT INTO filter_configs (agent_role, type, params, stats, version, updated_by, updated_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, now())
     ON CONFLICT (agent_role) DO UPDATE SET
       type = EXCLUDED.type,
       params = EXCLUDED.params,
       version = EXCLUDED.version,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [
      config.agentRole,
      config.type,
      JSON.stringify(config.params),
      JSON.stringify(config.stats),
      config.version,
      config.updatedBy,
    ],
  );
}

export async function snapshotFilterToS3(
  s3: S3Client,
  bucket: string,
  config: FilterConfig,
): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const key = `filters/history/${config.agentRole}-${ts}-v${config.version}.json`;
  await s3PutJson(s3, bucket, key, config as unknown as Record<string, unknown>);
  return key;
}
