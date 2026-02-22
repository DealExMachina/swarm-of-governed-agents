import { join } from "path";
import type { S3Client } from "@aws-sdk/client-s3";
import { Agent } from "@mastra/core/agent";
import { getChatModelConfig } from "../modelConfig.js";
import { logger } from "../logger.js";
import { s3GetText } from "../s3.js";
import { loadPolicies, getGovernanceForScope, evaluateRules } from "../governance.js";
import { makeReadDriftTool, makeReadFactsTool, makeReadGovernanceRulesTool } from "./sharedTools.js";

const GOVERNANCE_PATH = process.env.GOVERNANCE_PATH ?? join(process.cwd(), "governance.yaml");

const PLANNER_INSTRUCTIONS = `You are a governance-aware planning agent. Given drift analysis, current facts, and governance rules, determine what actions to take.
Use the tools: readDrift, readFacts, readGovernanceRules. Respect governance constraints. Prioritize by severity.
Reply with a JSON object: { "actions": ["action1", "action2"], "reasoning": "brief explanation" }.`;

/**
 * Run planner: LLM-powered when OPENAI_API_KEY set, else rule-based evaluateRules.
 */
export async function runPlannerAgent(
  s3: S3Client,
  bucket: string,
  _payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const modelConfig = getChatModelConfig();
  if (modelConfig) {
    try {
      const readDrift = makeReadDriftTool(s3, bucket);
      const readFacts = makeReadFactsTool(s3, bucket);
      const readGovernanceRules = makeReadGovernanceRulesTool();
      const agent = new Agent({
        id: "planner-agent",
        name: "Planner Agent",
        instructions: PLANNER_INSTRUCTIONS,
        model: modelConfig,
        tools: { readDrift, readFacts, readGovernanceRules },
      });
      const result = await agent.generate(
        "Read drift, facts, and governance rules. Decide recommended actions and return JSON with actions array and reasoning.",
        { maxSteps: 8 },
      );
      const text = result?.text ?? "";
      let actions: string[] = [];
      let reasoning = "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as { actions?: string[]; reasoning?: string };
          actions = Array.isArray(parsed.actions) ? parsed.actions : [];
          reasoning = String(parsed.reasoning ?? "");
        } catch {
          actions = [];
        }
      }
      const driftRaw = await s3GetText(s3, bucket, "drift/latest.json");
      const drift = driftRaw
        ? (JSON.parse(driftRaw) as { level: string; types: string[] })
        : { level: "none", types: [] as string[] };
      return { drift: { level: drift.level, types: drift.types }, actions, reasoning };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/timeout|ECONNREFUSED|API|fetch failed/i.test(msg)) {
        logger.warn("Mastra/OpenAI unreachable, falling back to rule-based planner", { error: msg });
      } else {
        throw err;
      }
    }
  }

  const driftRaw = await s3GetText(s3, bucket, "drift/latest.json");
  const drift = driftRaw
    ? (JSON.parse(driftRaw) as { level: string; types: string[] })
    : { level: "none", types: [] as string[] };
  const scopeId = process.env.SCOPE_ID ?? "default";
  const config = getGovernanceForScope(scopeId, loadPolicies(GOVERNANCE_PATH));
  const actions = evaluateRules(drift, config);
  return { drift: { level: drift.level, types: drift.types }, actions };
}
