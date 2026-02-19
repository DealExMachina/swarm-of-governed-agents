/**
 * Shared OpenAI-compatible model config used across the swarm (TypeScript side).
 *
 * Mastra 0.24.x routes "openai/<model>" through a gateway that calls the
 * OpenAI Responses API (/v1/responses) by default. Older and smaller models
 * (e.g. gpt-4o-mini) may not be supported on the Responses API, and the call
 * can hit a Headers Timeout. By always passing a `url`, we force Mastra to use
 * the createOpenAICompatible path (chat/completions), which is reliable and
 * works with any OpenAI-compatible endpoint (OpenAI, OpenRouter, Together, etc.).
 *
 * The Python facts-worker (DSPy / RLM) uses the same env vars
 * (OPENAI_MODEL, OPENAI_API_KEY, OPENAI_BASE_URL) and already calls
 * chat/completions directly, so no fix is needed there.
 */

const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";

export type ChatModelConfig = {
  id: `${string}/${string}`;
  url: string;
  apiKey: string;
};

/**
 * Build a Mastra-safe model config that always uses the chat/completions path.
 * Returns null when OPENAI_API_KEY is not set.
 */
export function getChatModelConfig(
  defaults?: { model?: string; baseUrl?: string },
): ChatModelConfig | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const raw = process.env.OPENAI_MODEL || defaults?.model || "gpt-4o-mini";
  const id = (raw.includes("/") ? raw : `openai/${raw}`) as `${string}/${string}`;
  const url = process.env.OPENAI_BASE_URL?.trim() || defaults?.baseUrl || DEFAULT_OPENAI_BASE;
  return { id, url, apiKey };
}
