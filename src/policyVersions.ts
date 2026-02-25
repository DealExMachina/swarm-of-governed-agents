/**
 * Policy version tracking: content hashes for governance and finality configs.
 * Used in DecisionRecord and finality certificates for audit and reproducibility.
 */

import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const DEFAULT_GOVERNANCE_PATH = join(process.cwd(), "governance.yaml");
const DEFAULT_FINALITY_PATH = join(process.cwd(), "finality.yaml");

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Return the policy version id for the governance config file (content hash).
 * Used when creating PolicyEngine and in DecisionRecord.policy_version.
 */
export function getGovernancePolicyVersion(path?: string): string {
  const p = path ?? process.env.GOVERNANCE_PATH ?? DEFAULT_GOVERNANCE_PATH;
  if (!existsSync(p)) return "no-file";
  const content = readFileSync(p, "utf-8");
  return hashContent(content);
}

/**
 * Return the policy version id for the finality config file (content hash).
 * Used in finality certificates and payloads.
 */
export function getFinalityPolicyVersion(path?: string): string {
  const p = path ?? process.env.FINALITY_PATH ?? DEFAULT_FINALITY_PATH;
  if (!existsSync(p)) return "no-file";
  const content = readFileSync(p, "utf-8");
  return hashContent(content);
}
