import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PoolClient } from "pg";
import {
  addPending,
  getPending,
  approvePending,
  rejectPending,
  resolveFinalityPending,
  setMitlPublishFns,
  _clearPendingForTest,
  _setMitlPoolForTest,
  _resetMitlTableEnsured,
} from "../../src/mitlServer";
import type { Proposal } from "../../src/events";

/** In-memory fake for mitl_pending so unit tests don't need DATABASE_URL. */
function createMockPool(): { pool: import("pg").Pool; store: Map<string, { proposal: unknown; action_payload: unknown }> } {
  const store = new Map<string, { proposal: unknown; action_payload: unknown }>();
  const pool = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("CREATE TABLE") || text.includes("CREATE INDEX")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("INSERT INTO mitl_pending")) {
        const [proposal_id, proposal, action_payload] = values ?? [];
        store.set(String(proposal_id), {
          proposal: typeof proposal === "string" ? JSON.parse(proposal) : proposal,
          action_payload: typeof action_payload === "string" ? JSON.parse(action_payload as string) : action_payload,
        });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("SELECT proposal_id, proposal FROM mitl_pending") && text.includes("status = 'pending'")) {
        const rows = Array.from(store.entries()).map(([proposal_id, v]) => ({
          proposal_id,
          proposal: v.proposal,
        }));
        return { rows, rowCount: rows.length };
      }
      if (text.includes("SELECT proposal, action_payload FROM mitl_pending")) {
        const id = values?.[0];
        const row = id ? store.get(String(id)) : null;
        if (!row) return { rows: [], rowCount: 0 };
        return {
          rows: [{ proposal: row.proposal, action_payload: row.action_payload }],
          rowCount: 1,
        };
      }
      if (text.includes("DELETE FROM mitl_pending")) {
        const id = values?.[0];
        if (id) store.delete(String(id));
        else store.clear();
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    connect: vi.fn(async (): Promise<PoolClient> => ({ release: vi.fn() } as unknown as PoolClient)),
  } as unknown as import("pg").Pool;
  return { pool, store };
}

