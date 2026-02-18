import "dotenv/config";
import { join } from "path";
import { randomUUID } from "crypto";
import { makeS3, s3GetText } from "./s3.js";
import { loadState, initState, advanceState } from "./stateGraph.js";
import { getSpec } from "./agentRegistry.js";
import { makeEventBus, type EventBus } from "./eventBus.js";
import { loadPolicies } from "./governance.js";
import { logger, setLogContext } from "./logger.js";
import { runFactsAgent } from "./agents/factsAgent.js";
import { runDriftAgent } from "./agents/driftAgent.js";
import { runPlannerAgent } from "./agents/plannerAgent.js";
import { runStatusAgent } from "./agents/statusAgent.js";

const BUCKET = process.env.S3_BUCKET!;
const AGENT_ID = process.env.AGENT_ID ?? `agent-${Math.random().toString(16).slice(2, 10)}`;
const ROLE = process.env.AGENT_ROLE ?? "facts";
const NATS_STREAM = process.env.NATS_STREAM ?? "SWARM_JOBS";

setLogContext({ agent_id: AGENT_ID, role: ROLE });

const JOB_RUNNERS: Record<string, (s3: any, bucket: string, payload: Record<string, unknown>) => Promise<unknown>> = {
  extract_facts: runFactsAgent,
  check_drift: runDriftAgent,
  plan_actions: runPlannerAgent,
  summarize_status: runStatusAgent,
};

async function bootstrap(bus: EventBus): Promise<void> {
  const subjects = ["swarm.jobs.extract_facts", "swarm.jobs.check_drift", "swarm.jobs.plan_actions", "swarm.jobs.summarize_status"];
  await bus.ensureStream(NATS_STREAM, ["swarm.jobs.>"]);
  for (const subj of subjects) {
    await bus.publish(subj, { type: subj.split(".").pop()!, reason: "bootstrap" });
  }
  logger.info("bootstrap complete");
}

async function main(): Promise<void> {
  const spec = getSpec(ROLE);
  if (!spec) {
    logger.error("unknown agent role", { role: ROLE });
    process.exit(1);
  }

  const s3 = makeS3();
  const bus = await makeEventBus();
  await bus.ensureStream(NATS_STREAM, ["swarm.jobs.>"]);
  await initState(randomUUID());

  if (process.env.BOOTSTRAP === "1") {
    await bootstrap(bus);
  }

  const subject = `swarm.jobs.${spec.jobType}`;
  const consumer = `${ROLE}-${AGENT_ID}`;
  logger.info("agent started, consuming", { subject, consumer });

  while (true) {
    if (spec.requiresNode !== null) {
      const state = await loadState();
      if (!state || state.lastNode !== spec.requiresNode) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
    }

    const processed = await bus.consume(NATS_STREAM, subject, consumer, async (msg) => {
      const payload = msg.data as Record<string, unknown>;

      const stateBefore = spec.requiresNode !== null ? await loadState() : null;
      if (spec.requiresNode !== null) {
        if (!stateBefore || stateBefore.lastNode !== spec.requiresNode) {
          logger.debug("state precondition no longer met, skipping", { msg_id: msg.id });
          return;
        }
      }

      const runner = JOB_RUNNERS[spec.jobType];
      let result: unknown;
      try {
        result = await runner(s3, BUCKET, payload);
      } catch (err) {
        logger.error("job execution failed", { job_type: spec.jobType, error: String(err) });
        return;
      }

      if (stateBefore && spec.advancesTo !== null) {
        const driftRaw = await s3GetText(s3, BUCKET, "drift/latest.json");
        const drift = driftRaw
          ? (JSON.parse(driftRaw) as { level: string; types: string[] })
          : { level: "none", types: [] as string[] };
        const govPath = process.env.GOVERNANCE_PATH ?? join(process.cwd(), "governance.yaml");
        const governance = loadPolicies(govPath);

        const advanced = await advanceState(stateBefore.epoch, { drift, governance });
        if (!advanced) {
          logger.warn("state advance blocked or CAS failed", {
            epoch: stateBefore.epoch,
            drift_level: drift.level,
          });
        }
      }

      if (spec.jobType === "plan_actions" && result && typeof result === "object") {
        const actions = (result as any).actions as string[] | undefined;
        if (actions?.length) {
          for (const action of actions) {
            await bus.publish("swarm.jobs.summarize_status", {
              type: "summarize_status",
              reason: "planner_action",
              action,
            });
          }
          logger.info("planner dispatched actions", { actions });
        }
      }

      logger.info("job completed", { job_type: spec.jobType, msg_id: msg.id });

      await bus.publish(subject, { type: spec.jobType, reason: "periodic" });
    }, { timeoutMs: 5000, maxMessages: 1 });

    if (processed === 0) {
      logger.debug("no messages, waiting");
    }
  }
}

main().catch((e) => {
  logger.error("fatal", { error: String(e) });
  process.exit(1);
});
