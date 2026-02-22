/**
 * Convergence tracker for finality gradient descent.
 *
 * Implements five mechanisms from the literature:
 * 1. Lyapunov disagreement function V(t) — quadratic distance to finality targets (Olfati-Saber 2007)
 * 2. Convergence rate α = -ln(V(t)/V(t-1)) — exponential decay rate estimation
 * 3. Monotonicity gate — score must be non-decreasing for β rounds before auto-resolve (Aegean)
 * 4. Plateau detection — EMA of progress ratio; triggers HITL when stalled (MACI)
 * 5. Pressure-directed activation — per-dimension pressure for stigmergic routing (Royal Society 2024)
 *
 * All analysis functions are pure (no side effects). DB persistence is separated.
 */

import type { FinalitySnapshot, GoalGradientConfig } from "./finalityEvaluator.js";
import { getPool } from "./db.js";
import pg from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConvergencePoint {
  epoch: number;
  goal_score: number;
  lyapunov_v: number;
  dimension_scores: Record<string, number>;
  pressure: Record<string, number>;
  created_at: string;
}

export interface ConvergenceState {
  /** Recent history (oldest first). */
  history: ConvergencePoint[];
  /** Convergence rate α: >0 = converging, <0 = diverging, 0 = stalled. */
  convergence_rate: number;
  /** Estimated rounds to reach auto-threshold. null if diverging or insufficient data. */
  estimated_rounds: number | null;
  /** Goal score has been non-decreasing for β consecutive rounds. */
  is_monotonic: boolean;
  /** MACI progress ratio below threshold for τ consecutive rounds. */
  is_plateaued: boolean;
  /** Number of consecutive plateau rounds. */
  plateau_rounds: number;
  /** Dimension with highest pressure (biggest gap × weight). */
  highest_pressure_dimension: string;
}

export interface ConvergenceConfig {
  /** Monotonicity window: require non-decreasing for this many rounds (default 3). */
  beta: number;
  /** Plateau detection window: consecutive rounds below threshold to declare plateau (default 3). */
  tau: number;
  /** EMA smoothing factor for progress ratio (default 0.3). */
  ema_alpha: number;
  /** Progress ratio below which counts as plateau (default 0.01). */
  plateau_threshold: number;
  /** Number of history points to load from DB (default 20). */
  history_depth: number;
  /** Convergence rate below this triggers divergence alert (default -0.05). */
  divergence_rate: number;
}

/** Targets for each dimension — the values that constitute "perfect finality". */
export interface FinalityTargets {
  claim_confidence: number;
  contradiction_resolution: number;
  goal_completion: number;
  risk_inverse: number;
}

export const DEFAULT_CONVERGENCE_CONFIG: ConvergenceConfig = {
  beta: 3,
  tau: 3,
  ema_alpha: 0.3,
  plateau_threshold: 0.01,
  history_depth: 20,
  divergence_rate: -0.05,
};

export const DEFAULT_FINALITY_TARGETS: FinalityTargets = {
  claim_confidence: 1.0,   // avg_confidence / 0.85 clamped to 1 → target ratio = 1
  contradiction_resolution: 1.0,  // 0 unresolved / total → ratio = 1
  goal_completion: 1.0,    // 100% goals resolved
  risk_inverse: 1.0,       // 0 risk → 1 - 0 = 1
};

// ---------------------------------------------------------------------------
// Pure functions — no DB, no side effects
// ---------------------------------------------------------------------------

/**
 * Compute dimension scores from a FinalitySnapshot (same formula as computeGoalScore).
 * Returns per-dimension values in [0, 1] where 1 = at target.
 */
export function computeDimensionScores(
  snapshot: FinalitySnapshot,
  config?: GoalGradientConfig,
): Record<string, number> {
  const claimScore = Math.min(snapshot.claims_active_avg_confidence / 0.85, 1);
  const contraScore =
    snapshot.contradictions_total_count === 0
      ? 1
      : 1 - snapshot.contradictions_unresolved_count / snapshot.contradictions_total_count;
  const goalScore = snapshot.goals_completion_ratio;
  const riskScore = 1 - Math.min(snapshot.scope_risk_score, 1);

  return {
    claim_confidence: claimScore,
    contradiction_resolution: contraScore,
    goal_completion: goalScore,
    risk_score_inverse: riskScore,
  };
}

