import "dotenv/config";
import { join } from "path";
import type { S3Client } from "@aws-sdk/client-s3";
import { s3GetText } from "../s3.js";
import { loadState } from "../stateGraph.js";
import { loadPolicies, canTransition } from "../governance.js";
import { checkPermission } from "../policy.js";
import { appendEvent } from "../contextWal.js";
import { addPending } from "../mitlServer.js";
import { makeEventBus, type EventBus } from "../eventBus.js";
import { logger, setLogContext } from "../logger.js";
import { recordProposal, recordPolicyViolation } from "../metrics.js";
import type { Proposal, Action } from "../events.js";

const AGENT_ID = process.env.AGENT_ID ?? "governance-1";
const NATS_STREAM = process.env.NATS_STREAM ?? "SWARM_JOBS";
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
        await processProposal(proposal, env);
      },
      { timeoutMs: 5000, maxMessages: 10 },
    );
    if (processed === 0) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
