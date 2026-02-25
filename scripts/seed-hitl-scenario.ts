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
import { runInTransaction } from "../src/db.js";
import {
  deleteNodesBySource,
  appendNode,
  appendEdge,
} from "../src/semanticGraph.js";
import {
  CLAIMS,
  GOALS,
  RISKS,
  CONTRADICTION_EDGES,
  RESOLUTION_EDGES,
  EXPECTED_NODE_COUNT,
  EXPECTED_EDGE_COUNT,
  HITL_CREATED_BY,
} from "../src/seed-data/hitl-scenario.js";

const SCOPE_ID = process.env.SCOPE_ID ?? "default";

async function main(): Promise<void> {
  const { nodesCreated, edgesCreated } = await runInTransaction(async (client) => {
    const deleted = await deleteNodesBySource(SCOPE_ID, HITL_CREATED_BY, client);
    if (deleted > 0) console.log("Removed", deleted, "existing seed-hitl-scenario nodes");

    const claimIds: string[] = [];
    for (const content of CLAIMS) {
      const nodeId = await appendNode(
        {
          scope_id: SCOPE_ID,
          type: "claim",
          content,
          confidence: 0.9,
          status: "active",
          source_ref: { source: "seed-hitl-scenario" },
          created_by: HITL_CREATED_BY,
        },
        client,
      );
      claimIds.push(nodeId);
    }

    for (const g of GOALS) {
      await appendNode(
        {
          scope_id: SCOPE_ID,
          type: "goal",
          content: g.content,
          status: g.status,
          source_ref: { source: "seed-hitl-scenario" },
          created_by: HITL_CREATED_BY,
        },
        client,
      );
    }

    for (const content of RISKS) {
      await appendNode(
        {
          scope_id: SCOPE_ID,
          type: "risk",
          content,
          status: "active",
          metadata: { severity: "high" },
          source_ref: { source: "seed-hitl-scenario" },
          created_by: HITL_CREATED_BY,
        },
        client,
      );
    }

    for (const e of CONTRADICTION_EDGES) {
      await appendEdge(
        {
          scope_id: SCOPE_ID,
          source_id: claimIds[e.sourceIndex],
          target_id: claimIds[e.targetIndex],
          edge_type: "contradicts",
          weight: 1,
          metadata: { raw: e.raw },
          created_by: HITL_CREATED_BY,
        },
        client,
      );
    }
    for (const e of RESOLUTION_EDGES) {
      await appendEdge(
        {
          scope_id: SCOPE_ID,
          source_id: claimIds[e.sourceIndex],
          target_id: claimIds[e.targetIndex],
          edge_type: "resolves",
          weight: 1,
          metadata: { note: e.note },
          created_by: HITL_CREATED_BY,
        },
        client,
      );
    }

    return { nodesCreated: EXPECTED_NODE_COUNT, edgesCreated: EXPECTED_EDGE_COUNT };
  });

  console.log("HITL seed scenario ready.", "Scope:", SCOPE_ID, "| Nodes:", nodesCreated, "| Edges:", edgesCreated);
  console.log("Start swarm; after governance runFinalityCheck a finality_review will appear in MITL pending.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
