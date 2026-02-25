/**
 * OPA-WASM policy engine. Loads a compiled Rego bundle (WASM), sets governance
 * config as data, and evaluates input to produce PolicyResult.
 * Requires policies to be compiled with: opa build -t wasm -e governance/result policies/
 */

import { readFileSync, existsSync } from "fs";
import { loadPolicy } from "@open-policy-agent/opa-wasm";
import type { PolicyEngine, PolicyContext, PolicyResult, DecisionRecord } from "./policyEngine.js";
import type { GovernanceConfig } from "./governance.js";

let cachedPolicy: Awaited<ReturnType<typeof loadPolicy>> | null = null;
let cachedWasmPath: string | null = null;

/**
 * Load OPA policy from a WASM file. Returns null if file missing or load fails.
 * Caches the loaded policy per path.
 */
export async function loadOPAPolicy(wasmPath: string): Promise<Awaited<ReturnType<typeof loadPolicy>> | null> {
  if (cachedPolicy && cachedWasmPath === wasmPath) return cachedPolicy;
  if (!existsSync(wasmPath)) return null;
  try {
    const wasm = readFileSync(wasmPath);
    const policy = await loadPolicy(wasm);
    cachedPolicy = policy;
    cachedWasmPath = wasmPath;
    return policy;
  } catch {
    return null;
  }
}

/**
 * Create a PolicyEngine that uses OPA-WASM. Returns null if WASM cannot be loaded.
 * Config is set as data at construction; same semantics as YAML (transition_rules + rules).
 */
export async function createOPAPolicyEngine(
  wasmPath: string,
  config: GovernanceConfig,
  policyVersion?: string,
): Promise<PolicyEngine | null> {
  const policy = await loadOPAPolicy(wasmPath);
  if (!policy) return null;

  const data = {
    transition_rules: config.transition_rules ?? [],
    rules: config.rules ?? [],
  };
  policy.setData(data);

  const version = policyVersion ?? "opa";

  return {
    async evaluate(input: PolicyContext): Promise<PolicyResult> {
      const inputJson = JSON.stringify({
        scope_id: input.scope_id,
        from_state: input.from_state,
        to_state: input.to_state,
        drift_level: input.drift_level,
        drift_types: input.drift_types ?? [],
      });
      const resultSet = policy.evaluate(inputJson);
      if (!resultSet || resultSet.length === 0) {
        const record: DecisionRecord = {
          decision_id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          policy_version: version,
          result: "deny",
          reason: "opa_no_result",
          obligations: [],
          binding: "opa",
          suggested_actions: [],
        };
        return { record, allowed: false };
      }
      const r = resultSet[0].result as { allow?: boolean; reason?: string; suggested_actions?: string[] };
      const allowed = r.allow === true;
      const record: DecisionRecord = {
        decision_id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        policy_version: version,
        result: allowed ? "allow" : "deny",
        reason: typeof r.reason === "string" ? r.reason : (allowed ? "no blocking rule" : "blocked"),
        obligations: [],
        binding: "opa",
        suggested_actions: Array.isArray(r.suggested_actions) ? r.suggested_actions : [],
      };
      return { record, allowed };
    },
  };
}
