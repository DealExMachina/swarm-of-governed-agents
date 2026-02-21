import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getChatModelConfig,
  getOversightModelConfig,
  getOllamaBaseUrl,
  getExtractionModel,
  getRationaleModel,
  getHitlModel,
  getEmbeddingModel,
  getFinalityThresholds,
  type FinalityThresholds,
} from "../../src/modelConfig";

describe("modelConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.stubEnv("OLLAMA_BASE_URL", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_BASE_URL", "");
    vi.stubEnv("OPENAI_MODEL", "");
    vi.stubEnv("EXTRACTION_MODEL", "");
    vi.stubEnv("RATIONALE_MODEL", "");
    vi.stubEnv("HITL_MODEL", "");
    vi.stubEnv("EMBEDDING_MODEL", "");
    vi.stubEnv("NEAR_FINALITY_THRESHOLD", "");
    vi.stubEnv("AUTO_FINALITY_THRESHOLD", "");
    vi.stubEnv("OVERSEE_MODEL", "");
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllEnvs();
  });

  describe("getOllamaBaseUrl", () => {
    it("returns null when OLLAMA_BASE_URL is unset", () => {
      expect(getOllamaBaseUrl()).toBeNull();
    });

    it("returns null when OLLAMA_BASE_URL is blank", () => {
      vi.stubEnv("OLLAMA_BASE_URL", "   ");
      expect(getOllamaBaseUrl()).toBeNull();
    });

    it("returns trimmed URL when set", () => {
      vi.stubEnv("OLLAMA_BASE_URL", "  http://localhost:11434  ");
      expect(getOllamaBaseUrl()).toBe("http://localhost:11434");
    });
  });

  describe("getExtractionModel", () => {
    it("returns default qwen3:8b when unset", () => {
      expect(getExtractionModel()).toBe("qwen3:8b");
    });

    it("returns env value when set", () => {
      vi.stubEnv("EXTRACTION_MODEL", "qwen3:14b");
      expect(getExtractionModel()).toBe("qwen3:14b");
    });
  });

  describe("getRationaleModel", () => {
    it("returns default phi4-mini when unset", () => {
      expect(getRationaleModel()).toBe("phi4-mini");
    });
  });

  describe("getHitlModel", () => {
    it("returns default mistral-small:22b when unset", () => {
      expect(getHitlModel()).toBe("mistral-small:22b");
    });
  });

  describe("getEmbeddingModel", () => {
    it("returns default bge-m3 when unset", () => {
      expect(getEmbeddingModel()).toBe("bge-m3");
    });
  });

  describe("getFinalityThresholds", () => {
    it("returns defaults when unset or invalid", () => {
      vi.stubEnv("NEAR_FINALITY_THRESHOLD", "x");
      vi.stubEnv("AUTO_FINALITY_THRESHOLD", "y");
      const t = getFinalityThresholds();
      expect(t.nearFinalityThreshold).toBe(0.75);
      expect(t.autoFinalityThreshold).toBe(0.92);
    });

    it("returns env values when valid", () => {
      vi.stubEnv("NEAR_FINALITY_THRESHOLD", "0.80");
      vi.stubEnv("AUTO_FINALITY_THRESHOLD", "0.95");
      const t = getFinalityThresholds();
      expect(t.nearFinalityThreshold).toBe(0.8);
      expect(t.autoFinalityThreshold).toBe(0.95);
    });

    it("clamps to 0-1 and falls back to defaults for invalid", () => {
      vi.stubEnv("NEAR_FINALITY_THRESHOLD", "2");
      vi.stubEnv("AUTO_FINALITY_THRESHOLD", "not-a-number");
      const t = getFinalityThresholds();
      expect(t.nearFinalityThreshold).toBe(0.75);
      expect(t.autoFinalityThreshold).toBe(0.92);
    });
  });

  describe("getChatModelConfig", () => {
    it("returns null when no API key and no Ollama", () => {
      expect(getChatModelConfig()).toBeNull();
    });

    it("returns Ollama config when OLLAMA_BASE_URL is set", () => {
      vi.stubEnv("OLLAMA_BASE_URL", "http://localhost:11434");
      const cfg = getChatModelConfig();
      expect(cfg).not.toBeNull();
      expect(cfg!.url).toBe("http://localhost:11434");
      expect(cfg!.apiKey).toBe("ollama");
      expect(cfg!.id).toContain("qwen3");
    });

    it("returns OpenAI config when OPENAI_API_KEY set and no Ollama", () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      vi.stubEnv("OPENAI_MODEL", "gpt-4o-mini");
      const cfg = getChatModelConfig();
      expect(cfg).not.toBeNull();
      expect(cfg!.apiKey).toBe("sk-test");
      expect(cfg!.id).toContain("gpt-4o-mini");
    });

    it("prefers Ollama when both OLLAMA_BASE_URL and OPENAI_API_KEY set", () => {
      vi.stubEnv("OLLAMA_BASE_URL", "http://localhost:11434");
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      const cfg = getChatModelConfig();
      expect(cfg).not.toBeNull();
      expect(cfg!.apiKey).toBe("ollama");
    });
  });

  describe("getOversightModelConfig", () => {
    it("returns null when getChatModelConfig is null", () => {
      expect(getOversightModelConfig()).toBeNull();
    });

    it("returns same as getChatModelConfig when OVERSEE_MODEL unset", () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      vi.stubEnv("OPENAI_MODEL", "gpt-4o-mini");
      const chat = getChatModelConfig();
      const over = getOversightModelConfig();
      expect(over).not.toBeNull();
      expect(over!.id).toBe(chat!.id);
    });

    it("returns config with OVERSEE_MODEL when set", () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      vi.stubEnv("OPENAI_MODEL", "gpt-4o");
      vi.stubEnv("OVERSEE_MODEL", "gpt-4o-mini");
      const over = getOversightModelConfig();
      expect(over).not.toBeNull();
      expect(over!.id).toContain("gpt-4o-mini");
    });
  });
});
