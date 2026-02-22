import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";

export interface PolicyRule {
  when: {
    drift_level: string[];
    drift_type: string;
  };
  action: string;
}

export interface TransitionRule {
  from: string;
  to: string;
  block_when: {
    drift_level: string[];
  };
  reason: string;
}

export type ApprovalMode = "YOLO" | "MITL" | "MASTER";

export interface ScopeOverrides {
  mode?: ApprovalMode;
}

export interface GovernanceConfig {
  mode?: ApprovalMode;
  rules: PolicyRule[];
  transition_rules?: TransitionRule[];
  /** Per-scope overrides; only mode is overridable per scope. */
  scopes?: Record<string, ScopeOverrides>;
}

export interface DriftInput {
  level: string;
  types: string[];
}

export interface TransitionDecision {
  allowed: boolean;
  reason: string;
}

export function loadPolicies(path: string): GovernanceConfig {
  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw) as GovernanceConfig;
  if (!parsed.rules || !Array.isArray(parsed.rules)) {
    return { rules: [], transition_rules: parsed.transition_rules ?? [] };
  }
  return parsed;
}

/**
 * Return the effective governance config for a scope (merge scope overrides onto base).
 * If the scope has an entry in config.scopes, its mode overrides the top-level mode.
 */
export function getGovernanceForScope(scopeId: string, config: GovernanceConfig): GovernanceConfig {
  const overrides = config.scopes?.[scopeId];
  if (!overrides) return config;
  return {
    ...config,
    mode: overrides.mode ?? config.mode,
  };
}

export function evaluateRules(drift: DriftInput, config: GovernanceConfig): string[] {
  const actions: string[] = [];
  for (const rule of config.rules) {
    const levelMatch = rule.when.drift_level.includes(drift.level);
    const typeMatch = drift.types.includes(rule.when.drift_type);
    if (levelMatch && typeMatch) {
      actions.push(rule.action);
    }
  }
  return actions;
}

export function canTransition(
  from: string,
  to: string,
  drift: DriftInput,
  config: GovernanceConfig,
): TransitionDecision {
  const tRules = config.transition_rules ?? [];
  for (const rule of tRules) {
    if (rule.from === from && rule.to === to) {
      if (rule.block_when.drift_level.includes(drift.level)) {
        return { allowed: false, reason: rule.reason };
      }
    }
  }
  return { allowed: true, reason: "no blocking rule" };
}
