/**
 * Governance agent tools: readState, readDrift, checkTransition, checkPolicy, publishApproval, publishRejection.
 */

import { join } from "path";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { loadState } from "../stateGraph.js";
import { loadPolicies, getGovernanceForScope, canTransition } from "../governance.js";
import { checkPermission } from "../policy.js";
import { appendEvent } from "../contextWal.js";
import { loadDrift, makeReadGovernanceRulesTool, DRIFT_NONE } from "./sharedTools.js";
import { recordProposal, recordPolicyViolation } from "../metrics.js";
import { logger } from "../logger.js";
import type { Proposal, Action } from "../events.js";

const SCOPE_ID = process.env.SCOPE_ID ?? "default";
const AGENT_ID = process.env.AGENT_ID ?? "governance-1";

export interface GovernanceToolsEnv {
  s3: import("@aws-sdk/client-s3").S3Client;
  bucket: string;
  getPublishAction: () => (subject: string, data: Record<string, unknown>) => Promise<void>;
  getPublishRejection: () => (subject: string, data: Record<string, unknown>) => Promise<void>;
}

export function createGovernanceTools(proposal: Proposal, env: GovernanceToolsEnv) {
  const { expectedEpoch, from, to } = (proposal.payload ?? {}) as {
    expectedEpoch?: number;
    from?: string;
    to?: string;
  };
  let decided = false;

  const readStateTool = createTool({
    id: "readState",
    description: "Read the current state graph state (runId, lastNode, epoch).",
    inputSchema: z.object({}),
    outputSchema: z.object({
      state: z.object({
        runId: z.string(),
        lastNode: z.string(),
        epoch: z.number(),
        updatedAt: z.string(),
      }).nullable(),
    }),
    execute: async () => {
      const state = await loadState(SCOPE_ID);
      return { state };
    },
  });

  const readDriftTool = createTool({
    id: "readDrift",
    description: "Read the current drift analysis (level, types).",
    inputSchema: z.object({}),
    outputSchema: z.object({
      drift: z.object({
        level: z.string(),
        types: z.array(z.string()),
      }),
    }),
    execute: async () => {
      const drift = (await loadDrift(env.s3, env.bucket)) ?? DRIFT_NONE;
      return { drift };
    },
  });

  const readGovernanceRules = makeReadGovernanceRulesTool();

  const checkTransitionTool = createTool({
    id: "checkTransition",
    description: "Check if the proposed transition (from -> to) is allowed given current drift and governance rules.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      allowed: z.boolean(),
      reason: z.string(),
    }),
    execute: async () => {
      const drift = (await loadDrift(env.s3, env.bucket)) ?? DRIFT_NONE;
      const govPath = process.env.GOVERNANCE_PATH ?? join(process.cwd(), "governance.yaml");
      const governance = getGovernanceForScope(SCOPE_ID, loadPolicies(govPath));
      if (from === undefined || to === undefined) {
        return { allowed: false, reason: "missing_from_or_to" };
      }
      const decision = canTransition(from, to, drift, governance);
      return { allowed: decision.allowed, reason: decision.reason };
    },
  });

  const checkPolicyTool = createTool({
    id: "checkPolicy",
    description: "Check if the proposing agent has permission to write to the target node.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      allowed: z.boolean(),
      error: z.string().optional(),
    }),
    execute: async () => {
      const result = await checkPermission(proposal.agent, "writer", proposal.target_node);
      return { allowed: result.allowed, error: result.error };
    },
  });

  const publishApprovalTool = createTool({
    id: "publishApproval",
    description: "Approve the proposal and publish the action. Only succeeds if state epoch matches and transition and policy checks pass.",
    inputSchema: z.object({
      reason: z.string().describe("Brief reason for approval"),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
    }),
    execute: async (input) => {
      if (decided) return { ok: false, error: "already_decided" };
      const reason = (input as { reason?: string })?.reason ?? "policy_passed";
      const state = await loadState(SCOPE_ID);
      if (!state || state.epoch !== expectedEpoch) {
        return { ok: false, error: "state_epoch_mismatch" };
      }
      const drift = (await loadDrift(env.s3, env.bucket)) ?? DRIFT_NONE;
      const govPath = process.env.GOVERNANCE_PATH ?? join(process.cwd(), "governance.yaml");
      const governance = getGovernanceForScope(SCOPE_ID, loadPolicies(govPath));
      if (from === undefined || to === undefined) {
        return { ok: false, error: "missing_from_or_to" };
      }
      const decision = canTransition(from, to, drift, governance);
      if (!decision.allowed) {
        return { ok: false, error: decision.reason };
      }
      const policyResult = await checkPermission(proposal.agent, "writer", proposal.target_node);
      if (!policyResult.allowed) {
        recordPolicyViolation();
        return { ok: false, error: policyResult.error ?? "policy_denied" };
      }
      decided = true;
      recordProposal(proposal.proposed_action, "approved");
      const action: Action = {
        proposal_id: proposal.proposal_id,
        approved_by: AGENT_ID,
        result: "approved",
        reason,
        action_type: "advance_state",
        payload: { expectedEpoch, runId: state.runId, from, to, scope_id: SCOPE_ID },
      };
      await env.getPublishAction()("swarm.actions.advance_state", action as unknown as Record<string, unknown>);
      await appendEvent({
        type: "proposal_approved",
        proposal_id: proposal.proposal_id,
        reason,
        governance_path: "processProposalWithAgent",
      });
      logger.info("proposal approved (agent)", { proposal_id: proposal.proposal_id, reason });
      return { ok: true };
    },
  });

  const publishRejectionTool = createTool({
    id: "publishRejection",
    description: "Reject the proposal and publish the rejection with a reason.",
    inputSchema: z.object({
      reason: z.string().describe("Reason for rejection"),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
    }),
    execute: async (input) => {
      if (decided) return { ok: true };
      const reason = (input as { reason?: string })?.reason ?? "rejected";
      decided = true;
      recordProposal(proposal.proposed_action, "rejected");
      await env.getPublishRejection()(`swarm.rejections.${proposal.proposed_action}`, {
        proposal_id: proposal.proposal_id,
        reason,
        result: "rejected",
      });
      await appendEvent({
        type: "proposal_rejected",
        proposal_id: proposal.proposal_id,
        reason,
        governance_path: "processProposalWithAgent",
      });
      logger.info("proposal rejected (agent)", { proposal_id: proposal.proposal_id, reason });
      return { ok: true };
    },
  });

  return {
    readState: readStateTool,
    readDrift: readDriftTool,
    readGovernanceRules,
    checkTransition: checkTransitionTool,
    checkPolicy: checkPolicyTool,
    publishApproval: publishApprovalTool,
    publishRejection: publishRejectionTool,
    isDecided: () => decided,
  };
}
