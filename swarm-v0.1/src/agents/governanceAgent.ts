import "dotenv/config";
import { join } from "path";
import type { S3Client } from "@aws-sdk/client-s3";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Agent } from "@mastra/core/agent";
import { s3GetText } from "../s3.js";
import { loadState } from "../stateGraph.js";
import { loadPolicies, canTransition } from "../governance.js";
import { checkPermission } from "../policy.js";
import { appendEvent } from "../contextWal.js";
import { addPending } from "../mitlServer.js";
import type { EventBus } from "../eventBus.js";
import { logger, setLogContext } from "../logger.js";
import { recordProposal, recordPolicyViolation } from "../metrics.js";
import { getChatModelConfig } from "../modelConfig.js";
import type { Proposal, Action } from "../events.js";
import { makeReadGovernanceRulesTool } from "./sharedTools.js";
import { evaluateFinality } from "../finalityEvaluator.js";
import { submitFinalityReviewForScope } from "../hitlFinalityRequest.js";

const AGENT_ID = process.env.AGENT_ID ?? "governance-1";
const NATS_STREAM = process.env.NATS_STREAM ?? "SWARM_JOBS";
const SCOPE_ID = process.env.SCOPE_ID ?? "default";
setLogContext({ agent_id: AGENT_ID, role: "governance" });

export interface GovernanceAgentEnv {
  s3: S3Client;
  bucket: string;
  getPublishAction: () => (subject: string, data: Record<string, unknown>) => Promise<void>;
  getPublishRejection: () => (subject: string, data: Record<string, unknown>) => Promise<void>;
}

/**
 * Process one proposal: check transition rules, optionally policy (OpenFGA in Phase 3),
 * then publish Action (approved) or Rejection.
 */
const GOVERNANCE_AGENT_INSTRUCTIONS = `You are the governance agent. You have a proposal to advance the state machine (from, to, expectedEpoch). The proposing agent and target node are in the proposal.
Use readState to see current state and epoch. Use readDrift to see drift level and types. Use readGovernanceRules to see transition rules and policy rules.
Use checkTransition to see if the proposed transition is allowed given drift (e.g. high drift may block). Use checkPolicy to verify the proposing agent is allowed to write to the target node.
You must reject if checkTransition or checkPolicy fails. If all checks pass, call publishApproval with a brief reason; otherwise call publishRejection with the reason.
Call exactly one of: publishApproval(reason) or publishRejection(reason). End with a one-sentence rationale.`;

function createGovernanceTools(proposal: Proposal, env: GovernanceAgentEnv) {
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
      const state = await loadState();
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
      const raw = await s3GetText(env.s3, env.bucket, "drift/latest.json");
      const drift = raw
        ? (JSON.parse(raw) as { level: string; types: string[] })
        : { level: "none", types: [] as string[] };
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
      const raw = await s3GetText(env.s3, env.bucket, "drift/latest.json");
      const drift = raw
        ? (JSON.parse(raw) as { level: string; types: string[] })
        : { level: "none", types: [] as string[] };
      const govPath = process.env.GOVERNANCE_PATH ?? join(process.cwd(), "governance.yaml");
      const governance = loadPolicies(govPath);
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
      const state = await loadState();
      if (!state || state.epoch !== expectedEpoch) {
        return { ok: false, error: "state_epoch_mismatch" };
      }
      const driftRaw = await s3GetText(env.s3, env.bucket, "drift/latest.json");
      const drift = driftRaw
        ? (JSON.parse(driftRaw) as { level: string; types: string[] })
        : { level: "none", types: [] as string[] };
      const govPath = process.env.GOVERNANCE_PATH ?? join(process.cwd(), "governance.yaml");
      const governance = loadPolicies(govPath);
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
        payload: { expectedEpoch, runId: state.runId, from, to },
      };
      await env.getPublishAction()("swarm.actions.advance_state", action as unknown as Record<string, unknown>);
      await appendEvent({ type: "proposal_approved", proposal_id: proposal.proposal_id, reason });
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

/**
 * Process one proposal using an LLM-backed agent: tools enforce rules; the agent provides reasoning and calls publishApproval or publishRejection.
 * If the agent does not call either tool (e.g. maxSteps reached), we fall back to deterministic processProposal so the proposal is always decided.
 */
