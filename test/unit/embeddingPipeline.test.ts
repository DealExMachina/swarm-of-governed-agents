import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getEmbedding,
  updateNodeEmbedding,
  getEmbeddingBatch,
  embedAndPersistNode,
} from "../../src/embeddingPipeline";

const EMBEDDING_DIM = 1024;

function makeVec(): number[] {
  return Array.from({ length: EMBEDDING_DIM }, (_, i) => (i * 0.001) % 1);
}

describe("embeddingPipeline", () => {
  beforeEach(() => {
    vi.stubEnv("OLLAMA_BASE_URL", "");
    vi.stubEnv("EMBEDDING_MODEL", "bge-m3");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("getEmbedding", () => {
    it("returns empty array when OLLAMA_BASE_URL is unset", async () => {
      const out = await getEmbedding("hello");
      expect(out).toEqual([]);
    });

    it("returns empty array when text is blank", async () => {
      vi.stubEnv("OLLAMA_BASE_URL", "http://localhost:11434");
      const out = await getEmbedding("   ");
      expect(out).toEqual([]);
    });

    it("returns empty array when fetch fails", async () => {
      vi.stubEnv("OLLAMA_BASE_URL", "http://localhost:11434");
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
      const out = await getEmbedding("hello");
      expect(out).toEqual([]);
    });

    it("returns empty array when response is not ok", async () => {
      vi.stubEnv("OLLAMA_BASE_URL", "http://localhost:11434");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
      const out = await getEmbedding("hello");
      expect(out).toEqual([]);
    });

    it("returns empty array when embedding has wrong dimension", async () => {
      vi.stubEnv("OLLAMA_BASE_URL", "http://localhost:11434");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ embedding: [0.1, 0.2] }),
        }),
      );
      const out = await getEmbedding("hello");
      expect(out).toEqual([]);
    });

    it("returns 1024-dim vector when Ollama returns valid embedding", async () => {
      vi.stubEnv("OLLAMA_BASE_URL", "http://localhost:11434");
      const vec = makeVec();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ embedding: vec }),
        }),
      );
      const out = await getEmbedding("hello");
      expect(out).toHaveLength(EMBEDDING_DIM);
      expect(out).toEqual(vec);
    });
  });

  describe("getEmbeddingBatch", () => {
    it("returns empty map when Ollama not configured", async () => {
      const out = await getEmbeddingBatch([
        { nodeId: "n1", content: "a" },
        { nodeId: "n2", content: "b" },
      ]);
      expect(out.size).toBe(0);
    });

    it("returns map of nodeId -> embedding for each item when fetch returns valid embedding", async () => {
      vi.stubEnv("OLLAMA_BASE_URL", "http://localhost:11434");
      const vec = makeVec();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ embedding: vec }),
        }),
      );
      const out = await getEmbeddingBatch([
        { nodeId: "n1", content: "first" },
        { nodeId: "n2", content: "second" },
      ]);
      expect(out.size).toBe(2);
      expect(out.get("n1")).toHaveLength(EMBEDDING_DIM);
      expect(out.get("n2")).toHaveLength(EMBEDDING_DIM);
    });
  });

  describe("updateNodeEmbedding", () => {
    it("does not throw when vector has wrong length (no-op)", async () => {
      await expect(updateNodeEmbedding("node-1", "scope-1", [1, 2, 3])).resolves.toBeUndefined();
    });
  });

  describe("embedAndPersistNode", () => {
    it("returns false when getEmbedding returns empty", async () => {
      const out = await embedAndPersistNode("n1", "s1", "text");
      expect(out).toBe(false);
    });

    it("returns true when getEmbedding returns vector (updateNodeEmbedding no-ops if DB unavailable)", async () => {
      vi.stubEnv("OLLAMA_BASE_URL", "http://localhost:11434");
      vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5439/nonexistent");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ embedding: makeVec() }),
        }),
      );
      const out = await embedAndPersistNode("n1", "s1", "text");
      expect(out).toBe(true);
    });
  });
});
