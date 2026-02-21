import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getPending, _clearPendingForTest } from "../../src/mitlServer";
import { submitFinalityReviewForScope } from "../../src/hitlFinalityRequest";

vi.mock("../../src/finalityEvaluator.js", () => ({
  evaluateFinality: vi.fn(),
}));

import { evaluateFinality } from "../../src/finalityEvaluator.js";

describe("hitlFinalityRequest", () => {
  beforeEach(() => {
    _clearPendingForTest();
    vi.stubEnv("OLLAMA_BASE_URL", "");
    vi.mocked(evaluateFinality).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("submitFinalityReviewForScope returns false when evaluateFinality returns null", async () => {
    vi.mocked(evaluateFinality).mockResolvedValue(null);
    const out = await submitFinalityReviewForScope("scope-1");
    expect(out).toBe(false);
    expect(getPending()).toHaveLength(0);
  });

  it("submitFinalityReviewForScope returns false when evaluateFinality returns status", async () => {
    vi.mocked(evaluateFinality).mockResolvedValue({ kind: "status", status: "RESOLVED" });
    const out = await submitFinalityReviewForScope("scope-1");
    expect(out).toBe(false);
    expect(getPending()).toHaveLength(0);
  });

  it("submitFinalityReviewForScope adds pending and returns true when evaluateFinality returns review", async () => {
    vi.mocked(evaluateFinality).mockResolvedValue({
      kind: "review",
      request: {
        type: "finality_review",
        scope_id: "scope-1",
        goal_score: 0.8,
        near_threshold: 0.75,
        auto_threshold: 0.92,
        gap: 0.12,
        dimension_breakdown: [],
        blockers: [{ type: "unresolved_contradiction", node_ids: [], description: "2 unresolved" }],
        llm_explanation: "",
        suggested_actions: [],
        options: [],
      },
    });
    const out = await submitFinalityReviewForScope("scope-1");
    expect(out).toBe(true);
    const pending = getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].proposal.agent).toBe("finality-evaluator");
    expect(pending[0].proposal.proposed_action).toBe("finality_review");
    expect((pending[0].proposal.payload as Record<string, unknown>).type).toBe("finality_review");
    expect((pending[0].proposal.payload as Record<string, unknown>).goal_score).toBe(0.8);
    expect((pending[0].proposal.payload as Record<string, unknown>).dimension_breakdown).toEqual([]);
    expect((pending[0].proposal.payload as Record<string, unknown>).blockers).toHaveLength(1);
    expect(Array.isArray((pending[0].proposal.payload as Record<string, unknown>).suggested_actions)).toBe(true);
  });
});
