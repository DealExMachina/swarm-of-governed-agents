import type { S3Client } from "@aws-sdk/client-s3";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { s3GetText, s3ListKeys } from "../s3.js";
import { tailEvents } from "../contextWal.js";
import { loadPolicies, getGovernanceForScope } from "../governance.js";
import { join } from "path";

const KEY_FACTS = "facts/latest.json";
const KEY_DRIFT = "drift/latest.json";

/** Reference item in drift snapshot. */
export interface DriftReference {
  type?: string;
  doc?: string;
  excerpt?: string;
}

/** Parsed drift snapshot from drift/latest.json. */
export interface DriftSnapshot {
  level: string;
  types: string[];
  notes?: string[];
  references?: DriftReference[];
}

/** Load and parse drift from S3. Returns null if missing or invalid. */
export async function loadDrift(s3: S3Client, bucket: string): Promise<DriftSnapshot | null> {
  const raw = await s3GetText(s3, bucket, KEY_DRIFT);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { level?: string; types?: unknown; notes?: unknown; references?: unknown };
    const refs = Array.isArray(p.references)
      ? p.references.map((r: unknown) => {
          const x = r as Record<string, unknown>;
          return { type: x?.type != null ? String(x.type) : undefined, doc: x?.doc != null ? String(x.doc) : undefined, excerpt: x?.excerpt != null ? String(x.excerpt) : undefined };
        })
      : undefined;
    return {
      level: typeof p.level === "string" ? p.level : "none",
      types: Array.isArray(p.types) ? p.types.map(String) : [],
      notes: Array.isArray(p.notes) ? p.notes.map(String) : undefined,
      references: refs,
    };
  } catch {
    return null;
  }
}

/** Default drift when none exists. */
export const DRIFT_NONE: DriftSnapshot = { level: "none", types: [] };
const KEY_FACTS_HIST_PREFIX = "facts/history/";
const GOVERNANCE_PATH = process.env.GOVERNANCE_PATH ?? join(process.cwd(), "governance.yaml");

export function makeReadFactsTool(s3: S3Client, bucket: string) {
  return createTool({
    id: "readFacts",
    description: "Read the current structured facts from storage (facts/latest.json).",
    inputSchema: z.object({}),
    outputSchema: z.object({
      facts: z.record(z.unknown()).nullable(),
    }),
    execute: async () => {
      const raw = await s3GetText(s3, bucket, KEY_FACTS);
      const facts = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      return { facts };
    },
  });
}

export function makeReadDriftTool(s3: S3Client, bucket: string) {
  return createTool({
    id: "readDrift",
    description: "Read the current drift analysis from storage (drift/latest.json).",
    inputSchema: z.object({}),
    outputSchema: z.object({
      drift: z.record(z.unknown()).nullable(),
    }),
    execute: async () => {
      const snapshot = await loadDrift(s3, bucket);
      const drift = snapshot
        ? { level: snapshot.level, types: snapshot.types, ...(snapshot.notes && { notes: snapshot.notes }), ...(snapshot.references && { references: snapshot.references }) }
        : null;
      return { drift };
    },
  });
}

export function makeReadContextTool(limitDefault: number = 200) {
  return createTool({
    id: "readContext",
    description: "Read the latest context events from the WAL (recent events that form the shared context).",
    inputSchema: z.object({
      limit: z.number().optional().default(limitDefault),
    }),
    outputSchema: z.object({
      context: z.array(z.record(z.unknown())),
    }),
    execute: async (input) => {
      const limit = (input as { limit?: number })?.limit ?? limitDefault;
      const events = await tailEvents(limit);
      const context = events.map((e) => e.data);
      return { context };
    },
  });
}

export function makeReadFactsHistoryTool(s3: S3Client, bucket: string, maxKeys: number = 20) {
  return createTool({
    id: "readFactsHistory",
    description: "Read recent facts snapshots from history for comparison (facts/history/*.json).",
    inputSchema: z.object({
      maxKeys: z.number().optional().default(maxKeys),
    }),
    outputSchema: z.object({
      history: z.array(z.record(z.unknown())),
    }),
    execute: async (input) => {
      const n = (input as { maxKeys?: number })?.maxKeys ?? maxKeys;
      const keys = await s3ListKeys(s3, bucket, KEY_FACTS_HIST_PREFIX, n);
      const sorted = keys.sort().reverse().slice(0, n);
      const history: Record<string, unknown>[] = [];
      for (const key of sorted) {
        const raw = await s3GetText(s3, bucket, key);
        if (raw) history.push(JSON.parse(raw) as Record<string, unknown>);
      }
      return { history };
    },
  });
}

export function makeReadGovernanceRulesTool() {
  return createTool({
    id: "readGovernanceRules",
    description: "Read the governance rules and transition rules from governance.yaml.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      rules: z.array(z.record(z.unknown())),
      transition_rules: z.array(z.record(z.unknown())),
    }),
    execute: async () => {
      const scopeId = process.env.SCOPE_ID ?? "default";
      const config = getGovernanceForScope(scopeId, loadPolicies(GOVERNANCE_PATH));
      return {
        rules: (config.rules ?? []) as unknown as Record<string, unknown>[],
        transition_rules: (config.transition_rules ?? []) as unknown as Record<string, unknown>[],
      };
    },
  });
}
