/**
 * Seed a deterministic semantic graph scenario where finality cannot be reached
 * (one unresolved contradiction, goal score in [near, auto) band). The finality
 * agent will trigger the chat agent and HITL so a human can see why finality is
 * not reached, what minimally would fix it, and provide new facts or a resolution.
 *
 * Run after migrations. Optional: after seed:all. Then start swarm; when
 * governance runs runFinalityCheck, a finality_review will appear in MITL pending.
 *
 * Usage: npm run seed:hitl
 */
import "dotenv/config";
import {
  runInTransaction,
  deleteNodesBySource,
  appendNode,
  appendEdge,
} from "../src/semanticGraph.js";

const SCOPE_ID = process.env.SCOPE_ID ?? "default";
const CREATED_BY = "seed-hitl-scenario";

async function main(): Promise<void> {
  const { nodesCreated, edgesCreated } = await runInTransaction(async (client) => {
    const deleted = await deleteNodesBySource(SCOPE_ID, CREATED_BY, client);
    if (deleted > 0) console.log("Removed", deleted, "existing seed-hitl-scenario nodes");

    const claimIds: string[] = [];
    const claims = [
      "Budget is approved for Q4.",
      "Launch date is set to November 15.",
      "We will hire 15 engineers by year-end.",
      "SOC 2 audit is scheduled for November.",
      "Nexus APAC rollout is delayed by 2 weeks.",
    ];
    for (const content of claims) {
      const nodeId = await appendNode(
        {
          scope_id: SCOPE_ID,
          type: "claim",
          content,
          confidence: 0.9,
          status: "active",
          source_ref: { source: "seed-hitl-scenario" },
          created_by: CREATED_BY,
        },
        client,
      );
      claimIds.push(nodeId);
    }

    const goals = [
      { content: "Complete Nexus rollout in APAC", status: "resolved" as const },
      { content: "Pass SOC 2 audit", status: "resolved" as const },
      { content: "Hire 15+ engineers by Dec 31", status: "resolved" as const },
      { content: "Close two enterprise logos", status: "resolved" as const },
      { content: "Achieve 50 Nexus deployments by end of 2025", status: "active" as const },
    ];
    for (const g of goals) {
      await appendNode(
        {
          scope_id: SCOPE_ID,
          type: "goal",
          content: g.content,
          status: g.status,
          source_ref: { source: "seed-hitl-scenario" },
          created_by: CREATED_BY,
        },
        client,
      );
    }

    const risks = [
      "Talent market may delay hiring.",
      "APAC delay may shift revenue to Q1.",
    ];
    for (const content of risks) {
      await appendNode(
        {
          scope_id: SCOPE_ID,
          type: "risk",
          content,
          status: "active",
          metadata: { severity: "high" },
          source_ref: { source: "seed-hitl-scenario" },
          created_by: CREATED_BY,
        },
        client,
      );
    }

    // Two contradiction pairs; one will be "resolved" so one stays unresolved
    await appendEdge(
      {
        scope_id: SCOPE_ID,
        source_id: claimIds[0],
        target_id: claimIds[2],
        edge_type: "contradicts",
        weight: 1,
        metadata: { raw: "Budget approved vs hire 15 (stretch)" },
        created_by: CREATED_BY,
      },
      client,
    );
    await appendEdge(
      {
        scope_id: SCOPE_ID,
        source_id: claimIds[1],
        target_id: claimIds[4],
        edge_type: "contradicts",
        weight: 1,
        metadata: { raw: "Launch Nov 15 vs APAC delayed" },
        created_by: CREATED_BY,
      },
      client,
    );
    // Resolve the first contradiction only
    await appendEdge(
      {
        scope_id: SCOPE_ID,
        source_id: claimIds[0],
        target_id: claimIds[2],
        edge_type: "resolves",
        weight: 1,
        metadata: { note: "Resolution: budget supports 15 stretch target" },
        created_by: CREATED_BY,
      },
      client,
    );

    const nodesCreated = 5 + 5 + 2;
    const edgesCreated = 3;
    return { nodesCreated, edgesCreated };
  });

  console.log("HITL seed scenario ready.", "Scope:", SCOPE_ID, "| Nodes:", nodesCreated, "| Edges:", edgesCreated);
  console.log("Start swarm; after governance runFinalityCheck a finality_review will appear in MITL pending.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
