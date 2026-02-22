/**
 * Sync extracted facts (claims, goals, risks, contradictions) into the semantic graph
 * so loadFinalitySnapshot and finality evaluation have real data.
 *
 * Uses CRDT-inspired monotonic upsert strategy (CodeCRDT, arXiv:2510.18893):
 * - Claims: upsert-if-better (only update confidence when new >= existing)
 * - Contradictions: irreversible resolution (once a resolves edge exists, cannot re-open)
 * - Stale nodes: marked "irrelevant" instead of deleted (append-only semantics)
 *
 * This guarantees the goal score is a ratchet — it only moves forward, never regresses.
 */

import {
  runInTransaction,
  appendNode,
  appendEdge,
  updateNodeConfidence,
  updateNodeStatus,
  hasResolvingEdge,
  queryNodesByCreator,
  type SemanticNode,
} from "./semanticGraph.js";
import { logger } from "./logger.js";

const FACTS_SYNC_SOURCE = "facts-sync";

export interface FactsPayload {
  entities?: string[];
  claims?: string[];
  risks?: string[];
  assumptions?: string[];
  contradictions?: string[];
  goals?: string[];
  confidence?: number;
  [k: string]: unknown;
}

/**
 * Parse NLI-style contradiction string into two claim fragments for matching.
 * Format: NLI: "claimA..." vs "claimB..."
 */
function parseNliContradiction(s: string): [string, string] | null {
  const trimmed = s.trim();
  const nli = /^NLI:\s*"(.*?)"\s+vs\s+"(.*?)"/s;
  const m = trimmed.match(nli);
  if (m) {
    const a = m[1].replace(/\.\.\.$/, "").trim();
    const b = m[2].replace(/\.\.\.$/, "").trim();
    if (a && b) return [a, b];
  }
  const fallback = /^(.*?)\s+contradicts\s+(.*)$/i.exec(trimmed);
  if (fallback) return [fallback[1].trim(), fallback[2].trim()];
  return null;
}

/**
 * Find best-matching claim node id from content->nodeId map (exact or starts-with).
 */
export function findClaimNodeId(
  contentToId: Map<string, string>,
  fragment: string,
): string | null {
  if (!fragment) return null;
  const exact = contentToId.get(fragment);
  if (exact) return exact;
  for (const [content, id] of contentToId) {
    if (content === fragment || content.startsWith(fragment) || fragment.startsWith(content))
      return id;
  }
  return null;
}

/**
 * Match a new claim against existing nodes by content similarity.
 * Returns the matched node or null.
 */
function matchExistingNode(
  existingNodes: SemanticNode[],
  content: string,
): SemanticNode | null {
  const trimmed = content.trim();
  for (const node of existingNodes) {
    if (
      node.content === trimmed ||
      node.content.startsWith(trimmed) ||
      trimmed.startsWith(node.content)
    ) {
      return node;
    }
  }
  return null;
}

/**
 * Sync facts for a scope into the semantic graph using monotonic upserts.
 *
 * Strategy (CRDT-inspired):
 * 1. Load existing fact-sourced nodes
 * 2. For each new claim: upsert-if-better (only increase confidence)
 * 3. For goals/risks: upsert or insert
 * 4. For contradictions: only create if no resolving edge exists (irreversible resolution)
 * 5. Mark stale nodes as "irrelevant" instead of deleting
 */
