import { describe, it, expect } from "vitest";
import {
  computeLyapunovV,
  computePressure,
  computeDimensionScores,
  analyzeConvergence,
  DEFAULT_CONVERGENCE_CONFIG,
  type ConvergencePoint,
  type ConvergenceConfig,
} from "../../src/convergenceTracker";
import type { FinalitySnapshot } from "../../src/finalityEvaluator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<FinalitySnapshot> = {}): FinalitySnapshot {
  return {
    claims_active_min_confidence: 1,
    claims_active_count: 5,
    claims_active_avg_confidence: 1,
    contradictions_unresolved_count: 0,
    contradictions_total_count: 0,
    risks_critical_active_count: 0,
    goals_completion_ratio: 1,
    scope_risk_score: 0,
    ...overrides,
  };
}

function makePoint(overrides: Partial<ConvergencePoint> = {}): ConvergencePoint {
  return {
    epoch: 1,
    goal_score: 0.5,
    lyapunov_v: 0.1,
    dimension_scores: { claim_confidence: 0.5, contradiction_resolution: 0.5, goal_completion: 0.5, risk_score_inverse: 0.5 },
    pressure: { claim_confidence: 0.15, contradiction_resolution: 0.15, goal_completion: 0.125, risk_score_inverse: 0.075 },
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Generate a history of N points with linearly improving scores. */
function makeImprovingHistory(n: number, startScore: number, endScore: number): ConvergencePoint[] {
  const points: ConvergencePoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 1 : i / (n - 1);
    const score = startScore + t * (endScore - startScore);
    // V decreases as score increases (inverse relationship, simplified)
    const v = Math.max(0.001, (1 - score) ** 2 * 0.3);
    points.push(makePoint({
      epoch: i + 1,
      goal_score: score,
      lyapunov_v: v,
      pressure: {
        claim_confidence: Math.max(0, 0.3 * (1 - score)),
        contradiction_resolution: Math.max(0, 0.3 * (1 - score)),
        goal_completion: Math.max(0, 0.25 * (1 - score)),
        risk_score_inverse: Math.max(0, 0.15 * (1 - score)),
      },
    }));
  }
  return points;
}

// ---------------------------------------------------------------------------
// computeLyapunovV
// ---------------------------------------------------------------------------

describe("computeLyapunovV", () => {
  it("returns 0 for a perfect snapshot", () => {
    const snapshot = makeSnapshot();
    const v = computeLyapunovV(snapshot);
    expect(v).toBe(0);
  });

  it("returns > 0 for an imperfect snapshot", () => {
    const snapshot = makeSnapshot({
      claims_active_avg_confidence: 0.5,
      contradictions_unresolved_count: 2,
      contradictions_total_count: 4,
      goals_completion_ratio: 0.6,
      scope_risk_score: 0.3,
    });
    const v = computeLyapunovV(snapshot);
    expect(v).toBeGreaterThan(0);
  });

  it("increases as dimensions worsen", () => {
    const good = makeSnapshot({
      claims_active_avg_confidence: 0.8,
      goals_completion_ratio: 0.9,
    });
    const bad = makeSnapshot({
      claims_active_avg_confidence: 0.4,
      goals_completion_ratio: 0.3,
    });
    expect(computeLyapunovV(bad)).toBeGreaterThan(computeLyapunovV(good));
  });

  it("returns 0 when avg_confidence >= 0.85 and everything else perfect", () => {
    const snapshot = makeSnapshot({ claims_active_avg_confidence: 0.85 });
    const v = computeLyapunovV(snapshot);
    expect(v).toBe(0);
  });

  it("handles zero contradictions total (no gap)", () => {
    const snapshot = makeSnapshot({ contradictions_total_count: 0, contradictions_unresolved_count: 0 });
    const v = computeLyapunovV(snapshot);
    // contradiction_resolution = 1 (no contradictions = perfect), gap = 0
    expect(v).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computePressure
// ---------------------------------------------------------------------------

describe("computePressure", () => {
  it("returns near-zero pressure when all dimensions at target", () => {
    const snapshot = makeSnapshot();
    const pressure = computePressure(snapshot);
    expect(pressure.claim_confidence).toBeCloseTo(0, 5);
    expect(pressure.contradiction_resolution).toBeCloseTo(0, 5);
    expect(pressure.goal_completion).toBeCloseTo(0, 5);
    expect(pressure.risk_score_inverse).toBeCloseTo(0, 5);
  });

  it("has highest pressure on the worst dimension", () => {
    const snapshot = makeSnapshot({
      claims_active_avg_confidence: 0.85,  // at target → low pressure
      contradictions_unresolved_count: 3,
      contradictions_total_count: 4,        // 75% unresolved → high pressure
      goals_completion_ratio: 0.95,         // near target → low pressure
      scope_risk_score: 0.1,               // near target → low pressure
    });
    const pressure = computePressure(snapshot);
    expect(pressure.contradiction_resolution).toBeGreaterThan(pressure.claim_confidence);
    expect(pressure.contradiction_resolution).toBeGreaterThan(pressure.goal_completion);
    expect(pressure.contradiction_resolution).toBeGreaterThan(pressure.risk_score_inverse);
  });

  it("respects weights", () => {
    const snapshot = makeSnapshot({ goals_completion_ratio: 0, scope_risk_score: 1 });
    const pressure = computePressure(snapshot);
    // goal weight = 0.25, risk weight = 0.15 → goal pressure > risk pressure for same gap
    expect(pressure.goal_completion).toBeGreaterThan(pressure.risk_score_inverse);
  });
});

// ---------------------------------------------------------------------------
// computeDimensionScores
// ---------------------------------------------------------------------------

describe("computeDimensionScores", () => {
  it("returns all 1s for perfect snapshot", () => {
    const scores = computeDimensionScores(makeSnapshot());
    expect(scores.claim_confidence).toBe(1);
    expect(scores.contradiction_resolution).toBe(1);
    expect(scores.goal_completion).toBe(1);
    expect(scores.risk_score_inverse).toBe(1);
  });

  it("clamps claim confidence ratio to 1", () => {
    const scores = computeDimensionScores(makeSnapshot({ claims_active_avg_confidence: 0.95 }));
    // 0.95 / 0.85 > 1, clamped to 1
    expect(scores.claim_confidence).toBe(1);
  });

  it("computes contradiction resolution correctly", () => {
    const scores = computeDimensionScores(makeSnapshot({
      contradictions_unresolved_count: 1,
      contradictions_total_count: 4,
    }));
    expect(scores.contradiction_resolution).toBeCloseTo(0.75, 5);
  });
});

// ---------------------------------------------------------------------------
// analyzeConvergence
// ---------------------------------------------------------------------------

describe("analyzeConvergence", () => {
  it("returns safe defaults for empty history", () => {
    const state = analyzeConvergence([]);
    expect(state.convergence_rate).toBe(0);
    expect(state.estimated_rounds).toBeNull();
    expect(state.is_monotonic).toBe(false);
    expect(state.is_plateaued).toBe(false);
    expect(state.plateau_rounds).toBe(0);
    expect(state.highest_pressure_dimension).toBe("");
  });

  it("returns safe defaults for single point", () => {
    const state = analyzeConvergence([makePoint({ pressure: { claim_confidence: 0.2, contradiction_resolution: 0.1 } })]);
    expect(state.convergence_rate).toBe(0);
    expect(state.estimated_rounds).toBeNull();
    expect(state.is_monotonic).toBe(false);
    expect(state.is_plateaued).toBe(false);
    expect(state.highest_pressure_dimension).toBe("claim_confidence");
  });

  describe("monotonicity", () => {
    it("detects monotonically improving history (beta=3)", () => {
      const history = makeImprovingHistory(5, 0.5, 0.9);
      const state = analyzeConvergence(history, { ...DEFAULT_CONVERGENCE_CONFIG, beta: 3 });
      expect(state.is_monotonic).toBe(true);
    });

    it("detects non-monotonic history when score drops", () => {
      const history = makeImprovingHistory(4, 0.5, 0.8);
      // Insert a drop at position 3
      history[3] = makePoint({ epoch: 4, goal_score: 0.6, lyapunov_v: 0.05 });
      const state = analyzeConvergence(history, { ...DEFAULT_CONVERGENCE_CONFIG, beta: 3 });
      expect(state.is_monotonic).toBe(false);
    });

    it("requires at least beta points for monotonicity", () => {
      const history = makeImprovingHistory(2, 0.5, 0.7);
      const state = analyzeConvergence(history, { ...DEFAULT_CONVERGENCE_CONFIG, beta: 3 });
      expect(state.is_monotonic).toBe(false);
    });

    it("allows tiny epsilon tolerance (0.001)", () => {
      const history = [
        makePoint({ epoch: 1, goal_score: 0.80, lyapunov_v: 0.05 }),
        makePoint({ epoch: 2, goal_score: 0.7995, lyapunov_v: 0.049 }), // drop of 0.0005 < epsilon
        makePoint({ epoch: 3, goal_score: 0.80, lyapunov_v: 0.048 }),
      ];
      const state = analyzeConvergence(history, { ...DEFAULT_CONVERGENCE_CONFIG, beta: 3 });
      expect(state.is_monotonic).toBe(true);
    });
  });

  describe("plateau detection", () => {
    it("detects plateau when score barely changes", () => {
      // Score oscillates around 0.70 with tiny deltas
      const history: ConvergencePoint[] = [];
      for (let i = 0; i < 8; i++) {
        const score = 0.70 + (i % 2 === 0 ? 0.001 : -0.001);
        history.push(makePoint({
          epoch: i + 1,
          goal_score: score,
          lyapunov_v: (1 - score) ** 2 * 0.3,
        }));
      }
      const state = analyzeConvergence(history, { ...DEFAULT_CONVERGENCE_CONFIG, tau: 3 });
      expect(state.is_plateaued).toBe(true);
      expect(state.plateau_rounds).toBeGreaterThanOrEqual(3);
    });

    it("does not false-plateau during fast convergence", () => {
      // Score jumps 5% each round
      const history = makeImprovingHistory(5, 0.5, 0.9);
      const state = analyzeConvergence(history, { ...DEFAULT_CONVERGENCE_CONFIG, tau: 3 });
      expect(state.is_plateaued).toBe(false);
    });

    it("does not plateau with insufficient history", () => {
      const history = [
        makePoint({ epoch: 1, goal_score: 0.70, lyapunov_v: 0.03 }),
        makePoint({ epoch: 2, goal_score: 0.70, lyapunov_v: 0.03 }),
      ];
      const state = analyzeConvergence(history, { ...DEFAULT_CONVERGENCE_CONFIG, tau: 3 });
      // Only 1 delta available (2 points → 1 delta), can't reach tau=3 plateau rounds
      expect(state.is_plateaued).toBe(false);
    });
  });

  describe("convergence rate", () => {
    it("is positive when V is decreasing", () => {
      const history = [
        makePoint({ epoch: 1, goal_score: 0.5, lyapunov_v: 0.10 }),
        makePoint({ epoch: 2, goal_score: 0.6, lyapunov_v: 0.07 }),
        makePoint({ epoch: 3, goal_score: 0.7, lyapunov_v: 0.04 }),
      ];
      const state = analyzeConvergence(history);
      expect(state.convergence_rate).toBeGreaterThan(0);
    });

    it("is negative when V is increasing (divergence)", () => {
      const history = [
        makePoint({ epoch: 1, goal_score: 0.7, lyapunov_v: 0.03 }),
        makePoint({ epoch: 2, goal_score: 0.6, lyapunov_v: 0.06 }),
        makePoint({ epoch: 3, goal_score: 0.5, lyapunov_v: 0.10 }),
      ];
      const state = analyzeConvergence(history);
      expect(state.convergence_rate).toBeLessThan(0);
    });

    it("provides finite estimated_rounds when converging", () => {
      const history = makeImprovingHistory(6, 0.3, 0.8);
      const state = analyzeConvergence(history);
      expect(state.estimated_rounds).not.toBeNull();
      expect(state.estimated_rounds).toBeGreaterThan(0);
      expect(state.estimated_rounds).toBeLessThan(1000);
    });

    it("returns null estimated_rounds when diverging", () => {
      const history = [
        makePoint({ epoch: 1, goal_score: 0.7, lyapunov_v: 0.03 }),
        makePoint({ epoch: 2, goal_score: 0.6, lyapunov_v: 0.06 }),
        makePoint({ epoch: 3, goal_score: 0.5, lyapunov_v: 0.10 }),
      ];
      const state = analyzeConvergence(history);
      expect(state.estimated_rounds).toBeNull();
    });

    it("returns 0 estimated_rounds when V is already near zero", () => {
      const history = [
        makePoint({ epoch: 1, goal_score: 0.95, lyapunov_v: 0.003 }),
        makePoint({ epoch: 2, goal_score: 0.96, lyapunov_v: 0.002 }),
      ];
      const state = analyzeConvergence(history);
      expect(state.estimated_rounds).toBe(0);
    });
  });

  describe("highest pressure dimension", () => {
    it("identifies the dimension with highest pressure", () => {
      const point = makePoint({
        pressure: {
          claim_confidence: 0.05,
          contradiction_resolution: 0.20,
          goal_completion: 0.10,
          risk_score_inverse: 0.02,
        },
      });
      const state = analyzeConvergence([point]);
      expect(state.highest_pressure_dimension).toBe("contradiction_resolution");
    });
  });

  describe("spike-and-drop scenario", () => {
    it("monotonicity gate blocks premature finality after score drop", () => {
      const history = [
        makePoint({ epoch: 1, goal_score: 0.70, lyapunov_v: 0.03 }),
        makePoint({ epoch: 2, goal_score: 0.80, lyapunov_v: 0.02 }),
        makePoint({ epoch: 3, goal_score: 0.95, lyapunov_v: 0.001 }), // spike
        makePoint({ epoch: 4, goal_score: 0.72, lyapunov_v: 0.025 }), // drop
      ];
      const state = analyzeConvergence(history, { ...DEFAULT_CONVERGENCE_CONFIG, beta: 3 });
      expect(state.is_monotonic).toBe(false);
      // Even though score was 0.95 at one point, monotonicity is broken
    });
  });

  describe("combined scenario: plateau + bottleneck identification", () => {
    it("identifies both plateau and highest pressure dimension simultaneously", () => {
      const history: ConvergencePoint[] = [];
      for (let i = 0; i < 6; i++) {
        history.push(makePoint({
          epoch: i + 1,
          goal_score: 0.65 + (i % 2 === 0 ? 0.002 : -0.001),
          lyapunov_v: 0.04,
          pressure: {
            claim_confidence: 0.02,
            contradiction_resolution: 0.18,
            goal_completion: 0.03,
            risk_score_inverse: 0.01,
          },
        }));
      }
      const state = analyzeConvergence(history, { ...DEFAULT_CONVERGENCE_CONFIG, tau: 3 });
      expect(state.is_plateaued).toBe(true);
      expect(state.highest_pressure_dimension).toBe("contradiction_resolution");
    });
  });

  describe("Gate C: oscillation and trajectory quality", () => {
    it("returns oscillation_detected false and high trajectory_quality for monotonic history", () => {
      const history = makeImprovingHistory(6, 0.5, 0.9);
      const state = analyzeConvergence(history);
      expect(state.oscillation_detected).toBe(false);
      expect(state.trajectory_quality).toBeGreaterThanOrEqual(0.8);
      expect(state.autocorrelation_lag1).not.toBeNull();
    });

    it("detects oscillation when direction changes >= 2", () => {
      const history: ConvergencePoint[] = [
        makePoint({ epoch: 1, goal_score: 0.70 }),
        makePoint({ epoch: 2, goal_score: 0.75 }),
        makePoint({ epoch: 3, goal_score: 0.72 }),
        makePoint({ epoch: 4, goal_score: 0.76 }),
        makePoint({ epoch: 5, goal_score: 0.73 }),
      ];
      const state = analyzeConvergence(history);
      expect(state.oscillation_detected).toBe(true);
      expect(state.trajectory_quality).toBeLessThan(1);
    });

    it("sets coordination_signal with metadata", () => {
      const history = makeImprovingHistory(4, 0.6, 0.85);
      const state = analyzeConvergence(history);
      expect(state.coordination_signal).toBeDefined();
      expect(state.coordination_signal?.signal_type).toBe("convergence");
      expect(state.coordination_signal?.metadata).toHaveProperty("highest_pressure_dimension");
      expect(state.coordination_signal?.metadata).toHaveProperty("trajectory_quality");
      expect(state.coordination_signal?.metadata).toHaveProperty("oscillation_detected");
    });

    it("returns autocorrelation_lag1 null for fewer than 4 points", () => {
      const history = makeImprovingHistory(3, 0.5, 0.7);
      const state = analyzeConvergence(history);
      expect(state.autocorrelation_lag1).toBeNull();
    });
  });
});
