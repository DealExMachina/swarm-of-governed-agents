/**
 * Sync extracted facts (claims, goals, risks, contradictions) into the semantic graph
 * so loadFinalitySnapshot and finality evaluation have real data.
 *
 * Uses replace strategy per scope: delete existing fact-sourced nodes (and their edges),
 * then insert nodes for claims, goals, risks, and edges for contradictions.
 */

import {
  runInTransaction,
  deleteNodesBySource,
  appendNode,
  appendEdge,
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
function findClaimNodeId(
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
 * Sync facts for a scope into the semantic graph. Replaces any existing fact-sourced
 * nodes for this scope, then inserts claims, goals, risks, and contradiction edges.
 */
export async function syncFactsToSemanticGraph(
  scopeId: string,
  facts: FactsPayload,
  opts?: { embedClaims?: boolean },
): Promise<{ nodesCreated: number; edgesCreated: number }> {
  const claims = (Array.isArray(facts.claims) ? facts.claims : []).filter((c): c is string => typeof c === "string");
  const goals = (Array.isArray(facts.goals) ? facts.goals : []).filter((g): g is string => typeof g === "string");
  const risks = (Array.isArray(facts.risks) ? facts.risks : []).filter((r): r is string => typeof r === "string");
  const contradictions = (Array.isArray(facts.contradictions) ? facts.contradictions : []).filter(
    (c): c is string => typeof c === "string",
  );
  const confidence = typeof facts.confidence === "number" ? facts.confidence : 1;

  let nodesCreated = 0;
  let edgesCreated = 0;
  const claimContentToNodeId = new Map<string, string>();

  await runInTransaction(async (client) => {
    const deleted = await deleteNodesBySource(scopeId, FACTS_SYNC_SOURCE, client);
    if (deleted > 0) {
      logger.info("facts-sync: cleared previous fact nodes", { scopeId, deleted });
    }

    claimContentToNodeId.clear();

    for (const content of claims) {
      if (typeof content !== "string" || !content.trim()) continue;
      const nodeId = await appendNode(
        {
          scope_id: scopeId,
          type: "claim",
          content: content.trim(),
          confidence,
          status: "active",
          source_ref: { source: "facts" },
          created_by: FACTS_SYNC_SOURCE,
        },
        client,
      );
      claimContentToNodeId.set(content.trim(), nodeId);
      nodesCreated++;
    }

    for (const content of goals) {
      if (typeof content !== "string" || !content.trim()) continue;
      await appendNode(
        {
          scope_id: scopeId,
          type: "goal",
          content: content.trim(),
          status: "active",
          source_ref: { source: "facts" },
          created_by: FACTS_SYNC_SOURCE,
        },
        client,
      );
      nodesCreated++;
    }

    for (const content of risks) {
      if (typeof content !== "string" || !content.trim()) continue;
      await appendNode(
        {
          scope_id: scopeId,
          type: "risk",
          content: content.trim(),
          status: "active",
          metadata: { severity: "high" },
          source_ref: { source: "facts" },
          created_by: FACTS_SYNC_SOURCE,
        },
        client,
      );
      nodesCreated++;
    }

    for (const raw of contradictions) {
      const str = typeof raw === "string" ? raw : String(raw);
      const pair = parseNliContradiction(str);
      if (!pair) continue;
      const [a, b] = pair;
      const sourceId = findClaimNodeId(claimContentToNodeId, a);
      const targetId = findClaimNodeId(claimContentToNodeId, b);
      if (sourceId && targetId && sourceId !== targetId) {
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
    edgesCreated,
  });
  return { nodesCreated, edgesCreated };
}
