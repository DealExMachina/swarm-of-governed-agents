#!/usr/bin/env tsx
/**
 * Benchmark harness for convergence tracker.
 *
 * Runs pure-math scenarios (no Docker, no Postgres, no NATS, no LLM).
 * Each scenario generates a sequence of FinalitySnapshots, runs them through
 * the convergence tracker, and checks the outcome against expectations.
 *
 * Usage: pnpm tsx scripts/benchmark-convergence.ts
 */

import {
  computeLyapunovV,
  computePressure,
  computeDimensionScores,
  analyzeConvergence,
  DEFAULT_CONVERGENCE_CONFIG,
  type ConvergencePoint,
  type ConvergenceConfig,
} from "../src/convergenceTracker.js";
import type { FinalitySnapshot } from "../src/finalityEvaluator.js";

// ---------------------------------------------------------------------------
// Scenario framework
// ---------------------------------------------------------------------------

interface Scenario {
  name: string;
  description: string;
  /** Generate a sequence of convergence points simulating agent work. */
  run(config: ConvergenceConfig): {
    points: ConvergencePoint[];
    expected: {
      /** Whether the system should be converging (alpha > 0) at the end. */
      should_converge: boolean;
      /** Whether plateau should be detected. */
      should_plateau: boolean;
      /** Whether monotonicity should hold. */
      should_be_monotonic: boolean;
      /** Expected highest-pressure dimension (if applicable). */
      expected_highest_pressure?: string;
      /** If converging, estimated_rounds should be non-null and positive. */
      should_have_eta: boolean;
    };
  };
}

function makeSnapshot(overrides: Partial<FinalitySnapshot> = {}): FinalitySnapshot {
  return {
    claims_active_min_confidence: 0.5,
    claims_active_count: 5,
    claims_active_avg_confidence: 0.5,
    contradictions_unresolved_count: 0,
    contradictions_total_count: 0,
    risks_critical_active_count: 0,
    goals_completion_ratio: 0.5,
    scope_risk_score: 0,
    ...overrides,
  };
}

function snapshotToPoint(epoch: number, snapshot: FinalitySnapshot, goalScore: number): ConvergencePoint {
  const lyapunovV = computeLyapunovV(snapshot);
  const pressure = computePressure(snapshot);
  const dimensionScores = computeDimensionScores(snapshot);
  return {
    epoch,
    goal_score: goalScore,
    lyapunov_v: lyapunovV,
    dimension_scores: dimensionScores,
    pressure,
    created_at: new Date().toISOString(),
  };
}

