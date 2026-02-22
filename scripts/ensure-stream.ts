import "dotenv/config";
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
  console.log("Stream ready:", NATS_STREAM);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