/**
 * Lyapunov disagreement function: V = Σ(w_d × (target_d - actual_d)²)
 * V >= 0; V = 0 means all dimensions at target (perfect finality).
 * V decreasing over time guarantees convergence.
 */
export function computeLyapunovV(
  snapshot: FinalitySnapshot,
  targets: FinalityTargets = DEFAULT_FINALITY_TARGETS,
  weights?: GoalGradientConfig["weights"],
): number {
  const w = weights ?? {
    claim_confidence: 0.3,
    contradiction_resolution: 0.3,
    goal_completion: 0.25,
    risk_score_inverse: 0.15,
  };
  const dims = computeDimensionScores(snapshot);

  const v =
    w.claim_confidence * (targets.claim_confidence - dims.claim_confidence) ** 2 +
    w.contradiction_resolution * (targets.contradiction_resolution - dims.contradiction_resolution) ** 2 +
    w.goal_completion * (targets.goal_completion - dims.goal_completion) ** 2 +
    w.risk_score_inverse * (targets.risk_inverse - dims.risk_score_inverse) ** 2;

  return Math.max(0, v);
}

/**
 * Per-dimension pressure: how far each dimension is from target, weighted.
 * Higher pressure = bigger bottleneck. Used for stigmergic agent routing.
 */
export function computePressure(
  snapshot: FinalitySnapshot,
  weights?: GoalGradientConfig["weights"],
): Record<string, number> {
  const w = weights ?? {
    claim_confidence: 0.3,
    contradiction_resolution: 0.3,
    goal_completion: 0.25,
    risk_score_inverse: 0.15,
  };
  const dims = computeDimensionScores(snapshot);

  return {
    claim_confidence: w.claim_confidence * Math.max(0, 1 - dims.claim_confidence),
    contradiction_resolution: w.contradiction_resolution * Math.max(0, 1 - dims.contradiction_resolution),
    goal_completion: w.goal_completion * Math.max(0, 1 - dims.goal_completion),
    risk_score_inverse: w.risk_score_inverse * Math.max(0, 1 - dims.risk_score_inverse),
  };
}

/**
 * Analyze convergence from history points. Pure function.
 *
 * Input: history sorted oldest-first (ascending epoch).
 */
