import { describe, it, expect } from "vitest";
import { join } from "path";
import {
  loadPolicies,
  getGovernanceForScope,
  evaluateRules,
  canTransition,
  type DriftInput,
  type GovernanceConfig,
} from "../../src/governance";

const GOVERNANCE_PATH = join(__dirname, "../../governance.yaml");

describe("governance", () => {
  describe("loadPolicies", () => {
    it("loads and parses governance.yaml", () => {
      const config = loadPolicies(GOVERNANCE_PATH);
      expect(config.rules).toBeDefined();
      expect(config.rules.length).toBeGreaterThanOrEqual(4);
      expect(config.rules[0].action).toBe("open_investigation");
      expect(config.rules[0].when.drift_type).toBe("contradiction");
    });
  });

  describe("getGovernanceForScope", () => {
    it("returns same config when no scopes", () => {
      const config: GovernanceConfig = { mode: "YOLO", rules: [] };
      expect(getGovernanceForScope("any", config)).toBe(config);
    });
    it("overrides mode for scope in scopes", () => {
      const config: GovernanceConfig = {
        mode: "YOLO",
        rules: [],
        scopes: { financial_dd: { mode: "MITL" } },
      };
      const out = getGovernanceForScope("financial_dd", config);
      expect(out.mode).toBe("MITL");
      expect(out.rules).toEqual(config.rules);
    });
    it("falls back to top-level mode for unknown scope", () => {
      const config: GovernanceConfig = {
        mode: "MASTER",
        rules: [],
        scopes: { other: { mode: "YOLO" } },
      };
      const out = getGovernanceForScope("unknown_scope", config);
      expect(out.mode).toBe("MASTER");
    });
  });

  describe("evaluateRules", () => {
    const config: GovernanceConfig = {
      rules: [
        { when: { drift_level: ["medium", "high"], drift_type: "contradiction" }, action: "open_investigation" },
        { when: { drift_level: ["medium", "high"], drift_type: "goal" }, action: "request_goal_refresh" },
        { when: { drift_level: ["high"], drift_type: "factual" }, action: "request_source_refresh" },
        { when: { drift_level: ["high"], drift_type: "entropy" }, action: "halt_and_review" },
      ],
    };

    it("returns empty actions when drift is none", () => {
      const drift: DriftInput = { level: "none", types: [] };
      expect(evaluateRules(drift, config)).toEqual([]);
    });

    it("returns empty actions when drift is low", () => {
      const drift: DriftInput = { level: "low", types: ["factual"] };
      expect(evaluateRules(drift, config)).toEqual([]);
    });

    it("matches contradiction at medium level", () => {
      const drift: DriftInput = { level: "medium", types: ["contradiction"] };
      const actions = evaluateRules(drift, config);
      expect(actions).toContain("open_investigation");
      expect(actions).not.toContain("request_source_refresh");
    });

    it("matches multiple types at high level", () => {
      const drift: DriftInput = { level: "high", types: ["contradiction", "factual", "entropy"] };
      const actions = evaluateRules(drift, config);
      expect(actions).toContain("open_investigation");
      expect(actions).toContain("request_source_refresh");
      expect(actions).toContain("halt_and_review");
      expect(actions).not.toContain("request_goal_refresh");
    });

    it("matches goal drift at medium level", () => {
      const drift: DriftInput = { level: "medium", types: ["goal"] };
      const actions = evaluateRules(drift, config);
      expect(actions).toEqual(["request_goal_refresh"]);
    });

    it("factual drift at medium level does not trigger (only high)", () => {
      const drift: DriftInput = { level: "medium", types: ["factual"] };
      const actions = evaluateRules(drift, config);
      expect(actions).toEqual([]);
    });

    it("uses the governance.yaml file end-to-end", () => {
      const realConfig = loadPolicies(GOVERNANCE_PATH);
      const drift: DriftInput = { level: "high", types: ["contradiction", "goal"] };
      const actions = evaluateRules(drift, realConfig);
      expect(actions).toContain("open_investigation");
      expect(actions).toContain("request_goal_refresh");
    });
  });

  describe("canTransition", () => {
    const config: GovernanceConfig = {
      rules: [],
      transition_rules: [
        {
          from: "DriftChecked",
          to: "ContextIngested",
          block_when: { drift_level: ["high"] },
          reason: "High drift blocks cycle reset",
        },
      ],
    };

    it("blocks DriftChecked -> ContextIngested when drift is high", () => {
      const drift: DriftInput = { level: "high", types: ["contradiction"] };
      const decision = canTransition("DriftChecked", "ContextIngested", drift, config);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("High drift");
    });

    it("allows DriftChecked -> ContextIngested when drift is none", () => {
      const drift: DriftInput = { level: "none", types: [] };
      const decision = canTransition("DriftChecked", "ContextIngested", drift, config);
      expect(decision.allowed).toBe(true);
    });

    it("allows DriftChecked -> ContextIngested when drift is low", () => {
      const drift: DriftInput = { level: "low", types: ["factual"] };
      const decision = canTransition("DriftChecked", "ContextIngested", drift, config);
      expect(decision.allowed).toBe(true);
    });

    it("allows transitions not covered by any rule", () => {
      const drift: DriftInput = { level: "high", types: [] };
      const decision = canTransition("ContextIngested", "FactsExtracted", drift, config);
      expect(decision.allowed).toBe(true);
    });

    it("loads transition_rules from governance.yaml", () => {
      const realConfig = loadPolicies(GOVERNANCE_PATH);
      expect(realConfig.transition_rules).toBeDefined();
      expect(realConfig.transition_rules!.length).toBeGreaterThanOrEqual(1);

      const drift: DriftInput = { level: "critical", types: [] };
      const decision = canTransition("DriftChecked", "ContextIngested", drift, realConfig);
      expect(decision.allowed).toBe(false);
    });

    it("allows DriftChecked -> ContextIngested when drift is high (only critical blocks)", () => {
      const realConfig = loadPolicies(GOVERNANCE_PATH);
      const drift: DriftInput = { level: "high", types: ["contradiction"] };
      const decision = canTransition("DriftChecked", "ContextIngested", drift, realConfig);
      expect(decision.allowed).toBe(true);
    });
  });
});
