import "dotenv/config";
import { makeS3, s3GetText, s3PutJson } from "./s3.js";
import { GraphState, nextState } from "./stateGraph.js";
import { appendEvent, eventsSince } from "./contextWal.js";
import { logger } from "./logger.js";
import { randomUUID } from "crypto";

const BUCKET = process.env.S3_BUCKET!;
const TICK_SECONDS = parseInt(process.env.TICK_SECONDS || "10", 10);
const FACTS_WORKER_URL = process.env.FACTS_WORKER_URL!;

const KEY_FACTS = "facts/latest.json";
const KEY_DRIFT = "drift/latest.json";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const s3 = makeS3();

  let state: GraphState = {
    runId: randomUUID(),
    lastNode: "ContextIngested",
    updatedAt: new Date().toISOString(),
  };

  let cursor = 0;

  await appendEvent({
    ts: new Date().toISOString(),
    type: "seed",
    text: "System boot. Continuous context starts.",
  });

  while (true) {
    const newEvents = await eventsSince(cursor);
    const contextSlice = newEvents.map((e) => e.data);

    if (contextSlice.length === 0) {
      await sleep(TICK_SECONDS * 1000);
      continue;
    }

    const lastFactsRaw = await s3GetText(s3, BUCKET, KEY_FACTS);
    const lastFacts = lastFactsRaw ? (JSON.parse(lastFactsRaw) as Record<string, unknown>) : null;

    const resp = await fetch(`${FACTS_WORKER_URL}/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: contextSlice, previous_facts: lastFacts }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      logger.error("facts-worker error", { detail: err });
    } else {
      const out = (await resp.json()) as { facts: Record<string, unknown>; drift: Record<string, unknown> };
      await s3PutJson(s3, BUCKET, KEY_FACTS, out.facts);
      await s3PutJson(s3, BUCKET, KEY_DRIFT, out.drift);

      await appendEvent({
        ts: new Date().toISOString(),
        type: "status",
        facts_version: out.facts?.version ?? 2,
        drift_level: out.drift?.level ?? "unknown",
        drift_types: (out.drift?.types as string[]) ?? [],
        notes: (out.drift?.notes as string[]) ?? [],
      });

      cursor = newEvents[newEvents.length - 1].seq;

      state = nextState(state);
      logger.info("cycle complete", {
        node: state.lastNode,
        drift_level: out.drift?.level,
        drift_types: out.drift?.types,
        facts_version: out.facts?.version,
      });
    }

    await sleep(TICK_SECONDS * 1000);
  }
}

main().catch((e) => {
  logger.error("fatal", { error: String(e) });
  process.exit(1);
});
