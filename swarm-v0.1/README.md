# swarm-v0.1

One orchestrator + one "RLM facts" worker + a tiny state graph + RustFS (S3) continuous context. Deliberately minimal: polling + immutable context log + facts snapshot + drift report.

## Stack

- **TypeScript everywhere** for application code (orchestrator, S3, state graph, scripts, tests). The only exception is **Python workers** (e.g. facts-worker), which stay Python for the DSPy/RLM tooling.
- **Docker** for local services (MinIO, Postgres, facts-worker).
- **OpenAI-compatible endpoint** for the facts-worker (OpenAI, OpenRouter, Together, etc.); set `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` in `.env`.

## Architecture

**Storage (RustFS / S3-compatible)**

- `context/stream.jsonl` – append-only continuous context (events, doc snippets, observations)
- `context/cursor.json` – cursor for incremental processing (v0.2)
- `facts/latest.json` – latest extracted structured facts (typed: entities, claims, risks, goals, confidence)
- `drift/latest.json` – typed drift report (level, types: factual / goal / contradiction / entropy)

**Runtime**

- **orchestrator** (TypeScript): ticks every N seconds, loads cursor, processes only new lines, calls worker, writes facts/drift and status, updates cursor.
- **facts-worker** (Python, DSPy): OpenAI-compatible endpoint, JSON-constrained output, Pydantic Facts/Drift models, structured drift (factual, goal, contradiction, entropy).

**State graph**

- Nodes: `ContextIngested` -> `FactsExtracted` -> `DriftChecked` -> `ContextIngested`
- Minimal; optional snapshot in RustFS.

## Layout

```
swarm-v0.1/
  README.md
  .env.example
  package.json
  tsconfig.json
  vitest.config.ts
  migrations/
    001_leases.sql
  src/
    orchestrator.ts
    s3.ts
    stateGraph.ts
    lease.ts
    queue.ts
    shard.ts
    swarm.ts
    s3Counter.ts
    autoscaler.ts
    loadgen.ts
    agents/
      factsAgent.ts
      driftAgent.ts
      plannerAgent.ts
      statusAgent.ts
  test/
    unit/
      stateGraph.test.ts
      s3.test.ts
    integration/
      s3.integration.test.ts
  workers/
    facts-worker/
      requirements.txt
      requirements-dev.txt
      app.py
      rlm_facts.py
      tests/
        unit/
          test_rlm_facts.py
        integration/
          test_app.py
  docker-compose.yml
```

## Run locally

```bash
cp .env.example .env
docker compose up -d
npm i
npm run dev
```

Create the bucket `swarm` in MinIO if needed (v0.1 leaves this manual). Console: http://localhost:9001

## Tests

**TypeScript (Vitest)**

```bash
npm i
npm run test          # run once
npm run test:watch    # watch mode
```

- Unit: `test/unit/` (state graph, S3 helpers with mocked client).
- Integration: `test/integration/s3.integration.test.ts` runs only when `S3_ENDPOINT`, `S3_ACCESS_KEY`, and `S3_SECRET_KEY` are set (e.g. MinIO up).

**Python (pytest)**

```bash
cd workers/facts-worker
pip install -r requirements.txt -r requirements-dev.txt
pytest tests/ -v
```

- Unit: `tests/unit/test_rlm_facts.py` (stable_hash, compute_drift, extract_facts_and_drift with mocked program).
- Integration: `tests/integration/test_app.py` (FastAPI TestClient for `POST /extract`, mocked DSPy).

After the first run you should see in the bucket:

- `context/stream.jsonl`
- `context/cursor.json` (v0.2)
- `facts/latest.json` (v0.2: version 2, entities, claims, risks, goals, confidence)
- `drift/latest.json` (v0.2: level, types, facts_hash)

## v0.2 (done)

- DSPy + OpenAI-compatible endpoint; JSON-constrained output; Pydantic Facts/Drift.
- Incremental cursor: only new context lines are sent to the worker; cursor updated after success.
- Typed drift: factual, goal, contradiction, entropy.

