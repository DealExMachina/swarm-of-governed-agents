# Swarm of Governed Agents

Governed agent swarm: event-driven reasoning roles sharing a context, governed by policy, converging toward finality — with formal convergence guarantees.

---

## The case against straightjackets

Most agent frameworks default to the same design: a directed graph, a fixed pipeline, a hardcoded sequence of steps. Tool 1 calls Tool 2, Tool 2 calls Tool 3. The orchestrator decides what happens next. If an unexpected condition arises — conflicting data, a missing predecessor, a policy constraint — the system either crashes, silently skips it, or falls to a cascade of if-else branches someone added at 11pm.

This works for demos. It does not work for coordination.

The core problem is that **workflow orchestration conflates sequencing with reasoning**. A DAG answers "what comes next" but not "should this happen at all, given what we know." It bakes the coordination logic into the structure itself, which means every new agent, every new rule, every new exception requires rewiring. The graph becomes load-bearing and fragile simultaneously.

Agents are increasingly capable of making local judgments. The open question is: how do we let them do so while keeping the overall system coherent, auditable, and safe? Putting them in a pipeline is one answer. It is the wrong one. A pipeline delegates coherence to topology. We want coherence to come from **shared state, shared policy, and a coordination mechanism that enforces invariants without prescribing sequence**.

That is what this project explores.

---

## Governance, not orchestration

The alternative is not "let agents do whatever they want." It is **governed coordination**: agents operate independently on shared state, and what they are *allowed* to do is determined by declarative policy, not hard-coded call chains.

The architecture rests on three principles:

**1. Shared, append-only context.** Every agent reads from the same event log (Postgres WAL) and the same facts/drift state (S3). There is no "agent A's context" vs "agent B's context." There is context. Agents read it, reason over it, propose changes, and wait for approval. The log is the system's memory.

**2. Proposals and approvals.** No agent directly advances the state. A facts agent extracts and proposes `FactsExtracted`; the governance agent checks whether that transition is currently allowed (given drift level, policy, epoch); the executor performs it if approved. This single control-loop pattern decouples the reasoning work from the state mutation. It also produces an audit trail: every transition has a reason, a proposer, and an approver.

**3. Declarative rules, not imperative code.** `governance.yaml` expresses transition rules ("block DriftChecked → ContextIngested when drift is high") and remediation actions ("open investigation when contradiction detected"). Rules are evaluated at runtime, not compiled into graph edges. Adding a new constraint is a YAML change, not a refactor.

The result: agents are **reasoning roles**, not pipeline stages. A drift agent does not need to know whether a planner agent ran before it. It reads the shared state, checks its precondition, runs if appropriate, and proposes an advance. The coordination emerges from the shared context and the governance layer — not from wiring.

---

## Why OpenFGA belongs here

The governance rules in `governance.yaml` handle *when* transitions are allowed. But enterprise deployments raise a prior question: **who is allowed to do what to which resource?**

Consider a multi-tenant deployment: multiple scopes (clients, projects, divisions) sharing the same swarm infrastructure. Agent A should be able to write facts for scope X but not scope Y. A human reviewer should be able to approve finality for their own scope but not others'. An audit role should have read access everywhere but write access nowhere.

Hard-coding these rules into each agent creates the same fragility as hard-coding workflow logic into a DAG. Every role change, every new scope, every new agent requires code changes, deployments, and re-testing. More fundamentally: policy becomes invisible, scattered across dozens of if-statements, impossible to audit as a whole.

**OpenFGA** — an open implementation of Google Zanzibar — provides a dedicated authorization layer that separates policy from code entirely. Instead of `if agent_role == "facts" and scope == "allowed_scope"`, you write a relationship model: `agent facts-1 is writer on node FactsExtracted for scope X`. Permission checks become API calls: `check(agent-id, write, node:FactsExtracted)`. The answer is derived from the relationship graph, not scattered conditionals.

For enterprise use, this matters for three reasons:

- **Auditability:** The full permission model is a first-class object. You can inspect, diff, and version it. Compliance teams can audit authorization logic without reading agent code.
- **Least privilege at scale:** As the number of agents, scopes, and roles grows, the permission surface grows combinatorially. A relationship model manages that growth; conditional logic does not.
- **Dynamic policy:** Zanzibar-style models support computed relationships (e.g. "member of group X implies permission on all scopes owned by group X"). Governance evolves without redeployment.

