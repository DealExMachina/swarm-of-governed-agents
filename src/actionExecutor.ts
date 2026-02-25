import "dotenv/config";
import { join } from "path";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Agent } from "@mastra/core/agent";
import { makeS3 } from "./s3.js";
import { loadDrift, DRIFT_NONE } from "./agents/sharedTools.js";
import { advanceState, loadState, transitions, type Node, type GraphState } from "./stateGraph.js";
import { getNextJobForNode } from "./agentRegistry.js";
import { loadPolicies, getGovernanceForScope } from "./governance.js";
import type { EventBus } from "./eventBus.js";
import { logger, setLogContext } from "./logger.js";
import { getChatModelConfig } from "./modelConfig.js";
import type { Action } from "./events.js";
import { createSwarmEvent } from "./events.js";
import { recordFinalityDecision } from "./finalityDecisions.js";
import type { FinalityOption } from "./finalityDecisions.js";
import { CircuitBreaker } from "./resilience.js";

/** LLM circuit breaker: opens after 3 consecutive failures, 60s cooldown. */
const llmBreaker = new CircuitBreaker("executor-llm", 3, 60000);

const BUCKET = process.env.S3_BUCKET ?? "swarm-facts";
const NATS_STREAM = process.env.NATS_STREAM ?? "SWARM_JOBS";
const AGENT_ID = process.env.AGENT_ID ?? "executor-1";

setLogContext({ agent_id: AGENT_ID, role: "executor" });

const EXECUTOR_AGENT_INSTRUCTIONS = `You are the executor agent. You have an approved action to advance the state machine (expectedEpoch, from, to).
Use readAction to see the full action. Use readState to see current state and epoch. Use readDrift to see current drift.
If the state has not changed and executing is appropriate, call executeAdvance to perform the transition and publish the next job. If you decide not to execute (e.g. conditions changed, drift too high to proceed now), call declineExecute with a brief reason.
Call exactly one of: executeAdvance() or declineExecute(reason). End with a one-sentence rationale.`;

function createExecutorTools(
  action: Action,
  bus: EventBus,
  s3: ReturnType<typeof makeS3>,
  bucket: string,
) {
  const govPath = process.env.GOVERNANCE_PATH ?? join(process.cwd(), "governance.yaml");
  const readActionTool = createTool({
    id: "readAction",
    description: "Read the approved action (proposal_id, payload with expectedEpoch, from, to).",
    inputSchema: z.object({}),
    outputSchema: z.object({
      action: z.record(z.unknown()),
    }),
    execute: async () => ({ action: action as unknown as Record<string, unknown> }),
  });
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
      const scopeId = (action.payload as { scope_id?: string })?.scope_id ?? process.env.SCOPE_ID ?? "default";
      const state = await loadState(scopeId);
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
      const drift = (await loadDrift(s3, bucket)) ?? DRIFT_NONE;
      return { drift };
    },
  });
  const executeAdvanceTool = createTool({
    id: "executeAdvance",
    description: "Perform the state advance: update state, publish next job, emit state_transition event.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      ok: z.boolean(),
      newState: z.record(z.unknown()).nullable(),
      error: z.string().optional(),
    }),
    execute: async () => {
      const payload = action.payload as { expectedEpoch: number; from?: string; to?: string; scope_id?: string } | undefined;
      if (!payload?.expectedEpoch) {
        return { ok: false, newState: null, error: "missing_payload" };
      }
      const scopeId = payload.scope_id ?? process.env.SCOPE_ID ?? "default";
      const governance = getGovernanceForScope(scopeId, loadPolicies(govPath));
      const drift = (await loadDrift(s3, bucket)) ?? DRIFT_NONE;
      const newState = await advanceState(payload.expectedEpoch, { scopeId, drift, governance });
      if (!newState) {
        const current = await loadState(scopeId);
        if (current && current.epoch > payload.expectedEpoch) {
          logger.info("executor advance skipped (state already advanced)", {
            proposal_id: action.proposal_id,
            expectedEpoch: payload.expectedEpoch,
            currentEpoch: current.epoch,
          });
          return { ok: true, newState: current as unknown as Record<string, unknown> };
        }
        logger.warn("executor advance failed", { proposal_id: action.proposal_id });
        return { ok: false, newState: null, error: "advance_failed" };
      }
      const nextJob = getNextJobForNode(newState.lastNode);
      if (nextJob) {
        await bus.publish(`swarm.jobs.${nextJob}`, { type: nextJob, reason: "after_advance" });
        logger.info("advanced and published next job", { to: newState.lastNode, next_job: nextJob });
      }
      const fromNode = (Object.entries(transitions) as [Node, Node][]).find(([, to]) => to === newState.lastNode)?.[0];
      if (fromNode) {
        await bus.publishEvent(
          createSwarmEvent("state_transition", {
            from: fromNode,
            to: newState.lastNode,
            epoch: newState.epoch,
            run_id: newState.runId,
          }, { source: "executor" }),
        );
      }
      return { ok: true, newState: newState as unknown as Record<string, unknown> };
    },
  });
  const declineExecuteTool = createTool({
    id: "declineExecute",
    description: "Decline to execute this action (e.g. conditions changed). The action will not be retried automatically.",
    inputSchema: z.object({
      reason: z.string().describe("Reason for declining"),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
    }),
    execute: async (input) => {
      const reason = (input as { reason?: string })?.reason ?? "declined";
      logger.info("executor declined (agent)", { proposal_id: action.proposal_id, reason });
      return { ok: true };
    },
  });
  return {
    readAction: readActionTool,
    readState: readStateTool,
    readDrift: readDriftTool,
    executeAdvance: executeAdvanceTool,
    declineExecute: declineExecuteTool,
  };
}

