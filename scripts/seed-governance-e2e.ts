/**
 * Seed fixture for E2E governance path coverage.
 *
 * Prerequisites: migrations 002 + 003, S3 bucket and NATS stream (ensure-bucket, ensure-stream).
 * Governance agent should be running (or will process when started); run verify-governance-paths
 * after governance has consumed the proposals.
 *
 * Sets up:
 * - swarm_state: DriftChecked, epoch 5, runId "seed-governance-e2e"
 * - S3 drift/latest.json: high (so YOLO DriftChecked->ContextIngested is blocked by transition rules)
 *
 * Publishes three proposals (same transition, same epoch) so each takes a different path:
 * 1. MASTER -> processProposal -> approved (master_override)
 * 2. MITL   -> processProposal -> pending
 * 3. YOLO   -> evaluate then (no LLM: commit; LLM: oversight) -> rejected (High drift...)
 *
 * Usage: npm run seed:governance-e2e
 * Then start (or ensure) governance agent; after a few seconds run verify-governance-paths.
 */
import "dotenv/config";
import { randomUUID } from "crypto";
import pg from "pg";
import { makeS3, s3PutJson } from "../src/s3.js";
import { ensureStateTable, loadState } from "../src/stateGraph.js";
import { makeEventBus } from "../src/eventBus.js";
import { waitForNatsAndStream } from "../src/readiness.js";

const NATS_STREAM = process.env.NATS_STREAM ?? "SWARM_JOBS";
const STREAM_SUBJECTS = [
  "swarm.jobs.>",
  "swarm.proposals.>",
  "swarm.actions.>",
  "swarm.rejections.>",
  "swarm.events.>",
];
const BUCKET = process.env.S3_BUCKET ?? "swarm";
const RUN_ID = "seed-governance-e2e";
const EPOCH = 5;
const FROM = "DriftChecked";
const TO = "ContextIngested";

const SCOPE_ID = process.env.SCOPE_ID ?? "default";

async function ensureState(pool: pg.Pool): Promise<void> {
  await ensureStateTable(pool);
  const existing = await loadState(SCOPE_ID, pool);
  if (existing && existing.epoch === EPOCH && existing.lastNode === FROM) {
    console.log("State already at", FROM, "epoch", EPOCH);
    return;
  }
  await pool.query(
    `INSERT INTO swarm_state (scope_id, run_id, last_node, epoch, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (scope_id) DO UPDATE SET run_id = $2, last_node = $3, epoch = $4, updated_at = now()`,
    [SCOPE_ID, RUN_ID, FROM, EPOCH],
  );
  console.log("State set to", FROM, "epoch", EPOCH, "runId", RUN_ID);
}

async function ensureDrift(s3: Awaited<ReturnType<typeof makeS3>>): Promise<void> {
  await s3PutJson(s3, BUCKET, "drift/latest.json", { level: "high", types: [] });
  console.log("Drift set to high (blocks DriftChecked -> ContextIngested per governance.yaml)");
}

function proposal(
  mode: "MASTER" | "MITL" | "YOLO",
  tag: string,
): Record<string, unknown> {
  return {
    proposal_id: `seed-e2e-${tag}-${randomUUID().slice(0, 8)}`,
    agent: "seed-script",
    proposed_action: "advance_state",
    target_node: TO,
    payload: { expectedEpoch: EPOCH, runId: RUN_ID, from: FROM, to: TO },
    mode,
  };
}

async function main(): Promise<void> {
  console.log("Seed governance E2E: state, drift, proposals...");

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL required");
  }
  const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
  try {
    await ensureState(pool);
  } finally {
    await pool.end();
  }

  if (process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY) {
    const s3 = makeS3();
    await ensureDrift(s3);
  } else {
    console.log("S3 env not set, skipping drift (governance may fail without drift file)");
  }

  await waitForNatsAndStream({
    streamName: NATS_STREAM,
    streamSubjects: STREAM_SUBJECTS,
    connectTimeoutMs: 5000,
    connectRetries: 5,
    retryDelayMs: 2000,
  });
  const bus = await makeEventBus();
  await bus.ensureStream(NATS_STREAM, STREAM_SUBJECTS);

  const subject = "swarm.proposals.advance_state";
  // Order matters: YOLO first (reject by drift, no state change), then MITL (pending, no state change), then MASTER (approve, executor advances state).
  const proposals = [
    proposal("YOLO", "yolo"),
    proposal("MITL", "mitl"),
    proposal("MASTER", "master"),
  ];
  for (const p of proposals) {
    await bus.publish(subject, p as Record<string, string>);
    console.log("Published", p.mode, (p as { proposal_id: string }).proposal_id);
  }
  await bus.close();
  console.log("Done. Start governance (or ensure it is running), then run: npm run verify:governance-paths");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
