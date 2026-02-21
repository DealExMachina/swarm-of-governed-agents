# Project status

Short snapshot of what exists, what is verified, and what comes next.

## What this is

Governed agent swarm: event-driven agents (facts, drift, planner, status) consume jobs from NATS, read/write shared context (Postgres WAL) and state graph (Postgres + S3 facts/drift). Governance and executor close the control loop (approve/reject proposals, execute transitions). A **semantic graph** (Postgres + pgvector) holds addressable nodes (claims, goals, risks) and edges (e.g. contradicts); a **finality** layer evaluates scope readiness (RESOLVED, ESCALATED, BLOCKED, etc.) and can trigger HITL review via the MITL server.

## Implemented and wired

**Core (existing)**

- Context WAL (`context_events`), state graph (`swarm_state`), migrations 002/003.
- NATS JetStream stream, four agents (facts, drift, planner, status), governance agent, executor.
- Governance rules (`governance.yaml`), OpenFGA policy checks, MITL server (approve/reject/options).
- Facts agent: readContext -> facts-worker `/extract` -> writeFacts to S3. Direct pipeline and optional Mastra orchestration.
- Feed server (port 3002): summary, POST context/docs, POST context/resolution.
- Docker Compose: Postgres (pgvector image), MinIO, NATS, facts-worker, OpenFGA, feed, otel-collector.

**Finality and semantic layer (recent)**

- **finality.yaml**: goal gradient weights, RESOLVED/ESCALATED/BLOCKED/EXPIRED conditions.
- **finalityEvaluator.ts**: `evaluateFinality(scopeId)` using `loadFinalitySnapshot(scopeId)`; Path A (auto RESOLVED when above threshold), Path B (near-finality -> HITL review).
- **hitlFinalityRequest.ts**: build HITL request, call Ollama for explanation, POST to MITL.
- **mitlServer.ts**: `finality_review` multi-option responses and NATS events.
- **governanceAgent.ts**: after each proposal handling, fire-and-forget `runFinalityCheck(SCOPE_ID)`; uses `SCOPE_ID` from env.
- **migrations/005_semantic_graph.sql**: `vector` extension, `nodes` (with `embedding vector(1024)`), `edges`, indexes, `nodes_notify` trigger.
- **semanticGraph.ts**: `appendNode` / `appendEdge`, `queryNodes` / `queryEdges`, `loadFinalitySnapshot(scopeId)`, `runInTransaction`, `deleteNodesBySource`.
- **embeddingPipeline.ts**: `getEmbedding` (Ollama bge-m3), `updateNodeEmbedding`, `embedAndPersistNode`.
- **factsToSemanticGraph.ts**: `syncFactsToSemanticGraph(scopeId, facts)`: replace fact-sourced nodes/edges for scope, insert claim/goal/risk nodes and contradiction edges; optional `embedClaims` (FACTS_SYNC_EMBED=1).
- **factsAgent writeFacts**: after S3 write, calls `syncFactsToSemanticGraph(scopeId, facts)`; sync failure is logged, S3 write still succeeds.
- **modelConfig.ts**: Ollama base URL, embedding model, chat/rationale/HITL models; SCOPE_ID.
- **docker-compose**: Postgres image `pgvector/pgvector:pg15`; facts-worker env (OLLAMA_BASE_URL, EXTRACTION_MODEL, HF_TOKEN, GLiNER, NLI).

**Verified**

- Migration 005 applied; Postgres + pgvector (vector 0.8.1) and tables `nodes`/`edges` present.
- `loadFinalitySnapshot('default')` runs against real DB; Ollama (bge-m3) returns 1024-d embeddings.
- Script `scripts/test-postgres-ollama.ts` (npm run test:postgres-ollama) exercises both.
- Unit tests: 134+ passing (including semanticGraph, finalityEvaluator, governanceAgent finality, factsToSemanticGraph, embeddingPipeline).

## HITL seed scenario

When finality cannot be reached (e.g. contradiction or confidence below thresholds), the finality agent calls a chat agent to explain for the human why it is not reached and what minimally would take to reach it; the human can then provide new facts or a resolution (or evaluate if acceptable). To seed a **deterministic scenario** that triggers this HITL path:

