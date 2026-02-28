import "dotenv/config";
import { setMaxListeners } from "events";
import { join } from "path";
import type { S3Client } from "@aws-sdk/client-s3";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Agent } from "@mastra/core/agent";
import { s3GetText } from "../s3.js";
import { loadState } from "../stateGraph.js";
import { loadPolicies, getGovernanceForScope } from "../governance.js";
import { createYamlPolicyEngine, type PolicyEngine } from "../policyEngine.js";
import { getGovernancePolicyVersion } from "../policyVersions.js";
import { persistDecisionRecord } from "../decisionRecorder.js";
import { executeObligations } from "../obligationEnforcer.js";
import { checkPermission } from "../policy.js";
import { appendEvent } from "../contextWal.js";
import { addPending } from "../mitlServer.js";
import { isProcessed, markProcessed } from "../messageDedup.js";
import type { EventBus } from "../eventBus.js";
import { logger, setLogContext } from "../logger.js";
import { recordProposal, recordPolicyViolation } from "../metrics.js";
import { getChatModelConfig, getOversightModelConfig } from "../modelConfig.js";
import type { Proposal, Action } from "../events.js";
import { makeReadGovernanceRulesTool } from "./sharedTools.js";

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

/**
 * Audit path: which governance path produced the decision. Recorded in context_events for E2E and audits.
 * - processProposal: direct deterministic (MASTER/MITL or YOLO with no LLM)
 * - oversight_acceptDeterministic: YOLO + oversight chose to accept deterministic result
 * - oversight_escalateToLLM: YOLO + oversight chose full LLM (decision then comes from processProposalWithAgent)
 * - oversight_escalateToHuman: YOLO + oversight chose MITL
 * - processProposalWithAgent: full governance LLM decided (approve/reject)
 */
export type GovernancePath =
  | "processProposal"
  | "oversight_acceptDeterministic"
  | "oversight_escalateToLLM"
  | "oversight_escalateToHuman"
  | "processProposalWithAgent";
import { evaluateFinality } from "../finalityEvaluator.js";
import { submitFinalityReviewForScope } from "../hitlFinalityRequest.js";
import { CircuitBreaker } from "../resilience.js";

/** LLM circuit breaker: opens after 3 consecutive failures, 60s cooldown. */
const llmBreaker = new CircuitBreaker("governance-llm", 3, 60000);

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

const OVERSIGHT_AGENT_INSTRUCTIONS = `You are the oversight agent. You have a proposal and the result of a deterministic governance check (outcome and reason).
You must choose exactly one option:
1. acceptDeterministic - Accept the deterministic result as-is (approve, reject, or pending will be applied accordingly).
2. escalateToLLM - Send to the full governance LLM for richer reasoning before a final decision.
3. escalateToHuman - Send to human-in-the-loop (MITL) for manual approval.
Call exactly one of these three tools. Do not invent or override the deterministic outcome; you only route to one of the three paths.`;

function createOversightTools(
  proposal: Proposal,
  deterministicResult: DeterministicResult,
  env: GovernanceAgentEnv,
): { tools: Record<string, ReturnType<typeof createTool>>; getChosen: () => string | null } {
  const chosen: { value: string | null } = { value: null };
  const acceptDeterministicTool = createTool({
    id: "acceptDeterministic",
    description: "Accept the deterministic result. The pre-computed outcome (approve, reject, or pending) will be published.",
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async () => {
      chosen.value = "acceptDeterministic";
      await commitDeterministicResult(proposal, deterministicResult, env, "oversight_acceptDeterministic");
      return { ok: true };
    },
  });
  const escalateToLLMTool = createTool({
    id: "escalateToLLM",
    description: "Escalate to the full governance LLM for richer reasoning and a final approve/reject decision.",
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async () => {
      chosen.value = "escalateToLLM";
      await processProposalWithAgent(proposal, env);
      return { ok: true };
    },
  });
  const escalateToHumanTool = createTool({
    id: "escalateToHuman",
    description: "Escalate to human-in-the-loop (MITL) for manual approval.",
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async () => {
      chosen.value = "escalateToHuman";
      const actionPayload = deterministicResult.actionPayload;
      if (actionPayload) {
        const { proposal_id, proposed_action } = proposal;
        recordProposal(proposed_action, "pending");
        await addPending(proposal_id, proposal, actionPayload);
        await env.getPublishAction()(`swarm.pending_approval.${proposal_id}`, {
          proposal_id,
          status: "pending",
        } as Record<string, unknown>);
        await appendEvent({
          type: "proposal_pending_approval",
          proposal_id,
          governance_path: "oversight_escalateToHuman",
        });
        logger.info("proposal pending MITL approval (oversight)", { proposal_id });
      } else {
        await commitDeterministicResult(proposal, deterministicResult, env);
      }
      return { ok: true };
    },
  });
  return {
    tools: {
      acceptDeterministic: acceptDeterministicTool,
      escalateToLLM: escalateToLLMTool,
      escalateToHuman: escalateToHumanTool,
    },
    getChosen: () => chosen.value,
  };
}

