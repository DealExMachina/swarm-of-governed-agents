import "dotenv/config";
import { join } from "path";
import { makeS3, s3GetText } from "./s3.js";
import { advanceState, transitions, type Node } from "./stateGraph.js";
import { getNextJobForNode } from "./agentRegistry.js";
import { loadPolicies } from "./governance.js";
import { makeEventBus, type EventBus } from "./eventBus.js";
import { logger, setLogContext } from "./logger.js";
import type { Action } from "./events.js";
import { createSwarmEvent } from "./events.js";

const BUCKET = process.env.S3_BUCKET!;
const NATS_STREAM = process.env.NATS_STREAM ?? "SWARM_JOBS";
const AGENT_ID = process.env.AGENT_ID ?? "executor-1";

setLogContext({ agent_id: AGENT_ID, role: "executor" });

export async function runActionExecutor(bus: EventBus): Promise<void> {
  const s3 = makeS3();
  const subject = "swarm.actions.>";
  const consumer = `executor-${AGENT_ID}`;

  logger.info("action executor started", { subject, consumer });

  while (true) {
    const processed = await bus.consume(
      NATS_STREAM,
      subject,
      consumer,
      async (msg) => {
        const data = msg.data as unknown as Action;
        if (data.result !== "approved" || !data.payload) return;

        const actionType = (data as any).action_type as string | undefined;
        if (actionType !== "advance_state") return;

        const { expectedEpoch } = data.payload as { expectedEpoch: number };
        const govPath = process.env.GOVERNANCE_PATH ?? join(process.cwd(), "governance.yaml");
        const governance = loadPolicies(govPath);
        const driftRaw = await s3GetText(s3, BUCKET, "drift/latest.json");
        const drift = driftRaw
          ? (JSON.parse(driftRaw) as { level: string; types: string[] })
          : { level: "none", types: [] as string[] };

        const newState = await advanceState(expectedEpoch, { drift, governance });
        if (!newState) {
          logger.warn("executor advance failed", { proposal_id: data.proposal_id });
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
      },
      { timeoutMs: 5000, maxMessages: 10 },
    );
    if (processed === 0) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