- Run after migrations (and optionally after `seed:all`): `npm run seed:hitl`
- This populates the semantic graph with a state that yields goal_score in the near-finality band and one unresolved contradiction (or similar blocker). Start the swarm; when governance runs `runFinalityCheck`, a finality_review will appear in the MITL pending list and the feed will show near_finality with dimension breakdown and suggested actions.

## Preflight (check services before swarm)

- **scripts/check-services.ts** (npm run check:services): Verifies Postgres, S3, NATS, and facts-worker are reachable before starting agents. Avoids "fetch failed" when facts-worker is still provisioning.
- **CHECK_SERVICES_MAX_WAIT_SEC**: If set, retries until all pass or timeout (e.g. `CHECK_SERVICES_MAX_WAIT_SEC=300` for first-time facts-worker pip install).
- **CHECK_FEED=1**: Also checks the feed server (used by run-e2e.sh).
- **swarm-all.sh** runs check:services first; if it fails, suggests starting Docker and optionally waiting with CHECK_SERVICES_MAX_WAIT_SEC.

## E2E

- **scripts/run-e2e.sh**: Starts Docker (postgres, s3, nats, facts-worker, feed), waits for Postgres then runs **check-services** (with CHECK_FEED=1, max wait 300s) so facts-worker and feed are ready before reset/migrations/seed/bootstrap/swarm. Then migrations 002/003/005, ensure-bucket, ensure-stream, seed, bootstrap, **ensure-pull-consumers**, swarm:all, waits, POSTs a doc, and checks summary and nodes/edges.
- **Push consumer fix**: If agents crash with "push consumer not supported", run `npm run ensure-pull-consumers` (or the script) before starting the swarm so durable consumers are recreated as pull. Then start the swarm again.
- **Facts-worker**: For the pipeline to write facts and sync to the semantic graph, the facts-worker must return 200 from `/extract`. In Docker it needs `OPENAI_API_KEY` (or Ollama reachable at `OLLAMA_BASE_URL`) and any model env; otherwise the worker may return 500 and the facts agent will log "Internal Server Error".
- **Facts-worker "Connection error" (500)**: The worker runs inside Docker and must reach the LLM backend. (1) **OpenAI**: leave `OLLAMA_BASE_URL` unset; ensure the container can reach the internet (e.g. no firewall blocking outbound HTTPS). (2) **Ollama on host**: set in `.env` `OLLAMA_BASE_URL=http://host.docker.internal:11434` (Mac/Windows; on Linux use host IP or `--add-host=host.docker.internal:host-gateway`). Run Ollama on the host and pull the extraction model (e.g. `ollama pull qwen3:8b`). Do not use `localhost` inside Docker for Ollama—it refers to the container, not the host.

## Not yet done / optional
- **Resolutions as goal completion**: when user posts a resolution, optionally mark one or more goals as `resolved` in the semantic graph (e.g. by convention or a small heuristic) so `goals_completion_ratio` increases.
- **HITL flow in UI**: MITL server already supports finality_review; a minimal UI or script to accept/reject/defer and emit the right response so governance/finality state is updated.
- **Embeddings by default**: set FACTS_SYNC_EMBED=1 in env to embed claim nodes after each facts sync (requires Ollama with bge-m3).
- **OpenFGA**: if OPENFGA_* is configured, policy checks are used; store/model setup and playground usage are doc’d in README.
- **README**: Updated with intent, architectural choices, semantic graph, finality, preflight, and current layout/scripts.

## Next steps (suggested order)

1. **E2E run**: With Postgres (with 002/003/005), MinIO, NATS, and facts-worker up, run seed + bootstrap + swarm:all; POST a doc; verify facts in S3 and nodes/edges in DB, and that `npm run test:postgres-ollama` still passes (optional: enable FACTS_SYNC_EMBED=1 and confirm embeddings written).
2. **Resolutions -> goals**: When handling POST /context/resolution, optionally create or update goal nodes (e.g. one goal "User resolution" with status resolved) or map resolution text to existing goals so finality sees higher goal completion.
3. **Documentation**: Add a short "Finality and semantic graph" section to README (finality.yaml, loadFinalitySnapshot, facts sync, migration 005, test:postgres-ollama, FACTS_SYNC_EMBED).
4. **HITL UX**: Expose finality review in the feed UI or a small CLI so operators can approve/reject/defer when finality triggers HITL.
5. **Observability**: Optionally log or expose finality outcome (RESOLVED / review requested) and snapshot metrics (e.g. in summary or a small /finality endpoint).
