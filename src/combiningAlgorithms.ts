/**
 * XACML-inspired combining algorithms for policy results.
 * Used when multiple policies or engines contribute to a single decision.
 */

import type { PolicyResult, DecisionRecord } from "./policyEngine.js";

/**
 * Deny-overrides: if any result is deny, the combined result is deny (first deny wins).
 * Obligations are merged from the winning result; if deny, obligations from the first deny.
 */
export function denyOverrides(results: PolicyResult[]): PolicyResult {
  if (results.length === 0) {
    const record: DecisionRecord = {
      decision_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      policy_version: "none",
      result: "deny",
      reason: "no_policies",
      obligations: [],
      binding: "combining",
    };
    return { record, allowed: false };
  }
  const firstDeny = results.find((r) => !r.allowed);
  if (firstDeny) return firstDeny;
  return results[0];
}

/**
 * First-applicable: return the first result. Used for ordered policy evaluation.
 */
export function firstApplicable(results: PolicyResult[]): PolicyResult {
  if (results.length === 0) {
    const record: DecisionRecord = {
      decision_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      policy_version: "none",
      result: "deny",
      reason: "no_policies",
      obligations: [],
      binding: "combining",
    };
    return { record, allowed: false };
  }
  return results[0];
}
