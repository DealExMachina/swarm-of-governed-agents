/**
 * Deterministic governance evaluation: evaluates proposal against rules and policy
 * without publishing. Used by processProposal and oversight routing.
 */

import { join } from "path";
import type { S3Client } from "@aws-sdk/client-s3";
import { loadState } from "./stateGraph.js";
import { loadPolicies, getGovernanceForScope, canTransition } from "./governance.js";
import { checkPermission } from "./policy.js";
import { loadDrift, DRIFT_NONE } from "./agents/sharedTools.js";
import type { Proposal } from "./events.js";

const SCOPE_ID = process.env.SCOPE_ID ?? "default";

/** Result of deterministic governance evaluation (no side effects). */
export interface DeterministicResult {
  outcome: "approve" | "reject" | "pending" | "ignore";
  reason: string;
  actionPayload?: {
    expectedEpoch: number;
    runId: string;
    from: string;
    to: string;
    type?: string;
    drift_level?: string;
    drift_types?: string[];
    block_reason?: string;
  };
}

export interface GovernanceEvaluatorEnv {
  s3: S3Client;
  bucket: string;
}

/**
 * Evaluate a proposal with the same logic as processProposal but without publishing.
 * Returns the outcome and reason (and actionPayload when approve/pending) for use by oversight or commit.
 */
export async function evaluateProposalDeterministic(
  proposal: Proposal,
  env: GovernanceEvaluatorEnv,
): Promise<DeterministicResult> {
  const { agent, proposed_action, target_node, payload, mode } = proposal;
  if (proposed_action !== "advance_state") {
    return { outcome: "ignore", reason: "non advance_state proposal" };
  }

  const { expectedEpoch, from, to } = payload as { expectedEpoch: number; from: string; to: string };
  const state = await loadState(SCOPE_ID);
  if (!state || state.epoch !== expectedEpoch) {
    return { outcome: "reject", reason: "state_epoch_mismatch" };
  }

  const drift = (await loadDrift(env.s3, env.bucket)) ?? DRIFT_NONE;
  const govPath = process.env.GOVERNANCE_PATH ?? join(process.cwd(), "governance.yaml");
  const governance = getGovernanceForScope(SCOPE_ID, loadPolicies(govPath));

  if (mode === "MASTER") {
    return {
      outcome: "approve",
      reason: "master_override",
      actionPayload: { expectedEpoch, runId: state.runId, from, to },
    };
  }

  const decision = canTransition(from, to, drift, governance);
  if (!decision.allowed) {
    return {
      outcome: "pending",
      reason: decision.reason,
      actionPayload: {
        expectedEpoch,
        runId: state.runId,
        from,
        to,
        type: "governance_review",
        drift_level: drift.level,
        drift_types: drift.types,
        block_reason: decision.reason,
      },
    };
  }

  const policyResult = await checkPermission(agent, "writer", target_node);
  if (!policyResult.allowed) {
    return {
      outcome: "reject",
      reason: policyResult.error ?? "policy_denied",
      actionPayload: { expectedEpoch, runId: state.runId, from, to },
    };
  }

  if (mode === "MITL") {
    return {
      outcome: "pending",
      reason: "mitl_required",
      actionPayload: { expectedEpoch, runId: state.runId, from, to },
    };
  }

  return {
    outcome: "approve",
    reason: "policy_passed",
    actionPayload: { expectedEpoch, runId: state.runId, from, to },
  };
}
