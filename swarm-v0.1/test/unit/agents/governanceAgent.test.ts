import { describe, it, expect, vi, beforeEach } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  processProposal,
  runFinalityCheck,
  type GovernanceAgentEnv,
} from "../../../src/agents/governanceAgent";
import type { Proposal } from "../../../src/events";

const { mockLoadState } = vi.hoisted(() => ({ mockLoadState: vi.fn() }));
const { mockEvaluateFinality } = vi.hoisted(() => ({ mockEvaluateFinality: vi.fn() }));
const { mockSubmitFinalityReviewForScope } = vi.hoisted(() => ({ mockSubmitFinalityReviewForScope: vi.fn() }));

vi.mock("../../../src/stateGraph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/stateGraph")>();
  return { ...actual, loadState: mockLoadState };
});
vi.mock("../../../src/contextWal", () => ({
  appendEvent: vi.fn(async () => 1),
}));
vi.mock("../../../src/finalityEvaluator", () => ({
  evaluateFinality: (...args: unknown[]) => mockEvaluateFinality(...args),
}));
vi.mock("../../../src/hitlFinalityRequest", () => ({
  submitFinalityReviewForScope: (...args: unknown[]) => mockSubmitFinalityReviewForScope(...args),
}));

function createMockS3(driftLevel: string): S3Client {
  const drift = { level: driftLevel, types: [] as string[] };
  return {
    send: vi.fn(async (cmd: any) => {
      if (cmd instanceof HeadObjectCommand) return {};
      if (cmd instanceof GetObjectCommand)
        return { Body: Readable.from([Buffer.from(JSON.stringify(drift), "utf-8")]) };
      return {};
    }),
  } as unknown as S3Client;
}

describe("governanceAgent", () => {
  let publishAction: (subj: string, data: Record<string, unknown>) => Promise<void>;
  let publishRejection: (subj: string, data: Record<string, unknown>) => Promise<void>;
  let actionCalls: Array<{ subject: string; data: Record<string, unknown> }>;
  let rejectionCalls: Array<{ subject: string; data: Record<string, unknown> }>;

  beforeEach(() => {
    actionCalls = [];
    rejectionCalls = [];
    publishAction = vi.fn(async (subj, data) => {
      actionCalls.push({ subject: subj, data });
    });
    publishRejection = vi.fn(async (subj, data) => {
      rejectionCalls.push({ subject: subj, data });
    });
  });

  it("approves proposal when transition is allowed (low drift)", async () => {
    mockLoadState.mockResolvedValue({
      runId: "r1",
      lastNode: "ContextIngested",
      updatedAt: "",
      epoch: 1,
    });
    const s3 = createMockS3("low");
    const env: GovernanceAgentEnv = {
      s3,
      bucket: "b",
      getPublishAction: () => publishAction,
      getPublishRejection: () => publishRejection,
    };
    const proposal: Proposal = {
      proposal_id: "p1",
      agent: "facts-1",
      proposed_action: "advance_state",
      target_node: "FactsExtracted",
      payload: { expectedEpoch: 1, from: "ContextIngested", to: "FactsExtracted" },
      mode: "YOLO",
    };

    await processProposal(proposal, env);

    expect(actionCalls).toHaveLength(1);
    expect(actionCalls[0].subject).toBe("swarm.actions.advance_state");
    expect(actionCalls[0].data.result).toBe("approved");
    expect(rejectionCalls).toHaveLength(0);
  });

  it("rejects proposal when canTransition blocks (high drift, DriftChecked -> ContextIngested)", async () => {
    mockLoadState.mockResolvedValue({
      runId: "r1",
      lastNode: "DriftChecked",
      updatedAt: "",
      epoch: 5,
    });
    const s3 = createMockS3("high");
    const env: GovernanceAgentEnv = {
      s3,
      bucket: "b",
      getPublishAction: () => publishAction,
      getPublishRejection: () => publishRejection,
    };
    const proposal: Proposal = {
      proposal_id: "p2",
      agent: "planner-1",
      proposed_action: "advance_state",
      target_node: "ContextIngested",
      payload: { expectedEpoch: 5, from: "DriftChecked", to: "ContextIngested" },
      mode: "YOLO",
    };

    await processProposal(proposal, env);

    expect(rejectionCalls).toHaveLength(1);
    expect(rejectionCalls[0].data.reason).toContain("High drift");
    expect(actionCalls).toHaveLength(0);
  });

  it("when mode is MITL, adds to pending and publishes to pending_approval (no immediate action)", async () => {
    const { getPending, _clearPendingForTest } = await import("../../../src/mitlServer");
    _clearPendingForTest();
    mockLoadState.mockResolvedValue({
      runId: "r1",
      lastNode: "ContextIngested",
      updatedAt: "",
      epoch: 1,
    });
    const s3 = createMockS3("low");
    const env: GovernanceAgentEnv = {
      s3,
      bucket: "b",
      getPublishAction: () => publishAction,
      getPublishRejection: () => publishRejection,
    };
    const proposal: Proposal = {
      proposal_id: "p-mitl",
      agent: "facts-1",
      proposed_action: "advance_state",
      target_node: "FactsExtracted",
      payload: { expectedEpoch: 1, from: "ContextIngested", to: "FactsExtracted" },
      mode: "MITL",
    };
    await processProposal(proposal, env);
    const pendingList = getPending();
    expect(pendingList).toHaveLength(1);
    expect(pendingList[0].proposal_id).toBe("p-mitl");
    expect(actionCalls.some((c) => c.subject.startsWith("swarm.pending_approval"))).toBe(true);
    expect(actionCalls.filter((c) => c.subject === "swarm.actions.advance_state")).toHaveLength(0);
  });

  describe("runFinalityCheck", () => {
    beforeEach(() => {
      mockEvaluateFinality.mockReset();
      mockSubmitFinalityReviewForScope.mockReset();
    });

    it("calls evaluateFinality with the given scopeId", async () => {
      mockEvaluateFinality.mockResolvedValue(null);
      await runFinalityCheck("default");
      expect(mockEvaluateFinality).toHaveBeenCalledTimes(1);
      expect(mockEvaluateFinality).toHaveBeenCalledWith("default");
      expect(mockSubmitFinalityReviewForScope).not.toHaveBeenCalled();
    });

    it("calls submitFinalityReviewForScope when evaluateFinality returns kind review", async () => {
      mockEvaluateFinality.mockResolvedValue({
        kind: "review",
        request: {
          type: "finality_review",
          scope_id: "my-scope",
          goal_score: 0.8,
          dimension_breakdown: [],
          blockers: [],
          options: [],
        },
      });
      await runFinalityCheck("my-scope");
      expect(mockEvaluateFinality).toHaveBeenCalledWith("my-scope");
      expect(mockSubmitFinalityReviewForScope).toHaveBeenCalledTimes(1);
      expect(mockSubmitFinalityReviewForScope).toHaveBeenCalledWith("my-scope");
    });

    it("does not call submitFinalityReviewForScope when evaluateFinality returns status", async () => {
      mockEvaluateFinality.mockResolvedValue({ kind: "status", status: "RESOLVED" });
      await runFinalityCheck("default");
      expect(mockSubmitFinalityReviewForScope).not.toHaveBeenCalled();
    });
  });
});
