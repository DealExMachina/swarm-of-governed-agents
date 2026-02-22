# Project status

Short snapshot of what exists, what is verified, and what comes next.

## What this is

Governed agent swarm: event-driven agents (facts, drift, planner, status) consume jobs from NATS, read/write shared context (Postgres WAL) and state graph (Postgres + S3 facts/drift). Governance and executor close the control loop (approve/reject proposals, execute transitions). A **semantic graph** (Postgres + pgvector) holds addressable nodes (claims, goals, risks) and edges (e.g. contradicts). A **stateful finality** layer uses a convergence tracker (Lyapunov V(t), monotonicity gate, plateau detection, pressure-directed activation) to evaluate scope readiness and trigger HITL review via the MITL server when near-finality or stalled. See [docs/convergence.md](docs/convergence.md) for the theory.

## Implemented and wired

**Core**

- Context WAL (`context_events`), state graph (`swarm_state`). Migrations 002 (context_wal), 003 (swarm_state), 005 (semantic_graph), 006 (scope_finality_decisions), 007 (swarm_state_scope), 008 (mitl_pending), 009 (processed_messages), 010 (convergence_tracker). **ensure-schema** runs all in order; **run-e2e.sh** runs 002/003/005/006.
- NATS JetStream stream, four agents (facts, drift, planner, status), governance agent, executor.
- Governance rules (`governance.yaml`), OpenFGA policy checks, MITL server (approve/reject/options).
- Facts agent: readContext -> facts-worker `/extract` -> writeFacts to S3. Direct pipeline and optional Mastra orchestration.
- Feed server (port 3002): summary, POST context/docs, POST context/resolution, **GET /convergence?scope=** for convergence state.
- Docker Compose: Postgres (pgvector image), MinIO, NATS, facts-worker, OpenFGA, feed, otel-collector.

**Finality and semantic layer**

- **finality.yaml**: goal gradient weights, RESOLVED/ESCALATED/BLOCKED/EXPIRED conditions, optional convergence config (beta, tau, ema_alpha, plateau_threshold, history_depth, divergence_rate).
- **finalityEvaluator.ts**: `evaluateFinality(scopeId)` uses `loadFinalitySnapshot(scopeId)` and **convergence state**: auto RESOLVED when score >= threshold and monotonicity gate satisfied; ESCALATED when divergence detected; HITL review when near-finality or plateaued. Respects **finalityDecisions.ts** (approve_finality -> RESOLVED short-circuit).
- **convergenceTracker.ts**: Lyapunov V(t), convergence rate alpha, monotonicity gate (beta rounds), plateau detection (EMA progress ratio, tau rounds), pressure-directed dimensions. Persists to `convergence_history` (migration 010). Pure analysis + DB persistence.
- **hitlFinalityRequest.ts**: build HITL request with convergence context (rate, ETA, bottleneck dimension, score history), call Ollama for explanation, POST to MITL.
- **mitlServer.ts**: `finality_review` multi-option responses and NATS events.
- **governanceAgent.ts**: after each proposal handling, fire-and-forget `runFinalityCheck(SCOPE_ID)`; uses `SCOPE_ID` from env.
- **migrations/005_semantic_graph.sql**: `vector` extension, `nodes` (with `embedding vector(1024)`), `edges`, indexes, `nodes_notify` trigger.
- **semanticGraph.ts**: `appendNode` / `appendEdge`, `queryNodes` / `queryEdges`, `loadFinalitySnapshot(scopeId)`, `runInTransaction`, `deleteNodesBySource`.
- **embeddingPipeline.ts**: `getEmbedding` (Ollama bge-m3), `updateNodeEmbedding`, `embedAndPersistNode`.
- **factsToSemanticGraph.ts**: `syncFactsToSemanticGraph(scopeId, facts)`: replace fact-sourced nodes/edges for scope, insert claim/goal/risk nodes and contradiction edges; optional `embedClaims` (FACTS_SYNC_EMBED=1).
- **factsAgent writeFacts**: after S3 write, calls `syncFactsToSemanticGraph(scopeId, facts)`; sync failure is logged, S3 write still succeeds.
- **activationFilters.ts**: optional **pressure_directed** filter using convergence history (highest-pressure dimension); fallback when `convergence_history` missing.
- **modelConfig.ts**: Ollama base URL, embedding model, chat/rationale/HITL models; SCOPE_ID.
- **docker-compose**: Postgres image `pgvector/pgvector:pg15`; facts-worker env (OLLAMA_BASE_URL, EXTRACTION_MODEL, HF_TOKEN, GLiNER, NLI).

