import type { S3Client } from "@aws-sdk/client-s3";
import { s3GetText } from "../s3.js";
import { appendEvent } from "../contextWal.js";

export async function runStatusAgent(
  s3: S3Client,
  bucket: string,
  _payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const factsRaw = await s3GetText(s3, bucket, "facts/latest.json");
  const driftRaw = await s3GetText(s3, bucket, "drift/latest.json");
  const facts = factsRaw ? (JSON.parse(factsRaw) as Record<string, unknown>) : null;
  const drift = driftRaw ? (JSON.parse(driftRaw) as Record<string, unknown>) : null;

  const card = {
    ts: new Date().toISOString(),
    type: "status_card",
    drift_level: drift?.level ?? "unknown",
    drift_types: (drift?.types as string[]) ?? [],
    confidence: facts?.confidence ?? null,
    goals: (facts?.goals as string[]) ?? [],
    notes: (drift?.notes as string[]) ?? [],
  };

  await appendEvent(card);
  return card;
}
