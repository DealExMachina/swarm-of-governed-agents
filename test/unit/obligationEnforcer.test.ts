import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerObligationHandler,
  executeObligation,
  executeObligations,
  getRegisteredObligationTypes,
} from "../../src/obligationEnforcer";

describe("obligationEnforcer", () => {
  beforeEach(() => {
    // Clear registry between tests by re-importing would require module reset;
    // we test with unique type names or document that registry is global.
    const types = getRegisteredObligationTypes();
    for (const t of types) {
      // No unregister in skeleton; tests use distinct type names
    }
  });

  describe("executeObligation", () => {
    it("no-ops when no handler registered", async () => {
      await expect(
        executeObligation({ type: "nonexistent_obligation" }),
      ).resolves.toBeUndefined();
    });

    it("calls registered handler", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      registerObligationHandler("test_ob", handler);
      await executeObligation({ type: "test_ob", params: { foo: "bar" } });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        type: "test_ob",
        params: { foo: "bar" },
      });
    });
  });

  describe("executeObligations", () => {
    it("runs multiple obligations in sequence", async () => {
      const calls: string[] = [];
      registerObligationHandler("ob_a", async () => {
        calls.push("a");
      });
      registerObligationHandler("ob_b", async () => {
        calls.push("b");
      });
      await executeObligations([
        { type: "ob_a" },
        { type: "ob_b" },
        { type: "ob_a" },
      ]);
      expect(calls).toEqual(["a", "b", "a"]);
    });
  });

  describe("getRegisteredObligationTypes", () => {
    it("returns list of registered types", () => {
      registerObligationHandler("type_x", async () => {});
      const types = getRegisteredObligationTypes();
      expect(types).toContain("type_x");
    });
  });
});
