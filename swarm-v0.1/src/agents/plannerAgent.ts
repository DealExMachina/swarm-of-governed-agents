import { join } from "path";
import type { S3Client } from "@aws-sdk/client-s3";
import { s3GetText } from "../s3.js";
import { loadPolicies, evaluateRules } from "../governance.js";

const GOVERNANCE_PATH = process.env.GOVERNANCE_PATH ?? join(process.cwd(), "governance.yaml");

/**
 * Evaluate drift against governance rules and return recommended actions.
 * The caller (swarm loop) is responsible for dispatching actions via the event bus.
 */
export async function runPlannerAgent(
  s3: S3Client,
  bucket: string,
  _payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const driftRaw = await s3GetText(s3, bucket, "drift/latest.json");
  const drift = driftRaw
    ? (JSON.parse(driftRaw) as { level: string; types: string[] })
    : { level: "none", types: [] as string[] };

  const config = loadPolicies(GOVERNANCE_PATH);
  const actions = evaluateRules(drift, config);

  return { drift: { level: drift.level, types: drift.types }, actions };
}
