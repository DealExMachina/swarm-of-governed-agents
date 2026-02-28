import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadHatcheryConfig } from "../../src/hatcheryConfig";

describe("loadHatcheryConfig", () => {
  const saved: Record<string, string | undefined> = {};
  const envKeys = [
    "HATCHERY_FACTS_MIN", "HATCHERY_FACTS_MAX", "HATCHERY_FACTS_LAG_THRESHOLD",
    "HATCHERY_SCALE_UP_INTERVAL_MS", "HATCHERY_PRESSURE_SCALING",
    "NATS_STREAM", "SCOPE_ID",
  ];

  beforeEach(() => {
    for (const k of envKeys) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  it("loads defaults", () => {
    const cfg = loadHatcheryConfig();
    expect(cfg.roles.facts.minInstances).toBe(1);
    expect(cfg.roles.facts.maxInstances).toBe(4);
    expect(cfg.roles.governance.lagThreshold).toBe(20);
    expect(cfg.roles.tuner.minInstances).toBe(0);
    expect(cfg.scaleUpIntervalMs).toBe(5000);
    expect(cfg.pressureDirectedScaling).toBe(true);
    expect(cfg.roles.facts.heartbeatTimeoutMs).toBe(360_000);
    expect(cfg.roles.governance.heartbeatTimeoutMs).toBe(60_000);
  });

  it("overrides via HATCHERY_ env vars", () => {
    process.env.HATCHERY_FACTS_MIN = "3";
    process.env.HATCHERY_FACTS_MAX = "3";
    process.env.HATCHERY_FACTS_LAG_THRESHOLD = "100";
    process.env.HATCHERY_SCALE_UP_INTERVAL_MS = "10000";
    process.env.HATCHERY_PRESSURE_SCALING = "0";
    const cfg = loadHatcheryConfig();
    expect(cfg.roles.facts.minInstances).toBe(3);
    expect(cfg.roles.facts.maxInstances).toBe(3);
    expect(cfg.roles.facts.lagThreshold).toBe(100);
    expect(cfg.scaleUpIntervalMs).toBe(10000);
    expect(cfg.pressureDirectedScaling).toBe(false);
  });

  it("includes all expected roles", () => {
    const cfg = loadHatcheryConfig();
    const roles = Object.keys(cfg.roles).sort();
    expect(roles).toEqual(["drift", "executor", "facts", "governance", "planner", "status", "tuner"]);
  });

  it("per-role heartbeat timeouts are calibrated to agent latency", () => {
    const cfg = loadHatcheryConfig();
    expect(cfg.roles.facts.heartbeatTimeoutMs).toBeGreaterThan(cfg.roles.governance.heartbeatTimeoutMs);
    expect(cfg.roles.drift.heartbeatTimeoutMs).toBeGreaterThan(cfg.roles.executor.heartbeatTimeoutMs);
    expect(cfg.roles.tuner.heartbeatTimeoutMs).toBeGreaterThanOrEqual(600_000);
  });
});
