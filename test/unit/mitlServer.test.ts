import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  addPending,
  getPending,
  approvePending,
  rejectPending,
  resolveFinalityPending,
  setMitlPublishFns,
  _clearPendingForTest,
} from "../../src/mitlServer";
import type { Proposal } from "../../src/events";

describe("mitlServer", () => {
  let publishActionCalls: Array<{ subject: string; data: unknown }>;
  let publishRejectionCalls: Array<{ subject: string; data: unknown }>;

  beforeEach(() => {
    _clearPendingForTest();
    publishActionCalls = [];
    publishRejectionCalls = [];
    setMitlPublishFns(
      async (subj, data) => { publishActionCalls.push({ subject: subj, data }); },
      async (subj, data) => { publishRejectionCalls.push({ subject: subj, data }); },
    );
  });

  it("addPending and getPending", () => {
    const proposal: Proposal = {
      proposal_id: "p1",
      agent: "facts-1",
      proposed_action: "advance_state",
      target_node: "FactsExtracted",
      payload: { expectedEpoch: 1 },
      mode: "MITL",
    };
    addPending("p1", proposal, { expectedEpoch: 1, from: "A", to: "B" });
    const list = getPending();
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
    addPending("p2", proposal, { expectedEpoch: 2, runId: "r1", from: "FactsExtracted", to: "DriftChecked" });
    const result = await approvePending("p2");
    expect(result.ok).toBe(true);
    expect(publishActionCalls).toHaveLength(1);
    expect(publishActionCalls[0].subject).toBe("swarm.actions.advance_state");
    expect((publishActionCalls[0].data as any).result).toBe("approved");
    expect(getPending()).toHaveLength(0);
  });

  it("approvePending returns not_found for unknown id", async () => {
    const result = await approvePending("nonexistent");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_found");
  });

  it("rejectPending publishes rejection and removes from pending", async () => {
    addPending("p3", {
      proposal_id: "p3",
      agent: "x",
      proposed_action: "advance_state",
      target_node: "Y",
      payload: {},
      mode: "MITL",
    }, {});
    const result = await rejectPending("p3", "rejected by human");
    expect(result.ok).toBe(true);
    expect(publishRejectionCalls[0].data).toMatchObject({ proposal_id: "p3", result: "rejected" });
    expect(getPending()).toHaveLength(0);
  });

  it("approvePending returns use_finality_response for finality_review item", async () => {
    const payload = { type: "finality_review", scope_id: "s1", goal_score: 0.8 } as Record<string, unknown>;
    addPending("f1", {
      proposal_id: "f1",
      agent: "finality-evaluator",
      proposed_action: "finality_review",
      target_node: "RESOLVED",
      payload,
      mode: "MITL",
    }, payload);
    const result = await approvePending("f1");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("use_finality_response");
    expect(getPending()).toHaveLength(1);
  });

  it("resolveFinalityPending returns not_found for unknown id", async () => {
    const result = await resolveFinalityPending("nonexistent", "approve_finality");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_found");
  });

  it("resolveFinalityPending returns not_finality_review for non-finality item", async () => {
    addPending("p4", {
      proposal_id: "p4",
      agent: "facts-1",
      proposed_action: "advance_state",
      target_node: "FactsExtracted",
      payload: {},
      mode: "MITL",
    }, {});
    const result = await resolveFinalityPending("p4", "approve_finality");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_finality_review");
    expect(getPending()).toHaveLength(1);
  });

  it("resolveFinalityPending publishes to swarm.actions.finality and removes from pending", async () => {
    const payload = { type: "finality_review", scope_id: "s1", goal_score: 0.8 } as Record<string, unknown>;
    addPending("f2", {
      proposal_id: "f2",
      agent: "finality-evaluator",
      proposed_action: "finality_review",
      target_node: "RESOLVED",
      payload,
      mode: "MITL",
    }, payload);
    const result = await resolveFinalityPending("f2", "approve_finality");
    expect(result.ok).toBe(true);
    expect(publishActionCalls).toHaveLength(1);
    expect(publishActionCalls[0].subject).toBe("swarm.actions.finality");
    expect((publishActionCalls[0].data as Record<string, unknown>).option).toBe("approve_finality");
    expect((publishActionCalls[0].data as Record<string, unknown>).result).toBe("finality_response");
    expect(getPending()).toHaveLength(0);
  });

  it("resolveFinalityPending accepts defer with days", async () => {
    const payload = { type: "finality_review", scope_id: "s2" } as Record<string, unknown>;
    addPending("f3", {
      proposal_id: "f3",
      agent: "finality-evaluator",
      proposed_action: "finality_review",
      target_node: "RESOLVED",
      payload,
      mode: "MITL",
    }, payload);
    const result = await resolveFinalityPending("f3", "defer", 14);
    expect(result.ok).toBe(true);
    expect((publishActionCalls[0].data as Record<string, unknown>).option).toBe("defer");
    expect((publishActionCalls[0].data as Record<string, unknown>).days).toBe(14);
  });
});
