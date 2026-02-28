import type { S3Client } from "@aws-sdk/client-s3";
import type { EventBus } from "./eventBus.js";
import type { HatcheryConfig } from "./hatcheryConfig.js";
import {
  ArrivalRateEstimator,
  evaluateScalingDecisions,
  getConsumerLag,
  type RoleState,
} from "./hatcheryMetrics.js";
import { runAgentLoop } from "./agentLoop.js";
import { runGovernanceAgentLoop } from "./agents/governanceAgent.js";
import { runActionExecutor } from "./actionExecutor.js";
import { runTunerAgentLoop } from "./agents/tunerAgent.js";
import { createSwarmEvent } from "./events.js";
import { getPool } from "./db.js";
import { logger } from "./logger.js";
import { toErrorString } from "./errors.js";

// ── Types ────────────────────────────────────────────────────────────────────

type AgentState = "alive" | "draining" | "dead";

interface AgentInstance {
  id: string;
  role: string;
  state: AgentState;
  startedAt: number;
  lastHeartbeat: number;
  messagesProcessed: number;
  abort: AbortController;
  task: Promise<void>;
  restartTimestamps: number[];
}

export interface HatcherySnapshot {
  agents: Array<{
    id: string; role: string; state: AgentState;
    uptime: number; messagesProcessed: number;
  }>;
  roleCounts: Record<string, number>;
  totalAgents: number;
  estimators: Record<string, { lambda: number }>;
}

// ── Singleton accessor (for feed server) ─────────────────────────────────────

let _instance: AgentHatchery | null = null;
export function getHatcheryInstance(): AgentHatchery | null { return _instance; }

// ── Hatchery event logger ────────────────────────────────────────────────────

async function logHatcheryEvent(
  role: string, action: string, agentId: string,
  before: number, after: number,
  extra?: { lambda?: number; mu?: number; consumer_lag?: number; pressure?: number; reason?: string },
): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO hatchery_events (role, action, agent_id, instance_count_before, instance_count_after, lambda, mu, consumer_lag, pressure, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [role, action, agentId, before, after,
       extra?.lambda ?? null, extra?.mu ?? null, extra?.consumer_lag ?? null,
       extra?.pressure ?? null, extra?.reason ?? null],
    );
  } catch {
    // non-fatal: table may not exist yet on first run
  }
}

// ── AgentHatchery ────────────────────────────────────────────────────────────

export class AgentHatchery {
  private config: HatcheryConfig;
  private bus: EventBus;
  private s3: S3Client;
  private bucket: string;
  private agents = new Map<string, AgentInstance>();
  private estimators = new Map<string, ArrivalRateEstimator>();
  private lastScaleDown = new Map<string, number>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private shuttingDown = false;
  private nextInstanceId = new Map<string, number>();
  private governanceCount = 0;

  constructor(config: HatcheryConfig, bus: EventBus, s3: S3Client, bucket: string) {
    this.config = config;
    this.bus = bus;
    this.s3 = s3;
    this.bucket = bucket;
    _instance = this;

    for (const role of Object.keys(config.roles)) {
      this.estimators.set(role, new ArrivalRateEstimator(config.arrivalRateWindowMs));
      this.nextInstanceId.set(role, 1);
    }
  }

  async start(): Promise<void> {
    logger.info("hatchery starting", { roles: Object.keys(this.config.roles) });

    for (const [role, roleConfig] of Object.entries(this.config.roles)) {
      for (let i = 0; i < roleConfig.minInstances; i++) {
        await this.spawnAgent(role);
      }
    }

    this.timers.push(setInterval(() => this.lagSamplerTick(), 2000));
    this.timers.push(setInterval(() => this.scaleUpTick(), this.config.scaleUpIntervalMs));
    this.timers.push(setInterval(() => this.scaleDownTick(), this.config.scaleDownIntervalMs));
    this.timers.push(setInterval(() => this.heartbeatTick(), this.config.heartbeatIntervalMs));

    logger.info("hatchery started", { totalAgents: this.agents.size });
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    logger.info("hatchery shutting down", { agents: this.agents.size });
    for (const t of this.timers) clearInterval(t);
    this.timers = [];

    const drainPromises: Promise<void>[] = [];
    for (const agent of this.agents.values()) {
      if (agent.state === "alive") {
        drainPromises.push(this.drainAgent(agent.id));
      }
    }
    await Promise.allSettled(drainPromises);

    try { await this.bus.close(); } catch {}
    _instance = null;
    logger.info("hatchery shutdown complete");
  }

  // ── Spawn / Drain ──────────────────────────────────────────────────────────

