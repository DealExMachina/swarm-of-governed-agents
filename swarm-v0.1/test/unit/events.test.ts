import { describe, it, expect } from "vitest";
import { createSwarmEvent, isSwarmEvent, type SwarmEvent } from "../../src/events";

describe("events", () => {
  describe("createSwarmEvent", () => {
    it("creates envelope with required fields and defaults", () => {
      const ev = createSwarmEvent("test_type", { foo: "bar" });
      expect(ev.type).toBe("test_type");
      expect(ev.payload).toEqual({ foo: "bar" });
      expect(ev.id).toBeDefined();
      expect(ev.ts).toBeDefined();
      expect(ev.source).toBe("system");
      expect(ev.correlation_id).toBe("");
    });

    it("uses opts when provided", () => {
      const ev = createSwarmEvent("x", { a: 1 }, {
        source: "agent-1",
        correlation_id: "corr-123",
        id: "id-456",
        ts: "2025-01-01T00:00:00.000Z",
      });
      expect(ev.source).toBe("agent-1");
      expect(ev.correlation_id).toBe("corr-123");
      expect(ev.id).toBe("id-456");
      expect(ev.ts).toBe("2025-01-01T00:00:00.000Z");
    });
  });

  describe("isSwarmEvent", () => {
    it("returns true for valid SwarmEvent", () => {
      const ev: SwarmEvent = {
        id: "1",
        type: "t",
        ts: "2025-01-01T00:00:00.000Z",
        source: "s",
        correlation_id: "c",
        payload: {},
      };
      expect(isSwarmEvent(ev)).toBe(true);
    });

    it("returns false for plain object without envelope fields", () => {
      expect(isSwarmEvent({ type: "x" })).toBe(false);
      expect(isSwarmEvent({ id: "1", type: "t" })).toBe(false);
      expect(isSwarmEvent({ type: "t", payload: {} })).toBe(false);
    });

    it("returns false when payload is not object", () => {
      expect(
        isSwarmEvent({
          id: "1",
          type: "t",
          ts: "",
          source: "",
          correlation_id: "",
          payload: null as any,
        }),
      ).toBe(false);
    });
  });
});
