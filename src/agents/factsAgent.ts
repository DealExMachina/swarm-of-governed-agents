import type { S3Client } from "@aws-sdk/client-s3";
import { createTool } from "@mastra/core/tools";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { logger } from "../logger.js";
import { toErrorString } from "../errors.js";
import { s3GetText, s3PutJson } from "../s3.js";
import { tailEvents } from "../contextWal.js";

/** Default 5 min: local LLM (e.g. Ollama) can take several minutes per document; avoid client abort before worker finishes. */
const FACTS_WORKER_TIMEOUT_MS = Math.max(
  15000,
  parseInt(process.env.FACTS_WORKER_TIMEOUT_MS ?? "300000", 10) || 300000,
);

function getFactsWorkerUrl(): string {
  const url = process.env.FACTS_WORKER_URL;
  if (!url) throw new Error("FACTS_WORKER_URL is required for facts agent");
  return url;
}
const KEY_FACTS = "facts/latest.json";
const KEY_DRIFT = "drift/latest.json";
const KEY_FACTS_HIST = (ts: string) => `facts/history/${ts.replace(/[:.]/g, "-")}.json`;

export type LastFactsResult = { wrote: string[]; facts_hash?: string } | null;

function createFactsTools(
  s3: S3Client,
  bucket: string,
  lastWriteResult: { current: LastFactsResult },
) {
  const readContextTool = createTool({
    id: "readContext",
    description: "Read the latest context events from the WAL and previous facts from storage.",
    inputSchema: z.object({
      limit: z.number().optional().default(200),
    }),
    outputSchema: z.object({
      context: z.array(z.record(z.unknown())),
      previous_facts: z.record(z.unknown()).nullable(),
    }),
    execute: async ({ context }) => {
      const limit = context.limit ?? 200;
      const events = await tailEvents(limit);
      const contextData = events.map((e) => e.data);
      const prevRaw = await s3GetText(s3, bucket, KEY_FACTS);
      const previous_facts = prevRaw ? (JSON.parse(prevRaw) as Record<string, unknown>) : null;
      return { context: contextData, previous_facts };
    },
  });

  const extractFactsTool = createTool({
    id: "extractFacts",
    description: "Call the facts-worker to extract structured facts and drift from context and previous facts.",
    inputSchema: z.object({
      context: z.array(z.record(z.unknown())),
      previous_facts: z.record(z.unknown()).nullable(),
    }),
    outputSchema: z.object({
      facts: z.record(z.unknown()),
      drift: z.record(z.unknown()),
    }),
    execute: async ({ context }) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FACTS_WORKER_TIMEOUT_MS);
      try {
        const resp = await fetch(`${getFactsWorkerUrl()}/extract`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            context: context.context,
            previous_facts: context.previous_facts,
          }),
          signal: controller.signal,
        });
        if (!resp.ok) throw new Error(await resp.text());
        return (await resp.json()) as { facts: Record<string, unknown>; drift: Record<string, unknown> };
      } finally {
        clearTimeout(timeoutId);
      }
    },
  });

  const writeFactsTool = createTool({
    id: "writeFacts",
    description: "Write extracted facts and drift to storage (S3) and sync facts to the semantic graph.",
    inputSchema: z.object({
      facts: z.record(z.unknown()),
      drift: z.record(z.unknown()),
    }),
    outputSchema: z.object({
      wrote: z.array(z.string()),
      facts_hash: z.string().optional(),
    }),
    execute: async ({ context }) => {
      const ts = new Date().toISOString();
      await s3PutJson(s3, bucket, KEY_FACTS, context.facts);
      await s3PutJson(s3, bucket, KEY_DRIFT, context.drift);
      await s3PutJson(s3, bucket, KEY_FACTS_HIST(ts), context.facts);
      const wrote = [KEY_FACTS, KEY_DRIFT, KEY_FACTS_HIST(ts)];
      const facts_hash = (context.facts as { hash?: string })?.hash;
      lastWriteResult.current = { wrote, facts_hash };

      const scopeId = process.env.SCOPE_ID ?? "default";
      try {
        const factsPayload = JSON.parse(JSON.stringify(context.facts ?? {})) as Record<string, unknown>;
        const { syncFactsToSemanticGraph } = await import("../factsToSemanticGraph.js");
        await syncFactsToSemanticGraph(scopeId, factsPayload, {
          embedClaims: process.env.FACTS_SYNC_EMBED === "1",
        });
      } catch (e) {
        logger.warn("writeFacts: semantic graph sync failed", { scopeId, error: toErrorString(e) });
      }

      return { wrote, facts_hash };
    },
  });

  return { readContextTool, extractFactsTool, writeFactsTool };
}

