# swarm-v0.1

Governed agent swarm: event-driven reasoning roles sharing a context, governed by policy, converging toward finality.

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

## Scalability: from swarm to fabric

This prototype runs one swarm with four agents against one scope. The architecture is designed to scale out along several axes.

**Multiple scopes.** Each scope is an isolated coordination context: its own semantic graph nodes, its own finality state, its own MITL queue. A single swarm can serve many scopes simultaneously, with OpenFGA enforcing isolation. Finality gives each scope a lifecycle that does not depend on the others.

**Multiple agents per role.** The pull-consumer model on NATS means you can run ten facts agents against the same stream. Each picks up one job, runs extraction, proposes an advance. Epoch-based CAS on the state graph prevents double-advances. Horizontal scaling is additive, not architectural.

**Heterogeneous models.** The facts-worker is a separate Python service. The extraction model is a configuration parameter. Nothing prevents running a lighter model for low-stakes scopes and a heavier one for high-stakes ones — or routing to different backends per scope. The governance and finality layers stay constant; only the extraction backend changes.

**Multi-organization.** OpenFGA's relationship model supports org-level tenancy natively. Agent pools, scope ownership, and cross-org collaboration can be expressed as relationship tuples without touching agent code. A shared infrastructure can serve multiple organizations with strict policy isolation.

**The key constraint that scales well:** because governance is declarative and finality is computed from the semantic graph, adding complexity does not require rewriting the agents. You add rules to `governance.yaml`, update the finality weights in `finality.yaml`, adjust the authorization model in OpenFGA. The agents remain unchanged. The coordination substrate absorbs the new constraints.

The key constraint that does not scale well is the single-scope state machine — a bottleneck if thousands of scopes share a singleton. That is a solvable partition problem, not an architectural dead end.

---

## Architecture

**Event bus:** NATS JetStream stream `SWARM_JOBS` with subjects `swarm.jobs.>`, `swarm.proposals.>`, `swarm.actions.>`, `swarm.events.>`. Durable pull consumers, one per agent instance. No leases, no S3 queues.

**Context and state:** Postgres `context_events` (append-only WAL, seq/ts/data JSONB) and `swarm_state` (singleton, epoch CAS). S3 for `facts/latest.json`, `drift/latest.json`, and history. The WAL is readable by all agents; no agent owns the log.

**Semantic graph:** Postgres `nodes` (type, scope, payload, optional `embedding vector(1024)`) and `edges` (source, target, edge_type). Migration `005_semantic_graph.sql`. Synced from facts after each extraction cycle. Queried by the finality evaluator.

**Governance loop:** Planner proposes → governance agent checks transition rules + OpenFGA policy + optionally LLM rationale → executor performs approved advance. `advance_state` is always deterministic; the LLM adds explanation, not authority.

**Finality:** After each governance round, `evaluateFinality(scopeId)` runs against the semantic graph. Above `auto_finality_threshold` (0.92): auto-RESOLVED. Between `near_finality_threshold` (0.75) and threshold: HITL review queued to MITL server. Conditions for ESCALATED, BLOCKED, EXPIRED are evaluated in parallel.

**Facts-worker:** Python (FastAPI + DSPy/OpenAI-compatible). Runs in Docker. When Ollama is configured on the host, the container uses `host.docker.internal` to reach it — Compose enforces this so the worker always gets a reachable LLM URL regardless of what is in `.env`.

---

## Finality and semantic graph

The semantic graph (Postgres + pgvector, migration `005_semantic_graph.sql`) holds addressable nodes (claims, goals, risks, assessments) and edges (e.g. `contradicts`, `resolves`). The finality layer uses it to decide when a scope is done or needs human review.

**Config:** `finality.yaml` defines a goal gradient (weights for claim confidence, contradiction resolution, goal completion, risk) and thresholds: `near_finality_threshold` (default 0.75) and `auto_finality_threshold` (default 0.92). It also defines conditions for RESOLVED (e.g. no unresolved contradictions, goals completion ratio ≥ 0.90), ESCALATED, BLOCKED, and EXPIRED. The evaluator loads a scope snapshot via `loadFinalitySnapshot(scopeId)` and computes a goal score from the gradient.

**Path A — Auto RESOLVED:** When the goal score is above `auto_finality_threshold` and RESOLVED conditions hold, the scope is marked RESOLVED without human review.

**Path B — Near-finality and HITL:** When the score is between `near_finality_threshold` and `auto_finality_threshold`, the system builds a finality review: an LLM (Ollama HITL model) explains why finality is not reached and what would resolve it, then the review is sent to the MITL server. A human can approve finality, provide a resolution, escalate, or defer.

**Facts sync:** After each facts extraction, the facts agent writes to S3 and calls `syncFactsToSemanticGraph(scopeId, facts)`, which replaces fact-sourced nodes/edges for that scope and inserts claim, goal, and risk nodes (and contradiction edges). Set `FACTS_SYNC_EMBED=1` to embed claim nodes with Ollama `bge-m3` (1024-d); requires Ollama and the embedding model.

**Scripts:** `npm run test:postgres-ollama` verifies Postgres (migrations 002/003/005) and Ollama embedding. `npm run seed:hitl` seeds the semantic graph with a deterministic near-finality state (e.g. one unresolved contradiction) so that when the swarm runs, a finality review appears in the MITL queue. See STATUS.md for the full flow.

---

## Stack

