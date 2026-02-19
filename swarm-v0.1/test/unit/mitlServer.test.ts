import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  addPending,
  getPending,
  approvePending,
  rejectPending,
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
    expect(publishRejectionCalls).toHaveLength(1);
    expect(publishRejectionCalls[0].data).toMatchObject({ proposal_id: "p3", result: "rejected" });
    expect(getPending()).toHaveLength(0);
  });
});
