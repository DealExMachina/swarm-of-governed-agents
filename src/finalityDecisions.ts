/**
 * Persist and query human finality decisions (approve_finality, provide_resolution, escalate, defer).
 * Used by the action executor when consuming swarm.actions.finality and by the finality evaluator
 * to treat approve_finality as RESOLVED and skip re-sending HITL.
 */

import pg from "pg";
import { getPool } from "./db.js";

export type FinalityOption = "approve_finality" | "provide_resolution" | "escalate" | "defer";

export interface FinalityDecisionRow {
  scope_id: string;
  option: string;
  days: number | null;
  created_at: string;
}

/**
 * Record a human finality decision for a scope. Called by the executor when handling swarm.actions.finality.
 */
export async function recordFinalityDecision(
  scopeId: string,
  option: FinalityOption,
  days?: number,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO scope_finality_decisions (scope_id, option, days) VALUES ($1, $2, $3)`,
    [scopeId, option, days ?? null],
  );
}

/**
 * Return the most recent finality decision for the scope, if any.
 * Used by evaluateFinality to short-circuit: approve_finality -> RESOLVED.
 */
export async function getLatestFinalityDecision(
  scopeId: string,
): Promise<FinalityDecisionRow | null> {
  const pool = getPool();
  const res = await pool.query<FinalityDecisionRow>(
    `SELECT scope_id, option, days, created_at FROM scope_finality_decisions
     WHERE scope_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [scopeId],
  );
  return res.rows[0] ?? null;
}
