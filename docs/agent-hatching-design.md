# Agent Hatchery: Dynamic, Load-Aware Agent Lifecycle Management

## Context

The swarm currently spawns agents via static bash backgrounding (`scripts/swarm-all.sh`): 6 fixed processes, no supervision, no health checks, no dynamic scaling. If an agent crashes, it stays dead. If load spikes, the single instance per role becomes a bottleneck. If load drops, all 6 processes still consume resources.

The agent-hatching factory replaces this with a single-process orchestrator that spawns agent loops as in-process async tasks, monitors NATS consumer lag, estimates arrival/service rates using queueing theory (M/M/c), and dynamically scales instances per role. It draws on Erlang/OTP supervisor patterns for restart strategies and KEDA-style lag-based scaling for reactivity.

**Branch:** `agent-hatching` (created from main)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                     AgentHatchery (single process)            │
│                                                               │
│  ┌──────────────┐   ┌──────────────────────────────────────┐ │
│  │ Lag Sampler   │──▶│ Scaling Decision Engine               │ │
│  │ (2s interval) │   │  • λ = sliding window arrival rate    │ │
│  └──────────────┘   │  • μ = 1000/avgLatencyMs (from stats) │ │
│                      │  • c = ⌈λ/(μ×ρ)⌉ (M/M/c optimal)    │ │
│  ┌──────────────┐   │  • Lag override (KEDA-style)          │ │
│  │ Heartbeat     │   │  • Pressure-directed priority         │ │
│  │ (10s interval)│   └───────┬──────────────┬───────────────┘ │
│  └──────────────┘           │              │                  │
│                       scale_up(5s)   scale_down(60s, 5m CD)   │
│                              │              │                  │
│  ┌───────────────────────────┴──────────────┴────────────────┐│
│  │           Agent Instance Pool                              ││
│  │  facts-1  facts-2     drift-1     planner-1  planner-2    ││
│  │  governance-1    executor-1    status-1                    ││
│  │                                                            ││
│  │  Each: async task, shared bus/s3/pool, AbortSignal,       ││
│  │        competing NATS consumer ({role}-shared-events)      ││
│  └───────────────────────────────────────────────────────────┘│
│                                                               │
│  Supervisor: one_for_one, max 3 restarts / 5s                │
└──────────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### 1. In-process async tasks, not child processes
Agents run as `Promise<void>` tasks within a single Node.js process. They share the Postgres pool (singleton from `src/db.ts`), S3 client, and NATS connection. This avoids IPC overhead and simplifies lifecycle management. The existing `runAgentLoop`, `runGovernanceAgentLoop`, `runActionExecutor` are reused as-is with 3 optional parameters added.

### 2. Competing consumers for horizontal scaling
Currently each agent creates a unique NATS consumer (`${role}-${agentId}-events`), so each instance gets ALL messages. For scaling, all instances of the same role must share ONE consumer name (`${role}-shared-events`) so NATS distributes messages across them. This requires adding an optional `consumerName` param to `AgentLoopOptions`.

### 3. M/M/c + KEDA hybrid scaling
- **Proactive (M/M/c):** Estimate λ (arrival rate) and μ (service rate), compute optimal c = ⌈λ/(μ×0.75)⌉
- **Reactive (KEDA):** If consumer lag exceeds threshold, override with `c = ⌈lag/lagThreshold⌉ + current`
- **Priority (pressure-directed):** When multiple roles need scaling, use convergence pressure to determine which scales first

### 4. Erlang-style one_for_one supervisor
Each task is monitored independently. On unexpected exit: check restart intensity (max 3 in 5s window), respawn if within limits, stop if exceeded. During shutdown, drain all instances (mark draining → signal abort → wait grace period → force-kill).

### 5. Asymmetric hysteresis
- **Scale-up:** evaluate every 5s, act immediately
- **Scale-down:** evaluate every 60s, 5-minute cooldown per role, drain newest instance first (LIFO)

---

## Implementation Steps

### Step 1: `src/hatcheryConfig.ts` — Configuration types and defaults

Pure types, zero dependencies. ~80 lines.