import { getChatModelConfig, type ChatModelConfig } from "../modelConfig.js";

/**
 * Returns a Mastra-safe model config (chat/completions path).
 * Delegates to the shared getChatModelConfig. Falls back to a bare string
 * when OPENAI_API_KEY is not set (e.g. tests).
 */
export function getFactsModelConfig(): ChatModelConfig | string {
  return getChatModelConfig() ?? "openai/gpt-4o-mini";
}

export function createFactsMastraAgent(
  s3: S3Client,
  bucket: string,
  model?: string | { id: `${string}/${string}`; url?: string; apiKey?: string },
): { agent: Agent; getLastResult: () => LastFactsResult } {
  const lastWriteResult: { current: LastFactsResult } = { current: null };
  const { readContextTool, extractFactsTool, writeFactsTool } = createFactsTools(s3, bucket, lastWriteResult);
  const modelConfig = model ?? getFactsModelConfig();

  const agent = new Agent({
    id: "facts-agent",
    name: "Facts Agent",
    instructions: `You are a facts extraction agent. Your task is to extract structured facts from the current context and persist them.
1. Use readContext to get the latest context events and previous facts from storage.
2. Use extractFacts with that context and previous_facts to get new facts and drift from the worker.
3. Use writeFacts with the returned facts and drift to persist them.
Always perform these steps in order: readContext, then extractFacts, then writeFacts.`,
    model: modelConfig,
    tools: {
      readContext: readContextTool,
      extractFacts: extractFactsTool,
      writeFacts: writeFactsTool,
    },
  });

  return {
    agent,
    getLastResult: () => lastWriteResult.current,
  };
}

/** Run the three tools in sequence without the LLM. Used when OPENAI_API_KEY is unset (e.g. tests). */
export async function runFactsPipelineDirect(
  s3: S3Client,
  bucket: string,
): Promise<Record<string, unknown>> {
  const lastWriteResult: { current: LastFactsResult } = { current: null };
  const { readContextTool, extractFactsTool, writeFactsTool } = createFactsTools(s3, bucket, lastWriteResult);
  const opts = {};
  type ExecTool = { execute?: (ctx: { context: unknown }, o: unknown) => Promise<unknown> };
  const exec = async (tool: ExecTool, ctx: unknown) => {
    if (!tool.execute) throw new Error("tool has no execute");
    return tool.execute({ context: ctx }, opts);
  };
  const r1 = await exec(readContextTool as unknown as ExecTool, { limit: 200 });
  const r2 = await exec(extractFactsTool as unknown as ExecTool, r1);
  await exec(writeFactsTool as unknown as ExecTool, r2);
  const last = lastWriteResult.current;
  return {
    wrote: Array.isArray(last?.wrote) ? [...last.wrote] : [],
    facts_hash: typeof last?.facts_hash === "string" ? last.facts_hash : undefined,
  };
}

/**
 * Run the facts extraction pipeline.
 *
 * Default path: direct pipeline (readContext -> worker /extract -> writeFacts).
 * The actual LLM work happens inside the Python facts-worker (OpenAI SDK),
 * which uses OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL to call
 * chat/completions directly. No second LLM call is needed on the TypeScript
 * side for orchestration since the tool sequence is deterministic.
 *
 * Opt-in: set FACTS_USE_MASTRA=1 to route through a Mastra LLM Agent that
 * orchestrates the same three tools via an OpenAI chat model. Useful when
 * experimenting with agentic orchestration; the model config forces the
 * chat/completions path so Mastra never uses the Responses API.
 */
export async function runFactsAgent(
  s3: S3Client,
  bucket: string,
  _payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (process.env.FACTS_USE_MASTRA === "1" && process.env.OPENAI_API_KEY) {
    try {
      const { agent, getLastResult } = createFactsMastraAgent(s3, bucket);
      await agent.generate(
        "Extract structured facts from the current context and persist them using readContext, extractFacts, and writeFacts.",
        { maxSteps: 10 },
      );
      const last = getLastResult();
      return last ?? { wrote: [], facts_hash: undefined };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/timeout|ECONNREFUSED|API|fetch failed/i.test(msg)) {
        logger.warn("Mastra/OpenAI unreachable, falling back to direct pipeline", { error: msg });
      } else {
        throw err;
      }
    }
  }
  return runFactsPipelineDirect(s3, bucket);
}
