import "dotenv/config";
import { makeEventBus } from "./eventBus.js";
import { toErrorString } from "./errors.js";
import { logger } from "./logger.js";

const NATS_STREAM = process.env.NATS_STREAM ?? "SWARM_JOBS";

async function main(): Promise<void> {
  const n = parseInt(process.argv[2] ?? "5", 10);
  if (!Number.isFinite(n) || n < 1) {
    logger.error("Usage: node loadgen.js <count>");
    process.exit(1);
  }

  const bus = await makeEventBus();
  await bus.ensureStream(NATS_STREAM, ["swarm.jobs.>"]);

  logger.info(`publishing ${n} extract_facts jobs to NATS`);
  for (let i = 0; i < n; i++) {
    await bus.publish("swarm.jobs.extract_facts", {
      type: "extract_facts",
      reason: "loadgen",
      index: String(i + 1),
    });
  }
  logger.info(`done, ${n} jobs published`);

  await bus.close();
}

main().catch((e) => {
  logger.error("fatal", { error: toErrorString(e) });
  process.exit(1);
});