export async function syncFactsToSemanticGraph(
  scopeId: string,
  facts: FactsPayload,
  opts?: { embedClaims?: boolean },
): Promise<{ nodesCreated: number; edgesCreated: number; nodesUpdated: number; nodesStaled: number }> {
  const claims = (Array.isArray(facts.claims) ? facts.claims : []).filter((c): c is string => typeof c === "string");
  const goals = (Array.isArray(facts.goals) ? facts.goals : []).filter((g): g is string => typeof g === "string");
  const risks = (Array.isArray(facts.risks) ? facts.risks : []).filter((r): r is string => typeof r === "string");
  const contradictions = (Array.isArray(facts.contradictions) ? facts.contradictions : []).filter(
    (c): c is string => typeof c === "string",
  );
  const confidence = typeof facts.confidence === "number" ? facts.confidence : 1;

  let nodesCreated = 0;
  let nodesUpdated = 0;
  let nodesStaled = 0;
  let edgesCreated = 0;
  const claimContentToNodeId = new Map<string, string>();

  await runInTransaction(async (client) => {
    // Load existing fact-synced nodes
    const existingClaims = await queryNodesByCreator(scopeId, FACTS_SYNC_SOURCE, "claim", client);
    const existingGoals = await queryNodesByCreator(scopeId, FACTS_SYNC_SOURCE, "goal", client);
    const existingRisks = await queryNodesByCreator(scopeId, FACTS_SYNC_SOURCE, "risk", client);

    // Track which existing nodes were matched (for stale detection)
    const matchedClaimIds = new Set<string>();
    const matchedGoalIds = new Set<string>();
    const matchedRiskIds = new Set<string>();

    // --- Claims: upsert-if-better ---
    for (const content of claims) {
      if (typeof content !== "string" || !content.trim()) continue;
      const trimmed = content.trim();
      const existing = matchExistingNode(existingClaims, trimmed);

      if (existing) {
        matchedClaimIds.add(existing.node_id);
        // Monotonic: only update if new confidence >= existing
        if (confidence >= existing.confidence) {
          await updateNodeConfidence(existing.node_id, confidence, client);
          nodesUpdated++;
        }
        // Ensure active status (may have been previously marked irrelevant)
        if (existing.status !== "active") {
          await updateNodeStatus(existing.node_id, "active", client);
        }
        claimContentToNodeId.set(trimmed, existing.node_id);
      } else {
        // New claim — insert
        const nodeId = await appendNode(
          {
            scope_id: scopeId,
            type: "claim",
            content: trimmed,
            confidence,
            status: "active",
            source_ref: { source: "facts" },
            created_by: FACTS_SYNC_SOURCE,
          },
          client,
        );
        claimContentToNodeId.set(trimmed, nodeId);
        nodesCreated++;
      }
    }

    // --- Goals: upsert by content match ---
    for (const content of goals) {
      if (typeof content !== "string" || !content.trim()) continue;
      const trimmed = content.trim();
      const existing = matchExistingNode(existingGoals, trimmed);

      if (existing) {
        matchedGoalIds.add(existing.node_id);
        if (existing.status !== "active") {
          await updateNodeStatus(existing.node_id, "active", client);
        }
      } else {
        await appendNode(
          {
            scope_id: scopeId,
            type: "goal",
            content: trimmed,
            status: "active",
            source_ref: { source: "facts" },
            created_by: FACTS_SYNC_SOURCE,
          },
          client,
        );
        nodesCreated++;
      }
    }

    // --- Risks: upsert by content match ---
    for (const content of risks) {
      if (typeof content !== "string" || !content.trim()) continue;
      const trimmed = content.trim();
      const existing = matchExistingNode(existingRisks, trimmed);

      if (existing) {
        matchedRiskIds.add(existing.node_id);
        if (existing.status !== "active") {
          await updateNodeStatus(existing.node_id, "active", client);
        }
      } else {
        await appendNode(
          {
            scope_id: scopeId,
            type: "risk",
            content: trimmed,
            status: "active",
            metadata: { severity: "high" },
            source_ref: { source: "facts" },
            created_by: FACTS_SYNC_SOURCE,
          },
          client,
        );
        nodesCreated++;
      }
    }

    // --- Mark stale nodes as "irrelevant" (not deleted — CRDT append-only) ---
    for (const node of existingClaims) {
      if (!matchedClaimIds.has(node.node_id) && node.status === "active") {
        await updateNodeStatus(node.node_id, "irrelevant", client);
        nodesStaled++;
      }
    }
    for (const node of existingGoals) {
      if (!matchedGoalIds.has(node.node_id) && node.status === "active") {
        await updateNodeStatus(node.node_id, "irrelevant", client);
        nodesStaled++;
      }
    }
    for (const node of existingRisks) {
      if (!matchedRiskIds.has(node.node_id) && node.status === "active") {
        await updateNodeStatus(node.node_id, "irrelevant", client);
        nodesStaled++;
      }
    }

    // --- Contradictions: only create if no resolving edge exists (irreversible resolution) ---
    for (const raw of contradictions) {
      const str = typeof raw === "string" ? raw : String(raw);
      const pair = parseNliContradiction(str);
      if (!pair) continue;
      const [a, b] = pair;
      const sourceId = findClaimNodeId(claimContentToNodeId, a);
      const targetId = findClaimNodeId(claimContentToNodeId, b);
      if (sourceId && targetId && sourceId !== targetId) {
        // Irreversible resolution: if a resolves edge exists, do not re-create contradiction
        const resolved = await hasResolvingEdge(scopeId, sourceId, targetId, client);
        if (!resolved) {
          await appendEdge(
            {
              scope_id: scopeId,
              source_id: sourceId,
              target_id: targetId,
              edge_type: "contradicts",
              weight: 1,
              metadata: { raw: str },
              created_by: FACTS_SYNC_SOURCE,
            },
            client,
          );
          edgesCreated++;
        }
      }
    }
  });

  if (opts?.embedClaims && nodesCreated > 0) {
    const { embedAndPersistNode } = await import("./embeddingPipeline.js");
    const claimContents = [...claimContentToNodeId.entries()];
    for (const [content, nodeId] of claimContents) {
      try {
        await embedAndPersistNode(nodeId, scopeId, content);
      } catch (e) {
        logger.warn("facts-sync: embed claim failed", { nodeId, error: String(e) });
      }
    }
  }

  logger.info("facts-sync: synced facts to semantic graph", {
    scopeId,
    nodesCreated,
    nodesUpdated,
    nodesStaled,
    edgesCreated,
  });
  return { nodesCreated, edgesCreated, nodesUpdated, nodesStaled };
}