**Key types:**
- `AgentCategory = "worker" | "governance" | "executor" | "tuner"`
- `RoleScalingConfig { minInstances, maxInstances, subject, category, targetUtilization, lagThreshold, activationLagThreshold }`
- `HatcheryConfig { roles, scaleUpIntervalMs, scaleDownIntervalMs, scaleDownCooldownMs, drainGracePeriodMs, maxRestarts, restartWindowMs, heartbeatIntervalMs, heartbeatTimeoutMs, arrivalRateWindowMs, pressureDirectedScaling, natsStream, scopeId }`

**Defaults per role:**
| Role | min | max | Category | lagThreshold |
|------|-----|-----|----------|--------------|
| facts | 1 | 4 | worker | 50 |
| drift | 1 | 4 | worker | 50 |
| planner | 1 | 4 | worker | 50 |
| status | 1 | 2 | worker | 50 |
| governance | 1 | 2 | governance | 20 |
| executor | 1 | 2 | executor | 20 |
| tuner | 0 | 1 | tuner | 0 |

---

### Step 2: `src/hatcheryMetrics.ts` — Queue theory math + lag monitoring

Pure functions + one NATS query. ~150 lines.

**Classes/functions:**
- `ArrivalRateEstimator` — sliding window ring buffer, `addSample(count, ts)`, `estimateLambda(): number` (msgs/sec)
- `computeServiceRate(avgLatencyMs, fallbackMu=0.5): number` — `μ = 1000/avgLatencyMs`
- `computeOptimalWorkers(λ, μ, ρ_target, min, max): number` — `c = ⌈λ/(μ×ρ)⌉`, clamped
- `littlesLawQueueDepth(λ, μ): number` — `L = λ/μ` (sanity check)
- `getConsumerLag(jsm, stream, consumer): number` — NATS `consumers.info()` → `num_pending`
- `evaluateScalingDecisions(...)` — the main algorithm (see pseudocode below)

**Scaling algorithm pseudocode:**
```
for each role:
  λ = estimators[role].estimateLambda()
  μ = computeServiceRate(filterStats[role].avgLatencyMs)
  c_optimal = clamp(⌈λ/(μ×ρ)⌉, min, max)

  lag = getConsumerLag(stream, consumer)
  if lag > lagThreshold and lag > activationLagThreshold:
    c_lag = min(⌈lag/lagThreshold⌉ + current, max)
    c_optimal = max(c_optimal, c_lag)

  L = λ/μ  // Little's Law sanity check
  if L > 2×lag: warn("λ estimate may be inflated")

  decision = scale_up | scale_down | none

if pressureDirectedScaling:
  for scale_up decisions: pressure = Σ(convergence_pressure[dim] for dim in roleToDim[role])
  sort by pressure DESC (highest pressure scales first)
```

**Reuses:** `loadFilterConfig` from `src/activationFilters.ts` (for `avgLatencyMs`), `getConvergenceState` from `src/convergenceTracker.ts` (for pressure)

---

### Step 3: `migrations/011_hatchery_metrics.sql` — Event log table

Append-only scaling event log. ~20 lines.

```sql
CREATE TABLE IF NOT EXISTS hatchery_events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  role TEXT NOT NULL,
  action TEXT NOT NULL,          -- spawn, drain, restart, heartbeat_timeout
  agent_id TEXT NOT NULL,
  instance_count_before INT NOT NULL,
  instance_count_after INT NOT NULL,
  lambda FLOAT,
  mu FLOAT,
  consumer_lag BIGINT,
  pressure FLOAT,
  reason TEXT
);
CREATE INDEX idx_hatchery_events_ts ON hatchery_events (ts DESC);
CREATE INDEX idx_hatchery_events_role ON hatchery_events (role, ts DESC);
```

---

### Step 4: Modify `src/agentLoop.ts` — Add optional hatchery hooks

Minimal, non-breaking. ~10 lines changed.

**Add to `AgentLoopOptions`:**
```typescript
consumerName?: string;      // override consumer name for competing consumers
signal?: AbortSignal;       // graceful shutdown from hatchery
onHeartbeat?: (processed: number) => void;  // heartbeat callback
```

