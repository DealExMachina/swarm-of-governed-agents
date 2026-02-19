import { describe, it, expect, beforeEach } from "vitest";
import {
  recordProposal,
  recordPolicyViolation,
  recordAgentLatency,
  recordTaskResolutionTimeMs,
  recordTaskCost,
  _resetSwarmMetrics,
} from "../../src/metrics.js";
import { initTelemetry } from "../../src/telemetry.js";

describe("metrics", () => {
  beforeEach(() => {
    process.env.OTEL_SDK_DISABLED = "true";
    initTelemetry();
    _resetSwarmMetrics();
  });

  it("recordProposal does not throw", () => {
    expect(() => recordProposal("advance_state", "approved")).not.toThrow();
    expect(() => recordProposal("advance_state", "rejected")).not.toThrow();
    expect(() => recordProposal("advance_state", "pending")).not.toThrow();
  });

  it("recordPolicyViolation does not throw", () => {
    expect(() => recordPolicyViolation()).not.toThrow();
  });

  it("recordAgentLatency does not throw", () => {
    expect(() => recordAgentLatency("facts", 100)).not.toThrow();
    expect(() => recordAgentLatency("governance", 50)).not.toThrow();
  });

  it("recordTaskResolutionTimeMs does not throw", () => {
    expect(() => recordTaskResolutionTimeMs(200)).not.toThrow();
  });

  it("recordTaskCost does not throw", () => {
    expect(() => recordTaskCost(0.01)).not.toThrow();
  });
});
