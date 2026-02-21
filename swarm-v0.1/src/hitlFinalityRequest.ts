import { randomUUID } from "crypto";
import {
  evaluateFinality,
  type FinalityReviewRequest,
} from "./finalityEvaluator.js";
import { getOllamaBaseUrl, getHitlModel } from "./modelConfig.js";
import { addPending } from "./mitlServer.js";

const HITL_PROMPT = `You are a governance analyst reviewing a case for finality.
The case has a goal score of {{goal_score}} (needs {{auto_threshold}} for automatic resolution).
Here is the breakdown: {{dimension_breakdown_json}}
The blockers preventing automatic resolution are: {{blockers_json}}

Write a clear, factual 2-3 paragraph explanation for a human reviewer. Include:

1. **Why finality is not reached**: How close the case is and why it cannot be automatically closed (e.g. contradiction, non-consensus, or confidence below thresholds). Be specific about which dimension(s) are blocking and the claim content or contradictions involved.

2. **What specifically is blocking each dimension**: Name each blocker and what would need to change for that dimension to pass.

3. **Minimal steps to reach finality**: What the least set of actions would be to bring the case to finality (e.g. "Resolve the one remaining contradiction between X and Y" or "Add one goal resolution to reach 90% completion").

4. **Evaluate if acceptable**: Help the reviewer decide whether to accept the current state as-is (and approve finality anyway), or to provide new facts, a resolution, or an order so the system can reach finality automatically.`;

/**
 * Call Ollama chat to generate the HITL explanation. Returns empty string if Ollama unavailable.
 */
async function generateHitlExplanation(request: FinalityReviewRequest): Promise<string> {
  const base = getOllamaBaseUrl();
  const model = getHitlModel();
  if (!base) return "";

  const dimensionJson = JSON.stringify(request.dimension_breakdown, null, 2);
  const blockersJson = JSON.stringify(request.blockers, null, 2);
  const prompt = HITL_PROMPT.replace("{{goal_score}}", String(request.goal_score))
    .replace("{{auto_threshold}}", String(request.auto_threshold))
    .replace("{{dimension_breakdown_json}}", dimensionJson)
    .replace("{{blockers_json}}", blockersJson);

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
 */
export async function submitFinalityReviewForScope(scopeId: string): Promise<boolean> {
  const result = await evaluateFinality(scopeId);
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
  addPending(reviewId, proposal, request as unknown as Record<string, unknown>);
  return true;
}
