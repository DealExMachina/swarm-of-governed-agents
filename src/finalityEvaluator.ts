import { readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { getFinalityThresholds } from "./modelConfig.js";

/** Severity/materiality for contradiction mass (Gate B). */
export type ContradictionSeverity = "low" | "medium" | "high" | "material";

/**
 * Snapshot of scope-level aggregates used for finality conditions and goal score.
 * When semanticGraph exists, loadFinalitySnapshot should run a single aggregation query.
 */
export interface FinalitySnapshot {
  /** Min confidence among active claims (0–1). */
  claims_active_min_confidence: number;
  /** Number of active claims. */
  claims_active_count: number;
  /** Average confidence of active claims (for goal score). */
  claims_active_avg_confidence: number;
  /** Number of unresolved contradictions. */
  contradictions_unresolved_count: number;
  /** Total contradiction pairs (for resolution ratio). */
  contradictions_total_count: number;
  /** Number of active critical risks. */
  risks_critical_active_count: number;
  /** Goals completion ratio (0–1): resolved / total. */
  goals_completion_ratio: number;
  /** Scope-level risk score (0–1). */
  scope_risk_score: number;
  /** Optional: idle cycles / last delta age for BLOCKED/EXPIRED. */
  scope_idle_cycles?: number;
  scope_last_delta_age_ms?: number;
  scope_last_active_age_ms?: number;
  assessments_critical_unaddressed_count?: number;
  /** Gate B: weighted contradiction mass (severity × materiality); optional until Phase 1. */
  contradiction_mass?: number;
  /** Gate B: evidence coverage ratio (0–1); optional until Phase 1. */
  evidence_coverage?: number;
  /** Coordination signal (agent-to-agent); optional until Phase 2. */
  coordination_signal?: CoordinationSignal | null;
}

/** Coordination signal payload (placeholder for Phase 2). */
export interface CoordinationSignal {
  signal_type: string;
  value?: number;
  metadata?: Record<string, unknown>;
}

/** Payload for finality certificate (JWS signing in Phase 4). */
export interface FinalityCertificatePayload {
  scope_id: string;
  decision: "RESOLVED" | "ESCALATED" | "BLOCKED" | "EXPIRED";
  timestamp: string;
  policy_version_hashes?: { governance?: string; finality?: string };
  dimensions_snapshot?: Record<string, number>;
}

export type CaseStatus =
  | "ACTIVE"
  | "RESOLVED"
  | "ESCALATED"
  | "BLOCKED"
  | "SUSPENDED"
  | "SUPERSEDED"
  | "EXPIRED";

export interface FinalityConditionRule {
  mode: "all" | "any";
  conditions: string[];
  description?: string;
  auto_threshold?: number;
}

export interface GoalGradientConfig {
  weights: {
    claim_confidence: number;
    contradiction_resolution: number;
    goal_completion: number;
    risk_score_inverse: number;
  };
  near_finality_threshold: number;
  auto_finality_threshold: number;
}

export interface ConvergenceYamlConfig {
  beta?: number;
  tau?: number;
  ema_alpha?: number;
  plateau_threshold?: number;
  history_depth?: number;
  divergence_rate?: number;
}

/** Gate D: quiescence heuristic. When both are 0, quiescence is not required. */
export interface QuiescenceConfig {
  /** Minimum idle cycles (no state change) before RESOLVED can apply. */
  idle_cycles_min: number;
  /** Minimum ms since last state change (scope.last_delta_age_ms). */
  window_ms: number;
}

export interface FinalityConfig {
  goal_gradient?: GoalGradientConfig;
  convergence?: ConvergenceYamlConfig;
  /** Gate D: optional quiescence; 0/0 = disabled. */
  quiescence?: QuiescenceConfig;
  finality: Record<CaseStatus, FinalityConditionRule>;
}

const DEFAULT_SNAPSHOT: FinalitySnapshot = {
  claims_active_min_confidence: 0,
  claims_active_count: 0,
  claims_active_avg_confidence: 0,
  contradictions_unresolved_count: 0,
  contradictions_total_count: 0,
  risks_critical_active_count: 0,
  goals_completion_ratio: 0,
  scope_risk_score: 0,
};

/**
 * Load scope snapshot for finality evaluation. Uses semanticGraph.loadFinalitySnapshot when
 * the semantic graph (nodes/edges) exists; otherwise returns default snapshot.
 */
export async function loadFinalitySnapshot(scopeId: string): Promise<FinalitySnapshot> {
  try {
    const { loadFinalitySnapshot: loadFromGraph } = await import("./semanticGraph.js");
    return await loadFromGraph(scopeId);
  } catch {
    return { ...DEFAULT_SNAPSHOT };
  }
}

const FINALITY_PATH = process.env.FINALITY_PATH ?? join(process.cwd(), "finality.yaml");

export function loadFinalityConfig(): FinalityConfig {
  try {
    const raw = readFileSync(FINALITY_PATH, "utf-8");
    const parsed = parseYaml(raw) as FinalityConfig;
    if (!parsed.finality || typeof parsed.finality !== "object") {
      return { finality: {} as Record<CaseStatus, FinalityConditionRule> };
    }
    return parsed;
  } catch {
    return { finality: {} as Record<CaseStatus, FinalityConditionRule> };
  }
}

/** Parse a condition string like "claims.active.min_confidence: 0.85" or "scope.risk_score: \"< 0.20\"". */
function parseCondition(condition: string): { key: string; op: string; value: number } {
  const colon = condition.indexOf(":");
  if (colon === -1) return { key: "", op: "==", value: 0 };
  const key = condition.slice(0, colon).trim();
  const rest = condition.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
  const match = rest.match(/^(>=|<=|>|<|==)\s*([\d.]+)$/);
  if (match) {
    return { key, op: match[1], value: Number(match[2]) };
  }
  const num = Number(rest);
  const value = Number.isFinite(num) ? num : 0;
  const op = value === 0 && (key.includes("count") || key.includes("_count")) ? "==" : ">=";
  return { key, op, value };
}

function evaluateOne(condition: string, snapshot: FinalitySnapshot): boolean {
  const { key, op, value } = parseCondition(condition);
  let actual: number;
  switch (key) {
    case "claims.active.min_confidence":
      actual = snapshot.claims_active_min_confidence;
      break;
    case "contradictions.unresolved_count":
      actual = snapshot.contradictions_unresolved_count;
      break;
    case "risks.critical.active_count":
      actual = snapshot.risks_critical_active_count;
      break;
    case "goals.completion_ratio":
      actual = snapshot.goals_completion_ratio;
      break;
    case "scope.risk_score":
      actual = snapshot.scope_risk_score;
      break;
    case "scope.idle_cycles":
      actual = snapshot.scope_idle_cycles ?? 0;
      break;
    case "scope.last_delta_age_ms":
      actual = snapshot.scope_last_delta_age_ms ?? 0;
      break;
    case "scope.last_active_age_ms":
      actual = snapshot.scope_last_active_age_ms ?? 0;
      break;
    case "assessments.critical_unaddressed_count":
      actual = snapshot.assessments_critical_unaddressed_count ?? 0;
      break;
    default:
      return false;
  }
  switch (op) {
    case ">=":
      return actual >= value;
    case "<=":
      return actual <= value;
    case ">":
      return actual > value;
    case "<":
      return actual < value;
    case "==":
      return actual === value;
    default:
      return actual >= value;
  }
}

/**
 * Weighted goal score (0–1) for the scope. Used for Path B (goal gradient HITL).
 * Formula: claim_confidence * w1 + contradiction_resolution * w2 + goal_completion * w3 + risk_inverse * w4.
 */
export function computeGoalScore(snapshot: FinalitySnapshot, config?: GoalGradientConfig): number {
  const w = config?.weights ?? {
    claim_confidence: 0.3,
    contradiction_resolution: 0.3,
    goal_completion: 0.25,
    risk_score_inverse: 0.15,
  };
  const clampedRatio = (val: number, target: number) => Math.min(val / target, 1);
  const claimPart = clampedRatio(snapshot.claims_active_avg_confidence, 0.85) * (w.claim_confidence ?? 0.3);
  const contradictionPart =
    (snapshot.contradictions_total_count === 0
      ? 1
      : 1 - snapshot.contradictions_unresolved_count / snapshot.contradictions_total_count) *
    (w.contradiction_resolution ?? 0.3);
  const goalPart = snapshot.goals_completion_ratio * (w.goal_completion ?? 0.25);
  const riskPart = (1 - Math.min(snapshot.scope_risk_score, 1)) * (w.risk_score_inverse ?? 0.15);
  return Math.min(1, Math.max(0, claimPart + contradictionPart + goalPart + riskPart));
}

/**
 * Compute goal score for a scope (loads snapshot and config).
 */
export async function computeGoalScoreForScope(scopeId: string): Promise<number> {
  const snapshot = await loadFinalitySnapshot(scopeId);
  const config = loadFinalityConfig();
  return computeGoalScore(snapshot, config.goal_gradient);
}

/** Normalize condition to "key: op value" string (YAML may give object). */
function conditionToString(c: string | Record<string, unknown>): string {
  if (typeof c === "string") return c;
  const entries = Object.entries(c);
  if (entries.length === 0) return "";
  const [k, v] = entries[0];
  return `${k}: ${typeof v === "string" ? v : String(v)}`;
}

/**
 * Path A: threshold convergence (all conditions met) -> RESOLVED.
 * Path B: goal score in [near, auto) -> return FinalityReviewRequest for HITL.
 */
export interface ConvergenceData {
  rate: number;
  estimated_rounds: number | null;
  plateau_rounds: number;
  lyapunov_v: number;
  highest_pressure: string;
  is_monotonic: boolean;
  is_plateaued: boolean;
  score_history: number[];
  /** Gate C: trajectory quality 0–1; required >= 0.7 for auto RESOLVED. */
  trajectory_quality: number;
  /** Gate C: oscillation detected (blocks or downgrades auto-resolve). */
  oscillation_detected: boolean;
}

export interface FinalityReviewRequest {
  type: "finality_review";
  scope_id: string;
  goal_score: number;
  near_threshold: number;
  auto_threshold: number;
  gap: number;
  dimension_breakdown: {
    name: string;
    score: number;
    weight: number;
    status: "ok" | "partial" | "blocking";
    detail: string;
  }[];
  blockers: { type: string; node_ids: string[]; description: string }[];
  llm_explanation: string;
  suggested_actions: string[];
  options: FinalityOption[];
  convergence?: ConvergenceData;
}

export type FinalityOption =
  | { action: "approve_finality"; label: string }
  | { action: "provide_resolution"; label: string }
  | { action: "escalate"; label: string }
  | { action: "defer"; days: number; label: string };

export type FinalityResult =
  | { kind: "status"; status: CaseStatus }
  | { kind: "review"; request: FinalityReviewRequest };

/** Gate D: true when quiescence is disabled or snapshot meets idle_cycles and window_ms. */
function isQuiescent(snapshot: FinalitySnapshot, quiescence?: QuiescenceConfig): boolean {
  if (!quiescence || (quiescence.idle_cycles_min <= 0 && quiescence.window_ms <= 0)) return true;
  const idle = snapshot.scope_idle_cycles ?? 0;
  const ageMs = snapshot.scope_last_delta_age_ms ?? 0;
  return idle >= quiescence.idle_cycles_min && ageMs >= quiescence.window_ms;
}

async function emitSessionFinalized(scopeId: string): Promise<void> {
  try {
    const { appendEvent } = await import("./contextWal.js");
    await appendEvent({ type: "session_finalized", scope_id: scopeId });
  } catch {
    // WAL may be unavailable
  }
}

async function emitFinalityCertificate(scopeId: string): Promise<void> {
  try {
    const { buildCertificatePayload, signCertificate, persistCertificate } = await import("./finalityCertificates.js");
    const payload = buildCertificatePayload(scopeId, "RESOLVED");
    const jws = signCertificate(payload);
    await persistCertificate(scopeId, jws, payload);
  } catch {
    // table or key may be unavailable
  }
}

export async function evaluateFinality(scopeId: string): Promise<FinalityResult | null> {
  // Human-approved finality: skip re-HITL and treat as RESOLVED
  try {
    const { getLatestFinalityDecision } = await import("./finalityDecisions.js");
    const latest = await getLatestFinalityDecision(scopeId);
    if (latest?.option === "approve_finality") {
      await emitSessionFinalized(scopeId);
      await emitFinalityCertificate(scopeId);
      return { kind: "status", status: "RESOLVED" };
    }
  } catch {
    // table may not exist or DATABASE_URL unset
  }

  const snapshot = await loadFinalitySnapshot(scopeId);
  const config = loadFinalityConfig();
  const thresholds = getFinalityThresholds();
  const near = config.goal_gradient?.near_finality_threshold ?? thresholds.nearFinalityThreshold;
  const auto = config.goal_gradient?.auto_finality_threshold ?? thresholds.autoFinalityThreshold;
  const goalScore = computeGoalScore(snapshot, config.goal_gradient);

  // --- Convergence tracking (graceful degradation if DB unavailable) ---
  let convergenceData: ConvergenceData | undefined;
  try {
    const {
      computeLyapunovV,
      computePressure,
      computeDimensionScores,
      recordConvergencePoint,
      getConvergenceState,
      DEFAULT_CONVERGENCE_CONFIG,
    } = await import("./convergenceTracker.js");

    const lyapunovV = computeLyapunovV(snapshot, undefined, config.goal_gradient?.weights);
    const pressure = computePressure(snapshot, config.goal_gradient?.weights);
    const dimensionScores = computeDimensionScores(snapshot, config.goal_gradient);

    // Record this evaluation cycle
    const epoch = snapshot.scope_idle_cycles ?? 0; // best available epoch proxy
    await recordConvergencePoint(scopeId, epoch, goalScore, lyapunovV, dimensionScores, pressure);

    // Analyze convergence state
    const convConfig = {
      ...DEFAULT_CONVERGENCE_CONFIG,
      ...(config.convergence ?? {}),
    };
    const convergence = await getConvergenceState(scopeId, convConfig, auto);
    const divergenceRate = config.convergence?.divergence_rate ?? DEFAULT_CONVERGENCE_CONFIG.divergence_rate;

    convergenceData = {
      rate: convergence.convergence_rate,
      estimated_rounds: convergence.estimated_rounds,
      plateau_rounds: convergence.plateau_rounds,
      lyapunov_v: lyapunovV,
      highest_pressure: convergence.highest_pressure_dimension,
      is_monotonic: convergence.is_monotonic,
      is_plateaued: convergence.is_plateaued,
      score_history: convergence.history.map((p) => p.goal_score),
      trajectory_quality: convergence.trajectory_quality,
      oscillation_detected: convergence.oscillation_detected,
    };

    // Divergence detection: V is increasing → system moving away from finality
    if (convergence.convergence_rate < divergenceRate && convergence.history.length >= 3) {
      return { kind: "status", status: "ESCALATED" };
    }
  } catch {
    // convergence_history table may not exist yet; proceed without convergence data
  }

  // Gate E: minimum content — do not auto-resolve or trigger HITL when there's no meaningful content.
  // When all dimensions are 1.0 only because there are zero claims/goals/risks, the score is vacuously high.
  const hasContent = snapshot.claims_active_count > 0 || snapshot.goals_completion_ratio < 1;
  if (!hasContent) {
    return { kind: "status", status: "ACTIVE" };
  }

  // Path A: RESOLVED if all hard conditions hold and goal score >= auto
  // Monotonicity gate (Aegean): require stable non-decreasing score for β rounds
  // Gate C: trajectory quality >= 0.7 (no oscillation / spike-drop)
  // Gate D: quiescence (idle_cycles + last_delta_age window) when configured
  const resolvedRule = config.finality?.RESOLVED;
  if (resolvedRule?.conditions?.length) {
    const conditions = resolvedRule.conditions.map(conditionToString);
    const allMet = resolvedRule.mode === "all" && conditions.every((c) => evaluateOne(c, snapshot));
    const isMonotonic = convergenceData?.is_monotonic ?? true; // default to true if no convergence data
    const trajectoryOk = (convergenceData?.trajectory_quality ?? 1) >= 0.7;
    const quiescent = isQuiescent(snapshot, config.quiescence);
    if (allMet && goalScore >= auto && isMonotonic && trajectoryOk && quiescent) {
      await emitSessionFinalized(scopeId);
      await emitFinalityCertificate(scopeId);
      return { kind: "status", status: "RESOLVED" };
    }
  }

  // Path B: near <= goalScore < auto -> HITL review (payload built in hitlFinalityRequest)
  if (goalScore >= near && goalScore < auto) {
    const dimension_breakdown = buildDimensionBreakdown(snapshot, config.goal_gradient);
    const blockers = buildBlockers(snapshot);
    const request: FinalityReviewRequest = {
      type: "finality_review",
      scope_id: scopeId,
      goal_score: goalScore,
      near_threshold: near,
      auto_threshold: auto,
      gap: auto - goalScore,
      dimension_breakdown,
      blockers,
      llm_explanation: "",
      suggested_actions: [],
      options: [
        { action: "approve_finality", label: "Mark as Resolved now" },
        { action: "provide_resolution", label: "Add missing resolutions" },
        { action: "escalate", label: "Escalate to authority" },
        { action: "defer", days: 7, label: "Defer review (7 days)" },
      ],
      convergence: convergenceData,
    };
    return { kind: "review", request };
  }

  // Other finality states (ESCALATED, BLOCKED, EXPIRED)
  for (const [status, rule] of Object.entries(config.finality ?? {})) {
    if (status === "RESOLVED" || !rule?.conditions?.length) continue;
    const conditions = rule.conditions.map(conditionToString);
    const matched =
      rule.mode === "all"
        ? conditions.every((c) => evaluateOne(c, snapshot))
        : conditions.some((c) => evaluateOne(c, snapshot));
    if (matched) {
      return { kind: "status", status: status as CaseStatus };
    }
  }

  return null; // ACTIVE
}

function buildDimensionBreakdown(
  snapshot: FinalitySnapshot,
  goalGradient?: GoalGradientConfig,
): FinalityReviewRequest["dimension_breakdown"] {
  const w = goalGradient?.weights ?? {
    claim_confidence: 0.3,
    contradiction_resolution: 0.3,
    goal_completion: 0.25,
    risk_score_inverse: 0.15,
  };
  const clampedRatio = (v: number, t: number) => Math.min(v / t, 1);
  const claimScore = clampedRatio(snapshot.claims_active_avg_confidence, 0.85);
  const contraScore =
    snapshot.contradictions_total_count === 0
      ? 1
      : 1 - snapshot.contradictions_unresolved_count / snapshot.contradictions_total_count;
  const goalScore = snapshot.goals_completion_ratio;
  const riskScore = 1 - Math.min(snapshot.scope_risk_score, 1);

  return [
    {
      name: "claim_confidence",
      score: claimScore,
      weight: w.claim_confidence ?? 0.3,
      status: snapshot.claims_active_min_confidence >= 0.85 ? "ok" : snapshot.claims_active_min_confidence >= 0.65 ? "partial" : "blocking",
      detail: `min ${(snapshot.claims_active_min_confidence * 100).toFixed(0)}%, avg ${(snapshot.claims_active_avg_confidence * 100).toFixed(0)}%`,
    },
    {
      name: "contradiction_resolution",
      score: contraScore,
      weight: w.contradiction_resolution ?? 0.3,
      status: snapshot.contradictions_unresolved_count === 0 ? "ok" : "blocking",
      detail: `${snapshot.contradictions_unresolved_count} of ${snapshot.contradictions_total_count} contradictions unresolved`,
    },
    {
      name: "goal_completion",
      score: goalScore,
      weight: w.goal_completion ?? 0.25,
      status: goalScore >= 0.9 ? "ok" : goalScore >= 0.7 ? "partial" : "blocking",
      detail: `completion ratio ${(goalScore * 100).toFixed(0)}%`,
    },
    {
      name: "risk_score_inverse",
      score: riskScore,
      weight: w.risk_score_inverse ?? 0.15,
      status: snapshot.scope_risk_score < 0.2 ? "ok" : snapshot.scope_risk_score < 0.5 ? "partial" : "blocking",
      detail: `scope risk score ${(snapshot.scope_risk_score * 100).toFixed(0)}%`,
    },
  ];
}

function buildBlockers(snapshot: FinalitySnapshot): FinalityReviewRequest["blockers"] {
  const out: FinalityReviewRequest["blockers"] = [];
  if (snapshot.contradictions_unresolved_count > 0) {
    out.push({
      type: "unresolved_contradiction",
      node_ids: [],
      description: `${snapshot.contradictions_unresolved_count} unresolved contradiction(s)`,
    });
  }
  if (snapshot.risks_critical_active_count > 0) {
    out.push({
      type: "critical_risk",
      node_ids: [],
      description: `${snapshot.risks_critical_active_count} critical risk(s) active`,
    });
  }
  if (snapshot.claims_active_min_confidence < 0.85) {
    out.push({
      type: "low_confidence_claims",
      node_ids: [],
      description: `min claim confidence ${(snapshot.claims_active_min_confidence * 100).toFixed(0)}% (need 85%)`,
    });
  }
  if (snapshot.goals_completion_ratio < 0.9) {
    out.push({
      type: "missing_goal_resolution",
      node_ids: [],
      description: `goals completion ${(snapshot.goals_completion_ratio * 100).toFixed(0)}% (need 90%)`,
    });
  }
  return out;
}