**In `runAgentLoop`:**
```typescript
const consumer = opts.consumerName ?? `${role}-${agentId}-events`;
// ...
while (!opts.signal?.aborted) {   // was: while (true)
  // ...existing fetch/process logic...
  if (processed > 0 && opts.onHeartbeat) opts.onHeartbeat(processed);
}
```

**Same pattern for:** `runGovernanceAgentLoop` (add optional `signal`, `consumerName`), `runActionExecutor` (add optional `signal`, `consumerName`).

**Note:** Governance `maxInstances: 1` initially because the MITL HTTP server (port 3001) is a singleton. If needed later, only the first instance starts MITL.

---

### Step 5: `src/hatchery.ts` — The main AgentHatchery class

The orchestrator. ~300 lines.

**Key types:**
- `AgentState = "alive" | "draining" | "dead"`
- `AgentInstance { id, role, state, startedAt, lastHeartbeat, messagesProcessed, abort: AbortController, task: Promise<void>, restartTimestamps }`

**Class `AgentHatchery`:**

| Method | Responsibility |
|--------|---------------|
| `start()` | Spawn minInstances per role, start 4 timers (scaleUp, scaleDown, heartbeat, lagSampler), register SIGTERM/SIGINT |
| `shutdown()` | Stop timers, drain all instances, wait grace period, force-kill stragglers, close bus |
| `spawnAgent(role)` | Create AbortController, start the right loop (worker/governance/executor/tuner) as async task, attach supervisor handler |
| `drainAgent(agentId)` | Mark draining → signal abort → race(task, timeout) → mark dead → remove |
| `onAgentExit(agentId, error)` | Supervisor: check restart intensity → respawn or give up |
| `heartbeat(agentId, processed)` | Update lastHeartbeat (called from agent loop via onHeartbeat) |
| `getSnapshot()` | Return all agent states, role counts, total agents |

**Timers:**
| Timer | Interval | Action |
|-------|----------|--------|
| Scale-up | 5s | `evaluateScalingDecisions` → spawn if scale_up |
| Scale-down | 60s | `evaluateScalingDecisions` → drain if scale_down (with 5min cooldown) |
| Heartbeat | 10s | Check all agents' lastHeartbeat, drain if timeout (30s) |
| Lag sampler | 2s | Sample NATS consumer lag, feed ArrivalRateEstimator |

**Reuses:** `runAgentLoop` from `src/agentLoop.ts`, `runGovernanceAgentLoop` from `src/agents/governanceAgent.ts`, `runActionExecutor` from `src/actionExecutor.ts`, `runTunerAgentLoop` from `src/agents/tunerAgent.ts`, `loadFilterConfig` from `src/activationFilters.ts`, `getConvergenceState` from `src/convergenceTracker.ts`

---

### Step 6: Update `src/swarm.ts` — Hatchery mode

~15 lines added. Non-breaking: existing single-agent mode unchanged.

```typescript
// When AGENT_ROLE=hatchery (or unset), use hatchery
if (!process.env.AGENT_ROLE || process.env.AGENT_ROLE === "hatchery") {
  const config = loadHatcheryConfig();
  const hatchery = new AgentHatchery(config, bus, s3, BUCKET, jsm);
  await hatchery.start();
  await new Promise<void>(() => {}); // block forever; shutdown via SIGTERM
  return;
}
// ...existing single-agent mode below (unchanged)
```

---

### Step 7: `scripts/swarm-hatchery.sh` — Single-process replacement

Copy `swarm-all.sh`, replace the 6 background processes with:
```bash
export AGENT_ROLE=hatchery
export AGENT_ID=hatchery-1
exec $RUNNER run swarm 2>&1 | tee "$LOG_DIR/swarm-hatchery.log"
```

`exec` replaces the shell with the node process for clean signal handling.

---

### Step 8: Tests

**`test/unit/hatcheryMetrics.test.ts`** (~80 lines):
- `ArrivalRateEstimator`: empty → 0, sliding window computation, prune old samples, single sample
- `computeServiceRate`: latency→throughput, zero/negative fallback
- `computeOptimalWorkers`: M/M/c formula, min/max clamping, zero λ/μ edge cases
- `littlesLawQueueDepth`: L=λ/μ, zero μ