export async function processProposalWithAgent(
  proposal: Proposal,
  env: GovernanceAgentEnv,
): Promise<void> {
  const modelConfig = getChatModelConfig();
  if (!modelConfig) {
    await processProposal(proposal, env);
    return;
  }
  const tools = createGovernanceTools(proposal, env);
  const agent = new Agent({
    id: "governance-agent",
    name: "Governance Agent",
    instructions: GOVERNANCE_AGENT_INSTRUCTIONS,
    model: modelConfig,
    tools: {
      readState: tools.readState,
      readDrift: tools.readDrift,
      readGovernanceRules: tools.readGovernanceRules,
      checkTransition: tools.checkTransition,
      checkPolicy: tools.checkPolicy,
      publishApproval: tools.publishApproval,
      publishRejection: tools.publishRejection,
    },
  });
  const prompt = `Proposal: proposal_id=${proposal.proposal_id} agent=${proposal.agent} target_node=${proposal.target_node} payload=${JSON.stringify(proposal.payload)}. Decide approve or reject and call the corresponding tool.`;
  await agent.generate(prompt, { maxSteps: 12 });
  if (!tools.isDecided()) {
    logger.info("governance agent did not decide; falling back to rule-based", { proposal_id: proposal.proposal_id });
    await processProposal(proposal, env);
  }
}

export async function processProposal(
  proposal: Proposal,
  env: GovernanceAgentEnv,
): Promise<void> {
  const { proposal_id, agent, proposed_action, target_node, payload, mode } = proposal;
  if (proposed_action !== "advance_state") {
    logger.debug("ignoring non advance_state proposal", { proposal_id });
    return;
  }

  const { expectedEpoch, from, to } = payload as { expectedEpoch: number; from: string; to: string };
  const state = await loadState();
  if (!state || state.epoch !== expectedEpoch) {
    recordProposal(proposed_action, "rejected");
    await env.getPublishRejection()(`swarm.rejections.${proposed_action}`, {
      proposal_id,
      reason: "state_epoch_mismatch",
      result: "rejected",
    });
    await appendEvent({
      type: "proposal_rejected",
      proposal_id,
      reason: "state_epoch_mismatch",
    });
    return;
  }

  const driftRaw = await s3GetText(env.s3, env.bucket, "drift/latest.json");
  const drift = driftRaw
    ? (JSON.parse(driftRaw) as { level: string; types: string[] })
    : { level: "none", types: [] as string[] };
  const govPath = process.env.GOVERNANCE_PATH ?? join(process.cwd(), "governance.yaml");
  const governance = loadPolicies(govPath);

  if (mode === "MASTER") {
    recordProposal(proposed_action, "approved");
    const action: Action = {
      proposal_id,
      approved_by: AGENT_ID,
      result: "approved",
      reason: "master_override",
      action_type: "advance_state",
      payload: { expectedEpoch, runId: state.runId, from, to },
    };
    await env.getPublishAction()("swarm.actions.advance_state", action as unknown as Record<string, unknown>);
    await appendEvent({ type: "proposal_approved", proposal_id, reason: "master_override" });
    logger.info("proposal approved (master)", { proposal_id });
    return;
  }

  const decision = canTransition(from, to, drift, governance);
  if (!decision.allowed) {
    recordProposal(proposed_action, "rejected");
    await env.getPublishRejection()(`swarm.rejections.${proposed_action}`, {
      proposal_id,
      reason: decision.reason,
      result: "rejected",
    });
    await appendEvent({ type: "proposal_rejected", proposal_id, reason: decision.reason });
    logger.info("proposal rejected", { proposal_id, reason: decision.reason });
    return;
  }

  const policyResult = await checkPermission(agent, "writer", target_node);
  if (!policyResult.allowed) {
    recordProposal(proposed_action, "rejected");
    recordPolicyViolation();
    const reason = policyResult.error ?? "policy_denied";
    await env.getPublishRejection()(`swarm.rejections.${proposed_action}`, {
      proposal_id,
      reason,
      result: "rejected",
    });
    await appendEvent({ type: "proposal_rejected", proposal_id, reason });
    logger.info("proposal rejected (policy)", { proposal_id, reason });
    return;
  }

  if (mode === "MITL") {
    recordProposal(proposed_action, "pending");
    const actionPayload = { expectedEpoch, runId: state.runId, from, to };
    addPending(proposal_id, proposal, actionPayload);
    await env.getPublishAction()(`swarm.pending_approval.${proposal_id}`, {
      proposal_id,
      status: "pending",
    } as Record<string, unknown>);
    await appendEvent({ type: "proposal_pending_approval", proposal_id });
    logger.info("proposal pending MITL approval", { proposal_id });
    return;
  }

  recordProposal(proposed_action, "approved");
  const action: Action = {
    proposal_id,
    approved_by: "auto",
    result: "approved",
    reason: "policy_passed",
    action_type: "advance_state",
    payload: { expectedEpoch, runId: state.runId, from, to },
  };
  await env.getPublishAction()("swarm.actions.advance_state", action as unknown as Record<string, unknown>);
  await appendEvent({ type: "proposal_approved", proposal_id, reason: "policy_passed" });
  logger.info("proposal approved", { proposal_id });
}

