import "dotenv/config";
import { connect } from "nats";

const NATS_URL = process.env.NATS_URL ?? "nats://127.0.0.1:4222";
const NATS_STREAM = process.env.NATS_STREAM ?? "SWARM_JOBS";

async function main(): Promise<void> {
  const nc = await connect({ servers: NATS_URL, timeout: 5000 });
  const jsm = await nc.jetstreamManager();

  let deleted = 0;
  try {
    const consumers = await jsm.consumers.list(NATS_STREAM);
    for await (const c of consumers) {
      await jsm.consumers.delete(NATS_STREAM, c.name);
      deleted++;
    }
  } catch {
    // stream may not exist yet
  }

  await nc.close();
  console.log(`Purged ${deleted} NATS consumer(s) from ${NATS_STREAM}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("purge-consumers:", err);
  process.exit(1);
});
