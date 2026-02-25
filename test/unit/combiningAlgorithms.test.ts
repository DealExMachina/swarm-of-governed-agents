import { describe, it, expect } from "vitest";
import { denyOverrides, firstApplicable } from "../../src/combiningAlgorithms";
import type { PolicyResult } from "../../src/policyEngine";

function makeResult(allowed: boolean, reason: string): PolicyResult {
  return {
    allowed,
    record: {
      decision_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      policy_version: "test",
      result: allowed ? "allow" : "deny",
      reason,
      obligations: [],
      binding: "yaml",
    },
  };
}

describe("combiningAlgorithms", () => {
  describe("denyOverrides", () => {
    it("returns first result when single", () => {
      const r = makeResult(true, "ok");
      expect(denyOverrides([r]).allowed).toBe(true);
      expect(denyOverrides([r]).record.reason).toBe("ok");
    });

    it("returns deny when any result is deny", () => {
      const allow = makeResult(true, "allow");
      const deny = makeResult(false, "blocked");
      const combined = denyOverrides([allow, deny]);
      expect(combined.allowed).toBe(false);
      expect(combined.record.reason).toBe("blocked");
    });

    it("returns allow when all allow", () => {
      const a1 = makeResult(true, "a1");
      const a2 = makeResult(true, "a2");
      const combined = denyOverrides([a1, a2]);
      expect(combined.allowed).toBe(true);
      expect(combined.record.reason).toBe("a1");
    });

    it("returns deny with no_policies when empty", () => {
      const combined = denyOverrides([]);
      expect(combined.allowed).toBe(false);
      expect(combined.record.reason).toBe("no_policies");
    });
  });

  describe("firstApplicable", () => {
    it("returns first result", () => {
      const r = makeResult(false, "first");
      expect(firstApplicable([r]).allowed).toBe(false);
      expect(firstApplicable([r]).record.reason).toBe("first");
    });

    it("returns deny with no_policies when empty", () => {
      const combined = firstApplicable([]);
      expect(combined.allowed).toBe(false);
      expect(combined.record.reason).toBe("no_policies");
    });
  });
});
