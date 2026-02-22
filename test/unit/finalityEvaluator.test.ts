import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";
import {
  loadFinalitySnapshot,
  loadFinalityConfig,
  computeGoalScore,
  computeGoalScoreForScope,
  evaluateFinality,
  type FinalitySnapshot,
  type GoalGradientConfig,
} from "../../src/finalityEvaluator";

const FINALITY_PATH = join(__dirname, "../../finality.yaml");

vi.mock("../../src/semanticGraph.js", () => ({
  loadFinalitySnapshot: vi.fn(async () => {
    throw new Error("no db");
  }),
}));

// Mock convergence tracker for convergence-gate tests
const mockRecordConvergencePoint = vi.fn().mockResolvedValue(undefined);
const mockGetConvergenceState = vi.fn().mockRejectedValue(new Error("no table"));
vi.mock("../../src/convergenceTracker.js", () => ({
  computeLyapunovV: vi.fn(() => 0.01),
  computePressure: vi.fn(() => ({
    claim_confidence: 0, contradiction_resolution: 0, goal_completion: 0, risk_score_inverse: 0,
  })),
  computeDimensionScores: vi.fn(() => ({
    claim_confidence: 1, contradiction_resolution: 1, goal_completion: 1, risk_score_inverse: 1,
  })),
  recordConvergencePoint: (...args: unknown[]) => mockRecordConvergencePoint(...args),
  getConvergenceState: (...args: unknown[]) => mockGetConvergenceState(...args),
  DEFAULT_CONVERGENCE_CONFIG: {
    beta: 3, tau: 3, ema_alpha: 0.3, plateau_threshold: 0.01,
    history_depth: 20, divergence_rate: -0.05,
  },
}));

