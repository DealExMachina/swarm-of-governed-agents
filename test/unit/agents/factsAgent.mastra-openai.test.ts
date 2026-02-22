/**
 * Tests that Mastra can reach the OpenAI-compatible endpoint using the same
 * config as the facts agent (getFactsModelConfig). Runs only when OPENAI_API_KEY
 * is set (and not placeholder) and OLLAMA_BASE_URL is not set (so we use OpenAI).
 */
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { Agent } from "@mastra/core/agent";
import { getFactsModelConfig } from "../../../src/agents/factsAgent";

const hasOpenAI =
  process.env.OPENAI_API_KEY &&
  process.env.OPENAI_API_KEY !== "sk-xxxx" &&
  !process.env.OLLAMA_BASE_URL?.trim();

describe.runIf(hasOpenAI)("factsAgent Mastra OpenAI access", () => {
  it("Mastra Agent with getFactsModelConfig() can call the configured model", async () => {
    const model = getFactsModelConfig();
    const agent = new Agent({
      id: "test-openai",
      name: "Test",
      instructions: "Reply briefly.",
      model,
    });

    const result = await agent.generate("Reply with exactly: OK", {
      maxSteps: 1,
    });

    expect(result).toBeDefined();
    expect(typeof (result as { text?: string }).text).toBe("string");
    expect(((result as { text: string }).text).trim().toUpperCase()).toContain("OK");
  }, 20000);
});
