import { describe, it, expect, vi, beforeEach } from "vitest";

const runInTransaction = vi.fn();
const appendNode = vi.fn();
const appendEdge = vi.fn();
const updateNodeConfidence = vi.fn();
const updateNodeStatus = vi.fn();
const hasResolvingEdge = vi.fn();
const queryNodesByCreator = vi.fn();

vi.mock("../../src/semanticGraph.js", () => ({
  runInTransaction: (...args: unknown[]) => runInTransaction(...args),
  appendNode: (...args: unknown[]) => appendNode(...args),
  appendEdge: (...args: unknown[]) => appendEdge(...args),
  updateNodeConfidence: (...args: unknown[]) => updateNodeConfidence(...args),
  updateNodeStatus: (...args: unknown[]) => updateNodeStatus(...args),
  hasResolvingEdge: (...args: unknown[]) => hasResolvingEdge(...args),
  queryNodesByCreator: (...args: unknown[]) => queryNodesByCreator(...args),
}));

vi.mock("../../src/embeddingPipeline.js", () => ({ embedAndPersistNode: vi.fn().mockResolvedValue(true) }));

function makeNode(overrides: Record<string, unknown> = {}) {
  return {
    node_id: "existing-id",
    scope_id: "scope-1",
    type: "claim",
    content: "Claim A",
    confidence: 0.8,
    status: "active",
    source_ref: {},
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "facts-sync",
    version: 1,
    ...overrides,
  };
}

