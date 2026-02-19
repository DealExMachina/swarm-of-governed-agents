/**
 * Swarm observability metrics via OpenTelemetry.
 * Requires initTelemetry() to have been called (NodeSDK sets global meter provider from env).
 */
import { getMeter } from "./telemetry.js";

let proposalCount: ReturnType<ReturnType<typeof getMeter>["createCounter"]> | null = null;
let policyViolationCount: ReturnType<ReturnType<typeof getMeter>["createCounter"]> | null = null;
let agentLatencyHistogram: ReturnType<ReturnType<typeof getMeter>["createHistogram"]> | null = null;
let taskResolutionTimeHistogram: ReturnType<ReturnType<typeof getMeter>["createHistogram"]> | null = null;
let taskCostCounter: ReturnType<ReturnType<typeof getMeter>["createCounter"]> | null = null;

function ensureInstruments() {
  const meter = getMeter();
  if (proposalCount == null) {
    proposalCount = meter.createCounter("swarm.proposal.count", {
      description: "Proposals by type and result",
      unit: "1",
    });
  }
  if (policyViolationCount == null) {
    policyViolationCount = meter.createCounter("swarm.policy.violation_count", {
      description: "Proposals rejected due to policy",
      unit: "1",
    });
  }
  if (agentLatencyHistogram == null) {
    agentLatencyHistogram = meter.createHistogram("swarm.agent.latency_ms", {
      description: "Agent run latency in milliseconds",
      unit: "ms",
    });
  }
  if (taskResolutionTimeHistogram == null) {
    taskResolutionTimeHistogram = meter.createHistogram("swarm.task.resolution_time_ms", {
      description: "Task resolution time in milliseconds",
      unit: "ms",
    });
  }
  if (taskCostCounter == null) {
    taskCostCounter = meter.createCounter("swarm.task.cost", {
      description: "Estimated cost of tasks (e.g. LLM)",
      unit: "1",
    });
  }
}

export function recordProposal(type: string, result: "approved" | "rejected" | "pending"): void {
  try {
    ensureInstruments();
    proposalCount?.add(1, { type, result });
  } catch {
    // no-op if meter provider not set
  }
}

export function recordPolicyViolation(): void {
  try {
    ensureInstruments();
    policyViolationCount?.add(1);
  } catch {
    // no-op
  }
}

export function recordAgentLatency(role: string, latencyMs: number): void {
  try {
    ensureInstruments();
    agentLatencyHistogram?.record(latencyMs, { role });
  } catch {
    // no-op
  }
}

export function recordTaskResolutionTimeMs(ms: number): void {
  try {
    ensureInstruments();
    taskResolutionTimeHistogram?.record(ms);
  } catch {
    // no-op
  }
}

export function recordTaskCost(cost: number): void {
  try {
    ensureInstruments();
    taskCostCounter?.add(cost);
  } catch {
    // no-op
  }
}

/** Reset instruments (for tests). */
export function _resetSwarmMetrics(): void {
  proposalCount = null;
  policyViolationCount = null;
  agentLatencyHistogram = null;
  taskResolutionTimeHistogram = null;
  taskCostCounter = null;
}