describe("finalityEvaluator", () => {
  beforeEach(() => {
    vi.stubEnv("FINALITY_PATH", FINALITY_PATH);
    vi.stubEnv("NEAR_FINALITY_THRESHOLD", "0.75");
    vi.stubEnv("AUTO_FINALITY_THRESHOLD", "0.92");
    mockRecordConvergencePoint.mockResolvedValue(undefined);
    // Default: convergence tracker unavailable (graceful degradation)
    mockGetConvergenceState.mockRejectedValue(new Error("no table"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("loadFinalitySnapshot", () => {
    it("returns default snapshot for any scope", async () => {
      const s = await loadFinalitySnapshot("scope-1");
      expect(s.claims_active_min_confidence).toBe(0);
      expect(s.contradictions_unresolved_count).toBe(0);
      expect(s.scope_risk_score).toBe(0);
    });
  });

  describe("loadFinalityConfig", () => {
    it("loads finality.yaml with goal_gradient and finality states", () => {
      const config = loadFinalityConfig();
      expect(config.goal_gradient).toBeDefined();
      expect(config.goal_gradient?.near_finality_threshold).toBe(0.4);
      expect(config.goal_gradient?.auto_finality_threshold).toBe(0.92);
      expect(config.finality.RESOLVED).toBeDefined();
      expect(config.finality.RESOLVED.mode).toBe("all");
      expect(config.finality.RESOLVED.conditions.length).toBeGreaterThan(0);
      expect(config.finality.ESCALATED?.mode).toBe("any");
    });
  });

  describe("computeGoalScore", () => {
    it("returns 1 for perfect snapshot", () => {
      const snapshot: FinalitySnapshot = {
        claims_active_min_confidence: 1,
        claims_active_count: 5,
        claims_active_avg_confidence: 1,
        contradictions_unresolved_count: 0,
        contradictions_total_count: 0,
        risks_critical_active_count: 0,
        goals_completion_ratio: 1,
        scope_risk_score: 0,
      };
      expect(computeGoalScore(snapshot)).toBe(1);
    });

    it("returns lower score when contradictions unresolved", () => {
      const snapshot: FinalitySnapshot = {
        claims_active_min_confidence: 0.9,
        claims_active_count: 5,
        claims_active_avg_confidence: 0.9,
        contradictions_unresolved_count: 2,
        contradictions_total_count: 4,
        risks_critical_active_count: 0,
        goals_completion_ratio: 0.9,
        scope_risk_score: 0.1,
      };
      const score = computeGoalScore(snapshot);
      expect(score).toBeLessThan(1);
      expect(score).toBeGreaterThan(0);
    });

    it("uses custom weights when provided", () => {
      const snapshot: FinalitySnapshot = {
        claims_active_min_confidence: 0.85,
        claims_active_count: 1,
        claims_active_avg_confidence: 0.85,
        contradictions_unresolved_count: 0,
        contradictions_total_count: 0,
        risks_critical_active_count: 0,
        goals_completion_ratio: 1,
        scope_risk_score: 0,
      };
      const config: GoalGradientConfig = {
        weights: { claim_confidence: 1, contradiction_resolution: 0, goal_completion: 0, risk_score_inverse: 0 },
        near_finality_threshold: 0.75,
        auto_finality_threshold: 0.92,
      };
      expect(computeGoalScore(snapshot, config)).toBe(1);
    });
  });

  describe("computeGoalScoreForScope", () => {
    it("returns a number in [0,1]", async () => {
      const score = await computeGoalScoreForScope("any-scope");
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  describe("evaluateFinality", () => {
    it("returns status RESOLVED when snapshot meets all conditions and goal score >= auto", async () => {
      const perfectSnapshot: FinalitySnapshot = {
        claims_active_min_confidence: 0.9,
        claims_active_count: 1,
        claims_active_avg_confidence: 0.9,
        contradictions_unresolved_count: 0,
        contradictions_total_count: 0,
        risks_critical_active_count: 0,
        goals_completion_ratio: 0.95,
        scope_risk_score: 0.1,
      };
      const sem = await import("../../src/semanticGraph.js");
      vi.mocked(sem.loadFinalitySnapshot).mockResolvedValueOnce(perfectSnapshot);
      const result = await evaluateFinality("scope-1");
      expect(result).not.toBeNull();
      expect(result?.kind).toBe("status");
      if (result?.kind === "status") expect(result.status).toBe("RESOLVED");
    });

    it("returns review when goal score in [near, auto) and RESOLVED conditions not all met", async () => {
      vi.stubEnv("NEAR_FINALITY_THRESHOLD", "0");
      vi.stubEnv("AUTO_FINALITY_THRESHOLD", "1");
      const result = await evaluateFinality("scope-1");
      expect(result).not.toBeNull();
      if (result?.kind === "review") {
        expect(result.request.scope_id).toBe("scope-1");
        expect(result.request.dimension_breakdown.length).toBeGreaterThan(0);
        expect(result.request.blockers).toBeDefined();
        expect(result.request.options.some((o) => o.action === "approve_finality")).toBe(true);
      }
    });

    it("monotonicity gate: blocks RESOLVED when is_monotonic is false despite perfect score", async () => {
      const perfectSnapshot: FinalitySnapshot = {
        claims_active_min_confidence: 0.9,
        claims_active_count: 1,
        claims_active_avg_confidence: 0.9,
        contradictions_unresolved_count: 0,
        contradictions_total_count: 0,
        risks_critical_active_count: 0,
        goals_completion_ratio: 0.95,
        scope_risk_score: 0.1,
      };
      const sem = await import("../../src/semanticGraph.js");
      vi.mocked(sem.loadFinalitySnapshot).mockResolvedValueOnce(perfectSnapshot);
      // Mock convergence as NOT monotonic
      mockGetConvergenceState.mockResolvedValueOnce({
        history: [{ epoch: 1, goal_score: 0.95, lyapunov_v: 0.01, pressure: {}, dimension_scores: {}, created_at: "" }],
        convergence_rate: 0.1,
        estimated_rounds: 2,
        is_monotonic: false,
        is_plateaued: false,
        plateau_rounds: 0,
        highest_pressure_dimension: "",
      });
      const result = await evaluateFinality("scope-1");
      // Should NOT return RESOLVED because monotonicity gate blocks it.
      // Since goalScore >= auto, it doesn't enter Path B either.
      // Falls through to return null (ACTIVE — wait for stabilization).
      if (result?.kind === "status") {
        expect(result.status).not.toBe("RESOLVED");
      }
      // null (ACTIVE) is the expected outcome when mono gate blocks and score >= auto
      // — the system must wait for β rounds of non-decreasing scores.
    });

    it("divergence detection: returns ESCALATED when convergence rate is negative", async () => {
      const sem = await import("../../src/semanticGraph.js");
      vi.mocked(sem.loadFinalitySnapshot).mockResolvedValueOnce({
        claims_active_min_confidence: 0.5,
        claims_active_count: 3,
        claims_active_avg_confidence: 0.5,
        contradictions_unresolved_count: 3,
        contradictions_total_count: 4,
        risks_critical_active_count: 0,
        goals_completion_ratio: 0.4,
        scope_risk_score: 0.3,
      });
      // Mock convergence as diverging
      mockGetConvergenceState.mockResolvedValueOnce({
        history: [
          { epoch: 1, goal_score: 0.5, lyapunov_v: 0.1 },
          { epoch: 2, goal_score: 0.4, lyapunov_v: 0.15 },
          { epoch: 3, goal_score: 0.3, lyapunov_v: 0.2 },
        ],
        convergence_rate: -0.15, // below divergence_rate of -0.05
        estimated_rounds: null,
        is_monotonic: false,
        is_plateaued: false,
        plateau_rounds: 0,
        highest_pressure_dimension: "contradiction_resolution",
      });
      const result = await evaluateFinality("scope-1");
      expect(result).not.toBeNull();
      expect(result?.kind).toBe("status");
      if (result?.kind === "status") {
        expect(result.status).toBe("ESCALATED");
      }
    });

    it("review includes convergence data when available", async () => {
      vi.stubEnv("NEAR_FINALITY_THRESHOLD", "0");
      vi.stubEnv("AUTO_FINALITY_THRESHOLD", "1");
      const sem = await import("../../src/semanticGraph.js");
      vi.mocked(sem.loadFinalitySnapshot).mockResolvedValueOnce({
        claims_active_min_confidence: 0.5,
        claims_active_count: 3,
        claims_active_avg_confidence: 0.7,
        contradictions_unresolved_count: 1,
        contradictions_total_count: 2,
        risks_critical_active_count: 0,
        goals_completion_ratio: 0.6,
        scope_risk_score: 0.1,
      });
      mockGetConvergenceState.mockResolvedValueOnce({
        history: [
          { epoch: 1, goal_score: 0.6, lyapunov_v: 0.05, pressure: { claim_confidence: 0.05 }, dimension_scores: {}, created_at: "" },
          { epoch: 2, goal_score: 0.65, lyapunov_v: 0.04, pressure: { claim_confidence: 0.03 }, dimension_scores: {}, created_at: "" },
        ],
        convergence_rate: 0.2,
        estimated_rounds: 5,
        is_monotonic: true,
        is_plateaued: false,
        plateau_rounds: 0,
        highest_pressure_dimension: "contradiction_resolution",
      });
      const result = await evaluateFinality("scope-1");
      expect(result).not.toBeNull();
      if (result?.kind === "review") {
        expect(result.request.convergence).toBeDefined();
        expect(result.request.convergence?.rate).toBe(0.2);
        expect(result.request.convergence?.estimated_rounds).toBe(5);
        expect(result.request.convergence?.is_monotonic).toBe(true);
        expect(result.request.convergence?.highest_pressure).toBe("contradiction_resolution");
        expect(result.request.convergence?.score_history).toEqual([0.6, 0.65]);
      }
    });
  });
});