## v0.3 (swarm)

Multiple agents work concurrently via a job queue and **Postgres-backed leases** so only one agent processes a given job until the lease expires or the job is completed.

**Lease table (Postgres)**

Leases give exclusive right to process a job. S3 has no compare-and-swap: two agents could both write a "lease" file and think they won. With a single `leases` table in Postgres we do an atomic `INSERT ... ON CONFLICT (job_id) DO UPDATE SET ... WHERE lease_until < now() OR leased_by = $agent RETURNING *`. Only one agent gets a row back; others get nothing. If an agent crashes, `lease_until` passes and another agent can take the job. Schema: `migrations/001_leases.sql`; `src/lease.ts` implements `tryLease(jobId, agentId, leaseSeconds)` and `releaseLease(jobId)`.

**Storage (v0.3)**

- **Queue (S3):** `queue/pending/<type>/<jobId>.json`, `queue/done/<jobId>.json`. Jobs are keyed by type (extract_facts, check_drift, plan_actions, summarize_status) so the autoscaler can count by prefix; leases live in Postgres.
- **Shards:** `context/shards/shard-00.jsonl` … (optional; `shard.ts` + `SHARD_COUNT` for future stream sharding).
- **Facts/drift:** `facts/latest.json`, `facts/history/`, `drift/latest.json`, `drift/history/`.

**Agents**

- **FactsAgent:** calls the Python facts-worker, writes facts + history.
- **DriftAgent:** snapshots drift to history.
- **PlannerAgent:** if drift is medium/high, enqueues status jobs (e.g. open_investigation, request_goal_refresh).
- **StatusAgent:** appends a compact status card to the context stream.

**Run the swarm**

Requires Postgres (e.g. `docker compose up -d`), MinIO, facts-worker, and `DATABASE_URL` in `.env`. Create the lease table on first run (automatic via `ensureLeaseTable()`).

```bash
# Terminal 1
AGENT_ROLE=facts  AGENT_ID=facts-1  npm run swarm

# Terminal 2
AGENT_ROLE=drift  AGENT_ID=drift-1  npm run swarm

# Terminal 3
AGENT_ROLE=planner AGENT_ID=planner-1 npm run swarm

# Terminal 4
AGENT_ROLE=status AGENT_ID=status-1 npm run swarm
```

Each process only picks jobs of its role. After completing a job it re-enqueues one of the same type (heartbeat). If you kill an agent, its lease expires (default 30s) and another can take the job.

## v0.3.1 (lock fix + Node autoscaler)

**Lock correctness**

If one agent lists pending jobs and another completes a job before the first reads it, the first would throw "Job not found". The swarm now catches that error and skips to the next key (no crash).

**Queue layout by type**

Pending keys are `queue/pending/<type>/<jobId>.json` so S3 prefix counts are per-type. The autoscaler counts `queue/pending/extract_facts/` with pagination.

**Node autoscaler (no AWS CLI, no bash)**

- `src/s3Counter.ts` – `countPrefix(s3, bucket, prefix)` with full ListObjectsV2 pagination.
- `src/autoscaler.ts` – loop: count pending extract_facts, compute desired facts agents (ceil(pending / TARGET_PER_AGENT), clamped to 1..MAX_FACTS), spawn or kill `node dist/swarm.js` with `AGENT_ROLE=facts`. Uses `dist/` so run `npm run build` first.
- Scripts: `build` (tsc), `start` (node dist/swarm.js), `autoscale` (node dist/autoscaler.js), `loadgen` (node dist/loadgen.js).

**Loadgen**

```bash
npm run build
node dist/loadgen.js 5    # enqueue 5 extract_facts jobs
npm run autoscale         # scale facts agents by queue depth
```

Increase load with `node dist/loadgen.js 10` or `15`; autoscaler scales up/down within MAX_FACTS (6) and TARGET_PER_AGENT (20). Pure Node + @aws-sdk/client-s3; works on MinIO, RustFS, real S3.