/**
 * Run finality evaluation for the scope; if in near-finality band, submit HITL review.
 * Fire-and-forget: callers should .catch() to log errors without failing the message ack.
 */
export async function runFinalityCheck(scopeId: string): Promise<void> {
  const result = await evaluateFinality(scopeId);
  if (result?.kind === "status") {
    logger.info("finality outcome", { scope_id: scopeId, outcome: result.status });
  } else if (result?.kind === "review") {
    logger.info("finality outcome", {
      scope_id: scopeId,
      outcome: "review_requested",
      goal_score: result.request.goal_score,
    });
    await submitFinalityReviewForScope(scopeId);
  } else {
    logger.info("finality outcome", { scope_id: scopeId, outcome: "ACTIVE" });
  }
}

export async function runGovernanceAgentLoop(bus: EventBus, s3: S3Client, bucket: string): Promise<never> {
  const { setMitlPublishFns, startMitlServer } = await import("../mitlServer.js");
  const mitlPort = parseInt(process.env.MITL_PORT ?? "3001", 10);
  setMitlPublishFns(
    (subj, data) => bus.publish(subj, data as Record<string, string>).then(() => {}),
    (subj, data) => bus.publish(subj, data as Record<string, string>).then(() => {}),
  );
  startMitlServer(mitlPort);

  const subject = "swarm.proposals.>";
  const consumer = `governance-${AGENT_ID}`;
  logger.info("governance agent started", { subject, consumer });

  const env: GovernanceAgentEnv = {
    s3,
    bucket,
    getPublishAction: () => (subj: string, data: Record<string, unknown>) =>
      bus.publish(subj, data as Record<string, string>).then(() => {}),
    getPublishRejection: () => (subj: string, data: Record<string, unknown>) =>
      bus.publish(subj, data as Record<string, string>).then(() => {}),
  };

  while (true) {
    const processed = await bus.consume(
      NATS_STREAM,
      subject,
      consumer,
      async (msg) => {
        const data = msg.data as unknown as Record<string, unknown>;
        const proposal: Proposal = {
          proposal_id: String(data.proposal_id ?? ""),
          agent: String(data.agent ?? ""),
          proposed_action: String(data.proposed_action ?? ""),
          target_node: String(data.target_node ?? ""),
          payload: (data.payload as Record<string, unknown>) ?? {},
          mode: (data.mode as "YOLO" | "MITL" | "MASTER") ?? "YOLO",
        };
        if (proposal.mode === "MASTER" || proposal.mode === "MITL") {
          await processProposal(proposal, env);
        } else if (getChatModelConfig()) {
          await processProposalWithAgent(proposal, env);
        } else {
          await processProposal(proposal, env);
        }
        runFinalityCheck(SCOPE_ID).catch((err) => {
          logger.error("finality check error", { scope_id: SCOPE_ID, error: String(err) });
        });
      },
      { timeoutMs: 5000, maxMessages: 10 },
    );
    if (processed === 0) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
