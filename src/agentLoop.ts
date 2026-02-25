/**
 * Event-driven autonomous agent loop. Pull from swarm.events.> (no push subscription
 * to avoid NATS "duplicate subscription" when durable consumer is still push_bound).
 * Run deterministic filter, self-check OpenFGA, execute agent, publish result, update memory, emit proposal if needed.
 */

import { randomUUID } from "crypto";
import type { S3Client } from "@aws-sdk/client-s3";
import type { EventBus } from "./eventBus.js";
import { loadState, transitions } from "./stateGraph.js";
import { getSpec } from "./agentRegistry.js";
import { loadFilterConfig, loadAgentMemory, saveAgentMemory, checkFilter, recordActivation } from "./activationFilters.js";
import { checkPermission } from "./policy.js";
import { isProcessed, markProcessed } from "./messageDedup.js";
import { createSwarmEvent } from "./events.js";
import { toErrorString } from "./errors.js";
import { logger } from "./logger.js";
import { recordAgentLatency, recordAgentError } from "./metrics.js";
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

function memoryUpdateFromContext(_role: string, context: Record<string, unknown>): Partial<import("./activationFilters.js").AgentMemory> {
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
  scopeId?: string;
  /** Abort signal for graceful shutdown — loop exits when aborted. */
  signal?: AbortSignal;
}

/**
 * Run the event-driven agent loop. Subscribes to events and processes them; does not return.
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  const { s3, bucket, bus, stream, agentId, role, scopeId: optsScopeId } = opts;
  const scopeId = optsScopeId ?? process.env.SCOPE_ID ?? "default";
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
  const s = spec;
  const r = runner;

  const subject = "swarm.events.>";
  const consumer = `${role}-${agentId}-events`;

  await bus.ensureStream(stream, [subject]);

  async function handleMessage(msg: { id: string; data: Record<string, unknown> }): Promise<void> {
    if (await isProcessed(consumer, msg.id)) {
      return;
    }
    const startMs = Date.now();
    try {
      const config = await loadFilterConfig(role);
      const memory = await loadAgentMemory(role);
      const filterCtx = { s3, bucket };
      const activation = await checkFilter(config, memory, filterCtx);
      if (!activation.shouldActivate) {
        logger.info("filter rejected", { role, reason: activation.reason, ...activation.context });
        // NAK with delay so NATS redelivers after cooldown; otherwise message would be acked and lost.
        if (activation.reason.includes("cooldown")) {
          const e = new Error(`filter_cooldown: ${activation.reason}`) as Error & { nakDelayMs?: number };
          e.nakDelayMs = 2500; // slightly above default facts cooldown (2000ms)
          throw e;
        }
        return;
      }
      logger.info("filter activated", { role, reason: activation.reason });

      const permitted = await checkPermission(agentId, "writer", s.targetNode);
      if (!permitted.allowed) {
        logger.info("permission denied, skipping", { role, targetNode: s.targetNode });
        return;
      }

      const result = await r(s3, bucket, activation.context as Record<string, unknown>);
      const latencyMs = Date.now() - startMs;
      recordAgentLatency(role, latencyMs);
      await recordActivation(role, true, latencyMs);

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(JSON.stringify(result ?? {})) as Record<string, unknown>;
      } catch {
        payload = { wrote: [], facts_hash: undefined };
      }
      await bus.publishEvent(
        createSwarmEvent(s.resultEventType, payload, { source: role }),
      );

      const memUpdate = memoryUpdateFromContext(role, activation.context);
      await saveAgentMemory(role, memUpdate);

      if (s.proposesAdvance && s.advancesTo) {
        const stateBefore = await loadState(scopeId);
        if (stateBefore) {
          const to = transitions[stateBefore.lastNode];
          const proposal = {
            proposal_id: randomUUID(),
            agent: agentId,
            proposed_action: "advance_state",
            target_node: s.advancesTo,
            payload: {
              expectedEpoch: stateBefore.epoch,
              runId: stateBefore.runId,
              from: stateBefore.lastNode,
              to,
            },
            mode: "YOLO" as const,
          };
          await bus.publish(`swarm.proposals.${s.jobType}`, proposal as unknown as Record<string, string>);
          logger.info("proposal emitted", { proposal_id: proposal.proposal_id, job_type: s.jobType });
        }
      }
      await markProcessed(consumer, msg.id);
    } catch (err) {
      recordAgentError(role);
      const errMsg = toErrorString(err);
      const isTimeoutOrConnect =
        /timeout|TIMEOUT|abort|AbortError|The operation was aborted|fetch failed|ECONNREFUSED/i.test(errMsg) ||
        (err instanceof Error && (err as Error & { name?: string }).name === "AbortError");
      logger.error("agent loop error", {
        role,
        error: errMsg,
        ...(isTimeoutOrConnect
          ? { hint: "Worker/LLM timeout or unreachable. Set FACTS_WORKER_TIMEOUT_MS (e.g. 300000 for 5 min) for heavy steps; check FACTS_WORKER_URL and worker health." }
          : {}),
      });
      // Rethrow transient errors so the event bus NAKs the message; NATS will redeliver (up to max_deliver).
      // Ensures documents get processed when facts-worker or LLM becomes reachable again.
      if (isTimeoutOrConnect) {
        throw err;
      }
    }
  }

  logger.info("agent loop started (pull)", { role, subject, consumer });

  const BACKOFF_MS = 500;
  const BACKOFF_MAX_MS = 5000;
  let delayMs = BACKOFF_MS;

  const signal = opts.signal;

  while (!signal?.aborted) {
    const processed = await bus.consume(
      stream,
      subject,
      consumer,
      handleMessage,
      { timeoutMs: 5000, maxMessages: 10 },
    );
    if (processed === 0) {
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 2, BACKOFF_MAX_MS);
    } else {
      delayMs = BACKOFF_MS;
    }
  }
  logger.info("agent loop stopped (shutdown signal)", { role });
}
