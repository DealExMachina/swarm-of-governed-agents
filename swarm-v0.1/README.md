# swarm-v0.1

Governed agent swarm: multiple agents consume jobs from NATS JetStream, interact with a Postgres-backed state graph, and follow declarative governance rules. Context is an append-only event log in Postgres; facts and drift live in S3.

## Why this exists

This repo is an **experiment** to move agents **out of fixed workflows** and into **reasoning roles** that react to events over a **shared context and facts state**. Instead of a single DAG or scripted pipeline, we want:

- **Event-driven activation:** New events (e.g. a document in the context WAL) hit a shared, durable context and facts layer. Agents run when their conditions are met (state node, filters, jobs), not because a workflow step called them.
- **Shared state graph:** A small state machine (ContextIngested → FactsExtracted → DriftChecked → ContextIngested) plus S3-held facts and drift give every agent the same view of “what is known” and “what changed.” Reasoning (facts extraction, drift, planning, status) is done by **roles** that read and write that shared state.
- **Governance, not ad-hoc wiring:** Who can do what, and when transitions are allowed, is governed by **OpenFGA** (policy checks: agent X can write to node Y) and **declarative rules** in `governance.yaml` (e.g. block cycle reset when drift is high, suggest `open_investigation` on contradiction). The system stays auditable and policy-driven instead of hard-coded.

So the goal is: agents as **reasoning roles** that respond to events, share one context/facts/state picture, and are constrained by OpenFGA and governance rules. This README describes how that is implemented and how to run the demo.

## Stack

- **TypeScript** for orchestration, state graph, event bus client, agents, and tests.

**Dependencies:** All runtime and dev dependencies use stable majors (e.g. `@aws-sdk/client-s3` ^3.x, `@mastra/core` ^0.24.x, `zod` ^3.x, `vitest` ^2.x). Major upgrades (dotenv 17, vitest 4, zod 4) are left for deliberate migration; `npm outdated` may show newer majors.
- **Python** for the facts-worker (DSPy/OpenAI) used by the facts agent.
- **Docker** for MinIO, Postgres, NATS JetStream, and the facts-worker.
- **NATS JetStream** as the event bus (job dispatch, durable consumers).
- **Postgres** for the context WAL (`context_events`) and state graph (`swarm_state` with epoch CAS).
- **S3-compatible (MinIO)** for facts, drift snapshots, and history.

## Architecture

**Event bus (NATS JetStream)**

- Stream `SWARM_JOBS` with subjects `swarm.jobs.>`.
- Job types: `extract_facts`, `check_drift`, `plan_actions`, `summarize_status`.
- Each agent consumes its subject with a durable consumer; no S3 queue, no leases.

**Context and state**

- **Context WAL:** Postgres table `context_events` (seq, ts, data JSONB). Agents append events and read via `tailEvents` / `eventsSince`.
- **State graph:** Postgres table `swarm_state` (singleton). Nodes: `ContextIngested` -> `FactsExtracted` -> `DriftChecked` -> `ContextIngested`. Transitions use epoch-based CAS; governance rules can block transitions (e.g. high drift blocks cycle reset).
- **S3:** `facts/latest.json`, `facts/history/`, `drift/latest.json`, `drift/history/`.

**Governance**

- `governance.yaml` defines rule-based actions (e.g. open_investigation when drift is medium/high and type is contradiction) and transition rules (e.g. block DriftChecked -> ContextIngested when drift level is high).
- The planner agent evaluates rules; the swarm passes drift and governance into `advanceState` for transition gating.

**Agents**

- **Facts:** Reads context from WAL, calls Python facts-worker `/extract`, writes facts and drift to S3. Requires node `ContextIngested`, advances to `FactsExtracted`.
- **Drift:** Snapshots drift to S3 history. Requires `FactsExtracted`, advances to `DriftChecked`.
- **Planner:** Evaluates governance rules, dispatches status jobs for recommended actions. Requires `DriftChecked`, advances to `ContextIngested` (unless blocked by transition rules).
- **Status:** Appends a status card to the context WAL. No state precondition; does not advance the graph.

## Layout

