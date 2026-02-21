/**
 * Delete existing agent durable consumers so they are recreated as pull (not push).
 * Fixes "push consumer not supported" when agents use consume() after a previous push subscription.
 * Run before starting the swarm in E2E or after upgrading from push to pull.
 */
import "dotenv/config";
import { connect } from "nats";

const STREAM = process.env.NATS_STREAM ?? "SWARM_JOBS";
const CONSUMERS = [
  "facts-facts-1-events",
  "drift-drift-1-events",
  "planner-planner-1-events",
  "status-status-1-events",
];

async function main() {
  const nc = await connect({
    servers: process.env.NATS_URL ?? "nats://localhost:4222",
    timeout: 5000,
  });
  const jsm = await nc.jetstreamManager();
  for (const name of CONSUMERS) {
    try {
      await jsm.consumers.delete(STREAM, name);
      console.log("Deleted consumer:", name);
    } catch {
      // Consumer may not exist
    }
  }
  await nc.close();
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
