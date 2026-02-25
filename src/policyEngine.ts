/**
 * Policy engine abstraction for governance decisions.
 * Allows swapping YAML evaluation for OPA-WASM or other backends without changing callers.
 */

/** Input context for a policy evaluation (state, drift, proposal, scope). */
export interface PolicyContext {
  scope_id: string;
  from_state: string;
  to_state: string;
  drift_level: string;
  drift_types: string[];
  /** Optional: proposing agent id for authorization checks. */
  proposer_id?: string;
  /** Optional: target resource for authorization. */
  target_id?: string;
  [key: string]: unknown;
}

/** Single obligation to be executed after a decision (e.g. dual_review, compliance_notification). */
export interface Obligation {
  type: string;
  params?: Record<string, unknown>;
}

/** Immutable record of a governance decision for audit and policy versioning. */
export interface DecisionRecord {
  decision_id: string;
  timestamp: string;
  policy_version: string;
  result: "allow" | "deny";
  reason: string;
  obligations: Obligation[];
  /** Engine that produced this decision (e.g. "yaml" | "opa"). */
  binding: string;
  /** Optional: suggested actions from policy rules (e.g. open_investigation). */
  suggested_actions?: string[];
}

/** Result of a policy evaluation. */
export interface PolicyResult {
  record: DecisionRecord;
  allowed: boolean;
}

/**
 * Policy engine interface. Implementations: current YAML (default), OPA-WASM (Phase 1).
 */
export interface PolicyEngine {
  evaluate(input: PolicyContext): Promise<PolicyResult>;
}

// Lazy import to avoid circular dependency; governance is the default engine.
type GovernanceConfig = import("./governance.js").GovernanceConfig;

/**
 * Create a PolicyEngine that uses the existing YAML governance (governance.ts).
 * Default implementation so current behaviour is unchanged.
 */
export function createYamlPolicyEngine(
  config: GovernanceConfig,
  policyVersion?: string,
): PolicyEngine {
  const version = policyVersion ?? "yaml";
  return {
    async evaluate(input: PolicyContext): Promise<PolicyResult> {
      const { getGovernanceForScope, canTransition, evaluateRules } = await import("./governance.js");
      const scopeConfig = getGovernanceForScope(input.scope_id, config);
      const drift = { level: input.drift_level, types: input.drift_types };
      const transition = canTransition(
        input.from_state,
        input.to_state,
        drift,
        scopeConfig,
      );
      const suggested_actions = evaluateRules(drift, scopeConfig);
      const allowed = transition.allowed;
      const record: DecisionRecord = {
        decision_id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        policy_version: version,
        result: allowed ? "allow" : "deny",
        reason: transition.reason,
        obligations: [],
        binding: "yaml",
        suggested_actions,
      };
      return { record, allowed };
    },
  };
}
