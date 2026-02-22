import type { Node } from "./stateGraph.js";

export type AgentRole = "facts" | "drift" | "planner" | "status" | "tuner";

/** Legacy job type for executor and backward compatibility. */
export type JobType = "extract_facts" | "check_drift" | "plan_actions" | "summarize_status" | "optimize_filters";

export interface AgentSpec {
  role: AgentRole;
  capabilities: string[];
  /** Legacy: job type for old swarm loop and executor. */
  jobType: JobType;
  /** Legacy: node that must be current for this agent to run (old loop). Null = no gate. */
  requiresNode: Node | null;
  /** Node this agent writes to (for OpenFGA self-check: writer on node) */
  targetNode: Node;
  /** Whether completing this agent's work emits a state advance proposal */
  proposesAdvance: boolean;
  /** Target node for the proposal when proposesAdvance is true */
  advancesTo: Node | null;
  /** Event type published when agent completes (e.g. facts_extracted) */
  resultEventType: string;
}

export const AGENT_SPECS: AgentSpec[] = [
  {
    role: "facts",
    capabilities: ["extract_facts"],
    jobType: "extract_facts",
    requiresNode: "ContextIngested",
    targetNode: "FactsExtracted",
    proposesAdvance: true,
    advancesTo: "FactsExtracted",
    resultEventType: "facts_extracted",
  },
  {
    role: "drift",
    capabilities: ["analyze_drift"],
    jobType: "check_drift",
    requiresNode: "FactsExtracted",
    targetNode: "DriftChecked",
    proposesAdvance: true,
    advancesTo: "DriftChecked",
    resultEventType: "drift_analyzed",
  },
  {
    role: "planner",
    capabilities: ["plan_actions"],
    jobType: "plan_actions",
    requiresNode: "DriftChecked",
    targetNode: "ContextIngested",
    proposesAdvance: true,
    advancesTo: "ContextIngested",
    resultEventType: "actions_planned",
  },
  {
    role: "status",
    capabilities: ["summarize_status", "briefing"],
    jobType: "summarize_status",
    requiresNode: null,
    targetNode: "ContextIngested",
    proposesAdvance: false,
    advancesTo: null,
    resultEventType: "status_briefing",
  },
  {
    role: "tuner",
    capabilities: ["optimize_filters"],
    jobType: "optimize_filters",
    requiresNode: null,
    targetNode: "ContextIngested",
    proposesAdvance: false,
    advancesTo: null,
    resultEventType: "filters_optimized",
  },
];

export function getSpec(role: string): AgentSpec | undefined {
  return AGENT_SPECS.find((s) => s.role === role);
}

/** Which job to publish after advancing to this node (executor backward compat). */
export function getNextJobForNode(node: Node): JobType | null {
  const map: Record<Node, JobType | null> = {
    ContextIngested: "extract_facts",
    FactsExtracted: "check_drift",
    DriftChecked: "plan_actions",
  };
  return map[node] ?? null;
}
