import type { S3Client } from "@aws-sdk/client-s3";
import { createTool } from "@mastra/core/tools";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { toErrorString } from "../errors.js";
import { getChatModelConfig } from "../modelConfig.js";
import { logger } from "../logger.js";
import {
  loadAllFilterConfigs,
  saveFilterConfig,
  snapshotFilterToS3,
  type FilterConfig,
} from "../activationFilters.js";

const TUNER_INSTRUCTIONS = `You are a system optimizer. Review the activation statistics for each agent's filter.
For each filter, analyze the productive/wasted ratio, average latency, and activation frequency.
Recommend parameter adjustments to maximize productive activations and minimize waste.
Use readFilterStats to load current configs, then use writeFilterConfig to apply changes for each agent you want to tune.
Explain your reasoning.`;

function makeReadFilterStatsTool() {
  return createTool({
    id: "readFilterStats",
    description: "Load all filter configs and their activation statistics from the database.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      configs: z.array(z.record(z.unknown())),
    }),
    execute: async () => {
      const configs = await loadAllFilterConfigs();
      return { configs: configs as unknown as Record<string, unknown>[] };
    },
  });
}

function makeWriteFilterConfigTool(s3: S3Client, bucket: string) {
  return createTool({
    id: "writeFilterConfig",
    description: "Update a filter's parameters, bump version, and snapshot to S3. Pass agentRole and the new params.",
    inputSchema: z.object({
      agentRole: z.string(),
      params: z.record(z.union([z.number(), z.string(), z.boolean()])),
    }),
    outputSchema: z.object({
      updated: z.boolean(),
      version: z.number(),
      snapshotKey: z.string().optional(),
    }),
    execute: async (ctx) => {
      const input = (ctx as unknown) as { context?: { agentRole?: string; params?: Record<string, number | string | boolean> } };
      const agentRole = input?.context?.agentRole ?? "";
      const params = (input?.context?.params ?? {}) as Record<string, number | string | boolean>;
      if (!agentRole) return { updated: false, version: 0 };
      const configs = await loadAllFilterConfigs();
      const current = configs.find((c) => c.agentRole === agentRole);
      if (!current) return { updated: false, version: 0 };
      const updated: FilterConfig = {
        ...current,
        params: { ...current.params, ...params },
        version: current.version + 1,
        updatedBy: "tuner-agent",
        updatedAt: new Date().toISOString(),
      };
      await saveFilterConfig(updated);
      const snapshotKey = await snapshotFilterToS3(s3, bucket, updated);
      return { updated: true, version: updated.version, snapshotKey };
    },
  });
}

const TUNER_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Run one tuner cycle: LLM reads filter stats, reasons, and writes optimized configs.
 */
export async function runTunerCycle(
  s3: S3Client,
  bucket: string,
): Promise<Record<string, unknown>> {
  const modelConfig = getChatModelConfig();
  if (!modelConfig) {
    logger.info("tuner: no OPENAI_API_KEY, skipping cycle");
    return { skipped: true, reason: "no_api_key" };
  }
  try {
    const readFilterStats = makeReadFilterStatsTool();
    const writeFilterConfig = makeWriteFilterConfigTool(s3, bucket);
    const agent = new Agent({
      id: "tuner-agent",
      name: "Tuner Agent",
      instructions: TUNER_INSTRUCTIONS,
      model: modelConfig,
      tools: { readFilterStats, writeFilterConfig },
    });
    await agent.generate(
      "Review all filter statistics and apply parameter adjustments where they would reduce waste or improve responsiveness.",
      { maxSteps: 15 },
    );
    return { cycle: "ok", ts: new Date().toISOString() };
  } catch (err) {
    const msg = toErrorString(err);
    logger.error("tuner cycle failed", { error: msg });
    return { cycle: "error", error: msg };
  }
}

/**
 * Run the tuner agent loop: every ~30 min run a cycle, then publish filters_optimized event.
 */
export async function runTunerAgentLoop(
  s3: S3Client,
  bucket: string,
  publishEvent: (type: string, payload: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  logger.info("tuner agent started", { intervalMs: TUNER_INTERVAL_MS });
  const run = async () => {
    const result = await runTunerCycle(s3, bucket);
    await publishEvent("filters_optimized", result);
  };
  await run();
  setInterval(run, TUNER_INTERVAL_MS);
  await new Promise<void>(() => {});
}
