/**
 * Quiescence watchdog: detects when the swarm has settled (no proposals for N seconds),
 * re-evaluates finality, and if a HITL review is needed, builds a situation summary
 * with specific ranked questions for the human.
 *
 * Runs as a periodic timer inside the governance loop.
 */

import { logger } from "./logger.js";
import { evaluateFinality, type FinalityReviewRequest, computeGoalScoreForScope, loadFinalitySnapshot } from "./finalityEvaluator.js";
import { submitFinalityReviewForScope } from "./hitlFinalityRequest.js";
import { getPool } from "./db.js";
import type { EventBus } from "./eventBus.js";

const SCOPE_ID = process.env.SCOPE_ID ?? "default";
const WATCHDOG_INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS) || 15000;
const QUIESCENCE_THRESHOLD_MS = Number(process.env.WATCHDOG_QUIESCENCE_MS) || 30000;

export interface WatchdogState {
  lastProposalAt: number;
  lastFinalityCheckAt: number;
  hitlTriggered: boolean;
}

/**
 * A ranked question the watchdog wants to ask the human.
 * Sorted by estimated finality impact (highest first).
 */
export interface WatchdogQuestion {
  dimension: string;
  current_score: number;
  weight: number;
  potential_gain: number;
  question: string;
  suggested_action: string;
  priority: "critical" | "high" | "medium";
}

/**
 * Build specific, ranked questions based on what would most improve the finality score.
 * Greedy: sort by (weight * gap) descending -- the dimension where improvement yields the most.
 */
export async function buildRankedQuestions(scopeId: string): Promise<WatchdogQuestion[]> {
  const snapshot = await loadFinalitySnapshot(scopeId);
  const pool = getPool();

  const weights = {
    claim_confidence: 0.30,
    contradiction_resolution: 0.30,
    goal_completion: 0.25,
    risk_score_inverse: 0.15,
  };

  const claimScore = Math.min(snapshot.claims_active_avg_confidence / 0.85, 1);
  const contraScore = snapshot.contradictions_total_count === 0
    ? 1
    : 1 - snapshot.contradictions_unresolved_count / snapshot.contradictions_total_count;
  const goalScore = snapshot.goals_completion_ratio;
  const riskScore = 1 - Math.min(snapshot.scope_risk_score, 1);

  const dims = [
    { name: "goal_completion", score: goalScore, weight: weights.goal_completion },
    { name: "claim_confidence", score: claimScore, weight: weights.claim_confidence },
    { name: "contradiction_resolution", score: contraScore, weight: weights.contradiction_resolution },
    { name: "risk_score_inverse", score: riskScore, weight: weights.risk_score_inverse },
  ];

  const questions: WatchdogQuestion[] = [];

  for (const dim of dims) {
    const gap = 1 - dim.score;
    if (gap < 0.05) continue;
    const potential_gain = gap * dim.weight;

    if (dim.name === "goal_completion" && gap > 0) {
      const goalRows = await pool.query(
        `SELECT content, status FROM nodes
         WHERE scope_id = $1 AND type = 'goal'
         AND superseded_at IS NULL AND (valid_to IS NULL OR valid_to > now())
         ORDER BY created_at`,
        [scopeId],
      );
      const unresolved = goalRows.rows.filter((r: { status: string }) => r.status !== "resolved");
      for (const g of unresolved) {
        questions.push({
          dimension: "goal_completion",
          current_score: goalScore,
          weight: weights.goal_completion,
          potential_gain,
          question: `Goal not resolved: "${(g as { content: string }).content}". Can you confirm this is addressed or provide a resolution?`,
          suggested_action: "provide_resolution",
          priority: potential_gain > 0.15 ? "critical" : "high",
        });
      }
    }

    if (dim.name === "claim_confidence" && gap > 0.1) {
      const lowClaims = await pool.query(
        `SELECT content, confidence FROM nodes
         WHERE scope_id = $1 AND type = 'claim' AND status = 'active'
         AND confidence < 0.85
         AND superseded_at IS NULL AND (valid_to IS NULL OR valid_to > now())
         ORDER BY confidence ASC LIMIT 5`,
        [scopeId],
      );
      for (const c of lowClaims.rows) {
        const row = c as { content: string; confidence: number };
        questions.push({
          dimension: "claim_confidence",
          current_score: claimScore,
          weight: weights.claim_confidence,
          potential_gain,
          question: `Low-confidence claim (${Math.round(row.confidence * 100)}%): "${row.content.slice(0, 120)}". Can you confirm or refute this?`,
          suggested_action: "provide_resolution",
          priority: potential_gain > 0.15 ? "high" : "medium",
        });
      }
    }

    if (dim.name === "contradiction_resolution" && gap > 0) {
      questions.push({
        dimension: "contradiction_resolution",
        current_score: contraScore,
        weight: weights.contradiction_resolution,
        potential_gain,
        question: `${snapshot.contradictions_unresolved_count} unresolved contradiction(s) remain. Which version of the conflicting facts should be authoritative?`,
        suggested_action: "provide_resolution",
        priority: potential_gain > 0.15 ? "critical" : "high",
      });
    }
  }

  questions.sort((a, b) => b.potential_gain - a.potential_gain);
  return questions;
}