**Demo**

- **Project Horizon**: M&A due diligence scenario (five docs, contradictions, HITL at near-finality). `pnpm run demo` (port 3003), `./demo/run-demo.sh`, [docs/demo.md](docs/demo.md), [demo/DEMO.md](demo/DEMO.md).

**Verified**

- Migrations 002–010 applied via ensure-schema; Postgres + pgvector and tables `context_events`, `swarm_state`, `nodes`/`edges`, `scope_finality_decisions`, `convergence_history`, etc. present.
- `loadFinalitySnapshot('default')` runs against real DB; Ollama (bge-m3) returns 1024-d embeddings.
- Script `scripts/test-postgres-ollama.ts` (pnpm run test:postgres-ollama) exercises Postgres + Ollama.
- **Unit tests**: 196 passing (semanticGraph, finalityEvaluator, convergenceTracker, finalityDecisions, governanceAgent finality, factsToSemanticGraph, embeddingPipeline, hitlFinalityRequest, activationFilters, etc.).
- **Convergence benchmark**: `npx tsx scripts/benchmark-convergence.ts` — 7 scenarios (pure math, no Docker) for Lyapunov, monotonicity, plateau, divergence.

## HITL seed scenario

When finality cannot be reached (e.g. contradiction or confidence below thresholds), the finality agent calls a chat agent to explain for the human why it is not reached and what minimally would take to reach it; the human can then provide new facts or a resolution (or evaluate if acceptable). To seed a **deterministic scenario** that triggers this HITL path:

- Run after migrations (and optionally after `seed:all`): `pnpm run seed:hitl`
- This populates the semantic graph with a state that yields goal_score in the near-finality band and one unresolved contradiction (or similar blocker). Start the swarm; when governance runs `runFinalityCheck`, a finality_review will appear in the MITL pending list and the feed will show near_finality with dimension breakdown and suggested actions.

## Preflight (check services before swarm)

- **scripts/check-services.ts** (pnpm run check:services): Verifies Postgres, S3, NATS, and facts-worker are reachable before starting agents. Avoids "fetch failed" when facts-worker is still provisioning.
- **CHECK_SERVICES_MAX_WAIT_SEC**: If set, retries until all pass or timeout (e.g. `CHECK_SERVICES_MAX_WAIT_SEC=300` for first-time facts-worker pip install).
- **CHECK_FEED=1**: Also checks the feed server (used by run-e2e.sh).
- **swarm-all.sh** runs check:services first; if it fails, suggests starting Docker and optionally waiting with CHECK_SERVICES_MAX_WAIT_SEC.

## Governance paths and E2E audit

Governance does not always run deterministic-only: for YOLO proposals it runs deterministic evaluation first, then (when an LLM is configured) a small **oversight agent** chooses accept deterministic, escalate to full LLM, or escalate to human. All paths are auditable.

**Routes (by proposal mode)**

- **MASTER / MITL**: Handled directly by `processProposal` (no oversight). MASTER always approves; MITL adds to pending. Audit: `context_events` rows with `type` proposal_approved / proposal_pending_approval and `governance_path: "processProposal"`.
- **YOLO**: (1) `evaluateProposalDeterministic` runs (no publish). (2) If no LLM: `commitDeterministicResult` with path `processProposal`. (3) If LLM: oversight agent runs; it may call `acceptDeterministic` (path `oversight_acceptDeterministic`), `escalateToLLM` (then full agent emits path `processProposalWithAgent`), or `escalateToHuman` (path `oversight_escalateToHuman`). Fallback when oversight does not call a tool: commit with path `oversight_acceptDeterministic`.

**Audit fields in context_events**

Every proposal decision written to the WAL includes `governance_path` when applicable: `processProposal` | `oversight_acceptDeterministic` | `oversight_escalateToLLM` | `oversight_escalateToHuman` | `processProposalWithAgent`. Query by `data->>'type' IN ('proposal_approved','proposal_rejected','proposal_pending_approval')` and `data->>'governance_path'` to verify which path was taken.

