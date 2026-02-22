import "dotenv/config";
import { randomUUID } from "crypto";
import { makeS3 } from "./s3.js";
import { initTelemetry } from "./telemetry.js";
import { initState } from "./stateGraph.js";
import { getSpec } from "./agentRegistry.js";
import { makeEventBus, type EventBus } from "./eventBus.js";
import { waitForNatsAndStream } from "./readiness.js";
import { logger, setLogContext } from "./logger.js";
import { toErrorString } from "./errors.js";
import { runGovernanceAgentLoop } from "./agents/governanceAgent.js";
import { runActionExecutor } from "./actionExecutor.js";
import { runAgentLoop } from "./agentLoop.js";
import { runTunerAgentLoop } from "./agents/tunerAgent.js";
import { createSwarmEvent } from "./events.js";

const BUCKET = process.env.S3_BUCKET!;
const AGENT_ID = process.env.AGENT_ID ?? `agent-${Math.random().toString(16).slice(2, 10)}`;
const ROLE = process.env.AGENT_ROLE ?? "facts";
const NATS_STREAM = process.env.NATS_STREAM ?? "SWARM_JOBS";
const SCOPE_ID = process.env.SCOPE_ID ?? "default";

const STREAM_SUBJECTS = [
  "swarm.jobs.>",
  "swarm.proposals.>",
  "swarm.actions.>",
  "swarm.rejections.>",
  "swarm.events.>",
  "swarm.finality.>",
];

setLogContext({ agent_id: AGENT_ID, role: ROLE });

async function bootstrap(bus: EventBus): Promise<void> {
  const jobSubjects = ["swarm.jobs.extract_facts", "swarm.jobs.check_drift", "swarm.jobs.plan_actions", "swarm.jobs.summarize_status"];
  for (const subj of jobSubjects) {
    await bus.publish(subj, { type: subj.split(".").pop()!, reason: "bootstrap" });
  }
  await bus.publishEvent(
    createSwarmEvent("bootstrap", { reason: "bootstrap" }, { source: "swarm" }),
  );
  logger.info("bootstrap complete");
}

async function main(): Promise<void> {
  initTelemetry();
  await waitForNatsAndStream({
    streamName: NATS_STREAM,
    streamSubjects: STREAM_SUBJECTS,
    connectTimeoutMs: 5000,
    connectRetries: 5,
    retryDelayMs: 2000,
  });
  const s3 = makeS3();
  const bus = await makeEventBus();
  await bus.ensureStream(NATS_STREAM, STREAM_SUBJECTS);
  await initState(SCOPE_ID, randomUUID());

  if (process.env.BOOTSTRAP === "1") {
    await bootstrap(bus);
  }

  if (ROLE === "governance") {
    await runGovernanceAgentLoop(bus, s3, BUCKET);
  }
  if (ROLE === "executor") {
    await runActionExecutor(bus);
  }

  const spec = getSpec(ROLE);
  if (!spec) {
    logger.error("unknown agent role", { role: ROLE });
    process.exit(1);
  }

  if (ROLE === "tuner") {
    await runTunerAgentLoop(s3, BUCKET, async (type, payload) => {
      await bus.publishEvent(createSwarmEvent(type, payload, { source: "tuner" }));
    });
  }

  await runAgentLoop({
    s3,
    bucket: BUCKET,
    bus,
    stream: NATS_STREAM,
    agentId: AGENT_ID,
    role: ROLE,
    scopeId: SCOPE_ID,
  });
}

main().catch((e) => {
  logger.error("fatal", { error: toErrorString(e) });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection", { error: toErrorString(reason) });
  process.exit(1);
});
