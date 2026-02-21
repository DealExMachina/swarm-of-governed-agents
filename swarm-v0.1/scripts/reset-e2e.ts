/**
 * Reset DB, S3, and NATS to a clean state for E2E.
 * - Stops any running swarm processes (caller may run pkill before)
 * - Truncates Postgres: edges, nodes, context_events, swarm_state, filter_configs, agent_memory
 * - Empties S3 bucket (all objects)
 * - Deletes NATS JetStream stream so it is recreated fresh
 *
 * Run: node --loader ts-node/esm scripts/reset-e2e.ts
 */
import "dotenv/config";
import { execSync } from "child_process";
import pg from "pg";
import { connect } from "nats";
import { makeS3 } from "../src/s3.js";
import { ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";

const { Pool } = pg;

const STREAM = process.env.NATS_STREAM ?? "SWARM_JOBS";
const BUCKET = process.env.S3_BUCKET ?? "swarm";

async function truncateDb(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("DATABASE_URL not set, skipping DB reset");
    return;
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query("TRUNCATE TABLE edges, nodes, context_events, swarm_state, filter_configs, agent_memory RESTART IDENTITY CASCADE");
    console.log("Postgres: truncated edges, nodes, context_events, swarm_state, filter_configs, agent_memory");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("does not exist")) {
      console.log("Postgres: some tables missing (run migrations first), truncated existing");
    } else {
      throw e;
    }
  } finally {
    await pool.end();
  }
}

async function emptyS3(s3: S3Client): Promise<void> {
  let continuationToken: string | undefined;
  let total = 0;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 1000, ContinuationToken: continuationToken }),
    );
    const keys = (list.Contents ?? []).map((c) => c.Key!).filter(Boolean);
    if (keys.length === 0) break;
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
      }),
    );
    total += keys.length;
    continuationToken = list.NextContinuationToken;
  } while (continuationToken);
  console.log("S3: deleted", total, "objects from bucket", BUCKET);
}

async function deleteNatsStream(): Promise<void> {
  const url = process.env.NATS_URL ?? "nats://localhost:4222";
  try {
    const nc = await connect({ servers: url, timeout: 5000 });
    const jsm = await nc.jetstreamManager();
    try {
      await jsm.streams.delete(STREAM);
      console.log("NATS: deleted stream", STREAM);
    } catch {
      console.log("NATS: stream", STREAM, "did not exist");
    }
    await nc.close();
  } catch (e) {
    console.warn("NATS: could not connect or delete stream:", (e as Error).message);
  }
}

function killSwarm(): void {
  try {
    execSync("pkill -f 'ts-node/esm src/swarm.ts' 2>/dev/null || true", { stdio: "inherit" });
    console.log("Stopped any running swarm processes");
  } catch {
    // ignore
  }
}

async function main(): Promise<void> {
  console.log("Reset E2E: clean DB, S3, NATS...");
  killSwarm();
  await new Promise((r) => setTimeout(r, 1500));

  await truncateDb();

  if (process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY) {
    const s3 = makeS3();
    await emptyS3(s3);
  } else {
    console.log("S3 env not set, skipping bucket empty");
  }

  await deleteNatsStream();

  console.log("Done. Run migrations and seed:all then swarm for a fresh E2E.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
