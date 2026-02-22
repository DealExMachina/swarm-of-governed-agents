import { describe, it, expect } from "vitest";
import { AGENT_SPECS, getSpec } from "../../src/agentRegistry";
import { transitions, type Node } from "../../src/stateGraph";

describe("agentRegistry", () => {
  it("has no duplicate roles", () => {
    const roles = AGENT_SPECS.map((s) => s.role);
    expect(new Set(roles).size).toBe(roles.length);
  });

  it("has no duplicate job types", () => {
    const types = AGENT_SPECS.map((s) => s.jobType);
    expect(new Set(types).size).toBe(types.length);
  });

  it("all requiresNode values are valid state graph nodes or null", () => {
    const validNodes = new Set(Object.keys(transitions));
    for (const spec of AGENT_SPECS) {
      if (spec.requiresNode !== null) {
        expect(validNodes.has(spec.requiresNode)).toBe(true);
      }
    }
  });

  it("all advancesTo values are valid state graph nodes or null", () => {
    const validNodes = new Set(Object.values(transitions));
    for (const spec of AGENT_SPECS) {
      if (spec.advancesTo !== null) {
        expect(validNodes.has(spec.advancesTo)).toBe(true);
      }
    }
  });

  it("requiresNode -> advancesTo follows the transition map", () => {
    for (const spec of AGENT_SPECS) {
      if (spec.requiresNode && spec.advancesTo) {
        expect(transitions[spec.requiresNode]).toBe(spec.advancesTo);
      }
    }
  });

  it("getSpec returns the correct spec by role", () => {
    expect(getSpec("facts")?.jobType).toBe("extract_facts");
    expect(getSpec("status")?.requiresNode).toBeNull();
    expect(getSpec("nonexistent")).toBeUndefined();
  });
});
