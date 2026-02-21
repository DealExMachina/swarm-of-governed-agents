/**
 * Shared OpenAI-compatible and Ollama model config used across the swarm (TypeScript side).
 *
 * When OLLAMA_BASE_URL is set, extraction, rationale, HITL, and embedding flows use Ollama;
 * otherwise OpenAI (or OPENAI_BASE_URL) is used for chat, and embedding may use a separate path.
 *
 * Mastra 0.24.x routes "openai/<model>" through a gateway that calls the
 * OpenAI Responses API (/v1/responses) by default. By always passing a `url`, we force
 * chat/completions, which works with any OpenAI-compatible endpoint including Ollama.
 */

const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";

export type ChatModelConfig = {
  id: `${string}/${string}`;
  url: string;
  apiKey: string;
};

/**
 * Build a Mastra-safe model config that always uses the chat/completions path.
 * When OLLAMA_BASE_URL is set, returns Ollama url and the appropriate model for the role;
 * otherwise uses OPENAI_* env vars. Returns null when no API is configured.
 */
export function getChatModelConfig(
  defaults?: { model?: string; baseUrl?: string },
): ChatModelConfig | null {
  const ollamaBase = getOllamaBaseUrl();
  if (ollamaBase) {
    const model = process.env.EXTRACTION_MODEL || defaults?.model || "qwen3:8b";
    const id = (model.includes("/") ? model : `openai/${model}`) as `${string}/${string}`;
    return { id, url: ollamaBase, apiKey: "ollama" };
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const raw = process.env.OPENAI_MODEL || defaults?.model || "gpt-4o-mini";
  const id = (raw.includes("/") ? raw : `openai/${raw}`) as `${string}/${string}`;
  const url = process.env.OPENAI_BASE_URL?.trim() || defaults?.baseUrl || DEFAULT_OPENAI_BASE;
  return { id, url, apiKey };
}

/**
 * Model config for the oversight (routing) agent. When OVERSEE_MODEL is set, uses that model;
 * otherwise falls back to getChatModelConfig() so the oversight step can use a cheaper model.
 */
export function getOversightModelConfig(): ChatModelConfig | null {
  const base = getChatModelConfig();
  if (!base) return null;
  const overSee = process.env.OVERSEE_MODEL?.trim();
  if (!overSee) return base;
  const id = (overSee.includes("/") ? overSee : `openai/${overSee}`) as `${string}/${string}`;
  return { ...base, id };
}

/** Ollama base URL (e.g. http://localhost:11434 or http://host.docker.internal:11434). When set, Ollama is used for extraction/rationale/HITL/embeddings. */
export function getOllamaBaseUrl(): string | null {
  const u = process.env.OLLAMA_BASE_URL?.trim();
  return u || null;
}

export function getExtractionModel(): string {
  return process.env.EXTRACTION_MODEL?.trim() || "qwen3:8b";
}

export function getRationaleModel(): string {
  return process.env.RATIONALE_MODEL?.trim() || "phi4-mini";
}

export function getHitlModel(): string {
  return process.env.HITL_MODEL?.trim() || "mistral-small:22b";
}

export function getEmbeddingModel(): string {
  return process.env.EMBEDDING_MODEL?.trim() || "bge-m3";
}

export interface FinalityThresholds {
  nearFinalityThreshold: number;
  autoFinalityThreshold: number;
}

export function getFinalityThresholds(): FinalityThresholds {
  const near = Number(process.env.NEAR_FINALITY_THRESHOLD);
  const auto = Number(process.env.AUTO_FINALITY_THRESHOLD);
  return {
    nearFinalityThreshold: Number.isFinite(near) && near >= 0 && near <= 1 ? near : 0.75,
    autoFinalityThreshold: Number.isFinite(auto) && auto >= 0 && auto <= 1 ? auto : 0.92,
  };
}
