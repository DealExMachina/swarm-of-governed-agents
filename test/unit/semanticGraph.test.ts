import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockQuery = vi.fn();
vi.mock("pg", () => ({
  default: {
    Pool: vi.fn().mockImplementation(() => ({ query: mockQuery })),
  },
}));

describe("semanticGraph", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost/db");
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            claims_active_min_confidence: 0.9,
            claims_active_count: 5,
            claims_active_avg_confidence: 0.92,
            risks_critical_active_count: 0,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ resolved: 3, total: 4 }] })
      .mockResolvedValueOnce({ rows: [{ risk_score: 0.1 }] })
      .mockResolvedValueOnce({ rows: [{ total: 2 }] })
      .mockResolvedValueOnce({ rows: [{ c: 1 }] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockQuery.mockReset();
  });

  it("loadFinalitySnapshot returns FinalitySnapshot shape", async () => {
    const { loadFinalitySnapshot } = await import("../../src/semanticGraph.js");
    const snapshot = await loadFinalitySnapshot("scope-1");
    expect(snapshot).toMatchObject({
      claims_active_min_confidence: expect.any(Number),
      claims_active_count: expect.any(Number),
      claims_active_avg_confidence: expect.any(Number),
      contradictions_unresolved_count: expect.any(Number),
      contradictions_total_count: expect.any(Number),
      risks_critical_active_count: expect.any(Number),
      goals_completion_ratio: expect.any(Number),
      scope_risk_score: expect.any(Number),
    });
    expect(snapshot.claims_active_min_confidence).toBe(0.9);
    expect(snapshot.claims_active_count).toBe(5);
    expect(snapshot.goals_completion_ratio).toBe(3 / 4);
    expect(snapshot.scope_risk_score).toBe(0.1);
    expect(snapshot.contradictions_total_count).toBe(2);
    expect(snapshot.contradictions_unresolved_count).toBe(1);
  });

  it("appendResolutionGoal inserts a goal node with status resolved", async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [{ node_id: "goal-res-1" }] });
    const { appendResolutionGoal } = await import("../../src/semanticGraph.js");
    const nodeId = await appendResolutionGoal("scope-1", "We decided to align hiring to 15+.", "Hiring target aligned");
    expect(nodeId).toBe("goal-res-1");
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain("INSERT INTO nodes");
    expect(call[1]).toEqual([
      "scope-1",
      "goal",
      "Hiring target aligned",
      1.0,
      "resolved",
      expect.any(String),
      "{}",
      "resolution",
      null,
    ]);
    const sourceRef = JSON.parse(call[1][5] as string);
    expect(sourceRef).toMatchObject({ source: "resolution", decision_preview: "We decided to align hiring to 15+." });
  });
});
