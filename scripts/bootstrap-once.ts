import "dotenv/config";
import { makeEventBus } from "../src/eventBus.js";
import { createSwarmEvent } from "../src/events.js";
import { appendEvent } from "../src/contextWal.js";
import { waitForNatsAndStream } from "../src/readiness.js";

const NATS_STREAM = process.env.NATS_STREAM ?? "SWARM_JOBS";
const STREAM_SUBJECTS = [
  "swarm.jobs.>",
  "swarm.proposals.>",
  "swarm.actions.>",
  "swarm.rejections.>",
  "swarm.events.>",
];

async function main(): Promise<void> {
  await waitForNatsAndStream({
    streamName: NATS_STREAM,
    streamSubjects: STREAM_SUBJECTS,
    connectTimeoutMs: 5000,
    connectRetries: 5,
    retryDelayMs: 2000,
  });
  const bus = await makeEventBus();
  await bus.ensureStream(NATS_STREAM, STREAM_SUBJECTS);
  const jobSubjects = [
    "swarm.jobs.extract_facts",
    "swarm.jobs.check_drift",
    "swarm.jobs.plan_actions",
    "swarm.jobs.summarize_status",
  ];
  for (const subj of jobSubjects) {
    await bus.publish(subj, { type: subj.split(".").pop() ?? "bootstrap", reason: "bootstrap" });
  }
  const bootstrapEvent = createSwarmEvent("bootstrap", { reason: "bootstrap" }, { source: "bootstrap-once" });
  await bus.publishEvent(bootstrapEvent);
  const seq = await appendEvent(bootstrapEvent as unknown as Record<string, unknown>);
  console.log("bootstrap complete (NATS + WAL seq", seq, ")");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
