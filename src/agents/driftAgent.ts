import type { S3Client } from "@aws-sdk/client-s3";
import { createTool } from "@mastra/core/tools";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { setMaxListeners } from "events";
import { getChatModelConfig } from "../modelConfig.js";
import { logger } from "../logger.js";
import { s3GetText, s3PutJson } from "../s3.js";
import { makeReadFactsTool, makeReadFactsHistoryTool, makeReadDriftTool } from "./sharedTools.js";

const DRIFT_LLM_TIMEOUT_MS = 90_000;

const KEY_DRIFT = "drift/latest.json";
const KEY_DRIFT_HIST = (ts: string) => `drift/history/${ts.replace(/[:.]/g, "-")}.json`;

const DRIFT_INSTRUCTIONS = `You are a drift analysis agent. Your job is to detect ALL forms of drift and contradiction.

Step 1 — Temporal drift: Compare current facts against historical facts. If history exists and differs, identify what changed: factual contradictions, goal shifts, confidence degradation, emerging risks.

Step 2 — Intra-batch drift: Even if there is no history or history matches current, analyze the current facts for INTERNAL inconsistencies. Look for claims that contradict each other (e.g. one claim says ARR is 50M while another says 38M), goals that conflict with identified risks, or facts from different sources that disagree. This is critical when multiple documents are ingested at once.

Step 3 — Consider resolutions: If contradictions have been addressed by human resolutions (e.g. "ARR confirmed at 38M"), the contradiction is resolved and should NOT count as drift. Only count contradictions that remain genuinely unresolved.

Step 4 — Classify: drift level (none, low, medium, high) and types (factual, goal, contradiction, entropy). If contradictions exist but have been resolved by human input, drift should decrease. If ALL contradictions are resolved, remove "contradiction" from types. Provide brief reasoning and cite sources with references (type, doc, excerpt).

Use tools: readFacts, readFactsHistory, readCurrentDrift, then writeDrift with your analysis.`;

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
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), DRIFT_LLM_TIMEOUT_MS);
      setMaxListeners(64, abortController.signal);
      try {
        await agent.generate(
          "Analyze drift: read current facts and history, compare them, then write your drift analysis using writeDrift.",
          { maxSteps: 10, abortSignal: abortController.signal },
        );
      } finally {
        clearTimeout(timeoutId);
      }
      const driftRaw = await s3GetText(s3, bucket, KEY_DRIFT);
      const drift = driftRaw ? (JSON.parse(driftRaw) as { level: string; types: string[] }) : { level: "none", types: [] };
      return { wrote: [KEY_DRIFT], level: drift.level, types: drift.types };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/timeout|TIMEOUT|ECONNREFUSED|API|fetch failed|abort/i.test(msg)) {
        logger.warn("Mastra/OpenAI unreachable or timed out, falling back to direct drift archive", { error: msg });
      } else {
        throw err;
      }
    }
  }

  const factsRaw = await s3GetText(s3, bucket, "facts/latest.json");
  const facts = factsRaw ? (JSON.parse(factsRaw) as Record<string, unknown>) : null;

  const intraBatch = detectIntraBatchDrift(facts);
  const graphState = await getGraphResolutionState();

  const driftRaw = await s3GetText(s3, bucket, KEY_DRIFT);
  const existing = driftRaw
    ? (JSON.parse(driftRaw) as { level: string; types: string[]; notes?: string[] })
    : null;

  const base = intraBatch.hasContradictions
    ? {
        level: intraBatch.level,
        types: intraBatch.types,
        notes: intraBatch.notes,
        references: intraBatch.references,
      }
    : existing
      ? { level: existing.level, types: existing.types, notes: existing.notes ?? [], references: undefined }
      : { level: "none", types: [] as string[], notes: ["no drift yet"], references: undefined };
  let drift: { level: string; types: string[]; notes: string[]; references?: Array<{ type: string; doc?: string; excerpt?: string }> } = {
    level: base.level, types: base.types, notes: base.notes, references: base.references as Array<{ type: string; doc?: string; excerpt?: string }> | undefined,
  };

  drift = adjustDriftForResolutions(drift, graphState);

  const ts = new Date().toISOString();
  await s3PutJson(s3, bucket, KEY_DRIFT, drift);
  await s3PutJson(s3, bucket, KEY_DRIFT_HIST(ts), drift);
  return { wrote: [KEY_DRIFT, KEY_DRIFT_HIST(ts)], level: drift.level, types: drift.types };
}

interface GraphResolutionState {
  contradictionsTotal: number;
  contradictionsResolved: number;
  goalsTotal: number;
  goalsResolved: number;
  goalsInProgress: number;
}