/**
 * Run the oversight agent: it chooses acceptDeterministic, escalateToLLM, or escalateToHuman.
 * If it does not call any tool (e.g. maxSteps), we fall back to committing the deterministic result.
 */
export async function runOversightAgent(
  proposal: Proposal,
  deterministicResult: DeterministicResult,
  env: GovernanceAgentEnv,
): Promise<void> {
  const modelConfig = getOversightModelConfig();
  if (!modelConfig) {
    await commitDeterministicResult(proposal, deterministicResult, env);
    return;
  }
  const { tools, getChosen } = createOversightTools(proposal, deterministicResult, env);
  const agent = new Agent({
    id: "oversight-agent",
    name: "Oversight Agent",
    instructions: OVERSIGHT_AGENT_INSTRUCTIONS,
    model: modelConfig,
    tools,
  });
  const summary = `${deterministicResult.outcome}: ${deterministicResult.reason}`;
  const prompt = `Proposal: proposal_id=${proposal.proposal_id} agent=${proposal.agent} target_node=${proposal.target_node} payload=${JSON.stringify(proposal.payload)}. Deterministic result: ${summary}. Choose one: acceptDeterministic, escalateToLLM, or escalateToHuman. Call the corresponding tool.`;
  const LLM_TIMEOUT_MS = 30000;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), LLM_TIMEOUT_MS);
  setMaxListeners(64, abortController.signal);
  try {
    await llmBreaker.call(() => agent.generate(prompt, { maxSteps: 5, abortSignal: abortController.signal }));
  } catch (e) {
    // If circuit breaker is open or LLM failed, fall back to deterministic
    if (!getChosen()) {
      logger.warn("oversight LLM failed or circuit open; committing deterministic result", {
        proposal_id: proposal.proposal_id,
        error: String(e),
      });
      await commitDeterministicResult(proposal, deterministicResult, env, "oversight_acceptDeterministic");
      return;
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!getChosen()) {
    logger.info("oversight agent did not call a tool; committing deterministic result", {
      proposal_id: proposal.proposal_id,
    });
    await commitDeterministicResult(proposal, deterministicResult, env, "oversight_acceptDeterministic");
  }
}

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
      const governance = getGovernanceForScope(SCOPE_ID, loadPolicies(govPath));
      if (from === undefined || to === undefined) {
        return { allowed: false, reason: "missing_from_or_to" };
      }
      const policyVersion = getGovernancePolicyVersion(govPath);
      const engine = createYamlPolicyEngine(governance, policyVersion);
      const result = await engine.evaluate({
        scope_id: SCOPE_ID,
        from_state: from,
        to_state: to,
        drift_level: drift.level,
        drift_types: drift.types,
      });
      try {
        await persistDecisionRecord(result.record);
      } catch {
        // table may not exist or DB unavailable
      }
      await executeObligations(result.record.obligations ?? []);
      return { allowed: result.allowed, reason: result.record.reason };
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
      const driftRaw = await s3GetText(env.s3, env.bucket, "drift/latest.json");
      const drift = driftRaw
        ? (JSON.parse(driftRaw) as { level: string; types: string[] })
        : { level: "none", types: [] as string[] };
      const govPath = process.env.GOVERNANCE_PATH ?? join(process.cwd(), "governance.yaml");
      const governance = getGovernanceForScope(SCOPE_ID, loadPolicies(govPath));
      if (from === undefined || to === undefined) {
        return { ok: false, error: "missing_from_or_to" };
      }
      const policyVersion = getGovernancePolicyVersion(govPath);
      const engine = createYamlPolicyEngine(governance, policyVersion);
      const policyResultTransition = await engine.evaluate({
        scope_id: SCOPE_ID,
        from_state: from,
        to_state: to,
        drift_level: drift.level,
        drift_types: drift.types,
      });
      try {
        await persistDecisionRecord(policyResultTransition.record);
      } catch {
        // table may not exist or DB unavailable
      }
      await executeObligations(policyResultTransition.record.obligations ?? []);
      if (!policyResultTransition.allowed) {
        return { ok: false, error: policyResultTransition.record.reason };
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
  const LLM_TIMEOUT_MS = 30000;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), LLM_TIMEOUT_MS);
  setMaxListeners(64, abortController.signal);
  try {
    await llmBreaker.call(() => agent.generate(prompt, { maxSteps: 12, abortSignal: abortController.signal }));
  } catch (e) {
    // If circuit breaker is open or LLM failed, fall back to deterministic
    if (!tools.isDecided()) {
      logger.warn("governance LLM failed or circuit open; falling back to rule-based", {
        proposal_id: proposal.proposal_id,
        error: String(e),
      });
      await processProposal(proposal, env);
      return;
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!tools.isDecided()) {
    logger.info("governance agent did not decide; falling back to rule-based", { proposal_id: proposal.proposal_id });
    await processProposal(proposal, env);
  }
}