/** Compute goal score from a snapshot (same formula as computeGoalScore). */
function goalScore(snap: FinalitySnapshot): number {
  const claimPart = Math.min(snap.claims_active_avg_confidence / 0.85, 1) * 0.3;
  const contradictionPart =
    (snap.contradictions_total_count === 0
      ? 1
      : 1 - snap.contradictions_unresolved_count / snap.contradictions_total_count) * 0.3;
  const goalPart = snap.goals_completion_ratio * 0.25;
  const riskPart = (1 - Math.min(snap.scope_risk_score, 1)) * 0.15;
  return Math.min(1, Math.max(0, claimPart + contradictionPart + goalPart + riskPart));
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const scenarios: Scenario[] = [
  {
    name: "Steady convergence",
    description: "Each round improves all dimensions by ~5%. Should reach high score and detect monotonicity.",
    run(config) {
      const points: ConvergencePoint[] = [];
      for (let i = 0; i < 15; i++) {
        const t = i / 14;
        const snap = makeSnapshot({
          claims_active_avg_confidence: 0.5 + t * 0.45,
          claims_active_min_confidence: 0.5 + t * 0.45,
          goals_completion_ratio: 0.5 + t * 0.5,
          scope_risk_score: 0.3 * (1 - t),
          contradictions_unresolved_count: Math.max(0, Math.round(3 * (1 - t))),
          contradictions_total_count: 3,
        });
        const score = goalScore(snap);
        points.push(snapshotToPoint(i + 1, snap, score));
      }
      return {
        points,
        expected: {
          should_converge: true,
          should_plateau: false,
          should_be_monotonic: true,
          should_have_eta: false, // should be near 0 estimated rounds (already converged)
        },
      };
    },
  },
  {
    name: "Plateau at 0.70",
    description: "Oscillates around ~0.70 for many rounds. Should detect plateau.",
    run(config) {
      const points: ConvergencePoint[] = [];
      // Generate 10 rounds of flat oscillation around 0.70
      // (No initial improvement phase — start directly at plateau to ensure EMA detects it)
      for (let i = 0; i < 10; i++) {
        const jitter = (i % 2 === 0 ? 0.002 : -0.002);
        const snap = makeSnapshot({
          claims_active_avg_confidence: 0.70 + jitter,
          goals_completion_ratio: 0.65 + jitter,
          contradictions_unresolved_count: 1,
          contradictions_total_count: 2,
        });
        const score = goalScore(snap);
        points.push(snapshotToPoint(i + 1, snap, score));
      }
      return {
        points,
        expected: {
          should_converge: false,
          should_plateau: true,
          should_be_monotonic: false,
          should_have_eta: false,
        },
      };
    },
  },
  {
    name: "Spike-and-drop",
    description: "Score jumps to 0.95 then drops to 0.70. Monotonicity gate should block despite positive avg rate.",
    run(config) {
      const points: ConvergencePoint[] = [];
      // Build up to ~0.70
      for (let i = 0; i < 3; i++) {
        const t = i / 2;
        const snap = makeSnapshot({
          claims_active_avg_confidence: 0.5 + t * 0.2,
          goals_completion_ratio: 0.5 + t * 0.2,
        });
        points.push(snapshotToPoint(i + 1, snap, goalScore(snap)));
      }
      // Spike to 0.95
      const spikeSnap = makeSnapshot({
        claims_active_avg_confidence: 0.95,
        claims_active_min_confidence: 0.95,
        goals_completion_ratio: 0.95,
        scope_risk_score: 0,
      });
      points.push(snapshotToPoint(4, spikeSnap, goalScore(spikeSnap)));
      // Drop back to 0.70
      const dropSnap = makeSnapshot({
        claims_active_avg_confidence: 0.70,
        goals_completion_ratio: 0.65,
      });
      points.push(snapshotToPoint(5, dropSnap, goalScore(dropSnap)));
      return {
        points,
        expected: {
          // Average convergence rate is positive because 3/4 transitions improve.
          // This is correct — the key protection is the monotonicity gate (false).
          should_converge: true,
          should_plateau: false,
          should_be_monotonic: false, // THIS is the key: monotonicity is broken by the drop
          should_have_eta: true, // Rate is positive so ETA is computed (but unreliable)
        },
      };
    },
  },
  {
    name: "Divergence",
    description: "Contradictions increase each round. V should increase (diverging).",
    run(config) {
      const points: ConvergencePoint[] = [];
      for (let i = 0; i < 6; i++) {
        const snap = makeSnapshot({
          claims_active_avg_confidence: Math.max(0.3, 0.7 - i * 0.05),
          goals_completion_ratio: Math.max(0.2, 0.6 - i * 0.05),
          contradictions_unresolved_count: 1 + i,
          contradictions_total_count: 2 + i,
          scope_risk_score: Math.min(1, 0.2 + i * 0.1),
        });
        points.push(snapshotToPoint(i + 1, snap, goalScore(snap)));
      }
      return {
        points,
        expected: {
          should_converge: false,
          // Plateau IS expected during divergence: progress ratio is 0 (negative deltas clamped to 0),
          // so EMA stays below plateau_threshold. This is correct behavior — the system is both
          // diverging AND stalled. The divergence detection (alpha < divergence_rate) is the
          // primary signal; plateau is a secondary one.
          should_plateau: true,
          should_be_monotonic: false,
          should_have_eta: false,
        },
      };
    },
  },
  {
    name: "One-dimension bottleneck",
    description: "3 dimensions at target, contradiction_resolution stuck. Should identify correct pressure dim.",
    run(config) {
      const points: ConvergencePoint[] = [];
      for (let i = 0; i < 5; i++) {
        const snap = makeSnapshot({
          claims_active_avg_confidence: 0.95,
          claims_active_min_confidence: 0.95,
          goals_completion_ratio: 0.95,
          scope_risk_score: 0.05,
          contradictions_unresolved_count: 3,
          contradictions_total_count: 4,
        });
        points.push(snapshotToPoint(i + 1, snap, goalScore(snap)));
      }
      return {
        points,
        expected: {
          should_converge: false,
          should_plateau: true,
          should_be_monotonic: true,
          expected_highest_pressure: "contradiction_resolution",
          should_have_eta: false,
        },
      };
    },
  },
  {
    name: "Fast convergence",
    description: "Reaches 0.92+ in 3 rounds. Should not false-plateau.",
    run(config) {
      const snapshots: FinalitySnapshot[] = [
        makeSnapshot({
          claims_active_avg_confidence: 0.7, goals_completion_ratio: 0.7,
          contradictions_unresolved_count: 1, contradictions_total_count: 2,
        }),
        makeSnapshot({
          claims_active_avg_confidence: 0.85, goals_completion_ratio: 0.85,
          claims_active_min_confidence: 0.85,
          contradictions_unresolved_count: 0, contradictions_total_count: 2,
        }),
        makeSnapshot({
          claims_active_avg_confidence: 0.95, goals_completion_ratio: 0.95,
          claims_active_min_confidence: 0.95,
          contradictions_unresolved_count: 0, contradictions_total_count: 2,
          scope_risk_score: 0.02,
        }),
      ];
      const points = snapshots.map((s, i) => snapshotToPoint(i + 1, s, goalScore(s)));
      return {
        points,
        expected: {
          should_converge: true,
          should_plateau: false,
          should_be_monotonic: true,
          should_have_eta: false, // already near target
        },
      };
    },
  },
  {
    name: "Empty graph",
    description: "No claims, no goals. Should return safe defaults, not crash.",
    run(config) {
      const snap = makeSnapshot({
        claims_active_avg_confidence: 0,
        claims_active_min_confidence: 0,
        claims_active_count: 0,
        goals_completion_ratio: 0,
        scope_risk_score: 0,
      });
      const points = [snapshotToPoint(1, snap, goalScore(snap))];
      return {
        points,
        expected: {
          should_converge: false,
          should_plateau: false,
          should_be_monotonic: false,
          should_have_eta: false,
        },
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface ScenarioResult {
  name: string;
  passed: boolean;
  details: string[];
}

function runScenario(scenario: Scenario): ScenarioResult {
  const config: ConvergenceConfig = { ...DEFAULT_CONVERGENCE_CONFIG, beta: 3, tau: 3 };
  const { points, expected } = scenario.run(config);
  const state = analyzeConvergence(points, config);

  const details: string[] = [];
  let passed = true;

  // Check convergence direction
  const isConverging = state.convergence_rate > 0.001;
  if (expected.should_converge !== isConverging) {
    details.push(`convergence: expected ${expected.should_converge}, got ${isConverging} (rate=${state.convergence_rate.toFixed(4)})`);
    passed = false;
  } else {
    details.push(`convergence: OK (rate=${state.convergence_rate.toFixed(4)})`);
  }

  // Check plateau
  if (expected.should_plateau !== state.is_plateaued) {
    details.push(`plateau: expected ${expected.should_plateau}, got ${state.is_plateaued} (rounds=${state.plateau_rounds})`);
    passed = false;
  } else {
    details.push(`plateau: OK (rounds=${state.plateau_rounds})`);
  }

  // Check monotonicity
  if (expected.should_be_monotonic !== state.is_monotonic) {
    details.push(`monotonicity: expected ${expected.should_be_monotonic}, got ${state.is_monotonic}`);
    passed = false;
  } else {
    details.push(`monotonicity: OK (${state.is_monotonic})`);
  }

  // Check ETA
  const hasEta = state.estimated_rounds !== null && state.estimated_rounds > 0;
  if (expected.should_have_eta !== hasEta) {
    // Allow estimated_rounds === 0 as "already converged" — not a failure
    if (state.estimated_rounds === 0 && !expected.should_have_eta) {
      details.push(`ETA: OK (already converged, rounds=0)`);
    } else {
      details.push(`ETA: expected has_eta=${expected.should_have_eta}, got ${state.estimated_rounds}`);
      passed = false;
    }
  } else {
    details.push(`ETA: OK (rounds=${state.estimated_rounds})`);
  }

  // Check highest pressure dimension (if specified)
  if (expected.expected_highest_pressure) {
    if (state.highest_pressure_dimension !== expected.expected_highest_pressure) {
      details.push(`pressure: expected ${expected.expected_highest_pressure}, got ${state.highest_pressure_dimension}`);
      passed = false;
    } else {
      details.push(`pressure: OK (${state.highest_pressure_dimension})`);
    }
  }

  return { name: scenario.name, passed, details };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║          Convergence Tracker Benchmark                      ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const result = runScenario(scenario);
    results.push(result);
  }

  // Print results table
  const nameWidth = 28;
  const statusWidth = 10;
  console.log("┌" + "─".repeat(nameWidth) + "┬" + "─".repeat(statusWidth) + "┬" + "─".repeat(60) + "┐");
  console.log(
    "│" + " Scenario".padEnd(nameWidth) +
    "│" + " Result".padEnd(statusWidth) +
    "│" + " Details".padEnd(60) + "│",
  );
  console.log("├" + "─".repeat(nameWidth) + "┼" + "─".repeat(statusWidth) + "┼" + "─".repeat(60) + "┤");

  for (const r of results) {
    const status = r.passed ? "✅ PASS" : "❌ FAIL";
    const detail = r.details[0] ?? "";
    console.log(
      "│" + ` ${r.name}`.padEnd(nameWidth) +
      "│" + ` ${status}`.padEnd(statusWidth) +
      "│" + ` ${detail}`.padEnd(60) + "│",
    );
    for (let i = 1; i < r.details.length; i++) {
      console.log(
        "│" + "".padEnd(nameWidth) +
        "│" + "".padEnd(statusWidth) +
        "│" + ` ${r.details[i]}`.padEnd(60) + "│",
      );
    }
    if (r !== results[results.length - 1]) {
      console.log("├" + "─".repeat(nameWidth) + "┼" + "─".repeat(statusWidth) + "┼" + "─".repeat(60) + "┤");
    }
  }

  console.log("└" + "─".repeat(nameWidth) + "┴" + "─".repeat(statusWidth) + "┴" + "─".repeat(60) + "┘");
  console.log();

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const allPassed = passed === total;
  console.log(`${allPassed ? "✅" : "❌"} ${passed}/${total} scenarios passed.`);

  if (!allPassed) {
    console.log("\nFailed scenarios:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  - ${r.name}`);
      for (const d of r.details) {
        console.log(`    ${d}`);
      }
    }
    process.exit(1);
  }
}

main();
