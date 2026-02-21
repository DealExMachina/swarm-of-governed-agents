import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("pg", () => ({
  default: {
    Pool: vi.fn().mockImplementation(() => ({ query: mockQuery })),
  },
}));

describe("finalityDecisions", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost/db");
    mockQuery.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("recordFinalityDecision inserts scope_id, option, days", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { recordFinalityDecision } = await import("../../src/finalityDecisions.js");
    await recordFinalityDecision("scope-1", "approve_finality");
    expect(mockQuery).toHaveBeenCalledWith(
      `INSERT INTO scope_finality_decisions (scope_id, option, days) VALUES ($1, $2, $3)`,
      ["scope-1", "approve_finality", null],
    );
  });

  it("recordFinalityDecision with days", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { recordFinalityDecision } = await import("../../src/finalityDecisions.js");
    await recordFinalityDecision("scope-1", "defer", 14);
    expect(mockQuery).toHaveBeenCalledWith(
      `INSERT INTO scope_finality_decisions (scope_id, option, days) VALUES ($1, $2, $3)`,
      ["scope-1", "defer", 14],
    );
  });

  it("getLatestFinalityDecision returns latest row", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ scope_id: "scope-1", option: "approve_finality", days: null, created_at: "2025-01-01T12:00:00Z" }],
    });
    const { getLatestFinalityDecision } = await import("../../src/finalityDecisions.js");
    const row = await getLatestFinalityDecision("scope-1");
    expect(row).toEqual({
      scope_id: "scope-1",
      option: "approve_finality",
      days: null,
      created_at: "2025-01-01T12:00:00Z",
    });
  });

  it("getLatestFinalityDecision returns null when no row", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { getLatestFinalityDecision } = await import("../../src/finalityDecisions.js");
    const row = await getLatestFinalityDecision("scope-1");
    expect(row).toBeNull();
  });
});
