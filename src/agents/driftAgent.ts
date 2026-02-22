import type { S3Client } from "@aws-sdk/client-s3";
import { createTool } from "@mastra/core/tools";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { getChatModelConfig } from "../modelConfig.js";
import { logger } from "../logger.js";
import { s3GetText, s3PutJson } from "../s3.js";
import { makeReadFactsTool, makeReadFactsHistoryTool, makeReadDriftTool } from "./sharedTools.js";

const KEY_DRIFT = "drift/latest.json";
const KEY_DRIFT_HIST = (ts: string) => `drift/history/${ts.replace(/[:.]/g, "-")}.json`;

const DRIFT_INSTRUCTIONS = `You are a drift analysis agent. Compare current facts against historical facts.
Identify contradictions, goal shifts, confidence degradation, and emerging risks.
Classify drift level (none, low, medium, high) and types (factual, goal, contradiction, entropy).
Provide brief reasoning for each finding. When explaining a drift or discrepancy, always cite sources and references: which document or fact supports the finding, and a short excerpt or quote where relevant. Use the writeDrift tool with notes/reasoning and a references array (each item: type, optional doc, optional excerpt). Use the tools: readFacts, readFactsHistory, readCurrentDrift, then writeDrift with your analysis.`;

const driftRefSchema = z.object({
  type: z.string(),
  doc: z.string().optional(),
  excerpt: z.string().optional(),
});

function createWriteDriftTool(s3: S3Client, bucket: string) {
  return createTool({
    id: "writeDrift",
    description: "Write drift analysis to storage (drift/latest.json and drift/history). Include references (sources) with type, doc, excerpt when citing a drift finding.",
    inputSchema: z.object({
      level: z.enum(["none", "low", "medium", "high"]),
      types: z.array(z.string()),
      notes: z.array(z.string()).optional(),
      reasoning: z.string().optional(),
      references: z.array(driftRefSchema).optional(),
    }),
    outputSchema: z.object({
      wrote: z.array(z.string()),
    }),
    execute: async (ctx) => {
      const input = ((ctx as unknown) as { context?: Record<string, unknown> })?.context ?? (ctx as unknown) as Record<string, unknown>;
      const level = String(input.level ?? "none");
      const types = Array.isArray(input.types) ? input.types.map(String) : [];
      const notes = Array.isArray(input.notes) ? input.notes.map(String) : [];
      const reasoning = typeof input.reasoning === "string" ? input.reasoning : undefined;
      const rawRefs = input.references;
      const references = Array.isArray(rawRefs)
        ? rawRefs.map((r: unknown) => {
            const x = r as Record<string, unknown>;
            return {
              type: String(x?.type ?? ""),
              doc: x?.doc != null ? String(x.doc) : undefined,
              excerpt: x?.excerpt != null ? String(x.excerpt) : undefined,
            };
          })
        : [];
      const drift = { level, types, notes: reasoning ? [...notes, reasoning] : notes, references };
      const ts = new Date().toISOString();
      await s3PutJson(s3, bucket, KEY_DRIFT, drift);
      await s3PutJson(s3, bucket, KEY_DRIFT_HIST(ts), drift);
      return { wrote: [KEY_DRIFT, KEY_DRIFT_HIST(ts)] };
    },
  });
}

/**
 * Run drift agent: LLM-powered semantic analysis when OPENAI_API_KEY is set, else direct archive.
 */
export async function runDriftAgent(
  s3: S3Client,
  bucket: string,
  _payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const modelConfig = getChatModelConfig();
  if (modelConfig) {
    try {
      const readFacts = makeReadFactsTool(s3, bucket);
      const readFactsHistory = makeReadFactsHistoryTool(s3, bucket);
      const readDrift = makeReadDriftTool(s3, bucket);
      const writeDrift = createWriteDriftTool(s3, bucket);
      const agent = new Agent({
        id: "drift-agent",
        name: "Drift Agent",
        instructions: DRIFT_INSTRUCTIONS,
        model: modelConfig,
        tools: {
          readFacts,
          readFactsHistory,
          readCurrentDrift: readDrift,
          writeDrift,
        },
      });
      await agent.generate(
        "Analyze drift: read current facts and history, compare them, then write your drift analysis using writeDrift.",
        { maxSteps: 10 },
      );
      const driftRaw = await s3GetText(s3, bucket, KEY_DRIFT);
      const drift = driftRaw ? (JSON.parse(driftRaw) as { level: string; types: string[] }) : { level: "none", types: [] };
      return { wrote: [KEY_DRIFT], level: drift.level, types: drift.types };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/timeout|ECONNREFUSED|API|fetch failed/i.test(msg)) {
        logger.warn("Mastra/OpenAI unreachable, falling back to direct drift archive", { error: msg });
      } else {
        throw err;
      }
    }
  }

  const driftRaw = await s3GetText(s3, bucket, KEY_DRIFT);
  const drift = driftRaw
    ? (JSON.parse(driftRaw) as { level: string; types: string[]; notes?: string[] })
    : { level: "none", types: [] as string[], notes: ["no drift yet"] };
  const ts = new Date().toISOString();
  await s3PutJson(s3, bucket, KEY_DRIFT_HIST(ts), drift);
  return { wrote: [KEY_DRIFT_HIST(ts)], level: drift.level, types: drift.types };
}
