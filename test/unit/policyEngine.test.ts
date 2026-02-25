import { describe, it, expect } from "vitest";
import { join } from "path";
import {
  type PolicyContext,
  type DecisionRecord,
  type PolicyResult,
  createYamlPolicyEngine,
} from "../../src/policyEngine";
import { loadPolicies } from "../../src/governance";

const GOVERNANCE_PATH = join(__dirname, "../../governance.yaml");

describe("policyEngine", () => {
  describe("DecisionRecord shape", () => {
    it("createYamlPolicyEngine produces record with required fields", async () => {
      const config = loadPolicies(GOVERNANCE_PATH);
      const engine = createYamlPolicyEngine(config);
      const ctx: PolicyContext = {
        scope_id: "default",
        from_state: "DriftChecked",
        to_state: "ContextIngested",
        drift_level: "low",
        drift_types: ["factual"],
      };
      const result: PolicyResult = await engine.evaluate(ctx);
      expect(result.record).toBeDefined();
      const r = result.record as DecisionRecord;
      expect(typeof r.decision_id).toBe("string");
      expect(r.decision_id.length).toBeGreaterThan(0);
      expect(r.timestamp).toBeDefined();
      expect(r.policy_version).toBe("yaml");
      expect(r.result).toBe("allow");
      expect(typeof r.reason).toBe("string");
      expect(Array.isArray(r.obligations)).toBe(true);
      expect(r.binding).toBe("yaml");
    });

    it("produces deny and suggested_actions when transition blocked", async () => {
      const config = loadPolicies(GOVERNANCE_PATH);
      const engine = createYamlPolicyEngine(config);
      const ctx: PolicyContext = {
        scope_id: "default",
        from_state: "DriftChecked",
        to_state: "ContextIngested",
        drift_level: "critical",
        drift_types: ["contradiction"],
      };
      const result = await engine.evaluate(ctx);
      expect(result.allowed).toBe(false);
      expect(result.record.result).toBe("deny");
      expect(result.record.reason).toContain("drift");
      expect(Array.isArray(result.record.suggested_actions)).toBe(true);
      expect(result.record.suggested_actions!.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("createYamlPolicyEngine", () => {
    it("allows transition when no blocking rule", async () => {
      const config = loadPolicies(GOVERNANCE_PATH);
      const engine = createYamlPolicyEngine(config, "v1");
      const result = await engine.evaluate({
        scope_id: "default",
        from_state: "FactsExtracted",
        to_state: "DriftChecked",
        drift_level: "none",
        drift_types: [],
      });
      expect(result.allowed).toBe(true);
      expect(result.record.policy_version).toBe("v1");
    });
  });
});