describe("factsToSemanticGraph", () => {
  beforeEach(() => {
    runInTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({}));
    appendNode.mockResolvedValue("node-uuid");
    appendEdge.mockResolvedValue("edge-uuid");
    updateNodeConfidence.mockResolvedValue(undefined);
    updateNodeStatus.mockResolvedValue(undefined);
    hasResolvingEdge.mockResolvedValue(false);
    queryNodesByCreator.mockResolvedValue([]);
    vi.clearAllMocks();
  });

  it("inserts claims, goals, risks when no existing nodes", async () => {
    queryNodesByCreator.mockResolvedValue([]);
    const { syncFactsToSemanticGraph } = await import("../../src/factsToSemanticGraph.js");
    const result = await syncFactsToSemanticGraph("scope-1", {
      claims: ["Claim A", "Claim B"],
      goals: ["Goal 1"],
      risks: ["Risk one"],
      contradictions: [],
      confidence: 0.9,
    });

    expect(appendNode).toHaveBeenCalledTimes(4);
    const nodeCalls = appendNode.mock.calls.map((c) => c[0]) as Array<{ type: string; content: string }>;
    const types = nodeCalls.map((n) => n.type).sort();
    const contents = nodeCalls.map((n) => n.content).sort();
    expect(types).toEqual(["claim", "claim", "goal", "risk"]);
    expect(contents).toEqual(["Claim A", "Claim B", "Goal 1", "Risk one"]);
    expect(appendEdge).not.toHaveBeenCalled();
    expect(result).toEqual({ nodesCreated: 4, edgesCreated: 0, nodesUpdated: 0, nodesStaled: 0 });
  });

  it("parses NLI contradiction and creates edge when claim nodes match", async () => {
    queryNodesByCreator.mockResolvedValue([]);
    appendNode
      .mockResolvedValueOnce("id-a")
      .mockResolvedValueOnce("id-b");
    const { syncFactsToSemanticGraph } = await import("../../src/factsToSemanticGraph.js");
    const result = await syncFactsToSemanticGraph("scope-1", {
      claims: ["Short claim A", "Short claim B"],
      contradictions: ['NLI: "Short claim A" vs "Short claim B"'],
    });

    expect(appendEdge).toHaveBeenCalledTimes(1);
    expect(appendEdge.mock.calls[0][0]).toMatchObject({
      scope_id: "scope-1",
      source_id: "id-a",
      target_id: "id-b",
      edge_type: "contradicts",
      created_by: "facts-sync",
    });
    expect(result.edgesCreated).toBe(1);
  });

  describe("monotonic upserts (CRDT)", () => {
    it("preserves higher confidence when new confidence is lower", async () => {
      // Existing claim with confidence 0.8
      queryNodesByCreator.mockImplementation(async (_s: string, _c: string, type?: string) => {
        if (type === "claim") return [makeNode({ node_id: "claim-1", content: "Claim A", confidence: 0.8 })];
        return [];
      });
      const { syncFactsToSemanticGraph } = await import("../../src/factsToSemanticGraph.js");
      const result = await syncFactsToSemanticGraph("scope-1", {
        claims: ["Claim A"],
        confidence: 0.7, // lower than existing 0.8
      });

      // Should NOT update confidence (monotonic: only update if new >= existing)
      expect(updateNodeConfidence).not.toHaveBeenCalled();
      // Should NOT insert a new node (content matched)
      expect(appendNode).not.toHaveBeenCalled();
      expect(result.nodesCreated).toBe(0);
      expect(result.nodesUpdated).toBe(0);
    });

    it("updates confidence when new confidence is higher", async () => {
      queryNodesByCreator.mockImplementation(async (_s: string, _c: string, type?: string) => {
        if (type === "claim") return [makeNode({ node_id: "claim-1", content: "Claim A", confidence: 0.8 })];
        return [];
      });
      const { syncFactsToSemanticGraph } = await import("../../src/factsToSemanticGraph.js");
      const result = await syncFactsToSemanticGraph("scope-1", {
        claims: ["Claim A"],
        confidence: 0.9, // higher than existing 0.8
      });

      expect(updateNodeConfidence).toHaveBeenCalledWith("claim-1", 0.9, expect.anything());
      expect(appendNode).not.toHaveBeenCalled();
      expect(result.nodesUpdated).toBe(1);
      expect(result.nodesCreated).toBe(0);
    });

    it("marks stale claims as irrelevant instead of deleting", async () => {
      queryNodesByCreator.mockImplementation(async (_s: string, _c: string, type?: string) => {
        if (type === "claim") return [
          makeNode({ node_id: "claim-1", content: "Claim A", confidence: 0.8 }),
          makeNode({ node_id: "claim-2", content: "Claim B", confidence: 0.8 }),
        ];
        return [];
      });
      const { syncFactsToSemanticGraph } = await import("../../src/factsToSemanticGraph.js");
      const result = await syncFactsToSemanticGraph("scope-1", {
        claims: ["Claim A"], // Only Claim A — Claim B is stale
        confidence: 0.9,
      });

      // Claim B should be marked irrelevant
      expect(updateNodeStatus).toHaveBeenCalledWith("claim-2", "irrelevant", expect.anything());
      expect(result.nodesStaled).toBe(1);
    });

    it("does not re-create contradiction when resolves edge exists (irreversible resolution)", async () => {
      queryNodesByCreator.mockResolvedValue([]);
      appendNode
        .mockResolvedValueOnce("id-a")
        .mockResolvedValueOnce("id-b");
      hasResolvingEdge.mockResolvedValue(true); // already resolved

      const { syncFactsToSemanticGraph } = await import("../../src/factsToSemanticGraph.js");
      const result = await syncFactsToSemanticGraph("scope-1", {
        claims: ["Claim A", "Claim B"],
        contradictions: ['NLI: "Claim A" vs "Claim B"'],
      });

      // Contradiction edge should NOT be created (already resolved)
      expect(appendEdge).not.toHaveBeenCalled();
      expect(result.edgesCreated).toBe(0);
    });

    it("reactivates previously irrelevant nodes when they reappear", async () => {
      queryNodesByCreator.mockImplementation(async (_s: string, _c: string, type?: string) => {
        if (type === "claim") return [
          makeNode({ node_id: "claim-1", content: "Claim A", confidence: 0.8, status: "irrelevant" }),
        ];
        return [];
      });
      const { syncFactsToSemanticGraph } = await import("../../src/factsToSemanticGraph.js");
      await syncFactsToSemanticGraph("scope-1", {
        claims: ["Claim A"],
        confidence: 0.9,
      });

      // Should reactivate the node
      expect(updateNodeStatus).toHaveBeenCalledWith("claim-1", "active", expect.anything());
    });
  });
});
