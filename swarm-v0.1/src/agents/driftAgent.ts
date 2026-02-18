import type { S3Client } from "@aws-sdk/client-s3";
import { s3GetText, s3PutJson } from "../s3.js";

const KEY_DRIFT = "drift/latest.json";
const KEY_DRIFT_HIST = (ts: string) => `drift/history/${ts.replace(/[:.]/g, "-")}.json`;

export async function runDriftAgent(
  s3: S3Client,
  bucket: string,
  _payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const driftRaw = await s3GetText(s3, bucket, KEY_DRIFT);
  const drift = driftRaw
    ? (JSON.parse(driftRaw) as { level: string; types: string[]; notes?: string[] })
    : { level: "none", types: [] as string[], notes: ["no drift yet"] };

  const ts = new Date().toISOString();
  await s3PutJson(s3, bucket, KEY_DRIFT_HIST(ts), drift);
  return { wrote: [KEY_DRIFT_HIST(ts)], level: drift.level, types: drift.types };
}