```
swarm-v0.1/
  README.md
  .env.example
  package.json
  tsconfig.json
  vitest.config.ts
  governance.yaml
  migrations/
    002_context_wal.sql
    003_swarm_state.sql
  src/
    s3.ts
    contextWal.ts
    stateGraph.ts
    eventBus.ts
    agentRegistry.ts
    governance.ts
    logger.ts
    swarm.ts
    loadgen.ts
    agents/
      factsAgent.ts
      driftAgent.ts
      plannerAgent.ts
      statusAgent.ts
  test/
    unit/
    integration/
  workers/
    facts-worker/
      app.py
      rlm_facts.py
      requirements.txt
      tests/
  docker-compose.yml
```

## Run locally

**Initial conditions:** NATS must be running with JetStream enabled (e.g. `docker run -d -p 4222:4222 nats:latest -js` or your `docker compose`). The swarm ensures the JetStream stream exists before agents subscribe; you can run `npm run ensure-stream` once to create it, or let `npm run swarm:all` do it automatically.

```bash
cp .env.example .env
# Set OPENAI_API_KEY (and optionally OPENAI_BASE_URL, OPENAI_MODEL) for the facts-worker.
docker compose up -d
npm i
```

**Docker: ports and restart**

Exposed ports (host:container):

| Port  | Service       | Purpose                    |
|-------|---------------|----------------------------|
| 3002  | feed          | SSE event feed (HTML UI at `/`, stream at `/events`) |
| 4222  | nats          | NATS client                |
| 8222  | nats          | NATS monitoring            |
| 5433  | postgres      | Postgres (internal 5432)   |
| 9000  | s3 (MinIO)    | S3 API                     |
| 9001  | s3 (MinIO)    | MinIO console              |
| 8010  | facts-worker  | Facts extraction API       |
| 3000  | openfga       | OpenFGA Playground (use http://localhost:3000/playground; `/` returns 404) |
| 8080  | openfga       | OpenFGA HTTP API (swarm uses this for policy checks)                        |
| 8081  | openfga       | OpenFGA gRPC (internal)                                                     |
| 4317  | otel-collector| OTLP gRPC                  |
| 4318  | otel-collector| OTLP HTTP                  |

To use the latest images and recreate containers:

```bash
docker compose pull
docker compose up -d --force-recreate
```

Create the bucket `swarm` in MinIO if needed (e.g. http://localhost:9001). Run migrations (Postgres):

```bash
psql "$DATABASE_URL" -f migrations/002_context_wal.sql
psql "$DATABASE_URL" -f migrations/003_swarm_state.sql
```

Run the swarm. Stream is created automatically; use `BOOTSTRAP=1` to seed initial jobs:

```bash
BOOTSTRAP=1 npm run swarm:all
# Or without bootstrap (stream only): npm run swarm:all
# Or ensure stream once then start agents manually:
npm run ensure-stream
npm run swarm:all
```

Run all four agents manually (separate terminals):

```bash
AGENT_ROLE=facts   AGENT_ID=facts-1   npm run swarm
AGENT_ROLE=drift   AGENT_ID=drift-1   npm run swarm
AGENT_ROLE=planner AGENT_ID=planner-1 npm run swarm
AGENT_ROLE=status  AGENT_ID=status-1  npm run swarm
```

**Monitoring and logs**

- **Per-agent logs:** When using `npm run swarm:all`, each agent writes to `$LOG_DIR/swarm-<role>.log` (default `LOG_DIR=/tmp`). To watch one agent: `tail -f /tmp/swarm-facts.log`. To see all: `tail -f /tmp/swarm-*.log`.
- **Live event stream (CLI):** `npm run observe` tails `swarm.events.>` from NATS and pretty-prints events (bootstrap, proposals, state transitions, briefings, etc.) in the terminal. Ctrl+C to stop.
- **Live event feed (HTTP):** `npm run feed` starts an SSE server (default port 3002), or run it in Docker via `docker compose up -d` (feed service). Open `http://localhost:3002/` for the HTML event list, or `http://localhost:3002/events` for raw SSE. **Demo API:** `GET http://localhost:3002/summary` returns state, facts, drift, and what changed; `POST http://localhost:3002/context/docs` with JSON `{ "title", "body" }` adds a document and triggers the pipeline.

**Where it starts working**

The pipeline runs when (1) the state graph is at the right node for each agent, and (2) there is **context** for the facts agent to read. Context is the append-only log in Postgres (`context_events`). The facts agent calls `tailEvents(200)` and sends that to the Python facts-worker; if the WAL is empty, extraction has nothing to work on.

**What kind of docs to load**

Context events are JSON objects; the facts-worker expects events that contain readable **text** (e.g. a `text` field). The worker’s LLM extracts:

- **entities** (people, orgs, products)
- **claims**, **risks**, **assumptions**, **contradictions**, **goals**
- **confidence** (0–1)

So use **prose or semi-structured text** that supports that: announcements, reports, memos, meeting notes, articles, product briefs. Plain text or Markdown is fine. Each event can be one doc or one chunk; the last 200 events in the WAL are sent together as context for a single extraction. Drift is then computed by comparing this extraction to the previous one (so loading new or updated docs over time will produce drift and trigger governance rules).

**You need to load context (e.g. a doc) once** so the facts agent has input:

```bash
# Seed the context WAL with a sample snippet (or pass a file path)
npm run seed
# Or seed from a file:
npm run seed -- /path/to/your-doc.txt

# Or seed the full set of sample business docs (recommended):
npm run seed:all
```
`seed:all` loads all `.txt`/`.md` files from `seed-docs/` in order (see `seed-docs/README.md`).

Then run bootstrap so the pipeline sees the new context and starts the cycle:

```bash
npm run ensure-stream
node --loader ts-node/esm scripts/bootstrap-once.ts
```

Start governance and executor (separate terminals), then the four worker agents. The facts agent runs when it sees a **new context** event in the WAL (type `bootstrap` or `context_doc`). After a full cycle (ContextIngested -> FactsExtracted -> DriftChecked -> ContextIngested), the loop **suspends** until you add more docs or run bootstrap again.

**Real demo flow**

1. **Initial context:** Seed docs, then bootstrap (WAL gets `context_doc` and `bootstrap`). Start feed, swarm agents, governance, executor.
2. **Add more docs:** POST a document to trigger the pipeline again:
   ```bash
   curl -s -X POST http://localhost:3002/context/docs -H "Content-Type: application/json" -d '{"title":"Q4 update","body":"Acme revised guidance: revenue target now $2.5M."}'
   ```
   The facts agent will run when it sees the new `context_doc` in the WAL.
3. **User-facing output:** GET a summary of state, facts, drift, and what changed:
   ```bash
   curl -s http://localhost:3002/summary
   ```
   Returns: `state` (lastNode, epoch), `facts` (goals, confidence), `drift` (level, types, notes), `what_changed` (recent pipeline events).
4. **Consensus and suspend:** When the full context has been processed and the state advances to `ContextIngested` again, no new `context_doc` or `bootstrap` is appended, so the facts agent does not re-run and the loop stays idle until you add another doc or re-bootstrap.

Load generation (publish jobs to NATS):

```bash
npm run build
npm run loadgen -- 5
```

## Tests

**TypeScript (Vitest)**

```bash
npm run test
npm run test:watch
```

- Unit tests in `test/unit/` (state graph, S3, context WAL, event bus, governance, logger, agent registry). No external services required; NATS/Postgres are mocked where needed.
- Integration tests in `test/integration/` require `DATABASE_URL`, `NATS_URL`, and/or S3 env vars; they are skipped when unset (`describe.skipIf(...)`).

**Python (pytest)**

```bash
cd workers/facts-worker
pip install -r requirements.txt -r requirements-dev.txt
pytest tests/ -v
```

## Scripts

- `npm run swarm` – run one swarm agent (set `AGENT_ROLE`, `AGENT_ID`).
- `npm run swarm:all` – start facts, drift, planner, and status agents in the background.
- `npm run build` – compile TypeScript to `dist/`.
- `npm run start` – run compiled swarm entry (`node dist/swarm.js`).
- `npm run loadgen -- <count>` – publish `<count>` extract_facts jobs to NATS.
- `npm run seed [file]` – seed the context WAL with a sample or with the content of `file` (emits `context_doc`; facts run when they see it).
- `npm run seed:all` – seed from all `.txt`/`.md` in `seed-docs/`.
- `npm run check:model` – test that the OpenAI-compatible model is reachable with current `.env` (same config as facts agent and facts-worker).

**Feed server (port 3002):** `GET /` or `GET /summary` (dashboard: state, facts, drift with why/suggested/sources, live events), `GET /summary?raw=1` (JSON), `POST /context/docs` (add doc to trigger pipeline).