- **TypeScript** — orchestration, agents, state graph, feed, tests.
- **Python** — facts-worker (DSPy; Ollama or OpenAI-compatible extraction).
- **Docker Compose** — Postgres (pgvector), MinIO, NATS JetStream, facts-worker, feed, OpenFGA, otel-collector.
- **NATS JetStream** — event bus.
- **Postgres + pgvector** — context WAL, state graph, semantic graph with optional 1024-d embeddings.
- **MinIO** — S3-compatible blob store for facts, drift, and history.
- **OpenFGA** — policy checks (Zanzibar-style; optional but wired in).
- **Ollama or OpenAI** — extraction, rationale, HITL explanation, embeddings (`bge-m3`).

---

## Run locally

**Prerequisites:** Docker. OpenAI key or Ollama running locally with the extraction model pulled (e.g. `ollama pull qwen3:8b`).

```bash
cp .env.example .env
# Edit .env: set OPENAI_API_KEY or OLLAMA_BASE_URL=http://host.docker.internal:11434
docker compose up -d postgres s3 nats facts-worker feed
npm i
```

**Preflight** — ensures Postgres, S3, NATS, and facts-worker are reachable before starting. Use `CHECK_SERVICES_MAX_WAIT_SEC=300` on first run (facts-worker installs Python deps on startup):

```bash
CHECK_SERVICES_MAX_WAIT_SEC=300 npm run check:services
```

**Migrations:**

```bash
export PGPASSWORD="${POSTGRES_PASSWORD:-swarm}"
psql -h localhost -p 5433 -U "${POSTGRES_USER:-swarm}" -d "${POSTGRES_DB:-swarm}" -f migrations/002_context_wal.sql
psql -h localhost -p 5433 -U "${POSTGRES_USER:-swarm}" -d "${POSTGRES_DB:-swarm}" -f migrations/003_swarm_state.sql
psql -h localhost -p 5433 -U "${POSTGRES_USER:-swarm}" -d "${POSTGRES_DB:-swarm}" -f migrations/005_semantic_graph.sql
psql -h localhost -p 5433 -U "${POSTGRES_USER:-swarm}" -d "${POSTGRES_DB:-swarm}" -f migrations/006_scope_finality_decisions.sql
```

**Seed, bootstrap, and launch:**

```bash
npm run ensure-bucket && npm run ensure-stream
npm run seed:all
npm run bootstrap-once
npm run swarm:all       # starts 4 agents + governance + executor; check:services runs first
```

**Feed and summary:**

```bash
# Feed runs in Docker on port 3002
curl -s http://localhost:3002/summary | jq .state

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
| `npm run swarm:all` | Start four agents + governance + executor. Runs preflight first. |
| `npm run check:services` | Preflight (Postgres, S3, NATS, facts-worker). Supports `CHECK_SERVICES_MAX_WAIT_SEC`, `CHECK_FEED=1`. |
| `npm run bootstrap-once` | Publish bootstrap job and append bootstrap WAL event. |
| `npm run seed:all` | Seed context WAL from `seed-docs/`. |
| `npm run seed:hitl` | Seed semantic graph for a deterministic HITL finality scenario. |
| `npm run seed:governance-e2e` | Seed state/drift and publish MASTER/MITL/YOLO proposals for governance path E2E. |
| `npm run verify:governance-paths` | Verify context_events contain expected governance paths (run after seed:governance-e2e and governance). |
| `npm run reset-e2e` | Truncate DB, empty S3, delete NATS stream. |
| `npm run ensure-stream` | Create or update NATS stream. |
| `npm run ensure-bucket` | Create S3 bucket if missing. |
| `npm run ensure-pull-consumers` | Recreate consumers as pull (fix "push consumer not supported"). |
| `npm run feed` | Run feed server (port 3002). |
| `npm run observe` | Tail NATS events in the terminal. |
| `npm run check:model` | Test OpenAI-compatible endpoint from `.env`. |
| `npm run test:postgres-ollama` | Verify Postgres (migrations 002/003/005) and Ollama embedding (bge-m3). |

**E2E:** Run `./scripts/run-e2e.sh` to start Docker, run migrations (002/003/005), seed, bootstrap, swarm, POST a doc, and verify nodes/edges. Requires Postgres, MinIO, NATS, facts-worker, and feed. Set `FACTS_SYNC_EMBED=1` to verify claim embeddings are written. For facts-worker in Docker with Ollama on the host, set `OLLAMA_BASE_URL=http://host.docker.internal:11434` in `.env` (see `.env.example`).

---

## Tests

```bash
npm run test          # TypeScript unit + integration (Vitest)
npm run test:watch
```

```bash
cd workers/facts-worker
pip install -r requirements.txt -r requirements-dev.txt
pytest tests/ -v      # Python facts-worker unit + integration
```

---

## Optional

- **HITL finality scenario:** `npm run seed:hitl` seeds a near-finality state with an unresolved contradiction. Run the swarm; when governance evaluates finality, a `finality_review` appears in the MITL queue with explanation and options. See STATUS.md.
- **Governance path E2E:** `npm run seed:governance-e2e` publishes MASTER/MITL/YOLO proposals; after the governance agent runs, `npm run verify:governance-paths` checks that context_events contain the expected auditable paths (processProposal, and optionally oversight_*). See STATUS.md "Governance paths and E2E audit".
- **Embeddings:** Set `FACTS_SYNC_EMBED=1` + Ollama serving `bge-m3`. Claim nodes get 1024-d embeddings for semantic search.
- **Tuner agent:** `AGENT_ROLE=tuner npm run swarm` runs a periodic loop (every ~30min) that uses an LLM to optimize activation filter configs based on productive/wasted ratio stats.
- **Observability:** Configure `OTEL_*` in `.env` to send traces and metrics to the otel-collector.

For current status, verified functionality, and next steps, see **STATUS.md**.