/**
 * Build a situation summary for the human: what the swarm found, where it's stuck,
 * and what specific answers would unblock it.
 */
export async function buildSituationSummary(scopeId: string): Promise<{
  goal_score: number;
  status: string;
  summary: string;
  questions: WatchdogQuestion[];
}> {
  const score = await computeGoalScoreForScope(scopeId);
  const questions = await buildRankedQuestions(scopeId);

  const topBlocker = questions.length > 0
    ? questions[0].dimension.replace(/_/g, " ")
    : "none";

  const summary = `The swarm has processed all available documents and reached a stable state. ` +
    `Finality score: ${Math.round(score * 100)}%. ` +
    `The system is waiting because ${topBlocker === "none" ? "all dimensions are healthy" : `the "${topBlocker}" dimension is the primary blocker`}. ` +
    `${questions.length} question(s) need human input to make progress.`;

  return {
    goal_score: score,
    status: score >= 0.92 ? "auto_resolvable" : score >= 0.40 ? "needs_human" : "early",
    summary,
    questions,
  };
}

/**
 * Start the quiescence watchdog. Call from the governance loop.
 * Returns state object and a stop function.
 */
export function startWatchdog(
  bus: EventBus,
  signal?: AbortSignal,
): { state: WatchdogState; stop: () => void } {
  const state: WatchdogState = {
    lastProposalAt: Date.now(),
    lastFinalityCheckAt: 0,
    hitlTriggered: false,
  };

  const timer = setInterval(async () => {
    if (signal?.aborted) return;

    const idleMs = Date.now() - state.lastProposalAt;
    if (idleMs < QUIESCENCE_THRESHOLD_MS) return;

    if (state.hitlTriggered) {
      try {
        const { hasPendingFinalityReviewForScope } = await import("./mitlServer.js");
        const stillPending = await hasPendingFinalityReviewForScope(SCOPE_ID);
        if (!stillPending) {
          state.hitlTriggered = false;
          logger.info("watchdog: previous HITL resolved, re-armed", { scope_id: SCOPE_ID });
        }
      } catch { /* ignore */ }
      if (state.hitlTriggered) return;
    }

    const sinceLast = Date.now() - state.lastFinalityCheckAt;
    if (sinceLast < QUIESCENCE_THRESHOLD_MS) return;

    state.lastFinalityCheckAt = Date.now();
    logger.info("watchdog: quiescence detected, re-evaluating finality", {
      idle_ms: idleMs,
      scope_id: SCOPE_ID,
    });

    try {
      const result = await evaluateFinality(SCOPE_ID);
      if (!result) return;

      if (result.kind === "review") {
        const situation = await buildSituationSummary(SCOPE_ID);
        logger.info("watchdog: HITL review needed", {
          scope_id: SCOPE_ID,
          goal_score: situation.goal_score,
          questions: situation.questions.length,
          top_blocker: situation.questions[0]?.dimension,
        });

        const submitted = await submitFinalityReviewForScope(SCOPE_ID, result);
        if (submitted) {
          state.hitlTriggered = true;
          await bus.publish("swarm.events.watchdog_hitl", {
            type: "watchdog_hitl",
            scope_id: SCOPE_ID,
            goal_score: String(situation.goal_score),
            questions_count: String(situation.questions.length),
            summary: situation.summary,
          } as Record<string, string>);
        }
      } else if (result.kind === "status") {
        logger.info("watchdog: finality status", {
          scope_id: SCOPE_ID,
          status: result.status,
        });
      }
    } catch (err) {
      logger.error("watchdog: finality check failed", {
        error: String(err),
      });
    }
  }, WATCHDOG_INTERVAL_MS);

  const stop = () => clearInterval(timer);

  if (signal) {
    signal.addEventListener("abort", stop, { once: true });
  }

  logger.info("watchdog started", {
    interval_ms: WATCHDOG_INTERVAL_MS,
    quiescence_ms: QUIESCENCE_THRESHOLD_MS,
  });

  return { state, stop };
}