  private async spawnAgent(role: string): Promise<string> {
    const seqNum = this.nextInstanceId.get(role) ?? 1;
    this.nextInstanceId.set(role, seqNum + 1);
    const agentId = `${role}-${seqNum}`;
    const consumerName = `${role}-shared-events`;
    const abort = new AbortController();
    const countBefore = this.countRole(role);

    const onHeartbeat = (processed: number) => {
      const inst = this.agents.get(agentId);
      if (inst) {
        inst.lastHeartbeat = Date.now();
        inst.messagesProcessed += processed;
      }
    };

    let task: Promise<void>;
    const roleConfig = this.config.roles[role];

    if (roleConfig.category === "governance") {
      this.governanceCount++;
      const isFirst = this.governanceCount === 1;
      task = runGovernanceAgentLoop(this.bus, this.s3, this.bucket, {
        signal: abort.signal,
        consumerName,
        agentId,
        onHeartbeat,
        startMitl: isFirst,
      });
    } else if (roleConfig.category === "executor") {
      task = runActionExecutor(this.bus, {
        signal: abort.signal,
        consumerName,
        agentId,
        onHeartbeat,
      });
    } else if (roleConfig.category === "tuner") {
      const publishEvent = async (type: string, payload: Record<string, unknown>) => {
        await this.bus.publishEvent(createSwarmEvent(type, payload, { source: "tuner" }));
      };
      task = runTunerAgentLoop(this.s3, this.bucket, publishEvent, abort.signal);
    } else {
      task = runAgentLoop({
        s3: this.s3,
        bucket: this.bucket,
        bus: this.bus,
        stream: this.config.natsStream,
        agentId,
        role,
        scopeId: this.config.scopeId,
        signal: abort.signal,
        consumerName,
        onHeartbeat,
      });
    }

    const instance: AgentInstance = {
      id: agentId, role, state: "alive",
      startedAt: Date.now(), lastHeartbeat: Date.now(),
      messagesProcessed: 0, abort, task, restartTimestamps: [],
    };
    this.agents.set(agentId, instance);

    task.then(() => {
      this.onAgentExit(agentId, null);
    }).catch((err) => {
      this.onAgentExit(agentId, err);
    });

    const countAfter = this.countRole(role);
    await logHatcheryEvent(role, "spawn", agentId, countBefore, countAfter, { reason: "initial_or_scale_up" });
    logger.info("hatchery: spawned agent", { agentId, role, count: countAfter });
    return agentId;
  }

  private async drainAgent(agentId: string): Promise<void> {
    const inst = this.agents.get(agentId);
    if (!inst || inst.state === "dead") return;
    const countBefore = this.countRole(inst.role);
    inst.state = "draining";

    inst.abort.abort();

    const roleConfig = this.config.roles[inst.role];
    const graceMs = roleConfig?.drainGracePeriodMs ?? 30_000;
    const timeout = new Promise<void>((r) => setTimeout(r, graceMs));
    await Promise.race([inst.task.catch(() => {}), timeout]);

    inst.state = "dead";
    if (inst.role === "governance" || this.config.roles[inst.role]?.category === "governance") {
      this.governanceCount = Math.max(0, this.governanceCount - 1);
    }
    this.agents.delete(agentId);
    const countAfter = this.countRole(inst.role);
    await logHatcheryEvent(inst.role, "drain", agentId, countBefore, countAfter, { reason: "scale_down_or_shutdown" });
    logger.info("hatchery: drained agent", { agentId, role: inst.role, count: countAfter });
  }

  // ── Supervisor ─────────────────────────────────────────────────────────────

  private onAgentExit(agentId: string, err: unknown): void {
    const inst = this.agents.get(agentId);
    if (!inst) return;
    if (inst.state === "draining" || inst.state === "dead" || this.shuttingDown) {
      inst.state = "dead";
      this.agents.delete(agentId);
      return;
    }

    inst.state = "dead";
    this.agents.delete(agentId);

    const now = Date.now();
    inst.restartTimestamps.push(now);
    const windowStart = now - this.config.restartWindowMs;
    const recentRestarts = inst.restartTimestamps.filter((t) => t >= windowStart);

    if (recentRestarts.length > this.config.maxRestarts) {
      logger.error("hatchery: restart intensity exceeded, not restarting", {
        agentId, role: inst.role, restarts: recentRestarts.length,
        error: err ? toErrorString(err) : "clean_exit",
      });
      void logHatcheryEvent(inst.role, "restart_exhausted", agentId,
        this.countRole(inst.role), this.countRole(inst.role),
        { reason: `exceeded ${this.config.maxRestarts} restarts in ${this.config.restartWindowMs}ms` });
      return;
    }

    logger.warn("hatchery: agent exited unexpectedly, restarting", {
      agentId, role: inst.role,
      error: err ? toErrorString(err) : "clean_exit",
    });
    void this.spawnAgent(inst.role).then((newId) => {
      const newInst = this.agents.get(newId);
      if (newInst) newInst.restartTimestamps = recentRestarts;
      void logHatcheryEvent(inst.role, "restart", newId,
        this.countRole(inst.role) - 1, this.countRole(inst.role),
        { reason: err ? toErrorString(err) : "clean_exit" });
    });
  }

