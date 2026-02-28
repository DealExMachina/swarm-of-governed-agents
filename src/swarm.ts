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
import { drainPool } from "./db.js";
import { runGovernanceAgentLoop } from "./agents/governanceAgent.js";
import { runActionExecutor } from "./actionExecutor.js";
import { runAgentLoop } from "./agentLoop.js";
import { runTunerAgentLoop } from "./agents/tunerAgent.js";
import { createSwarmEvent } from "./events.js";
import { loadHatcheryConfig } from "./hatcheryConfig.js";
import { AgentHatchery } from "./hatchery.js";

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

// ── Graceful shutdown ────────────────────────────────────────────────────────

const shutdownController = new AbortController();
const shutdownSignal = shutdownController.signal;
let _bus: EventBus | null = null;
const SHUTDOWN_GRACE_MS = 10000; // 10s for in-flight handlers to finish

function onShutdownSignal(sig: string) {
  logger.info("shutdown signal received, draining...", { signal: sig });
  shutdownController.abort();

  // Give in-flight handlers time to finish, then force-close resources
  setTimeout(async () => {
    try {
      if (_bus) await _bus.close();
    } catch (e) {
      logger.error("bus close error", { error: toErrorString(e) });
    }
    try {
      await drainPool();
    } catch (e) {
      logger.error("pool drain error", { error: toErrorString(e) });
    }
    logger.info("graceful shutdown complete");
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
}

process.on("SIGTERM", () => onShutdownSignal("SIGTERM"));
process.on("SIGINT", () => onShutdownSignal("SIGINT"));

// ── Main ─────────────────────────────────────────────────────────────────────

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
  _bus = bus; // Store reference for shutdown handler
  await bus.ensureStream(NATS_STREAM, STREAM_SUBJECTS);
  await initState(SCOPE_ID, randomUUID());

  if (process.env.BOOTSTRAP === "1") {
    await bootstrap(bus);
  }

  // ── Hatchery mode: single-process orchestrator ─────────────────────────────
  if (ROLE === "hatchery") {
    const config = loadHatcheryConfig();
    const hatchery = new AgentHatchery(config, bus, s3, BUCKET);

    const hatcheryShutdown = async (sig: string) => {
      logger.info("hatchery shutdown signal received", { signal: sig });
      await hatchery.shutdown();
      try { await drainPool(); } catch {}
      process.exit(0);
    };
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    process.on("SIGTERM", () => void hatcheryShutdown("SIGTERM"));
    process.on("SIGINT", () => void hatcheryShutdown("SIGINT"));

    await hatchery.start();
    await new Promise<void>(() => {}); // block forever; shutdown via signal
    return;
  }

  if (ROLE === "governance") {
    await runGovernanceAgentLoop(bus, s3, BUCKET, shutdownSignal);
    return; // governance loop exits on signal; don't fall through to runAgentLoop
  }
  if (ROLE === "executor") {
    await runActionExecutor(bus, shutdownSignal);
    return;
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
    return;
  }

  await runAgentLoop({
    s3,
    bucket: BUCKET,
    bus,
    stream: NATS_STREAM,
    agentId: AGENT_ID,
    role: ROLE,
    scopeId: SCOPE_ID,
    signal: shutdownSignal,
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