In this project, OpenFGA is wired into the governance agent's `checkPolicy` tool. When a proposal arrives, the agent checks both the transition rules and the policy: did the proposing agent have write permission on the target node? Both can reject. Neither is in application code. The invariant holds whether the governance agent uses an LLM for rationale or a rule-based path as fallback.

---

## The semantic graph as coordination substrate

A shared event log is necessary. A facts object in S3 is useful. But a flat log and a blob of JSON do not support the coordination questions that actually matter as complexity grows: *Have we resolved the contradiction between claim A and claim B? Which goals are still open? Does this new information invalidate a previous risk assessment?*

The **semantic graph** — Postgres with pgvector — makes the knowledge structure explicit. Claims, goals, risks, and assumptions become addressable nodes. Contradictions and supports become typed edges. The graph is updated after each extraction cycle; it persists across cycles. You can query it: give me all unresolved contradictions for scope X; give me the goals with completion ratio below threshold; give me the claims with confidence below 0.85 — the finality layer does exactly this.

**Finality** (`finality.yaml`) closes the loop. Instead of running forever or stopping arbitrarily, a scope can reach a determined state: RESOLVED (sufficient confidence, no contradictions, goals met), ESCALATED (risk threshold exceeded), BLOCKED (idle with open issues), EXPIRED (inactive for a month). When the system is near finality but not quite — confidence is high, one contradiction remains unresolved — it does not force a decision. It routes to **human-in-the-loop review**: the governance agent builds an explanation ("here is what is blocking finality, here is what would resolve it, here are the options") and puts it in a MITL queue for a human to evaluate.

The pattern is: agents converge on knowledge, the semantic graph makes convergence measurable, finality decides when the process is done (or stuck), and humans step in precisely when the system cannot decide on its own. No hard-coded stopping condition. No silent termination.

---

## Finality gradient descent

The original `evaluateFinality()` was **memoryless** — each invocation computed a fresh `goalScore` from a snapshot and checked it against a threshold. There was no tracking of score history, no detection of whether the system was actually converging or stalling, no formal monotonicity guarantees, and no way to estimate how many more cycles were needed. A transient score spike could trigger premature RESOLVED; agents stuck at 0.65 with marginal oscillations would cycle forever.

The convergence tracker (`src/convergenceTracker.ts`) transforms finality from a stateless threshold check into a stateful convergence process with formal guarantees. It implements five mechanisms from the research literature:

