import type { EventBus } from "./eventBus.js";
import type { HatcheryConfig } from "./hatcheryConfig.js";
import { DEFAULT_SERVICE_RATES, ROLE_TO_DIMENSIONS } from "./hatcheryConfig.js";
import { loadFilterConfig } from "./activationFilters.js";
import { getConvergenceState } from "./convergenceTracker.js";
import { logger } from "./logger.js";

// ── Arrival rate estimation ──────────────────────────────────────────────────

interface Sample { count: number; ts: number }

export class ArrivalRateEstimator {
  private samples: Sample[] = [];
  private windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  addSample(count: number, ts: number = Date.now()): void {
    this.samples.push({ count, ts });
    this.prune(ts);
  }

  estimateLambda(): number {
    if (this.samples.length < 2) return 0;
    const now = Date.now();
    this.prune(now);
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dtSec = (last.ts - first.ts) / 1000;
    if (dtSec <= 0) return 0;
    const totalMsgs = this.samples.reduce((sum, s) => sum + s.count, 0);
    return totalMsgs / dtSec;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    this.samples = this.samples.filter((s) => s.ts >= cutoff);
  }
}

// ── Service rate ─────────────────────────────────────────────────────────────

export function computeServiceRate(avgLatencyMs: number, role?: string): number {
  if (avgLatencyMs > 0) return 1000 / avgLatencyMs;
  return DEFAULT_SERVICE_RATES[role ?? ""] ?? 0.01;
}

// ── M/M/c optimal workers ────────────────────────────────────────────────────

export function computeOptimalWorkers(
  lambda: number, mu: number, rhoTarget: number, min: number, max: number,
): number {
  if (lambda <= 0 || mu <= 0 || rhoTarget <= 0) return min;
  const c = Math.ceil(lambda / (mu * rhoTarget));
  return Math.max(min, Math.min(c, max));
}

// ── Little's Law sanity check ────────────────────────────────────────────────

export function littlesLawQueueDepth(lambda: number, mu: number): number {
  if (mu <= 0) return 0;
  return lambda / mu;
}

// ── Consumer lag ─────────────────────────────────────────────────────────────

export async function getConsumerLag(
  bus: EventBus, stream: string, consumer: string,
): Promise<number> {
  return bus.getConsumerPending(stream, consumer);
}

// ── Scaling decisions ────────────────────────────────────────────────────────

export type ScalingAction = "scale_up" | "scale_down" | "none";

export interface ScalingDecision {
  role: string;
  action: ScalingAction;
  currentCount: number;
  targetCount: number;
  lambda: number;
  mu: number;
  lag: number;
  pressure: number;
}

export interface RoleState {
  instanceCount: number;
  consumerName: string;
  lastScaleDownAt: number;
  agentsInFlight: number;
}

export async function evaluateScalingDecisions(
  config: HatcheryConfig,
  roleStates: Record<string, RoleState>,
  estimators: Record<string, ArrivalRateEstimator>,
  bus: EventBus,
): Promise<ScalingDecision[]> {
  const decisions: ScalingDecision[] = [];
  let convergencePressure: Record<string, number> = {};

  if (config.pressureDirectedScaling) {
    try {
      const convState = await getConvergenceState(config.scopeId);
      const latest = convState.history[convState.history.length - 1];
      convergencePressure = latest?.pressure ?? {};
    } catch {
      // convergence data unavailable; skip pressure
    }
  }

  for (const [role, roleConfig] of Object.entries(config.roles)) {
    const state = roleStates[role];
    if (!state) continue;
    if (roleConfig.category === "tuner") {
      decisions.push({
        role, action: "none", currentCount: state.instanceCount,
        targetCount: state.instanceCount, lambda: 0, mu: 0, lag: 0, pressure: 0,
      });
      continue;
    }

    const estimator = estimators[role];
    const lambda = estimator?.estimateLambda() ?? 0;

    let mu: number;
    try {
      const filterCfg = await loadFilterConfig(role);
      mu = computeServiceRate(filterCfg.stats.avgLatencyMs, role);
    } catch {
      mu = DEFAULT_SERVICE_RATES[role] ?? 0.01;
    }

    let cOptimal = computeOptimalWorkers(
      lambda, mu, roleConfig.targetUtilization, roleConfig.minInstances, roleConfig.maxInstances,
    );

    const lag = await getConsumerLag(bus, config.natsStream, state.consumerName);
    if (lag > roleConfig.lagThreshold && lag > roleConfig.activationLagThreshold) {
      const cLag = Math.min(
        Math.ceil(lag / roleConfig.lagThreshold) + state.instanceCount,
        roleConfig.maxInstances,
      );
      cOptimal = Math.max(cOptimal, cLag);
    }

    const L = littlesLawQueueDepth(lambda, mu);
    if (L > 2 * lag && lag > 0) {
      logger.warn("hatchery: lambda estimate may be inflated", { role, L, lag, lambda, mu });
    }

    let pressure = 0;
    if (config.pressureDirectedScaling) {
      const dims = ROLE_TO_DIMENSIONS[role] ?? [];
      pressure = dims.reduce((sum, d) => sum + (convergencePressure[d] ?? 0), 0);
    }

    let action: ScalingAction = "none";
    if (cOptimal > state.instanceCount) {
      action = "scale_up";
    } else if (cOptimal < state.instanceCount && state.agentsInFlight === 0) {
      const cooldownOk = Date.now() - state.lastScaleDownAt >= config.scaleDownCooldownMs;
      if (cooldownOk) action = "scale_down";
    }

    decisions.push({
      role, action, currentCount: state.instanceCount,
      targetCount: cOptimal, lambda, mu, lag, pressure,
    });
  }

  if (config.pressureDirectedScaling) {
    const ups = decisions.filter((d) => d.action === "scale_up");
    ups.sort((a, b) => b.pressure - a.pressure);
  }

  return decisions;
}
