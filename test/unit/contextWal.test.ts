import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  appendEvent,
  tailEvents,
  eventsSince,
  _resetTableEnsured,
} from "../../src/contextWal";

function mockPool(overrides?: (text: string, values?: any[]) => any) {
  const calls: Array<{ text: string; values: any[] }> = [];
  const pool = {
    query: vi.fn(async (text: string, values?: any[]) => {
      calls.push({ text, values: values ?? [] });
      if (overrides) {
        const result = overrides(text, values);
        if (result !== undefined) return result;
      }
      // Table-existence check (ensureContextTable)
      if (text.includes("information_schema") && text.includes("context_events")) {
        return { rows: [{}], rowCount: 1 };
      }
      if (text.includes("INSERT") && text.includes("RETURNING")) {
        return { rows: [{ seq: "42" }] };
      }
      return { rows: [] };
    }),
  };
  return { pool: pool as any, calls };
}

describe("contextWal", () => {
  beforeEach(() => _resetTableEnsured());

  describe("appendEvent", () => {
    it("inserts data as JSONB and returns the sequence number", async () => {
      const { pool, calls } = mockPool();
      const data = { type: "test", value: 123 };

      const seq = await appendEvent(data, pool);

      expect(seq).toBe(42);
      const insert = calls.find((c) =>
        c.text.includes("INSERT INTO context_events"),
      );
      expect(insert).toBeDefined();
      expect(insert!.text).toContain("RETURNING seq");
      expect(JSON.parse(insert!.values[0])).toEqual(data);
    });

    it("ensures table exists before inserting", async () => {
      const { pool, calls } = mockPool();
      await appendEvent({ x: 1 }, pool);

      const tableCheck = calls.find(
        (c) =>
          c.text.includes("information_schema") &&
          c.text.includes("context_events"),
      );
      expect(tableCheck).toBeDefined();
    });
  });

  describe("tailEvents", () => {
    it("queries with ORDER BY seq DESC, reverses to ascending", async () => {
      const rows = [
        { seq: "3", ts: new Date("2025-03-01"), data: { c: 3 } },
        { seq: "2", ts: new Date("2025-02-01"), data: { b: 2 } },
        { seq: "1", ts: new Date("2025-01-01"), data: { a: 1 } },
      ];
      const { pool, calls } = mockPool((text) => {
        if (text.includes("SELECT") && text.includes("ORDER BY")) {
          return { rows };
        }
      });

      const events = await tailEvents(100, pool);

      const sel = calls.find((c) => c.text.includes("ORDER BY seq DESC"));
      expect(sel).toBeDefined();
      expect(sel!.values[0]).toBe(100);

      expect(events).toHaveLength(3);
      expect(events[0].seq).toBe(1);
      expect(events[1].seq).toBe(2);
      expect(events[2].seq).toBe(3);
      expect(events[0].data).toEqual({ a: 1 });
      expect(events[2].data).toEqual({ c: 3 });
    });

    it("returns empty array when no events exist", async () => {
      const { pool } = mockPool();
      const events = await tailEvents(10, pool);
      expect(events).toEqual([]);
    });
  });

  describe("eventsSince", () => {
    it("queries events with seq > afterSeq in ascending order", async () => {
      const { pool, calls } = mockPool();
      await eventsSince(10, 500, pool);

      const sel = calls.find((c) => c.text.includes("seq > $1"));
      expect(sel).toBeDefined();
      expect(sel!.text).toContain("ORDER BY seq ASC");
      expect(sel!.text).toContain("LIMIT $2");
      expect(sel!.values[0]).toBe(10);
      expect(sel!.values[1]).toBe(500);
    });
  });
});
