import { randomUUID } from "crypto";
import {
  evaluateFinality,
  type FinalityReviewRequest,
  type FinalityResult,
} from "./finalityEvaluator.js";
import { getOllamaBaseUrl, getHitlModel } from "./modelConfig.js";
import { addPending } from "./mitlServer.js";
import { logger } from "./logger.js";

const HITL_PROMPT = `You are a governance analyst reviewing a case for finality.
The case has a goal score of {{goal_score}} (needs {{auto_threshold}} for automatic resolution).
Here is the breakdown: {{dimension_breakdown_json}}
The blockers preventing automatic resolution are: {{blockers_json}}
{{convergence_section}}
Write a clear, factual 2-3 paragraph explanation for a human reviewer. Include:

1. **Why finality is not reached**: How close the case is and why it cannot be automatically closed (e.g. contradiction, non-consensus, or confidence below thresholds). Be specific about which dimension(s) are blocking and the claim content or contradictions involved.

2. **What specifically is blocking each dimension**: Name each blocker and what would need to change for that dimension to pass.

3. **Minimal steps to reach finality**: What the least set of actions would be to bring the case to finality (e.g. "Resolve the one remaining contradiction between X and Y" or "Add one goal resolution to reach 90% completion").

4. **Convergence trajectory**: Based on the convergence data (if available), assess whether the system is making progress toward finality, whether it is stalled, or whether it is diverging. Recommend whether to wait for more cycles or intervene now.

5. **Evaluate if acceptable**: Help the reviewer decide whether to accept the current state as-is (and approve finality anyway), or to provide new facts, a resolution, or an order so the system can reach finality automatically.`;

/**
 * Build convergence context section for the HITL prompt.
 * When convergence data is available, provides convergence rate, ETA, plateau, pressure info.
 */
function buildConvergenceSection(request: FinalityReviewRequest): string {
  const c = request.convergence;
  if (!c) return "";

  const lines: string[] = [
    "",
    "--- Convergence Analysis ---",
    `The system has been evaluated ${c.score_history.length} time(s).`,
    `Convergence rate (α): ${c.rate.toFixed(4)} (${c.rate > 0.001 ? "converging" : c.rate < -0.001 ? "diverging" : "stalled"})`,
    `Estimated additional cycles to auto-resolve: ${c.estimated_rounds !== null ? c.estimated_rounds : "unknown (not converging)"}`,
    `Lyapunov disagreement V(t): ${c.lyapunov_v.toFixed(4)} (0 = perfect finality)`,
    `Monotonicity: score has been ${c.is_monotonic ? "non-decreasing" : "fluctuating"} in recent rounds`,
  ];

  if (c.is_plateaued) {
    lines.push(`PLATEAU DETECTED: The system has been plateaued for ${c.plateau_rounds} consecutive evaluation(s). Progress has stalled.`);
  }

  if (c.highest_pressure) {
    lines.push(`Highest-pressure dimension (bottleneck): ${c.highest_pressure}`);
  }

  if (c.score_history.length > 1) {
    lines.push(`Score trajectory: [${c.score_history.map((s) => s.toFixed(3)).join(", ")}]`);
  }

  lines.push("---", "");
  return lines.join("\n");
}

/**
 * Call Ollama chat to generate the HITL explanation. Returns empty string if Ollama unavailable.
 */
async function generateHitlExplanation(request: FinalityReviewRequest): Promise<string> {
  const base = getOllamaBaseUrl();
  const model = getHitlModel();
  if (!base) return "";

  const dimensionJson = JSON.stringify(request.dimension_breakdown, null, 2);
  const blockersJson = JSON.stringify(request.blockers, null, 2);
  const convergenceSection = buildConvergenceSection(request);
  const prompt = HITL_PROMPT.replace("{{goal_score}}", String(request.goal_score))
    .replace("{{auto_threshold}}", String(request.auto_threshold))
    .replace("{{dimension_breakdown_json}}", dimensionJson)
    .replace("{{blockers_json}}", blockersJson)
    .replace("{{convergence_section}}", convergenceSection);

  try {
    const url = `${base.replace(/\/$/, "")}/api/chat`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { message?: { content?: string } };
    return (data.message?.content ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * Build suggested_actions from blockers (one action per blocker type).
 */
function suggestedActionsFromBlockers(request: FinalityReviewRequest): string[] {
  const actions: string[] = [];
  for (const b of request.blockers) {
    if (b.type === "unresolved_contradiction")
      actions.push("Post resolution for contradiction(s) or mark as accepted risk.");
    else if (b.type === "critical_risk")
      actions.push("Address critical risk(s) or escalate.");
    else if (b.type === "low_confidence_claims")
      actions.push("Add evidence or revise low-confidence claims.");
    else if (b.type === "missing_goal_resolution")
      actions.push("Add goal resolutions to reach 90% completion.");
    else actions.push(b.description);
  }
  return actions;
}

/**
 * If the scope is in near-finality (Path B), generate the HITL explanation, fill the request,
 * and post it to the MITL server for human review. Idempotent per scope: call when governance
 * cycle finishes and evaluateFinality returns a review.
 * When preComputedReview is provided (e.g. from runFinalityCheck), it is used instead of
 * re-evaluating, so the review is not lost to a second evaluation returning something else.
 */
export async function submitFinalityReviewForScope(
  scopeId: string,
  preComputedReview?: FinalityResult,
): Promise<boolean> {
  const { hasPendingFinalityReviewForScope } = await import("./mitlServer.js");
  if (await hasPendingFinalityReviewForScope(scopeId)) {
    return true; // idempotent: review already pending for this scope
  }

  const result =
    preComputedReview?.kind === "review" ? preComputedReview : await evaluateFinality(scopeId);
  if (!result || result.kind !== "review") return false;

  const request = result.request;
  request.llm_explanation = await generateHitlExplanation(request);
  request.suggested_actions =
    request.suggested_actions?.length ? request.suggested_actions : suggestedActionsFromBlockers(request);

  const reviewId = `finality-${scopeId}-${randomUUID().slice(0, 8)}`;
  const proposal = {
    proposal_id: reviewId,
    agent: "finality-evaluator",
    proposed_action: "finality_review",
    target_node: "RESOLVED",
    payload: request as unknown as Record<string, unknown>,
    mode: "MITL" as const,
  };
  try {
    await addPending(reviewId, proposal, request as unknown as Record<string, unknown>);
    logger.info("finality review added to MITL", { scope_id: scopeId, review_id: reviewId, goal_score: request.goal_score });
    return true;
  } catch (err) {
    logger.error("finality review addPending failed", { scope_id: scopeId, review_id: reviewId, error: String(err) });
    throw err;
  }
}