/** Kept for potential future non-advance_state actions; advance_state always uses executeActionInline. */
async function processActionWithAgent(action: Action, bus: EventBus, s3: ReturnType<typeof makeS3>, bucket: string): Promise<void> {
  const modelConfig = getChatModelConfig();
  if (!modelConfig) {
    await executeActionInline(action, bus, s3, bucket);
    return;
  }
  const tools = createExecutorTools(action, bus, s3, bucket);
  const agent = new Agent({
    id: "executor-agent",
    name: "Executor Agent",
    instructions: EXECUTOR_AGENT_INSTRUCTIONS,
    model: modelConfig,
    tools: {
      readAction: tools.readAction,
      readState: tools.readState,
      readDrift: tools.readDrift,
      executeAdvance: tools.executeAdvance,
      declineExecute: tools.declineExecute,
    },
  });
  const prompt = `Approved action: proposal_id=${action.proposal_id} payload=${JSON.stringify(action.payload)}. Decide whether to execute or decline and call the corresponding tool.`;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 30000);
  try {
    await llmBreaker.call(() => agent.generate(prompt, { maxSteps: 10, abortSignal: abortController.signal }));
  } catch (e) {
    logger.warn("executor LLM failed or circuit open; falling back to inline execution", {
      proposal_id: action.proposal_id,
      error: String(e),
    });
    await executeActionInline(action, bus, s3, bucket);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function executeActionInline(
  action: Action,
  bus: EventBus,
  s3: ReturnType<typeof makeS3>,
  bucket: string,
): Promise<void> {
  if (action.result !== "approved" || !action.payload) return;
  const actionType = (action as Action & { action_type?: string }).action_type;
  if (actionType !== "advance_state") return;
  const payload = action.payload as { expectedEpoch: number; scope_id?: string };
  const { expectedEpoch } = payload;
  const scopeId = payload.scope_id ?? process.env.SCOPE_ID ?? "default";
  const isHumanOverride = action.approved_by === "human";
  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/af5b746e-3a32-49ef-92b2-aa2d9876cfd3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'executor:executeActionInline',message:'executing',data:{proposal_id:action.proposal_id,isHumanOverride,expectedEpoch,approved_by:action.approved_by},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  let newState: GraphState | null;
  if (isHumanOverride) {
    newState = await advanceState(expectedEpoch, { scopeId });
    logger.info("human-approved override, skipping governance re-check", { proposal_id: action.proposal_id });
  } else {
    const govPath = process.env.GOVERNANCE_PATH ?? join(process.cwd(), "governance.yaml");
    const governance = getGovernanceForScope(scopeId, loadPolicies(govPath));
    const drift = (await loadDrift(s3, bucket)) ?? DRIFT_NONE;
    newState = await advanceState(expectedEpoch, { scopeId, drift, governance });
  }
  if (!newState) {
    const current = await loadState(scopeId);
    if (current && current.epoch > expectedEpoch) {
      logger.info("executor advance skipped (state already advanced)", {
        proposal_id: action.proposal_id,
        expectedEpoch,
        currentEpoch: current.epoch,
      });
      return;
    }
    logger.warn("executor advance failed", { proposal_id: action.proposal_id });
    return;
  }
  const nextJob = getNextJobForNode(newState.lastNode);
  if (nextJob) {
    await bus.publish(`swarm.jobs.${nextJob}`, { type: nextJob, reason: "after_advance" });
    logger.info("advanced and published next job", { to: newState.lastNode, next_job: nextJob });
  }
  const fromNode = (Object.entries(transitions) as [Node, Node][]).find(([, to]) => to === newState.lastNode)?.[0];
  if (fromNode) {
    await bus.publishEvent(
      createSwarmEvent("state_transition", {
        from: fromNode,
        to: newState.lastNode,
        epoch: newState.epoch,
        run_id: newState.runId,
      }, { source: "executor" }),
    );
  }
}

export async function runActionExecutor(bus: EventBus, signal?: AbortSignal): Promise<void> {
  const s3 = makeS3();
  const subject = "swarm.actions.>";
  const consumer = `executor-${AGENT_ID}`;

  logger.info("action executor started", { subject, consumer });

  while (!signal?.aborted) {
    const processed = await bus.consume(
      NATS_STREAM,
      subject,
      consumer,
      async (msg) => {
        const data = msg.data as unknown as Action & { action_type?: string; option?: string; days?: number };
        const actionType = data.action_type;

        if (actionType === "finality") {
          const option = data.option as FinalityOption | undefined;
          const payload = data.payload as { scope_id?: string } | undefined;
          const scopeId = payload?.scope_id ?? process.env.SCOPE_ID ?? "default";
          const valid: FinalityOption[] = ["approve_finality", "provide_resolution", "escalate", "defer"];
          if (option && valid.includes(option)) {
            try {
              await recordFinalityDecision(scopeId, option, data.days);
              logger.info("finality decision recorded", { scope_id: scopeId, option, proposal_id: data.proposal_id });
            } catch (err) {
              logger.error("finality decision record failed", { scope_id: scopeId, option, error: String(err) });
            }
          }
          return;
        }

        if (data.result !== "approved" || !data.payload) return;
        if (actionType !== "advance_state") return;
        // advance_state: always use deterministic path so approved transitions are applied
        await executeActionInline(data, bus, s3, BUCKET);
      },
      { timeoutMs: 5000, maxMessages: 10 },
    );
    if (processed === 0) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  logger.info("action executor stopped (shutdown signal)");
}