**`test/unit/hatchery.test.ts`** (~120 lines, mocked EventBus/NATS/S3):
- Spawning: minInstances on start, unique agentIds, alive state
- Supervisor: restart on unexpected exit, restart intensity limit, no restart during shutdown/drain
- Draining: marks draining→dead, signals abort, force-kill on timeout
- Scaling: scale-up on high lag, maxInstances cap, scale-down on low load, cooldown enforcement, LIFO drain
- Heartbeat: timeout → drain, update on callback
- Shutdown: drains all, closes bus

---

### Step 9: Update `docs/architecture.md` — Add section 10

Add ~40 lines covering: single-process architecture, M/M/c scaling formula, supervisor tree, hysteresis, pressure-directed priority. Include a mermaid flowchart of the scaling decision loop.

---

## Files Modified/Created

| File | Action | Lines |
|------|--------|-------|
| `src/hatcheryConfig.ts` | **Create** | ~80 |
| `src/hatcheryMetrics.ts` | **Create** | ~150 |
| `src/hatchery.ts` | **Create** | ~300 |
| `migrations/011_hatchery_metrics.sql` | **Create** | ~20 |
| `src/agentLoop.ts` | **Modify** — add 3 optional params to AgentLoopOptions, check signal in while loop | ~10 lines changed |
| `src/agents/governanceAgent.ts` | **Modify** — add optional signal/consumerName params | ~10 lines changed |
| `src/actionExecutor.ts` | **Modify** — add optional signal/consumerName params | ~10 lines changed |
| `src/swarm.ts` | **Modify** — add hatchery mode detection | ~15 lines added |
| `scripts/swarm-hatchery.sh` | **Create** | ~40 |
| `test/unit/hatcheryMetrics.test.ts` | **Create** | ~80 |
| `test/unit/hatchery.test.ts` | **Create** | ~120 |
| `docs/architecture.md` | **Modify** — add section 10 | ~40 lines added |

## Files NOT Modified
- `src/eventBus.ts` — consumed as-is (consumer creation pattern reused)
- `src/activationFilters.ts` — consumed as-is (loadFilterConfig for μ estimation)
- `src/convergenceTracker.ts` — consumed as-is (pressure data for scaling priority)
- `src/agentRegistry.ts` — consumed as-is (AGENT_SPECS for role enumeration)
- `scripts/swarm-all.sh` — kept for backward compatibility (deprecated)

---

## Literature References

| Concept | Source | Application |
|---------|--------|-------------|
| M/M/c queue, ρ = λ/(c×μ) | Queueing theory (Erlang C) | Optimal worker count per role |
| Little's Law: L = λW | Little (1961) | Sanity check: verify λ estimate against observed lag |
| Poisson arrival estimation | Sliding window λ estimator | Estimate message arrival rate from NATS lag samples |
| KEDA lag-based scaling | KEDA NATS JetStream scaler | lagThreshold / activationLagThreshold overrides |
| Erlang/OTP supervisor trees | Armstrong (2003), Erlang/OTP | one_for_one restart, intensity limits |
| Drain-before-kill | K8s graceful termination | Mark draining → abort signal → grace period → force-kill |
| Hysteresis / cool-down | AWS Auto Scaling | Asymmetric: fast scale-up (5s), slow scale-down (60s + 5min CD) |
| Pressure-directed activation | Dorigo et al. 2024 (stigmergy) | Scale the role whose convergence dimension has highest pressure first |

---

## Verification

1. `pnpm test` — all existing 196+ tests still pass (no breaking changes to existing loops)
2. New tests pass: `pnpm vitest test/unit/hatcheryMetrics.test.ts test/unit/hatchery.test.ts`
3. Manual: `AGENT_ROLE=hatchery pnpm run swarm` — starts all agents, logs show spawn events
4. Manual: legacy mode still works: `AGENT_ROLE=facts pnpm run swarm` — single agent as before
5. `scripts/swarm-hatchery.sh` — single process, clean SIGTERM handling
6. Verify competing consumers: two instances of same role share work (not duplicate)
