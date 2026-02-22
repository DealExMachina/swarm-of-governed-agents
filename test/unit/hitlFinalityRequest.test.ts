import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getPending, _clearPendingForTest, _setMitlPoolForTest } from "../../src/mitlServer";
import { submitFinalityReviewForScope } from "../../src/hitlFinalityRequest";

vi.mock("../../src/finalityEvaluator.js", () => ({
  evaluateFinality: vi.fn(),
}));

import { evaluateFinality } from "../../src/finalityEvaluator.js";

function createFakeMitlPool(): import("pg").Pool {
  const store = new Map<string, { proposal: unknown; action_payload: unknown }>();
  return {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("CREATE TABLE") || text.includes("CREATE INDEX")) return { rows: [], rowCount: 0 };
      if (text.includes("INSERT INTO mitl_pending")) {
        const [id, proposal, action_payload] = values ?? [];
        store.set(String(id), {
          proposal: typeof proposal === "string" ? JSON.parse(proposal) : proposal,
          action_payload: typeof action_payload === "string" ? JSON.parse(action_payload as string) : action_payload,
        });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("SELECT proposal_id, proposal FROM mitl_pending")) {
        const rows = Array.from(store.entries()).map(([proposal_id, v]) => ({ proposal_id, proposal: v.proposal }));
        return { rows, rowCount: rows.length };
      }
      if (text.includes("SELECT proposal, action_payload FROM mitl_pending")) {
        const id = values?.[0];
        const row = id ? store.get(String(id)) : null;
        if (!row) return { rows: [], rowCount: 0 };
        return { rows: [{ proposal: row.proposal, action_payload: row.action_payload }], rowCount: 1 };
      }
      if (text.includes("SELECT 1 FROM mitl_pending") && text.includes("LIKE")) {
        const prefix = (values?.[0] as string) ?? "";
        const has = Array.from(store.keys()).some((k) => k.startsWith(prefix.replace(/%$/, "")));
        return { rows: has ? [{}] : [], rowCount: has ? 1 : 0 };
      }
      if (text.includes("DELETE FROM mitl_pending")) {
        const id = values?.[0];
        if (id) store.delete(String(id));
        else store.clear();
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as import("pg").Pool;
}

describe("hitlFinalityRequest", () => {
  beforeEach(async () => {
    const fakePool = createFakeMitlPool();
    _setMitlPoolForTest(fakePool);
    await _clearPendingForTest(fakePool);
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
    expect(await getPending()).toHaveLength(0);
  });

  it("submitFinalityReviewForScope returns false when evaluateFinality returns status", async () => {
    vi.mocked(evaluateFinality).mockResolvedValue({ kind: "status", status: "RESOLVED" });
    const out = await submitFinalityReviewForScope("scope-1");
    expect(out).toBe(false);
    expect(await getPending()).toHaveLength(0);
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
    const pending = await getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].proposal.agent).toBe("finality-evaluator");
    expect(pending[0].proposal.proposed_action).toBe("finality_review");
    expect((pending[0].proposal.payload as Record<string, unknown>).type).toBe("finality_review");
    expect((pending[0].proposal.payload as Record<string, unknown>).goal_score).toBe(0.8);
    expect((pending[0].proposal.payload as Record<string, unknown>).dimension_breakdown).toEqual([]);
    expect((pending[0].proposal.payload as Record<string, unknown>).blockers).toHaveLength(1);
    expect(Array.isArray((pending[0].proposal.payload as Record<string, unknown>).suggested_actions)).toBe(true);
  });

  it("submitFinalityReviewForScope returns true without adding when scope already has pending finality review", async () => {
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
        blockers: [],
        llm_explanation: "",
        suggested_actions: [],
        options: [],
      },
    });
    const out1 = await submitFinalityReviewForScope("scope-1");
    expect(out1).toBe(true);
    const pendingAfterFirst = await getPending();
    expect(pendingAfterFirst).toHaveLength(1);
    const out2 = await submitFinalityReviewForScope("scope-1");
    expect(out2).toBe(true);
    const pendingAfterSecond = await getPending();
    expect(pendingAfterSecond).toHaveLength(1);
  });
});
