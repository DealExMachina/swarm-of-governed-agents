/**
 * Event-driven autonomous agent loop. Subscribe to swarm.events.>, run deterministic
 * filter, self-check OpenFGA, execute agent, publish result, update memory, emit proposal if needed.
 */

import { randomUUID } from "crypto";
import type { S3Client } from "@aws-sdk/client-s3";
import type { EventBus } from "./eventBus.js";
import { loadState, transitions } from "./stateGraph.js";
import { getSpec } from "./agentRegistry.js";
import { loadFilterConfig, loadAgentMemory, saveAgentMemory, checkFilter, recordActivation } from "./activationFilters.js";
import { checkPermission } from "./policy.js";
import { createSwarmEvent } from "./events.js";
import { toErrorString } from "./errors.js";
import { logger } from "./logger.js";
import { runFactsAgent } from "./agents/factsAgent.js";
import { runDriftAgent } from "./agents/driftAgent.js";
import { runPlannerAgent } from "./agents/plannerAgent.js";
import { runStatusAgent } from "./agents/statusAgent.js";
import type { AgentSpec } from "./agentRegistry.js";

const JOB_RUNNERS: Record<string, (s3: S3Client, bucket: string, payload: Record<string, unknown>) => Promise<unknown>> = {
  extract_facts: runFactsAgent,
  check_drift: runDriftAgent,
  plan_actions: runPlannerAgent,
  summarize_status: runStatusAgent,
};

function getRunner(spec: AgentSpec): ((s3: S3Client, bucket: string, payload: Record<string, unknown>) => Promise<unknown>) | null {
  return JOB_RUNNERS[spec.jobType] ?? null;
}

function memoryUpdateFromContext(role: string, context: Record<string, unknown>): Partial<import("./activationFilters.js").AgentMemory> {
  const now = Date.now();
  const update: Partial<import("./activationFilters.js").AgentMemory> = { lastActivatedAt: now };
  if (typeof context.latestSeq === "number") {
    update.lastProcessedSeq = context.latestSeq;
  }
  if (typeof context.currentHash === "string") {
    if (String(context.field ?? "").includes("drift")) {
      update.lastDriftHash = context.currentHash;
    } else {
      update.lastHash = context.currentHash;
    }
  }
  return update;
}

export interface AgentLoopOptions {
  s3: S3Client;
  bucket: string;
  bus: EventBus;
  stream: string;
  agentId: string;
  role: string;
}

/**
 * Run the event-driven agent loop. Subscribes to events and processes them; does not return.
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  const { s3, bucket, bus, stream, agentId, role } = opts;
  const spec = getSpec(role);
  if (!spec) {
    logger.error("unknown agent role", { role });
    process.exit(1);
  }
  const runner = getRunner(spec);
  if (!runner) {
    logger.error("no runner for role", { role });
    process.exit(1);
  }

  const subject = "swarm.events.>";
  const consumer = `${role}-${agentId}-events`;

  await bus.ensureStream(stream, [subject]);

  const sub = await bus.subscribe(stream, subject, consumer, async (msg) => {
    const startMs = Date.now();
    try {
      const config = await loadFilterConfig(role);
      const memory = await loadAgentMemory(role);
      const filterCtx = { s3, bucket };
      const activation = await checkFilter(config, memory, filterCtx);
      if (!activation.shouldActivate) {
        return;
      }

      const permitted = await checkPermission(agentId, "writer", spec.targetNode);
      if (!permitted.allowed) {
        logger.info("permission denied, skipping", { role, targetNode: spec.targetNode });
        return;
      }

      const result = await runner(s3, bucket, activation.context as Record<string, unknown>);
      const latencyMs = Date.now() - startMs;
      await recordActivation(role, true, latencyMs);

      await bus.publishEvent(
        createSwarmEvent(spec.resultEventType, (result ?? {}) as Record<string, unknown>, { source: role }),
      );

      const memUpdate = memoryUpdateFromContext(role, activation.context);
      await saveAgentMemory(role, memUpdate);

      if (spec.proposesAdvance && spec.advancesTo) {
        const stateBefore = await loadState();
        if (stateBefore) {
          const to = transitions[stateBefore.lastNode];
          const proposal = {
            proposal_id: randomUUID(),
            agent: agentId,
            proposed_action: "advance_state",
            target_node: spec.advancesTo,
            payload: {
              expectedEpoch: stateBefore.epoch,
              runId: stateBefore.runId,
              from: stateBefore.lastNode,
              to,
            },
            mode: "YOLO" as const,
          };
          await bus.publish(`swarm.proposals.${spec.jobType}`, proposal as unknown as Record<string, string>);
          logger.info("proposal emitted", { proposal_id: proposal.proposal_id, job_type: spec.jobType });
        }
      }
    } catch (err) {
      logger.error("agent loop error", { role, error: toErrorString(err) });
    }
  });

  logger.info("agent loop subscribed", { role, subject, consumer });
  await new Promise<void>(() => {});
}
