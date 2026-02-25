import type { S3Client } from "@aws-sdk/client-s3";
import { createTool } from "@mastra/core/tools";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { getChatModelConfig } from "../modelConfig.js";
import { logger } from "../logger.js";
import { s3GetText } from "../s3.js";
import { appendEvent } from "../contextWal.js";
import { createSwarmEvent } from "../events.js";
import { makeReadFactsTool, makeReadDriftTool, makeReadContextTool, loadDrift } from "./sharedTools.js";

const SHORT_PROMPT = "Summarize recent changes in 2-3 sentences for a short status update.";
const FULL_PROMPT = "Produce a comprehensive status report: facts confidence, drift trends, recent actions, unresolved contradictions, recommended next steps.";

function createWriteBriefingTool() {
  return createTool({
    id: "writeBriefing",
    description: "Append a status briefing to the context WAL and make it visible in the feed.",
    inputSchema: z.object({
      summary: z.string(),
      type: z.enum(["short", "full"]).optional(),
    }),
    outputSchema: z.object({
      seq: z.number(),
      type: z.string(),
    }),
    execute: async (ctx) => {
      const input = (ctx as unknown) as { context?: { summary?: string; type?: string } };
      const summary = input?.context?.summary ?? "";
      const type = input?.context?.type ?? "short";
      const event = createSwarmEvent(
        type === "full" ? "briefing_full" : "briefing_short",
        { summary, ts: new Date().toISOString() },
        { source: "status_agent" },
      );
      const seq = await appendEvent(event as unknown as Record<string, unknown>);
      return { seq, type: type === "full" ? "briefing_full" : "briefing_short" };
    },
  });
}

/**
 * Run status agent: LLM synthesis (short or full from payload) when OPENAI_API_KEY set, else raw card.
 */
export async function runStatusAgent(
  s3: S3Client,
  bucket: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const elapsedMs = (payload?.elapsedMs as number) ?? 0;
  const nextFullMs = (payload?.nextFullMs as number) ?? 600000;
  const isFull = elapsedMs >= nextFullMs;

  const modelConfig = getChatModelConfig();
  if (modelConfig) {
    try {
      const readFacts = makeReadFactsTool(s3, bucket);
      const readDrift = makeReadDriftTool(s3, bucket);
      const readRecentEvents = makeReadContextTool(50);
      const writeBriefing = createWriteBriefingTool();
      const agent = new Agent({
        id: "status-agent",
        name: "Status Agent",
        instructions: "You are a status synthesis agent. Use readFacts, readDrift, readContext to gather state. Then use writeBriefing with a concise summary. For short updates use 2-3 sentences; for full briefings provide a comprehensive report.",
        model: modelConfig,
        tools: { readFacts, readDrift, readRecentEvents, writeBriefing },
      });
      const prompt = isFull ? FULL_PROMPT : SHORT_PROMPT;
      await agent.generate(prompt, { maxSteps: 8 });
      const factsRaw = await s3GetText(s3, bucket, "facts/latest.json");
      const facts = factsRaw ? (JSON.parse(factsRaw) as Record<string, unknown>) : null;
      const drift = await loadDrift(s3, bucket);
      const cardPayload = {
        ts: new Date().toISOString(),
        drift_level: drift?.level ?? "unknown",
        drift_types: drift?.types ?? [],
        confidence: facts?.confidence ?? null,
        goals: (facts?.goals as string[]) ?? [],
        briefing_type: isFull ? "full" : "short",
      };
      await appendEvent(
        createSwarmEvent("status_card", cardPayload, { source: "status_agent" }) as unknown as Record<string, unknown>,
      );
      return { type: "status_card", ...cardPayload };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/timeout|ECONNREFUSED|API|fetch failed/i.test(msg)) {
        logger.warn("Mastra/OpenAI unreachable, falling back to raw status card", { error: msg });
      } else {
        throw err;
      }
    }
  }

  const factsRaw = await s3GetText(s3, bucket, "facts/latest.json");
  const facts = factsRaw ? (JSON.parse(factsRaw) as Record<string, unknown>) : null;
  const drift = await loadDrift(s3, bucket);
  const cardPayload = {
    ts: new Date().toISOString(),
    drift_level: drift?.level ?? "unknown",
    drift_types: drift?.types ?? [],
    confidence: facts?.confidence ?? null,
    goals: (facts?.goals as string[]) ?? [],
    notes: drift?.notes ?? [],
  };
  await appendEvent(
    createSwarmEvent("status_card", cardPayload, { source: "status_agent" }) as unknown as Record<string, unknown>,
  );
  return { type: "status_card", ...cardPayload };
}
