import type { Node } from "./stateGraph.js";

export type JobType = "extract_facts" | "check_drift" | "plan_actions" | "summarize_status";

export interface AgentSpec {
  role: string;
  jobType: JobType;
  requiresNode: Node | null;
  advancesTo: Node | null;
}

export const AGENT_SPECS: AgentSpec[] = [
  { role: "facts",   jobType: "extract_facts",   requiresNode: "ContextIngested", advancesTo: "FactsExtracted" },
  { role: "drift",   jobType: "check_drift",     requiresNode: "FactsExtracted",  advancesTo: "DriftChecked" },
  { role: "planner", jobType: "plan_actions",     requiresNode: "DriftChecked",    advancesTo: "ContextIngested" },
  { role: "status",  jobType: "summarize_status", requiresNode: null,              advancesTo: null },
];

export function getSpec(role: string): AgentSpec | undefined {
  return AGENT_SPECS.find((s) => s.role === role);
}