async function getGraphResolutionState(): Promise<GraphResolutionState> {
  try {
    const { getPool } = await import("../db.js");
    const p = getPool();
    const scopeId = process.env.SCOPE_ID ?? "default";
    const contraRes = await p.query(
      `SELECT
         COUNT(*) FILTER (WHERE type = 'contradiction')::int AS total,
         COUNT(*) FILTER (WHERE type = 'contradiction' AND status != 'active')::int AS resolved
       FROM nodes WHERE scope_id = $1 AND superseded_at IS NULL`,
      [scopeId],
    );
    const goalRes = await p.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved,
         COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress
       FROM nodes WHERE scope_id = $1 AND type = 'goal' AND superseded_at IS NULL`,
      [scopeId],
    );
    const cr = contraRes.rows[0] ?? {};
    const gr = goalRes.rows[0] ?? {};
    return {
      contradictionsTotal: Number(cr.total ?? 0),
      contradictionsResolved: Number(cr.resolved ?? 0),
      goalsTotal: Number(gr.total ?? 0),
      goalsResolved: Number(gr.resolved ?? 0),
      goalsInProgress: Number(gr.in_progress ?? 0),
    };
  } catch {
    return { contradictionsTotal: 0, contradictionsResolved: 0, goalsTotal: 0, goalsResolved: 0, goalsInProgress: 0 };
  }
}

/**
 * Adjust drift level based on what's been resolved in the semantic graph.
 * If contradictions are resolved, remove "contradiction" type and lower drift.
 * If goals are progressing, remove "goal" type.
 */
function adjustDriftForResolutions(
  drift: { level: string; types: string[]; notes: string[]; references?: Array<{ type: string; doc?: string; excerpt?: string }> },
  graph: GraphResolutionState,
): typeof drift {
  const types = [...drift.types];
  const notes = [...drift.notes];

  const allContrasResolved = graph.contradictionsTotal > 0 && graph.contradictionsResolved >= graph.contradictionsTotal;
  if (allContrasResolved && types.includes("contradiction")) {
    types.splice(types.indexOf("contradiction"), 1);
    notes.push(`All ${graph.contradictionsTotal} contradiction(s) resolved in the knowledge graph`);
  }

  const goalProgress = graph.goalsTotal > 0
    ? (graph.goalsResolved + graph.goalsInProgress) / graph.goalsTotal
    : 0;
  if (goalProgress >= 0.5 && types.includes("goal")) {
    types.splice(types.indexOf("goal"), 1);
    notes.push(`Goals progressing: ${graph.goalsResolved} resolved, ${graph.goalsInProgress} in progress out of ${graph.goalsTotal}`);
  }

  let level = drift.level;
  if (types.length === 0) {
    level = "none";
  } else if (types.length === 1 && !types.includes("contradiction")) {
    level = level === "high" ? "medium" : level;
  } else if (allContrasResolved && level === "high") {
    level = "medium";
  }

  return { ...drift, level, types, notes };
}

/**
 * Detect contradictions within a single fact set (intra-batch drift).
 * Used when all documents are ingested at once and there's no prior baseline.
 */
function detectIntraBatchDrift(facts: Record<string, unknown> | null): {
  hasContradictions: boolean;
  level: string;
  types: string[];
  notes: string[];
  references: Array<{ type: string; doc?: string; excerpt?: string }>;
} {
  if (!facts) return { hasContradictions: false, level: "none", types: [], notes: [], references: [] };

  const claims = Array.isArray(facts.claims) ? facts.claims.filter((c): c is string => typeof c === "string") : [];
  const contradictions = Array.isArray(facts.contradictions) ? facts.contradictions.filter((c): c is string => typeof c === "string") : [];
  const risks = Array.isArray(facts.risks) ? facts.risks.filter((r): r is string => typeof r === "string") : [];
  const goals = Array.isArray(facts.goals) ? facts.goals.filter((g): g is string => typeof g === "string") : [];

  const notes: string[] = [];
  const references: Array<{ type: string; doc?: string; excerpt?: string }> = [];
  const types = new Set<string>();

  if (contradictions.length > 0) {
    types.add("contradiction");
    notes.push(`${contradictions.length} contradiction(s) detected within the current facts`);
    for (const c of contradictions) {
      references.push({ type: "contradiction", excerpt: c.slice(0, 200) });
    }
  }

  const numericClaims = claims.filter(c => /\d/.test(c));
  for (let i = 0; i < numericClaims.length; i++) {
    for (let j = i + 1; j < numericClaims.length; j++) {
      const shared = findSharedEntity(numericClaims[i], numericClaims[j]);
      if (shared) {
        const nums1 = extractNumbers(numericClaims[i]);
        const nums2 = extractNumbers(numericClaims[j]);
        for (const n1 of nums1) {
          for (const n2 of nums2) {
            if (n1 !== n2 && Math.abs(n1 - n2) / Math.max(n1, n2) > 0.1) {
              types.add("factual");
              const note = `Numeric discrepancy for "${shared}": ${n1} vs ${n2}`;
              if (!notes.includes(note)) {
                notes.push(note);
                references.push({ type: "factual", excerpt: `"${numericClaims[i].slice(0, 80)}" vs "${numericClaims[j].slice(0, 80)}"` });
              }
            }
          }
        }
      }
    }
  }

  if (risks.length >= 3) {
    types.add("entropy");
    notes.push(`High risk density: ${risks.length} risks identified across the fact set`);
  }

  if (goals.length > 0 && risks.length > 0) {
    types.add("goal");
    notes.push(`${goals.length} goal(s) coexist with ${risks.length} risk(s) that may impede them`);
  }

  const hasContradictions = notes.length > 0;
  const typesArr = [...types];
  const level = contradictions.length > 0 || typesArr.length >= 3
    ? "high"
    : typesArr.length >= 2
      ? "medium"
      : hasContradictions
        ? "low"
        : "none";

  if (hasContradictions) {
    notes.unshift("automatic structured drift detection");
  }

  return { hasContradictions, level, types: typesArr, notes, references };
}

function findSharedEntity(a: string, b: string): string | null {
  const wordsA = a.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const stopWords = new Set(["that", "this", "with", "from", "have", "been", "were", "will", "about", "into", "than", "also", "their", "which"]);
  for (const w of wordsA) {
    if (wordsB.has(w) && !stopWords.has(w)) return w;
  }
  return null;
}

function extractNumbers(s: string): number[] {
  const matches = s.match(/[\d,.]+/g) ?? [];
  return matches
    .map(m => parseFloat(m.replace(/,/g, "")))
    .filter(n => Number.isFinite(n) && n > 0);
}