/**
 * Evaluate a proposal with the same logic as processProposal but without publishing.
 * Returns the outcome and reason (and actionPayload when approve/pending) for use by oversight or commit.
 */
export async function evaluateProposalDeterministic(
  proposal: Proposal,
  env: GovernanceAgentEnv,
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

  const driftRaw = await s3GetText(env.s3, env.bucket, "drift/latest.json");
  const drift = driftRaw
    ? (JSON.parse(driftRaw) as { level: string; types: string[] })
    : { level: "none", types: [] as string[] };
  const govPath = process.env.GOVERNANCE_PATH ?? join(process.cwd(), "governance.yaml");
  const governance = getGovernanceForScope(SCOPE_ID, loadPolicies(govPath));

  if (mode === "MASTER") {
    return {
      outcome: "approve",
      reason: "master_override",
      actionPayload: { expectedEpoch, runId: state.runId, from, to },
    };
  }

  const policyVersion = getGovernancePolicyVersion(govPath);
  const engine: PolicyEngine = createYamlPolicyEngine(governance, policyVersion);
  const policyContext = {
    scope_id: SCOPE_ID,
    from_state: from,
    to_state: to,
    drift_level: drift.level,
    drift_types: drift.types,
  };
  const policyResult = await engine.evaluate(policyContext);
  try {
    await persistDecisionRecord(policyResult.record);
  } catch {
    // table may not exist or DB unavailable
  }
  await executeObligations(policyResult.record.obligations ?? []);
  if (!policyResult.allowed) {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/af5b746e-3a32-49ef-92b2-aa2d9876cfd3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'governanceAgent:evaluateProposal',message:'drift-block-escalated-to-HITL',data:{from,to,drift_level:drift.level,drift_types:drift.types,reason:policyResult.record.reason,expectedEpoch},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return {
      outcome: "pending",
      reason: policyResult.record.reason,
      actionPayload: {
        expectedEpoch,
        runId: state.runId,
        from,
        to,
        type: "governance_review",
        drift_level: drift.level,
        drift_types: drift.types,
        block_reason: policyResult.record.reason,
      },
    };
  }

  const permissionResult = await checkPermission(agent, "writer", target_node);
  if (!permissionResult.allowed) {
    return {
      outcome: "reject",
      reason: permissionResult.error ?? "policy_denied",
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

/**
 * Commit a pre-computed deterministic result: publish action/rejection/pending and record metrics/events.
 * Used by processProposal and by the oversight agent when it chooses acceptDeterministic.
 * @param path - Governance path for audit (context_events); default "processProposal"
 */
export async function commitDeterministicResult(
  proposal: Proposal,
  result: DeterministicResult,
  env: GovernanceAgentEnv,
  path: GovernancePath = "processProposal",
): Promise<void> {
  const { proposal_id, proposed_action } = proposal;
  if (result.outcome === "ignore") {
    logger.debug("ignoring non advance_state proposal", { proposal_id });
    return;
  }

  if (result.outcome === "reject") {
    if (result.reason === "policy_denied") {
      recordPolicyViolation();
    }
    recordProposal(proposed_action, "rejected");
    await env.getPublishRejection()(`swarm.rejections.${proposed_action}`, {
      proposal_id,
      reason: result.reason,
      result: "rejected",
    });
    await appendEvent({
      type: "proposal_rejected",
      proposal_id,
      reason: result.reason,
      governance_path: path,
    });
    logger.info("proposal rejected", { proposal_id, reason: result.reason, governance_path: path });
    return;
  }

  if (result.outcome === "pending" && result.actionPayload) {
    recordProposal(proposed_action, "pending");
    await addPending(proposal_id, proposal, result.actionPayload);
    await env.getPublishAction()(`swarm.pending_approval.${proposal_id}`, {
      proposal_id,
      status: "pending",
    } as Record<string, unknown>);
    await appendEvent({
      type: "proposal_pending_approval",
      proposal_id,
      governance_path: path,
    });
    logger.info("proposal pending MITL approval", { proposal_id, governance_path: path });
    return;
  }

  if (result.outcome === "approve" && result.actionPayload) {
    const isMaster = result.reason === "master_override";
    recordProposal(proposed_action, "approved");
    const action: Action = {
      proposal_id,
      approved_by: isMaster ? AGENT_ID : "auto",
      result: "approved",
      reason: result.reason,
      action_type: "advance_state",
      payload: { ...result.actionPayload, scope_id: SCOPE_ID },
    };
    await env.getPublishAction()("swarm.actions.advance_state", action as unknown as Record<string, unknown>);
    await appendEvent({
      type: "proposal_approved",
      proposal_id,
      reason: result.reason,
      governance_path: path,
    });
    logger.info("proposal approved", { proposal_id, reason: result.reason, governance_path: path });
  }
}

export async function processProposal(
  proposal: Proposal,
  env: GovernanceAgentEnv,
): Promise<void> {
  const result = await evaluateProposalDeterministic(proposal, env);
  await commitDeterministicResult(proposal, result, env);
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
    await submitFinalityReviewForScope(scopeId, result);
  } else {
    logger.info("finality outcome", { scope_id: scopeId, outcome: "ACTIVE" });
  }
}

/** Dedicated consumer for swarm.finality.evaluate; acks only after runFinalityCheck succeeds (retry on failure). */
async function runFinalityConsumerLoop(bus: EventBus, signal?: AbortSignal): Promise<void> {
  const stream = process.env.NATS_STREAM ?? "SWARM_JOBS";
  const subject = "swarm.finality.evaluate";
  const consumer = "finality-evaluator";
  logger.info("finality consumer started", { subject, consumer });
  while (!signal?.aborted) {
    const processed = await bus.consume(
      stream,
      subject,
      consumer,
      async (msg) => {
        const scopeId = String((msg.data as Record<string, unknown>).scope_id ?? "default");
        await runFinalityCheck(scopeId);
      },
      { timeoutMs: 5000, maxMessages: 10 },
    );
    if (processed === 0) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  logger.info("finality consumer stopped (shutdown signal)");
}

export interface GovernanceLoopOpts {
  signal?: AbortSignal;
  consumerName?: string;
  agentId?: string;
  onHeartbeat?: (processed: number) => void;
  /** When false, skip starting the MITL HTTP server (avoid port conflicts in multi-instance). */
  startMitl?: boolean;
}

export async function runGovernanceAgentLoop(bus: EventBus, s3: S3Client, bucket: string, signalOrOpts?: AbortSignal | GovernanceLoopOpts): Promise<void> {
  const opts: GovernanceLoopOpts = signalOrOpts instanceof AbortSignal
    ? { signal: signalOrOpts }
    : (signalOrOpts ?? {});
  const signal = opts.signal;
  const effectiveAgentId = opts.agentId ?? AGENT_ID;
  const shouldStartMitl = opts.startMitl !== false;

  const { setMitlPublishFns, startMitlServer } = await import("../mitlServer.js");
  const { startWatchdog } = await import("../watchdog.js");
  if (shouldStartMitl) {
    const mitlPort = parseInt(process.env.MITL_PORT ?? "3001", 10);
    setMitlPublishFns(
      (subj, data) => bus.publish(subj, data as Record<string, string>).then(() => {}),
      (subj, data) => bus.publish(subj, data as Record<string, string>).then(() => {}),
    );
    startMitlServer(mitlPort);
  }

  void runFinalityConsumerLoop(bus, signal);

  const { state: watchdogState } = startWatchdog(bus, signal);

  const subject = "swarm.proposals.>";
  const consumer = opts.consumerName ?? `governance-${effectiveAgentId}`;
  logger.info("governance agent started", { subject, consumer, agentId: effectiveAgentId });

  const BACKOFF_MS = 500;
  const BACKOFF_MAX_MS = 5000;
  let delayMs = BACKOFF_MS;

  const env: GovernanceAgentEnv = {
    s3,
    bucket,
    getPublishAction: () => (subj: string, data: Record<string, unknown>) =>
      bus.publish(subj, data as Record<string, string>).then(() => {}),
    getPublishRejection: () => (subj: string, data: Record<string, unknown>) =>
      bus.publish(subj, data as Record<string, string>).then(() => {}),
  };

  while (!signal?.aborted) {
    const processed = await bus.consume(
      NATS_STREAM,
      subject,
      consumer,
      async (msg: { id: string; data: Record<string, unknown> }) => {
        if (await isProcessed(consumer, msg.id)) return;
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
        } else {
          const deterministicResult = await evaluateProposalDeterministic(proposal, env);
          if (!getChatModelConfig()) {
            await commitDeterministicResult(proposal, deterministicResult, env);
          } else {
            await runOversightAgent(proposal, deterministicResult, env);
          }
        }
        await bus.publish("swarm.finality.evaluate", { scope_id: SCOPE_ID } as Record<string, string>);
        watchdogState.lastProposalAt = Date.now();
        await markProcessed(consumer, msg.id);
      },
      { timeoutMs: 5000, maxMessages: 10 },
    );
    opts.onHeartbeat?.(processed);
    if (processed === 0) {
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 2, BACKOFF_MAX_MS);
    } else {
      delayMs = BACKOFF_MS;
    }
  }
  logger.info("governance agent stopped (shutdown signal)");
}
