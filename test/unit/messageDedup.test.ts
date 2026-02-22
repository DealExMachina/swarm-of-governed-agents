import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock pg and db module ────────────────────────────────────────────────────

const mockQuery = vi.fn();

vi.mock("pg", () => {
  const Pool = vi.fn(() => ({
    query: mockQuery,
    connect: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  }));
  return { default: { Pool } };
});

vi.mock("../../src/db.js", () => ({
  getPool: vi.fn(() => ({
    query: mockQuery,
    connect: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  })),
}));

import { tryMarkProcessed, isProcessed, markProcessed } from "../../src/messageDedup";

describe("messageDedup", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    // Default: CREATE TABLE / CREATE INDEX queries succeed
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  // ── tryMarkProcessed ────────────────────────────────────────────────────────

  describe("tryMarkProcessed", () => {
    it("returns true for a new message (not yet processed)", async () => {
      // The first two calls are ensureProcessedMessagesTable (CREATE TABLE, CREATE INDEX)
      // The third call is the INSERT ... RETURNING query
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE INDEX
        .mockResolvedValueOnce({ rows: [{ consumer_name: "worker-1" }], rowCount: 1 }); // INSERT returned a row

      const result = await tryMarkProcessed("worker-1", "msg-abc");
      expect(result).toBe(true);

      // Verify the INSERT query was called with correct params
      const insertCall = mockQuery.mock.calls[2];
      expect(insertCall[0]).toContain("INSERT INTO processed_messages");
      expect(insertCall[0]).toContain("ON CONFLICT");
      expect(insertCall[0]).toContain("RETURNING");
      expect(insertCall[1]).toEqual(["worker-1", "msg-abc"]);
    });

    it("returns false for an already-processed message", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE INDEX
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // INSERT returned nothing (conflict)

      const result = await tryMarkProcessed("worker-1", "msg-dup");
      expect(result).toBe(false);
    });

    it("concurrent calls for the same message: only one returns true", async () => {
      // Simulate the atomic INSERT behavior:
      // First INSERT succeeds (rowCount: 1), second hits ON CONFLICT (rowCount: 0)
      let insertCallCount = 0;

      mockQuery.mockImplementation(async (sql: string) => {
        if (typeof sql === "string" && sql.includes("INSERT INTO processed_messages")) {
          insertCallCount++;
          if (insertCallCount === 1) {
            return { rows: [{ consumer_name: "worker-1" }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        // CREATE TABLE / CREATE INDEX
        return { rows: [], rowCount: 0 };
      });

      const [result1, result2] = await Promise.all([
        tryMarkProcessed("worker-1", "msg-concurrent"),
        tryMarkProcessed("worker-1", "msg-concurrent"),
      ]);

      const trueCount = [result1, result2].filter(Boolean).length;
      expect(trueCount).toBe(1);

      const falseCount = [result1, result2].filter((r) => r === false).length;
      expect(falseCount).toBe(1);
    });

    it("handles null rowCount by treating it as 0 (not processed)", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: null }); // null rowCount

      const result = await tryMarkProcessed("worker-1", "msg-null");
      expect(result).toBe(false);
    });
  });

  // ── isProcessed ─────────────────────────────────────────────────────────────

  describe("isProcessed", () => {
    it("returns true when message exists in processed_messages", async () => {
      // _tableEnsured is already true from earlier tests; only the SELECT query runs
      mockQuery
        .mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 }); // SELECT 1

      const result = await isProcessed("worker-1", "msg-existing");
      expect(result).toBe(true);
    });

    it("returns false when message does not exist", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT returns nothing

      const result = await isProcessed("worker-1", "msg-unknown");
      expect(result).toBe(false);
    });
  });

  // ── markProcessed ───────────────────────────────────────────────────────────

  describe("markProcessed", () => {
    it("executes INSERT with ON CONFLICT DO NOTHING", async () => {
      // _tableEnsured is already true from earlier tests; only the INSERT query runs
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await markProcessed("worker-1", "msg-mark");

      const insertCall = mockQuery.mock.calls[0];
      expect(insertCall[0]).toContain("INSERT INTO processed_messages");
      expect(insertCall[0]).toContain("ON CONFLICT");
      expect(insertCall[0]).toContain("DO NOTHING");
      expect(insertCall[1]).toEqual(["worker-1", "msg-mark"]);
    });
  });

  // ── Table creation caching ─────────────────────────────────────────────────

  describe("table ensured caching", () => {
    it("skips CREATE TABLE after first successful call", async () => {
      // Note: because _tableEnsured is module-level and tests in this file
      // share the same module instance, the table was already ensured by
      // earlier tests. We verify the CREATE TABLE is not re-issued.
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await tryMarkProcessed("worker-2", "msg-cache-test");

      // Should only have the INSERT call (no CREATE TABLE / CREATE INDEX)
      const createCalls = mockQuery.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("CREATE"),
      );
      expect(createCalls).toHaveLength(0);
    });
  });
});
