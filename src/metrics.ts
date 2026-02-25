/**
 * Swarm observability metrics via OpenTelemetry.
 * Requires initTelemetry() to have been called (NodeSDK sets global meter provider from env).
 */
import { getMeter } from "./telemetry.js";

let proposalCount: ReturnType<ReturnType<typeof getMeter>["createCounter"]> | null = null;
let policyViolationCount: ReturnType<ReturnType<typeof getMeter>["createCounter"]> | null = null;
let agentLatencyHistogram: ReturnType<ReturnType<typeof getMeter>["createHistogram"]> | null = null;
let agentErrorCount: ReturnType<ReturnType<typeof getMeter>["createCounter"]> | null = null;
let governanceLoopHistogram: ReturnType<ReturnType<typeof getMeter>["createHistogram"]> | null = null;

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
  if (agentErrorCount == null) {
    agentErrorCount = meter.createCounter("swarm.agent.error_count", {
      description: "Agent errors by role",
      unit: "1",
    });
  }
  if (governanceLoopHistogram == null) {
    governanceLoopHistogram = meter.createHistogram("swarm.governance.loop_ms", {
      description: "Governance proposal handling latency",
      unit: "ms",
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

export function recordAgentError(role: string): void {
  try {
    ensureInstruments();
    agentErrorCount?.add(1, { role });
  } catch {
    // no-op
  }
}

export function recordGovernanceLoopMs(latencyMs: number): void {
  try {
    ensureInstruments();
    governanceLoopHistogram?.record(latencyMs);
  } catch {
    // no-op
  }
}

/** Reset instruments (for tests). */
export function _resetSwarmMetrics(): void {
  proposalCount = null;
  policyViolationCount = null;
  agentLatencyHistogram = null;
  agentErrorCount = null;
  governanceLoopHistogram = null;
}
