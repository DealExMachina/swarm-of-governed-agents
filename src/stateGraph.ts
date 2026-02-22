import pg from "pg";
import { getPool } from "./db.js";
import { appendEvent } from "./contextWal.js";
import { createSwarmEvent } from "./events.js";
import { canTransition, type DriftInput, type GovernanceConfig } from "./governance.js";

export type Node = "ContextIngested" | "FactsExtracted" | "DriftChecked";

export interface GraphState {
  runId: string;
  lastNode: Node;
  updatedAt: string;
  epoch: number;
}

export const transitions: Record<Node, Node> = {
  ContextIngested: "FactsExtracted",
  FactsExtracted: "DriftChecked",
  DriftChecked: "ContextIngested",
};

export function nextState(s: GraphState): GraphState {
  const next = transitions[s.lastNode];
  return { ...s, lastNode: next, updatedAt: new Date().toISOString(), epoch: s.epoch + 1 };
}

/* ---- Postgres-backed persistence ---- */

let _tableEnsured = false;

export function _resetStateTableEnsured(): void {
  _tableEnsured = false;
}

export async function ensureStateTable(pool?: pg.Pool): Promise<void> {
  if (_tableEnsured) return;
  const p = pool ?? getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS swarm_state (
      scope_id   TEXT PRIMARY KEY,
      run_id     TEXT NOT NULL,
      last_node  TEXT NOT NULL,
      epoch      BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  _tableEnsured = true;
}

export async function loadState(scopeId: string, pool?: pg.Pool): Promise<GraphState | null> {
  const p = pool ?? getPool();
  await ensureStateTable(p);
  const res = await p.query(
    "SELECT run_id, last_node, epoch, updated_at FROM swarm_state WHERE scope_id = $1",
    [scopeId],
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0];
  return {
    runId: row.run_id,
    lastNode: row.last_node as Node,
    epoch: parseInt(row.epoch, 10),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export async function initState(
  scopeId: string,
  runId: string,
  startNode: Node = "ContextIngested",
  pool?: pg.Pool,
): Promise<GraphState> {
  const p = pool ?? getPool();
  await ensureStateTable(p);
  const res = await p.query(
    `INSERT INTO swarm_state (scope_id, run_id, last_node, epoch, updated_at)
     VALUES ($1, $2, $3, 0, now())
     ON CONFLICT (scope_id) DO NOTHING
     RETURNING run_id, last_node, epoch, updated_at`,
    [scopeId, runId, startNode],
  );
  if (res.rowCount === 0) {
    return (await loadState(scopeId, p))!;
  }
  const row = res.rows[0];
  return {
    runId: row.run_id,
    lastNode: row.last_node as Node,
    epoch: parseInt(row.epoch, 10),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export interface AdvanceOptions {
  scopeId?: string;
  drift?: DriftInput;
  governance?: GovernanceConfig;
}

/**
 * Atomically advance the state machine to the next node.
 * Uses CAS on epoch: only succeeds if the current epoch matches expectedEpoch.
 * When drift + governance are provided, evaluates transition rules before advancing.
 * Returns the new state on success, null if blocked or another agent already advanced.
 */
export async function advanceState(
  expectedEpoch: number,
  poolOrOpts?: pg.Pool | AdvanceOptions,
  maybePool?: pg.Pool,
): Promise<GraphState | null> {
  let p: pg.Pool;
  let opts: AdvanceOptions = {};
  if (poolOrOpts && "query" in (poolOrOpts as any)) {
    p = poolOrOpts as pg.Pool;
  } else if (poolOrOpts) {
    opts = poolOrOpts as AdvanceOptions;
    p = maybePool ?? getPool();
  } else {
    p = maybePool ?? getPool();
  }
  const scopeId = opts.scopeId ?? "default";
  await ensureStateTable(p);

  const current = await loadState(scopeId, p);
  if (!current || current.epoch !== expectedEpoch) return null;

  const next = transitions[current.lastNode];

  if (opts.drift && opts.governance) {
    const decision = canTransition(current.lastNode, next, opts.drift, opts.governance);
    if (!decision.allowed) return null;
  }
  const newEpoch = expectedEpoch + 1;

  const res = await p.query(
    `UPDATE swarm_state
     SET last_node = $1, epoch = $2, updated_at = now()
     WHERE scope_id = $3 AND epoch = $4
     RETURNING run_id, last_node, epoch, updated_at`,
    [next, newEpoch, scopeId, expectedEpoch],
  );

  if (res.rowCount === 0) return null;
  const row = res.rows[0];
  const newState: GraphState = {
    runId: row.run_id,
    lastNode: row.last_node as Node,
    epoch: parseInt(row.epoch, 10),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };

  try {
    await appendEvent(
      createSwarmEvent("state_transition", {
        from: current.lastNode,
        to: newState.lastNode,
        epoch: newState.epoch,
        run_id: newState.runId,
      }, { source: "state_graph" }),
      p,
    );
  } catch {
    // Non-fatal: transition succeeded even if event emission fails
  }

  return newState;
}