export function analyzeConvergence(
  history: ConvergencePoint[],
  config: ConvergenceConfig = DEFAULT_CONVERGENCE_CONFIG,
  autoThreshold: number = 0.92,
): ConvergenceState {
  const empty: ConvergenceState = {
    history,
    convergence_rate: 0,
    estimated_rounds: null,
    is_monotonic: false,
    is_plateaued: false,
    plateau_rounds: 0,
    highest_pressure_dimension: "",
  };

  if (history.length === 0) return empty;

  const latest = history[history.length - 1];

  // --- Highest pressure dimension ---
  let maxPressure = -1;
  let highestDim = "";
  for (const [dim, p] of Object.entries(latest.pressure)) {
    if (p > maxPressure) {
      maxPressure = p;
      highestDim = dim;
    }
  }

  if (history.length === 1) {
    return {
      ...empty,
      highest_pressure_dimension: highestDim,
    };
  }

  // --- Convergence rate: α = -ln(V(t) / V(t-1)) averaged over recent pairs ---
  const alphas: number[] = [];
  const recentCount = Math.min(history.length, 5);
  for (let i = history.length - recentCount; i < history.length; i++) {
    if (i === 0) continue;
    const vPrev = history[i - 1].lyapunov_v;
    const vCurr = history[i].lyapunov_v;
    if (vPrev > 1e-10) {
      // Clamp ratio to avoid log(0) — if V reaches 0, that's perfect convergence
      const ratio = Math.max(vCurr / vPrev, 1e-10);
      alphas.push(-Math.log(ratio));
    }
  }
  const avgAlpha = alphas.length > 0
    ? alphas.reduce((a, b) => a + b, 0) / alphas.length
    : 0;

  // --- Estimated rounds to auto-threshold ---
  // V at auto-threshold: we need goalScore >= autoThreshold.
  // Approximate: V_target ≈ (1 - autoThreshold)² × totalWeight  (rough upper bound)
  // More precise: use the actual V formula with dimension scores all at their threshold-matching values.
  // For simplicity, we use a small epsilon target.
  const currentV = latest.lyapunov_v;
  const vEpsilon = 0.005; // V value below which we consider finality achievable
  let estimatedRounds: number | null = null;
  if (avgAlpha > 0.001 && currentV > vEpsilon) {
    estimatedRounds = Math.ceil(-Math.log(vEpsilon / currentV) / avgAlpha);
    // Sanity cap
    if (estimatedRounds > 1000) estimatedRounds = null;
  } else if (currentV <= vEpsilon) {
    estimatedRounds = 0;
  }

  // --- Monotonicity gate: score non-decreasing for β consecutive rounds ---
  let isMonotonic = false;
  if (history.length >= config.beta) {
    const window = history.slice(-config.beta);
    isMonotonic = true;
    for (let i = 1; i < window.length; i++) {
      if (window[i].goal_score < window[i - 1].goal_score - 0.001) {
        isMonotonic = false;
        break;
      }
    }
  }

  // --- Plateau detection (MACI): EMA of progress ratio ---
  let plateauRounds = 0;
  if (history.length >= 2) {
    let ema = 0;
    let consecutivePlateau = 0;

    for (let i = 1; i < history.length; i++) {
      const delta = Math.max(0, history[i].goal_score - history[i - 1].goal_score);
      const remainingGap = Math.max(autoThreshold - history[i].goal_score, 0.001);
      const progressRatio = delta / remainingGap;

      ema = config.ema_alpha * progressRatio + (1 - config.ema_alpha) * ema;

      if (ema < config.plateau_threshold) {
        consecutivePlateau++;
      } else {
        consecutivePlateau = 0;
      }
    }
    plateauRounds = consecutivePlateau;
  }

  const isPlateaued = plateauRounds >= config.tau;

  return {
    history,
    convergence_rate: avgAlpha,
    estimated_rounds: estimatedRounds,
    is_monotonic: isMonotonic,
    is_plateaued: isPlateaued,
    plateau_rounds: plateauRounds,
    highest_pressure_dimension: highestDim,
  };
}

// ---------------------------------------------------------------------------
// DB persistence
// ---------------------------------------------------------------------------

/**
 * Append a convergence point to the history table.
 */
export async function recordConvergencePoint(
  scopeId: string,
  epoch: number,
  goalScore: number,
  lyapunovV: number,
  dimensionScores: Record<string, number>,
  pressure: Record<string, number>,
  pool?: pg.Pool,
): Promise<void> {
  const p = pool ?? getPool();
  await p.query(
    `INSERT INTO convergence_history (scope_id, epoch, goal_score, lyapunov_v, dimension_scores, pressure)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [scopeId, epoch, goalScore, lyapunovV, JSON.stringify(dimensionScores), JSON.stringify(pressure)],
  );
}

/**
 * Load recent convergence history for a scope, oldest-first.
 */
export async function loadConvergenceHistory(
  scopeId: string,
  depth: number = 20,
  pool?: pg.Pool,
): Promise<ConvergencePoint[]> {
  const p = pool ?? getPool();
  const res = await p.query(
    `SELECT epoch, goal_score, lyapunov_v, dimension_scores, pressure, created_at
     FROM convergence_history
     WHERE scope_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [scopeId, depth],
  );
  // Reverse so oldest is first
  return res.rows.reverse().map((r) => ({
    epoch: Number(r.epoch),
    goal_score: Number(r.goal_score),
    lyapunov_v: Number(r.lyapunov_v),
    dimension_scores: (r.dimension_scores as Record<string, number>) ?? {},
    pressure: (r.pressure as Record<string, number>) ?? {},
    created_at: String(r.created_at),
  }));
}

/**
 * Convenience: load history + analyze. Returns full convergence state.
 */
export async function getConvergenceState(
  scopeId: string,
  config?: Partial<ConvergenceConfig>,
  autoThreshold?: number,
  pool?: pg.Pool,
): Promise<ConvergenceState> {
  const fullConfig: ConvergenceConfig = { ...DEFAULT_CONVERGENCE_CONFIG, ...config };
  const history = await loadConvergenceHistory(scopeId, fullConfig.history_depth, pool);
  return analyzeConvergence(history, fullConfig, autoThreshold ?? 0.92);
}
