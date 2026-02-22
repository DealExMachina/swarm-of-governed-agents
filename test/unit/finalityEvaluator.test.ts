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

describe("finalityEvaluator", () => {
  beforeEach(() => {
    vi.stubEnv("FINALITY_PATH", FINALITY_PATH);
    vi.stubEnv("NEAR_FINALITY_THRESHOLD", "0.75");
    vi.stubEnv("AUTO_FINALITY_THRESHOLD", "0.92");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("loadFinalitySnapshot", () => {
    it("returns default snapshot for any scope", async () => {
      const s = await loadFinalitySnapshot("scope-1");
      expect(s.claims_active_min_confidence).toBe(1);
      expect(s.contradictions_unresolved_count).toBe(0);
      expect(s.scope_risk_score).toBe(0);
    });
  });

  describe("loadFinalityConfig", () => {
    it("loads finality.yaml with goal_gradient and finality states", () => {
      const config = loadFinalityConfig();
      expect(config.goal_gradient).toBeDefined();
      expect(config.goal_gradient?.near_finality_threshold).toBe(0.75);
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
    it("returns status RESOLVED when default snapshot meets all conditions and goal score >= auto", async () => {
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
  });
});