  // ── Timers ─────────────────────────────────────────────────────────────────

  private async lagSamplerTick(): Promise<void> {
    for (const [role, roleConfig] of Object.entries(this.config.roles)) {
      if (roleConfig.category === "tuner") continue;
      try {
        const consumerName = `${role}-shared-events`;
        const lag = await getConsumerLag(this.bus, this.config.natsStream, consumerName);
        this.estimators.get(role)?.addSample(lag);
      } catch {}
    }
  }

  private async scaleUpTick(): Promise<void> {
    if (this.shuttingDown) return;
    const decisions = await evaluateScalingDecisions(
      this.config, this.buildRoleStates(), this.mapToRecord(this.estimators), this.bus,
    );
    for (const d of decisions) {
      if (d.action === "scale_up" && d.targetCount > d.currentCount) {
        const toSpawn = d.targetCount - d.currentCount;
        for (let i = 0; i < toSpawn; i++) {
          await this.spawnAgent(d.role);
        }
      }
    }
  }

  private async scaleDownTick(): Promise<void> {
    if (this.shuttingDown) return;
    const decisions = await evaluateScalingDecisions(
      this.config, this.buildRoleStates(), this.mapToRecord(this.estimators), this.bus,
    );
    for (const d of decisions) {
      if (d.action === "scale_down" && d.targetCount < d.currentCount) {
        const toDrain = d.currentCount - d.targetCount;
        const roleAgents = [...this.agents.values()]
          .filter((a) => a.role === d.role && a.state === "alive")
          .sort((a, b) => b.startedAt - a.startedAt); // LIFO: drain newest first
        for (let i = 0; i < toDrain && i < roleAgents.length; i++) {
          await this.drainAgent(roleAgents[i].id);
        }
        this.lastScaleDown.set(d.role, Date.now());
      }
    }
  }

  private heartbeatTick(): void {
    if (this.shuttingDown) return;
    const now = Date.now();
    for (const [agentId, inst] of this.agents.entries()) {
      if (inst.state !== "alive") continue;
      const roleConfig = this.config.roles[inst.role];
      const timeout = roleConfig?.heartbeatTimeoutMs ?? 60_000;
      if (now - inst.lastHeartbeat > timeout) {
        logger.warn("hatchery: heartbeat timeout, draining", { agentId, role: inst.role, silenceMs: now - inst.lastHeartbeat });
        void this.drainAgent(agentId).then(() => {
          void logHatcheryEvent(inst.role, "heartbeat_timeout", agentId,
            this.countRole(inst.role) + 1, this.countRole(inst.role));
        });
      }
    }
  }

  // ── Snapshot ───────────────────────────────────────────────────────────────

  getSnapshot(): HatcherySnapshot {
    const agents = [...this.agents.values()].map((a) => ({
      id: a.id, role: a.role, state: a.state,
      uptime: Date.now() - a.startedAt,
      messagesProcessed: a.messagesProcessed,
    }));
    const roleCounts: Record<string, number> = {};
    for (const role of Object.keys(this.config.roles)) {
      roleCounts[role] = this.countRole(role);
    }
    const estimatorsOut: Record<string, { lambda: number }> = {};
    for (const [role, est] of this.estimators.entries()) {
      estimatorsOut[role] = { lambda: est.estimateLambda() };
    }
    return {
      agents, roleCounts,
      totalAgents: this.agents.size,
      estimators: estimatorsOut,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private countRole(role: string): number {
    let n = 0;
    for (const a of this.agents.values()) {
      if (a.role === role && a.state !== "dead") n++;
    }
    return n;
  }

  private buildRoleStates(): Record<string, RoleState> {
    const states: Record<string, RoleState> = {};
    for (const role of Object.keys(this.config.roles)) {
      let inFlight = 0;
      for (const a of this.agents.values()) {
        if (a.role === role && a.state === "alive") {
          const roleConfig = this.config.roles[role];
          const timeout = roleConfig?.heartbeatTimeoutMs ?? 60_000;
          if (Date.now() - a.lastHeartbeat > timeout * 0.8) inFlight++;
        }
      }
      states[role] = {
        instanceCount: this.countRole(role),
        consumerName: `${role}-shared-events`,
        lastScaleDownAt: this.lastScaleDown.get(role) ?? 0,
        agentsInFlight: inFlight,
      };
    }
    return states;
  }

  private mapToRecord(m: Map<string, ArrivalRateEstimator>): Record<string, ArrivalRateEstimator> {
    const r: Record<string, ArrivalRateEstimator> = {};
    for (const [k, v] of m.entries()) r[k] = v;
    return r;
  }
}
