import { describe, it, expect, vi, beforeEach } from "vitest";

const runInTransaction = vi.fn();
const deleteNodesBySource = vi.fn();
const appendNode = vi.fn();
const appendEdge = vi.fn();

vi.mock("../../src/semanticGraph.js", () => ({
  runInTransaction: (...args: unknown[]) => runInTransaction(...args),
  deleteNodesBySource: (...args: unknown[]) => deleteNodesBySource(...args),
  appendNode: (...args: unknown[]) => appendNode(...args),
  appendEdge: (...args: unknown[]) => appendEdge(...args),
}));

vi.mock("../../src/embeddingPipeline.js", () => ({ embedAndPersistNode: vi.fn().mockResolvedValue(true) }));

describe("factsToSemanticGraph", () => {
  beforeEach(() => {
    runInTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({}));
    deleteNodesBySource.mockResolvedValue(0);
    appendNode.mockResolvedValue("node-uuid");
    appendEdge.mockResolvedValue("edge-uuid");
  });

  it("syncFactsToSemanticGraph deletes previous fact nodes and inserts claims, goals, risks", async () => {
    const { syncFactsToSemanticGraph } = await import("../../src/factsToSemanticGraph.js");
    const result = await syncFactsToSemanticGraph("scope-1", {
      claims: ["Claim A", "Claim B"],
      goals: ["Goal 1"],
      risks: ["Risk one"],
      contradictions: [],
      confidence: 0.9,
    });

    expect(deleteNodesBySource).toHaveBeenCalledWith("scope-1", "facts-sync", expect.anything());
    expect(appendNode).toHaveBeenCalledTimes(4);
    const nodeCalls = appendNode.mock.calls.map((c) => c[0]) as Array<{ type: string; content: string }>;
    const types = nodeCalls.map((n) => n.type).sort();
    const contents = nodeCalls.map((n) => n.content).sort();
    expect(types).toEqual(["claim", "claim", "goal", "risk"]);
    expect(contents).toEqual(["Claim A", "Claim B", "Goal 1", "Risk one"]);
    expect(appendEdge).not.toHaveBeenCalled();
    expect(result).toEqual({ nodesCreated: 4, edgesCreated: 0 });
  });

  it("parses NLI contradiction and creates edge when claim nodes match", async () => {
    appendNode
      .mockResolvedValueOnce("id-a")
      .mockResolvedValueOnce("id-b")
      .mockResolvedValueOnce("id-c");
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
});