**1. Lyapunov disagreement function V(t).** A quadratic distance metric: `V = Σ(w_d × (target_d - actual_d)²)` over four weighted dimensions (claim confidence, contradiction resolution, goal completion, risk). V = 0 means perfect finality. A monotonically decreasing V guarantees asymptotic convergence to finality targets. Derived from consensus stability proofs in [Olfati-Saber & Murray, 2004](#references).

**2. Convergence rate α.** The exponential decay rate `α = -ln(V(t)/V(t-1))`, averaged over recent evaluation cycles. Positive α means the system is converging; negative α means it is diverging; near-zero means stalled. The rate feeds directly into ETA estimation: `estimated_rounds = ⌈-ln(ε / V(t)) / α⌉`.

**3. Monotonicity gate.** The goal score must be non-decreasing for β consecutive rounds (default β = 3) before auto-resolve is permitted. This prevents a transient spike from triggering premature RESOLVED. Inspired by the Aegean protocol's coordination invariants [Duan et al., 2025](#references).

**4. Plateau detection.** An exponential moving average of the progress ratio (score delta / remaining gap) detects when the system is making negligible progress. If the EMA stays below a threshold (default 0.01) for τ consecutive rounds (default τ = 3), the system is declared plateaued and HITL review is triggered. Based on the MACI framework's stagnation detection [Camacho et al., 2024](#references).

**5. Pressure-directed activation.** Per-dimension pressure (`pressure_d = w_d × gap_d`) identifies which dimension is the bottleneck. The activation filter system routes agents toward the highest-pressure dimension — facts agents activate when claim confidence is the bottleneck, drift agents when contradiction resolution is. This creates a natural stigmergic flow toward the dimensions that most need work. Inspired by pheromone-based coordination in [Dorigo et al., 2024](#references).

### How it integrates

After each governance round, `evaluateFinality(scopeId)` computes the goal score, records a convergence point (epoch, score, Lyapunov V, per-dimension scores, pressure), and analyzes the convergence state. The decision paths are:

| Condition | Outcome |
|-----------|---------|
| Score ≥ 0.92, all RESOLVED conditions met, **monotonicity gate satisfied** | Auto-RESOLVED |
| Convergence rate α < -0.05 (system diverging) | ESCALATED |
| Score in [0.40, 0.92), plateau detected | HITL review with convergence context |
| Score in [0.40, 0.92), not plateaued | ACTIVE (keep iterating) |
| BLOCKED / EXPIRED conditions met | BLOCKED / EXPIRED |

HITL reviews now include convergence rate, ETA, Lyapunov V, plateau duration, bottleneck dimension, and score trajectory — giving the human reviewer actionable context rather than a bare score.

### Monotonic graph upserts

The semantic graph sync (`factsToSemanticGraph.ts`) was changed from delete-and-replace to **upsert-if-better**: claim confidence is only updated when the new value is higher than the existing one. Resolved contradictions cannot be re-created (`resolves` edges are irreversible). Stale nodes are marked `irrelevant` rather than deleted. This guarantees the goal score is a ratchet — it can only move forward, never regress — which makes the monotonicity gate meaningful. Inspired by conflict-free replicated data types (CRDTs) applied to collaborative development in [Laddad et al., 2024](#references).

### Configuration

`finality.yaml` controls all convergence parameters:

```yaml
goal_gradient:
  weights:
    claim_confidence: 0.30
    contradiction_resolution: 0.30
    goal_completion: 0.25
    risk_score_inverse: 0.15
  near_finality_threshold: 0.40
  auto_finality_threshold: 0.92

convergence:
  beta: 3                    # monotonicity window
  tau: 3                     # plateau detection window
  ema_alpha: 0.3             # EMA smoothing factor
  plateau_threshold: 0.01    # progress ratio below which = plateau
  history_depth: 20          # convergence points to keep
  divergence_rate: -0.05     # α below this triggers ESCALATED
```

### Benchmark

`scripts/benchmark-convergence.ts` is a pure-math simulation (no Docker, no Postgres, no LLM) that validates the convergence tracker against seven scenarios: steady convergence, plateau at 0.70, spike-and-drop, divergence, one-dimension bottleneck, fast convergence, and empty graph. All seven pass.

```bash
npx tsx scripts/benchmark-convergence.ts
```

---

## Scalability: from swarm to fabric

This prototype runs one swarm with four agents against one scope. The architecture is designed to scale out along several axes.

**Multiple scopes.** Each scope is an isolated coordination context: its own semantic graph nodes, its own finality state, its own convergence history, its own MITL queue. A single swarm can serve many scopes simultaneously, with OpenFGA enforcing isolation. Finality gives each scope a lifecycle that does not depend on the others.

**Multiple agents per role.** The pull-consumer model on NATS means you can run ten facts agents against the same stream. Each picks up one job, runs extraction, proposes an advance. Epoch-based CAS on the state graph prevents double-advances. Horizontal scaling is additive, not architectural.

**Heterogeneous models.** The facts-worker is a separate Python service. The extraction model is a configuration parameter. Nothing prevents running a lighter model for low-stakes scopes and a heavier one for high-stakes ones — or routing to different backends per scope. The governance and finality layers stay constant; only the extraction backend changes.

**Multi-organization.** OpenFGA's relationship model supports org-level tenancy natively. Agent pools, scope ownership, and cross-org collaboration can be expressed as relationship tuples without touching agent code. A shared infrastructure can serve multiple organizations with strict policy isolation.

**The key constraint that scales well:** because governance is declarative and finality is computed from the semantic graph, adding complexity does not require rewriting the agents. You add rules to `governance.yaml`, update the finality weights in `finality.yaml`, adjust the authorization model in OpenFGA. The agents remain unchanged. The coordination substrate absorbs the new constraints.

The key constraint that does not scale well is the single-scope state machine — a bottleneck if thousands of scopes share a singleton. That is a solvable partition problem, not an architectural dead end.

---

## Architecture

**Event bus:** NATS JetStream stream `SWARM_JOBS` with subjects `swarm.jobs.>`, `swarm.proposals.>`, `swarm.actions.>`, `swarm.events.>`. Durable pull consumers, one per agent instance. No leases, no S3 queues.

**Context and state:** Postgres `context_events` (append-only WAL, seq/ts/data JSONB) and `swarm_state` (singleton, epoch CAS). S3 for `facts/latest.json`, `drift/latest.json`, and history. The WAL is readable by all agents; no agent owns the log.

**Semantic graph:** Postgres `nodes` (type, scope, payload, optional `embedding vector(1024)`) and `edges` (source, target, edge_type). Migration `005_semantic_graph.sql`. Synced from facts after each extraction cycle via monotonic upserts. Queried by the finality evaluator.

**Convergence history:** Postgres `convergence_history` (scope_id, epoch, goal_score, lyapunov_v, dimension_scores JSONB, pressure JSONB). Migration `010_convergence_tracker.sql`. Append-only, indexed by `(scope_id, created_at DESC)`.

**Governance loop:** Planner proposes → governance agent checks transition rules + OpenFGA policy + optionally LLM rationale → executor performs approved advance. `advance_state` is always deterministic; the LLM adds explanation, not authority.

**Finality:** After each governance round, `evaluateFinality(scopeId)` runs against the semantic graph and convergence history. Above `auto_finality_threshold` (0.92) with monotonicity gate satisfied: auto-RESOLVED. Diverging (α < -0.05): ESCALATED. Near-finality and plateaued: HITL review queued to MITL server with convergence context. Conditions for BLOCKED, EXPIRED are evaluated in parallel.

**Facts-worker:** Python (FastAPI + DSPy/OpenAI-compatible). Runs in Docker. When Ollama is configured on the host, the container uses `host.docker.internal` to reach it — Compose enforces this so the worker always gets a reachable LLM URL regardless of what is in `.env`.

---

## Stack

- **TypeScript** — orchestration, agents, state graph, convergence tracker, feed, tests.
- **Python** — facts-worker (DSPy; Ollama or OpenAI-compatible extraction).
- **Docker Compose** — Postgres (pgvector), MinIO, NATS JetStream, facts-worker, feed, OpenFGA, otel-collector.
- **NATS JetStream** — event bus.
- **Postgres + pgvector** — context WAL, state graph, semantic graph with optional 1024-d embeddings, convergence history.
- **MinIO** — S3-compatible blob store for facts, drift, and history.
- **OpenFGA** — policy checks (Zanzibar-style; optional but wired in).
- **Ollama or OpenAI** — extraction, rationale, HITL explanation, embeddings (`bge-m3`).

---

## Run locally

**Prerequisites:** Docker. Node 20+; pnpm (recommended; lockfile is `pnpm-lock.yaml`). OpenAI key or Ollama running locally with the extraction model pulled (e.g. `ollama pull qwen3:8b`).

```bash
cp .env.example .env
# Edit .env: set OPENAI_API_KEY or OLLAMA_BASE_URL=http://host.docker.internal:11434
docker compose up -d postgres s3 nats facts-worker feed
pnpm install
```

**Preflight** — ensures Postgres, S3, NATS, and facts-worker are reachable before starting. Use `CHECK_SERVICES_MAX_WAIT_SEC=300` on first run (facts-worker installs Python deps on startup):

```bash
CHECK_SERVICES_MAX_WAIT_SEC=300 pnpm run check:services
```

**Migrations:**

```bash
export PGPASSWORD="${POSTGRES_PASSWORD:-swarm}"
psql -h localhost -p 5433 -U "${POSTGRES_USER:-swarm}" -d "${POSTGRES_DB:-swarm}" -f migrations/002_context_wal.sql
psql -h localhost -p 5433 -U "${POSTGRES_USER:-swarm}" -d "${POSTGRES_DB:-swarm}" -f migrations/003_swarm_state.sql
psql -h localhost -p 5433 -U "${POSTGRES_USER:-swarm}" -d "${POSTGRES_DB:-swarm}" -f migrations/005_semantic_graph.sql
psql -h localhost -p 5433 -U "${POSTGRES_USER:-swarm}" -d "${POSTGRES_DB:-swarm}" -f migrations/006_scope_finality_decisions.sql
psql -h localhost -p 5433 -U "${POSTGRES_USER:-swarm}" -d "${POSTGRES_DB:-swarm}" -f migrations/007_swarm_state_scope.sql
psql -h localhost -p 5433 -U "${POSTGRES_USER:-swarm}" -d "${POSTGRES_DB:-swarm}" -f migrations/008_mitl_pending.sql
psql -h localhost -p 5433 -U "${POSTGRES_USER:-swarm}" -d "${POSTGRES_DB:-swarm}" -f migrations/009_processed_messages.sql
psql -h localhost -p 5433 -U "${POSTGRES_USER:-swarm}" -d "${POSTGRES_DB:-swarm}" -f migrations/010_convergence_tracker.sql
```

**Seed, bootstrap, and launch:**

```bash
pnpm run ensure-bucket && pnpm run ensure-stream
pnpm run seed:all
pnpm run bootstrap-once
pnpm run swarm:all       # starts 4 agents + governance + executor; check:services runs first
```

**Feed and summary:**

```bash
# Feed runs in Docker on port 3002
curl -s http://localhost:3002/summary | jq .state

# Convergence state for a scope
curl -s http://localhost:3002/convergence?scope=default | jq .

# Add a document to trigger the pipeline
curl -s -X POST http://localhost:3002/context/docs \
  -H "Content-Type: application/json" \
  -d '{"title":"Q4 update","body":"Revenue revised to $2.5M. New risk: compliance delay."}'
```

**Full automated E2E** (start Docker, reset, migrate, seed, bootstrap, run, verify):

```bash
./scripts/run-e2e.sh
```

**Ports:** 3002 feed · 4222/8222 NATS · 5433 Postgres · 9000/9001 MinIO · 8010 facts-worker · 3001 MITL · 3000/8080 OpenFGA.

---

## Approval modes

Set in `governance.yaml`:

| Mode | Behaviour |
|------|-----------|
| `YOLO` | Governance agent approves all valid transitions automatically. |
| `MITL` | Every proposal goes to the MITL queue; a human approves or rejects. |
| `MASTER` | Deterministic rule-based path; no LLM rationale. |

---

## Scripts

| Script | Purpose |
|--------|---------|
| `pnpm run swarm:all` | Start four agents + governance + executor. Runs preflight first. |
| `pnpm run check:services` | Preflight (Postgres, S3, NATS, facts-worker). Supports `CHECK_SERVICES_MAX_WAIT_SEC`, `CHECK_FEED=1`. |
| `pnpm run bootstrap-once` | Publish bootstrap job and append bootstrap WAL event. |
| `pnpm run seed:all` | Seed context WAL from `seed-docs/`. |
| `pnpm run seed:hitl` | Seed semantic graph for a deterministic HITL finality scenario. |
| `pnpm run seed:governance-e2e` | Seed state/drift and publish MASTER/MITL/YOLO proposals for governance path E2E. |
| `pnpm run verify:governance-paths` | Verify context_events contain expected governance paths (run after seed:governance-e2e and governance). |
| `pnpm run reset-e2e` | Truncate DB, empty S3, delete NATS stream. |
| `pnpm run ensure-stream` | Create or update NATS stream. |
| `pnpm run ensure-bucket` | Create S3 bucket if missing. |
| `pnpm run ensure-pull-consumers` | Recreate consumers as pull (fix "push consumer not supported"). |
| `pnpm run feed` | Run feed server (port 3002). |
| `pnpm run observe` | Tail NATS events in the terminal. |
| `pnpm run check:model` | Test OpenAI-compatible endpoint from `.env`. |
| `pnpm run test:postgres-ollama` | Verify Postgres (migrations 002/003/005) and Ollama embedding (bge-m3). |

**E2E:** Run `./scripts/run-e2e.sh` to start Docker, run migrations, seed, bootstrap, swarm, POST a doc, and verify nodes/edges. Requires Postgres, MinIO, NATS, facts-worker, and feed. Set `FACTS_SYNC_EMBED=1` to verify claim embeddings are written. For facts-worker in Docker with Ollama on the host, set `OLLAMA_BASE_URL=http://host.docker.internal:11434` in `.env` (see `.env.example`).

---

## Tests

```bash
pnpm run test          # 196 unit tests (Vitest); 15 integration tests (require Docker)
pnpm run test:watch
```

```bash
npx tsx scripts/benchmark-convergence.ts   # 7 convergence scenarios (pure math, no Docker)
```

```bash
cd workers/facts-worker
pip install -r requirements.txt -r requirements-dev.txt
pytest tests/ -v      # Python facts-worker unit + integration
```

---

## Optional

- **HITL finality scenario:** `pnpm run seed:hitl` seeds a near-finality state with an unresolved contradiction. Run the swarm; when governance evaluates finality, a `finality_review` appears in the MITL queue with explanation, convergence data, and options. See STATUS.md.
- **Governance path E2E:** `pnpm run seed:governance-e2e` publishes MASTER/MITL/YOLO proposals; after the governance agent runs, `pnpm run verify:governance-paths` checks that context_events contain the expected auditable paths (processProposal, and optionally oversight_*). See STATUS.md "Governance paths and E2E audit".
- **Embeddings:** Set `FACTS_SYNC_EMBED=1` + Ollama serving `bge-m3`. Claim nodes get 1024-d embeddings for semantic search.
- **Tuner agent:** `AGENT_ROLE=tuner pnpm run swarm` runs a periodic loop (every ~30min) that uses an LLM to optimize activation filter configs based on productive/wasted ratio stats.
- **Pressure-directed activation:** Set filter type to `pressure_directed` in agent config. Agents activate based on which dimension has the highest convergence pressure — facts agents focus on claim confidence, drift agents on contradiction resolution.
- **Observability:** Configure `OTEL_*` in `.env` to send traces and metrics to the otel-collector.

For current status, verified functionality, and next steps, see **STATUS.md**.

---

## References

1. <a id="ref-olfati-saber"></a> **Olfati-Saber, R. & Murray, R. M.** (2004). Consensus Problems in Networks of Agents With Switching Topology and Time-Delays. *IEEE Transactions on Automatic Control*, 49(9), 1520–1533. doi:[10.1109/TAC.2004.834113](https://doi.org/10.1109/TAC.2004.834113)
   — Lyapunov stability framework for multi-agent consensus; foundation for the disagreement function V(t) used in convergence tracking.

2. <a id="ref-aegean"></a> **Duan, S., Reiter, M. K., & Zhang, H.** (2025). Aegean: Making State Machine Replication Fast without Compromise. *arXiv preprint* arXiv:[2512.20184](https://arxiv.org/abs/2512.20184)
   — Monotonicity gates and coordination invariants for state machine replication; basis for the β-round non-decreasing gate before auto-resolve.

3. <a id="ref-maci"></a> **Camacho, D. et al.** (2024). MACI: Multi-Agent Collective Intelligence. *arXiv preprint* arXiv:[2510.04488](https://arxiv.org/abs/2510.04488)
   — EMA-based plateau detection for multi-agent stagnation; adapted for finality stall detection and HITL escalation.

4. <a id="ref-codecrdt"></a> **Laddad, S. et al.** (2024). CodeCRDT: A Conflict-Free Replicated Data Type for Collaborative Code Editing. *arXiv preprint* arXiv:[2510.18893](https://arxiv.org/abs/2510.18893)
   — CRDT monotonic upserts applied to collaborative development; adapted for irreversible semantic graph operations (upsert-if-better, irreversible resolution edges).

5. <a id="ref-stigmergy"></a> **Dorigo, M., Theraulaz, G., & Trianni, V.** (2024). Swarm Intelligence: Past, Present, and Future. *Proceedings of the Royal Society B*, 291(2024). doi:[10.1098/rspb.2024.0856](https://doi.org/10.1098/rspb.2024.0856)
   — Stigmergic coordination via pheromone-like signals; basis for pressure-directed agent activation routing toward bottleneck dimensions.

6. <a id="ref-zanzibar"></a> **Pang, R. et al.** (2019). Zanzibar: Google's Consistent, Global Authorization System. *USENIX ATC 2019*. [usenix.org](https://www.usenix.org/conference/atc19/presentation/pang)
   — Relationship-based access control at scale; theoretical foundation for OpenFGA integration in the governance layer.

---

## License

MIT — see [LICENSE](./LICENSE).
