/**
 * Canonical HITL seed scenario data. Used by scripts/seed-hitl-scenario.ts and
 * unit tests to validate fixture shape.
 *
 * Node counts: 5 claims + 5 goals + 2 risks = 12 nodes.
 * Edges: 2 contradicts + 1 resolves = 3 edges. One contradiction remains unresolved.
 */

export const HITL_SCOPE_ID = "default";
export const HITL_CREATED_BY = "seed-hitl-scenario";

export const CLAIMS = [
  "Budget is approved for Q4.",
  "Launch date is set to November 15.",
  "We will hire 15 engineers by year-end.",
  "SOC 2 audit is scheduled for November.",
  "Nexus APAC rollout is delayed by 2 weeks.",
] as const;

export const GOALS = [
  { content: "Complete Nexus rollout in APAC", status: "resolved" as const },
  { content: "Pass SOC 2 audit", status: "resolved" as const },
  { content: "Hire 15+ engineers by Dec 31", status: "resolved" as const },
  { content: "Close two enterprise logos", status: "resolved" as const },
  { content: "Achieve 50 Nexus deployments by end of 2025", status: "active" as const },
] as const;

export const RISKS = [
  "Talent market may delay hiring.",
  "APAC delay may shift revenue to Q1.",
] as const;

/** Contradiction edges: (source claim index, target claim index, metadata.raw). */
export const CONTRADICTION_EDGES = [
  { sourceIndex: 0, targetIndex: 2, raw: "Budget approved vs hire 15 (stretch)" },
  { sourceIndex: 1, targetIndex: 4, raw: "Launch Nov 15 vs APAC delayed" },
] as const;

/** Resolution edge: (source claim index, target claim index, note). */
export const RESOLUTION_EDGES = [
  { sourceIndex: 0, targetIndex: 2, note: "Resolution: budget supports 15 stretch target" },
] as const;

export const EXPECTED_NODE_COUNT = CLAIMS.length + GOALS.length + RISKS.length;
export const EXPECTED_EDGE_COUNT = CONTRADICTION_EDGES.length + RESOLUTION_EDGES.length;
