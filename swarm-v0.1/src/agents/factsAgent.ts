import type { S3Client } from "@aws-sdk/client-s3";
import { s3GetText, s3PutJson } from "../s3.js";
import { tailEvents } from "../contextWal.js";

const FACTS_WORKER_URL = process.env.FACTS_WORKER_URL!;
const KEY_FACTS = "facts/latest.json";
const KEY_DRIFT = "drift/latest.json";
const KEY_FACTS_HIST = (ts: string) => `facts/history/${ts.replace(/[:.]/g, "-")}.json`;

export async function runFactsAgent(
  s3: S3Client,
  bucket: string,
  _payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const events = await tailEvents(200);
  const context = events.map((e) => e.data);

  const prevRaw = await s3GetText(s3, bucket, KEY_FACTS);
  const previous_facts = prevRaw ? (JSON.parse(prevRaw) as Record<string, unknown>) : null;

  const resp = await fetch(`${FACTS_WORKER_URL}/extract`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ context, previous_facts }),
  });

  if (!resp.ok) throw new Error(await resp.text());
  const out = (await resp.json()) as { facts: Record<string, unknown>; drift: Record<string, unknown> };

  const ts = new Date().toISOString();
  await s3PutJson(s3, bucket, KEY_FACTS, out.facts);
  await s3PutJson(s3, bucket, KEY_DRIFT, out.drift);
  await s3PutJson(s3, bucket, KEY_FACTS_HIST(ts), out.facts);
  return { wrote: [KEY_FACTS, KEY_DRIFT, KEY_FACTS_HIST(ts)], facts_hash: out.facts?.hash };
}
