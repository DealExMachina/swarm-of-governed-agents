export type AgentCategory = "worker" | "governance" | "executor" | "tuner";

export interface RoleScalingConfig {
  minInstances: number;
  maxInstances: number;
  subject: string;
  category: AgentCategory;
  targetUtilization: number;
  lagThreshold: number;
  activationLagThreshold: number;
  heartbeatTimeoutMs: number;
  drainGracePeriodMs: number;
}

export interface HatcheryConfig {
  roles: Record<string, RoleScalingConfig>;
  scaleUpIntervalMs: number;
  scaleDownIntervalMs: number;
  scaleDownCooldownMs: number;
  maxRestarts: number;
  restartWindowMs: number;
  heartbeatIntervalMs: number;
  arrivalRateWindowMs: number;
  pressureDirectedScaling: boolean;
  natsStream: string;
  scopeId: string;
}

export const ROLE_TO_DIMENSIONS: Record<string, string[]> = {
  facts: ["claim_confidence"],
  drift: ["contradiction_resolution"],
  planner: ["goal_completion"],
  status: ["risk_inverse"],
  governance: ["claim_confidence", "contradiction_resolution", "goal_completion", "risk_inverse"],
  executor: ["claim_confidence", "contradiction_resolution", "goal_completion", "risk_inverse"],
  tuner: [],
};

const DEFAULT_ROLE_CONFIGS: Record<string, RoleScalingConfig> = {
  facts: {
    minInstances: 1, maxInstances: 4, subject: "swarm.events.>", category: "worker",
    targetUtilization: 0.75, lagThreshold: 50, activationLagThreshold: 10,
    heartbeatTimeoutMs: 360_000, drainGracePeriodMs: 330_000,
  },
  drift: {
    minInstances: 1, maxInstances: 4, subject: "swarm.events.>", category: "worker",
    targetUtilization: 0.75, lagThreshold: 50, activationLagThreshold: 10,
    heartbeatTimeoutMs: 120_000, drainGracePeriodMs: 100_000,
  },
  planner: {
    minInstances: 1, maxInstances: 4, subject: "swarm.events.>", category: "worker",
    targetUtilization: 0.75, lagThreshold: 50, activationLagThreshold: 10,
    heartbeatTimeoutMs: 90_000, drainGracePeriodMs: 70_000,
  },
  status: {
    minInstances: 1, maxInstances: 2, subject: "swarm.events.>", category: "worker",
    targetUtilization: 0.75, lagThreshold: 50, activationLagThreshold: 10,
    heartbeatTimeoutMs: 90_000, drainGracePeriodMs: 70_000,
  },
  governance: {
    minInstances: 1, maxInstances: 2, subject: "swarm.proposals.>", category: "governance",
    targetUtilization: 0.75, lagThreshold: 20, activationLagThreshold: 5,
    heartbeatTimeoutMs: 60_000, drainGracePeriodMs: 40_000,
  },
  executor: {
    minInstances: 1, maxInstances: 2, subject: "swarm.actions.>", category: "executor",
    targetUtilization: 0.75, lagThreshold: 20, activationLagThreshold: 5,
    heartbeatTimeoutMs: 60_000, drainGracePeriodMs: 40_000,
  },
  tuner: {
    minInstances: 0, maxInstances: 1, subject: "", category: "tuner",
    targetUtilization: 0.75, lagThreshold: 0, activationLagThreshold: 0,
    heartbeatTimeoutMs: 600_000, drainGracePeriodMs: 600_000,
  },
};

/** Role-aware fallback service rates (msgs/sec) based on max processing times. */
export const DEFAULT_SERVICE_RATES: Record<string, number> = {
  facts: 0.003,       // 1/300s
  drift: 0.011,       // 1/90s
  planner: 0.017,     // 1/60s
  status: 0.017,      // 1/60s
  governance: 0.033,  // 1/30s
  executor: 0.033,    // 1/30s
  tuner: 0.002,       // 1/600s
};

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  return v === "1" || v === "true";
}

export function loadHatcheryConfig(): HatcheryConfig {
  const roles: Record<string, RoleScalingConfig> = {};
  for (const [role, defaults] of Object.entries(DEFAULT_ROLE_CONFIGS)) {
    const prefix = `HATCHERY_${role.toUpperCase()}`;
    roles[role] = {
      ...defaults,
      minInstances: envInt(`${prefix}_MIN`, defaults.minInstances),
      maxInstances: envInt(`${prefix}_MAX`, defaults.maxInstances),
      lagThreshold: envInt(`${prefix}_LAG_THRESHOLD`, defaults.lagThreshold),
      activationLagThreshold: envInt(`${prefix}_ACTIVATION_LAG_THRESHOLD`, defaults.activationLagThreshold),
      heartbeatTimeoutMs: envInt(`${prefix}_HEARTBEAT_TIMEOUT_MS`, defaults.heartbeatTimeoutMs),
      drainGracePeriodMs: envInt(`${prefix}_DRAIN_GRACE_MS`, defaults.drainGracePeriodMs),
    };
  }
  return {
    roles,
    scaleUpIntervalMs: envInt("HATCHERY_SCALE_UP_INTERVAL_MS", 5000),
    scaleDownIntervalMs: envInt("HATCHERY_SCALE_DOWN_INTERVAL_MS", 60000),
    scaleDownCooldownMs: envInt("HATCHERY_SCALE_DOWN_COOLDOWN_MS", 300000),
    maxRestarts: envInt("HATCHERY_MAX_RESTARTS", 3),
    restartWindowMs: envInt("HATCHERY_RESTART_WINDOW_MS", 5000),
    heartbeatIntervalMs: envInt("HATCHERY_HEARTBEAT_INTERVAL_MS", 10000),
    arrivalRateWindowMs: envInt("HATCHERY_ARRIVAL_RATE_WINDOW_MS", 60000),
    pressureDirectedScaling: envBool("HATCHERY_PRESSURE_SCALING", true),
    natsStream: process.env.NATS_STREAM ?? "SWARM_JOBS",
    scopeId: process.env.SCOPE_ID ?? "default",
  };
}