describe("mitlServer", () => {
  let publishActionCalls: Array<{ subject: string; data: unknown }>;
  let publishRejectionCalls: Array<{ subject: string; data: unknown }>;
  let mockPool: ReturnType<typeof createMockPool>;

  beforeEach(async () => {
    mockPool = createMockPool();
    _setMitlPoolForTest(mockPool.pool);
    _resetMitlTableEnsured();
    await _clearPendingForTest(mockPool.pool);
    _resetMitlTableEnsured();
    publishActionCalls = [];
    publishRejectionCalls = [];
    setMitlPublishFns(
      async (subj, data) => { publishActionCalls.push({ subject: subj, data }); },
      async (subj, data) => { publishRejectionCalls.push({ subject: subj, data }); },
    );
  });

  it("addPending and getPending", async () => {
    const proposal: Proposal = {
      proposal_id: "p1",
      agent: "facts-1",
      proposed_action: "advance_state",
      target_node: "FactsExtracted",
      payload: { expectedEpoch: 1 },
      mode: "MITL",
    };
    await addPending("p1", proposal, { expectedEpoch: 1, from: "A", to: "B" }, mockPool.pool);
    const list = await getPending(mockPool.pool);
    expect(list).toHaveLength(1);
    expect(list[0].proposal_id).toBe("p1");
    expect(list[0].proposal.agent).toBe("facts-1");
  });

  it("approvePending publishes action and removes from pending", async () => {
    const proposal: Proposal = {
      proposal_id: "p2",
      agent: "drift-1",
      proposed_action: "advance_state",
      target_node: "DriftChecked",
      payload: {},
      mode: "MITL",
    };
    await addPending("p2", proposal, { expectedEpoch: 2, runId: "r1", from: "FactsExtracted", to: "DriftChecked" }, mockPool.pool);
    const result = await approvePending("p2", mockPool.pool);
    expect(result.ok).toBe(true);
    expect(publishActionCalls).toHaveLength(1);
    expect(publishActionCalls[0].subject).toBe("swarm.actions.advance_state");
    expect((publishActionCalls[0].data as { result?: string }).result).toBe("approved");
    const list = await getPending(mockPool.pool);
    expect(list).toHaveLength(0);
  });

  it("approvePending returns not_found for unknown id", async () => {
    const result = await approvePending("nonexistent", mockPool.pool);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_found");
  });

  it("rejectPending publishes rejection and removes from pending", async () => {
    await addPending("p3", {
      proposal_id: "p3",
      agent: "x",
      proposed_action: "advance_state",
      target_node: "Y",
      payload: {},
      mode: "MITL",
    }, {}, mockPool.pool);
    const result = await rejectPending("p3", "rejected by human", mockPool.pool);
    expect(result.ok).toBe(true);
    expect(publishRejectionCalls[0].data).toMatchObject({ proposal_id: "p3", result: "rejected" });
    const list = await getPending(mockPool.pool);
    expect(list).toHaveLength(0);
  });

  it("approvePending returns use_finality_response for finality_review item", async () => {
    const payload = { type: "finality_review", scope_id: "s1", goal_score: 0.8 } as Record<string, unknown>;
    await addPending("f1", {
      proposal_id: "f1",
      agent: "finality-evaluator",
      proposed_action: "finality_review",
      target_node: "RESOLVED",
      payload,
      mode: "MITL",
    }, payload, mockPool.pool);
    const result = await approvePending("f1", mockPool.pool);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("use_finality_response");
    const list = await getPending(mockPool.pool);
    expect(list).toHaveLength(1);
  });

  it("resolveFinalityPending returns not_found for unknown id", async () => {
    const result = await resolveFinalityPending("nonexistent", "approve_finality", undefined, mockPool.pool);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_found");
  });

  it("resolveFinalityPending returns not_finality_review for non-finality item", async () => {
    await addPending("p4", {
      proposal_id: "p4",
      agent: "facts-1",
      proposed_action: "advance_state",
      target_node: "FactsExtracted",
      payload: {},
      mode: "MITL",
    }, {}, mockPool.pool);
    const result = await resolveFinalityPending("p4", "approve_finality", undefined, mockPool.pool);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_finality_review");
    const list = await getPending(mockPool.pool);
    expect(list).toHaveLength(1);
  });

  it("resolveFinalityPending publishes to swarm.actions.finality and removes from pending", async () => {
    const payload = { type: "finality_review", scope_id: "s1", goal_score: 0.8 } as Record<string, unknown>;
    await addPending("f2", {
      proposal_id: "f2",
      agent: "finality-evaluator",
      proposed_action: "finality_review",
      target_node: "RESOLVED",
      payload,
      mode: "MITL",
    }, payload, mockPool.pool);
    const result = await resolveFinalityPending("f2", "approve_finality", undefined, mockPool.pool);
    expect(result.ok).toBe(true);
    expect(publishActionCalls).toHaveLength(1);
    expect(publishActionCalls[0].subject).toBe("swarm.actions.finality");
    expect((publishActionCalls[0].data as Record<string, unknown>).option).toBe("approve_finality");
    expect((publishActionCalls[0].data as Record<string, unknown>).result).toBe("finality_response");
    const list = await getPending(mockPool.pool);
    expect(list).toHaveLength(0);
  });

  it("resolveFinalityPending accepts defer with days", async () => {
    const payload = { type: "finality_review", scope_id: "s2" } as Record<string, unknown>;
    await addPending("f3", {
      proposal_id: "f3",
      agent: "finality-evaluator",
      proposed_action: "finality_review",
      target_node: "RESOLVED",
      payload,
      mode: "MITL",
    }, payload, mockPool.pool);
    const result = await resolveFinalityPending("f3", "defer", 14, mockPool.pool);
    expect(result.ok).toBe(true);
    expect((publishActionCalls[0].data as Record<string, unknown>).option).toBe("defer");
    expect((publishActionCalls[0].data as Record<string, unknown>).days).toBe(14);
  });
});
