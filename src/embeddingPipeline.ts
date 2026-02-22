import pg from "pg";
import { getPool } from "./db.js";
import { getOllamaBaseUrl, getEmbeddingModel } from "./modelConfig.js";

const EMBEDDING_DIM = 1024;

/**
 * Call Ollama bge-m3 (or EMBEDDING_MODEL) to embed text. Returns 1024-dim vector.
 * Returns empty array if Ollama is unavailable or request fails.
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const base = getOllamaBaseUrl();
  const model = getEmbeddingModel();
  if (!base || !text?.trim()) return [];

  try {
    const url = `${base.replace(/\/$/, "")}/api/embeddings`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text.trim().slice(0, 32000) }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { embedding?: number[] };
    const vec = data.embedding;
    if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) return [];
    return vec;
  } catch {
    return [];
  }
}

/**
 * Update a node's embedding column. No-op if the nodes table or pgvector is not present.
 * Requires migrations/005_semantic_graph.sql (or equivalent) with nodes.embedding vector(1024).
 */
export async function updateNodeEmbedding(
  nodeId: string,
  _scopeId: string,
  embedding: number[],
): Promise<void> {
  if (embedding.length !== EMBEDDING_DIM) return;
  try {
    const pool = getPool();
    const vec = `[${embedding.join(",")}]`;
    await pool.query(
      `UPDATE nodes SET embedding = $2::vector, updated_at = now() WHERE node_id = $1`,
      [nodeId, vec],
    );
  } catch {
    // Table or extension may not exist yet
  }
}

/**
 * After a node is written, run embedding and persist. Call from semanticGraph.appendNode
 * or from a job that processes new nodes. Idempotent: safe to call multiple times per node.
 */
export async function embedAndPersistNode(nodeId: string, scopeId: string, content: string): Promise<boolean> {
  const vec = await getEmbedding(content);
  if (vec.length === 0) return false;
  await updateNodeEmbedding(nodeId, scopeId, vec);
  return true;
}

/**
 * Batch-embed contents and return a map nodeId -> embedding. Does not persist.
 * Used when building HNSW in bulk; caller is responsible for writing embeddings and creating index.
 */
export async function getEmbeddingBatch(
  items: { nodeId: string; content: string }[],
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  for (const { nodeId, content } of items) {
    const vec = await getEmbedding(content);
    if (vec.length === EMBEDDING_DIM) out.set(nodeId, vec);
  }
  return out;
}
