/**
 * Test real access to Postgres (pgvector) and Ollama.
 * Run: pnpm run test:postgres-ollama
 * Requires: DATABASE_URL, and for Ollama OLLAMA_BASE_URL (default localhost:11434).
 */
import "dotenv/config";
import { loadFinalitySnapshot } from "../src/semanticGraph.js";
import { getEmbedding } from "../src/embeddingPipeline.js";

async function main() {
  console.log("Testing Postgres/pgvector and Ollama...\n");

  const scopeId = process.env.SCOPE_ID ?? "default";

  try {
    const snapshot = await loadFinalitySnapshot(scopeId);
    console.log("Postgres/pgvector: OK");
    console.log("  loadFinalitySnapshot(%s) =>", scopeId, {
      claims_active_count: snapshot.claims_active_count,
      goals_completion_ratio: snapshot.goals_completion_ratio,
      scope_risk_score: snapshot.scope_risk_score,
    });
  } catch (e) {
    console.error("Postgres/pgvector: FAIL", e);
    process.exitCode = 1;
  }

  const ollamaBase = process.env.OLLAMA_BASE_URL?.trim();
  if (ollamaBase) {
    try {
      const vec = await getEmbedding("hello world");
      if (vec.length === 1024) {
        console.log("\nOllama (bge-m3): OK");
        console.log("  getEmbedding('hello world') => vector length", vec.length);
      } else {
        console.log("\nOllama: unexpected vector length", vec.length);
        process.exitCode = 1;
      }
    } catch (e) {
      console.error("\nOllama: FAIL", e);
      process.exitCode = 1;
    }
  } else {
    console.log("\nOllama: skipped (OLLAMA_BASE_URL not set)");
  }

  console.log("\nDone.");
}

main();