**E2E fixture and verification**

- **seed:governance-e2e**: Sets state (DriftChecked, epoch 5) and drift (high), then publishes three proposals: MASTER, MITL, YOLO (same transition). Expectation: MASTER approved (processProposal), MITL pending (processProposal), YOLO rejected (processProposal or oversight_acceptDeterministic). Prerequisites: migrations 002/003, S3 bucket, NATS stream; governance agent must run after seed to consume proposals.
- **verify:governance-paths**: Reads `context_events` and checks that at least one approved with processProposal + master_override, one pending with processProposal, and one rejected (reason containing "drift"). Exit 1 if any check fails. Run after governance has processed the seeded proposals.

## E2E

- **scripts/run-e2e.sh**: Starts Docker (postgres, s3, nats, facts-worker, feed), waits for Postgres then runs **check-services** (CHECK_FEED=1, max wait 300s) so facts-worker and feed are ready. Then reset, **migrations 002/003/005/006**, ensure-bucket, ensure-stream, seed, bootstrap, **ensure-pull-consumers**, seed:governance-e2e, swarm:all, waits, POSTs a doc, checks summary, nodes/edges, and **verify-governance-paths**. For full schema including 007–010 (scope state, MITL pending, processed messages, convergence_history), run **pnpm run ensure-schema** before swarm when not using run-e2e.
- **Push consumer fix**: If agents crash with "push consumer not supported", run `pnpm run ensure-pull-consumers` (or the script) before starting the swarm so durable consumers are recreated as pull. Then start the swarm again.
- **Facts-worker**: For the pipeline to write facts and sync to the semantic graph, the facts-worker must return 200 from `/extract`. In Docker it needs `OPENAI_API_KEY` (or Ollama reachable at `OLLAMA_BASE_URL`) and any model env; otherwise the worker may return 500 and the facts agent will log "Internal Server Error".
- **Facts-worker "Connection error" (500)**: The worker runs inside Docker and must reach the LLM backend. (1) **OpenAI**: leave `OLLAMA_BASE_URL` unset; ensure the container can reach the internet (e.g. no firewall blocking outbound HTTPS). (2) **Ollama on host**: set in `.env` `OLLAMA_BASE_URL=http://host.docker.internal:11434` (Mac/Windows; on Linux use host IP or `--add-host=host.docker.internal:host-gateway`). Run Ollama on the host and pull the extraction model (e.g. `ollama pull qwen3:8b`). Do not use `localhost` inside Docker for Ollama—it refers to the container, not the host.

## Not yet done / optional
- **Resolutions as goal completion**: when user posts a resolution, optionally mark one or more goals as `resolved` in the semantic graph (e.g. by convention or a small heuristic) so `goals_completion_ratio` increases.
- **HITL flow in UI**: MITL server already supports finality_review; a minimal UI or script to accept/reject/defer and emit the right response so governance/finality state is updated.
- **Embeddings by default**: set FACTS_SYNC_EMBED=1 in env to embed claim nodes after each facts sync (requires Ollama with bge-m3).
- **OpenFGA**: if OPENFGA_* is configured, policy checks are used; store/model setup and playground usage are doc’d in README.
- **E2E full schema**: run-e2e.sh runs 002/003/005/006 only; for 007–010 (scope state, MITL pending, processed messages, convergence_history), run **pnpm run ensure-schema** before swarm when not using run-e2e.

## Next steps (suggested order)

1. **E2E run**: With Postgres (ensure-schema or E2E subset), MinIO, NATS, and facts-worker up, run seed + bootstrap + swarm:all; POST a doc; verify facts in S3 and nodes/edges in DB; run `pnpm run test:postgres-ollama` (optional: FACTS_SYNC_EMBED=1 for embeddings).
2. **Resolutions -> goals**: When handling POST /context/resolution, optionally create or update goal nodes (e.g. one goal "User resolution" with status resolved) or map resolution text to existing goals so finality sees higher goal completion.
3. **HITL UX**: Expose finality review in the feed UI or a small CLI so operators can approve/reject/defer when finality triggers HITL (summary and GET /convergence already expose convergence state).
4. **Observability**: Finality outcome is logged; GET /convergence and summary expose convergence state. Optional: dedicated /finality endpoint or summary metrics for last outcome (RESOLVED / review_requested / ESCALATED).
