# Project Horizon — Enterprise Demo

A governed agent swarm processes an M&A due diligence package in real time.
Five documents. Multiple contradictions. One human decision at the right moment.

---

## What this demonstrates

Most AI agent systems are pipelines: step 1 calls step 2 calls step 3. When something unexpected happens — a contradiction, a policy constraint, a missing predecessor — they crash, skip, or require code changes. They are optimized for the demo, not for the enterprise.

This demo shows a different model: **governed coordination**. Agents are reasoning roles operating on a shared knowledge base. What they are *allowed* to do is determined by declarative policy, not hard-coded call chains. The system works autonomously until it genuinely cannot — then it asks a human the right question with the right context.

Specifically, the demo covers:

| Capability | What it looks like |
|---|---|
| Structured knowledge extraction | Claims, goals, and risks extracted from documents as addressable graph nodes |
| Contradiction detection | The system identifies when two documents say incompatible things about the same fact |
| Declarative governance rules | A YAML file blocks state transitions when drift exceeds policy thresholds |
| Audit trail | Every transition has a proposer, approver, rationale, and timestamp |
| Human-in-the-loop at finality | When the system is confident but not certain, it queues a structured review |
| Governed escalation | ESCALATED, BLOCKED, and EXPIRED states have defined semantics and recovery paths |
| Multi-scope isolation | Each deal / project / client is an isolated context with its own lifecycle |
| Identity-based access | Agents can only act in their assigned role (OpenFGA / Zanzibar authorization) |

---

## The scenario: Project Horizon

A strategic buyer in the pharmaceutical distribution sector is evaluating the acquisition of **NovaTech AG**, a B2B SaaS company specializing in supply chain compliance software.

The deal team receives five documents over the course of due diligence:

| # | Document | What it reveals |
|---|---|---|
| 1 | Initial Analyst Briefing | Strong initial profile: €50M ARR, 45% CAGR, 7 patents, low risk |
| 2 | Financial Due Diligence | Actual ARR is €38M — a €12M overstatement; two patents have co-ownership disputes |
| 3 | Technical Assessment | Core technology is solid, but CTO and two senior engineers are departing |
| 4 | Market Intelligence | Competitor filed patent infringement suit; largest client is evaluating alternatives |
| 5 | Legal Review | IP risks are manageable; acquisition recommended at €270M–€290M with conditions |

The swarm processes each document as it arrives, maintains a structured knowledge graph across the entire sequence, and enforces governance policy at every transition.

---

## Architecture in plain language

Before running the demo, here is what each component does — in business terms:

**Facts agent**
Reads each incoming document and extracts structured information: factual claims (with confidence scores), active goals, and risks. This is not keyword extraction — it is semantic understanding. The output is a set of typed, addressable nodes in a shared knowledge graph.

**Drift agent**
After each extraction cycle, compares the current knowledge state against the prior state. Detects contradictions (two claims that cannot both be true), goal shifts (a goal that changed between documents), and factual drift (a claim that changed significantly). Classifies drift severity: none, low, medium, or high.

**Governance agent**
Reads `governance.yaml` (or `governance-demo.yaml`) to decide whether a proposed state transition should proceed, be blocked, or trigger a remediation action. It does not decide the sequence — it decides whether each transition is currently safe given the known state. Every decision is logged. The governance agent is the control point that makes the system auditable.

**Planner agent**
Synthesizes the current facts, drift analysis, and governance recommendations into a ranked set of proposed next actions. It does not execute — it proposes. Execution happens only after governance approval.

**Finality evaluator**
After each governance cycle, scores the knowledge state across four dimensions: claim confidence, contradiction resolution, goal completion, and risk score. When the score passes the near-finality threshold (default: 75%), the system queues a structured human review rather than auto-resolving. When it passes the auto-finality threshold (default: 92%), it resolves the scope without human input.

**MITL server (human-in-the-loop queue)**
Holds pending finality reviews and (in MITL mode) pending proposals. A human reviews the system's explanation of what it knows, what is blocking resolution, and what would resolve each blocker. Four structured options: approve, provide resolution, escalate, or defer. The decision is recorded regardless of which option is chosen.

**Semantic graph**
Postgres with pgvector. Claims, goals, risks, and assessments are nodes. Contradictions, resolutions, and supports are typed edges. The finality evaluator queries this graph — not a flat list of facts — to compute the goal score. This is what allows the system to detect that two independent documents both contradict the same core claim.

---

## Prerequisites

- Docker and Docker Compose installed
- Node.js 20+ and npm
- Either an OpenAI API key or Ollama running locally with a compatible model

For local Ollama, you need the extraction model:
```bash
ollama pull qwen3:8b
```

---

## Setup

```bash
cd swarm-v0.1
cp .env.example .env
# Edit .env: set OPENAI_API_KEY or OLLAMA_BASE_URL

docker compose up -d postgres s3 nats facts-worker feed
npm install

# First run: wait up to 5 minutes for facts-worker to install Python deps
CHECK_SERVICES_MAX_WAIT_SEC=300 npm run check:services
```

Apply database migrations:
```bash
export PGPASSWORD="${POSTGRES_PASSWORD:-swarm}"
psql -h localhost -p 5433 -U swarm -d swarm -f migrations/002_context_wal.sql
psql -h localhost -p 5433 -U swarm -d swarm -f migrations/003_swarm_state.sql
psql -h localhost -p 5433 -U swarm -d swarm -f migrations/005_semantic_graph.sql
psql -h localhost -p 5433 -U swarm -d swarm -f migrations/006_scope_finality_decisions.sql
```

Initialize infrastructure:
```bash
npm run ensure-bucket
npm run ensure-stream
npm run bootstrap-once
```

To use the M&A-specific governance rules for this demo, set the governance path before starting the swarm:
```bash
export GOVERNANCE_PATH="$(pwd)/demo/scenario/governance-demo.yaml"
```

Start the swarm (in a dedicated terminal):
```bash
npm run swarm:all
```

Open the live dashboard: [http://localhost:3002](http://localhost:3002)

---

## Running the demo

### Option A — Automated demo UI (recommended)

Start the demo server on port 3003:
```bash
npm run demo
```

Then open [http://localhost:3003](http://localhost:3003) in a browser.

The demo UI provides:
- A narrative walkthrough of each step with per-step explanations
- Live event stream from the swarm (SSE, auto-connected)
- Real-time state panel: drift level, finality score, semantic graph summary
- Governance event highlighting when rules fire or transitions are blocked
- A structured HITL modal when near-finality triggers human review
- Speed control (Slow / Normal / Fast) and step-by-step manual advance
- Play/Pause for live presentations

The UI auto-advances through the five steps, feeding each document to the swarm and waiting for agents to process it before explaining what happened.

### Option B — Interactive shell walkthrough

For terminal-only environments or scripted walkthroughs:
```bash
./demo/run-demo.sh
```

For a faster, automated run (no pauses):
```bash
./demo/run-demo.sh --fast
```

To start at a specific step:
```bash
./demo/run-demo.sh --step 3
```

### Option C — Background seed (headless)

Feed all five documents with a configurable delay and observe via the existing feed UI at [http://localhost:3002](http://localhost:3002):
```bash
npm run seed:demo                        # 20s gap between documents (default)
DEMO_DELAY_MS=10000 npm run seed:demo   # 10s gap (faster)
DEMO_DOC=02 npm run seed:demo            # single document by prefix
```

---

## What to observe at each step

### Step 1 — Baseline (Doc 1: Initial Analyst Briefing)

The system has no prior context. The facts agent extracts the baseline claims from the briefing and populates the semantic graph. There is nothing to contradict, so drift is `none`. Governance auto-approves the transition. The finality score will be low (approximately 0.15–0.30) — the system is at the very start of the knowledge lifecycle.

Check the summary:
```bash
curl -s http://localhost:3002/summary?raw=1 | python3 -m json.tool | grep -A5 '"facts"'
```

Expected knowledge graph after Step 1:
- Claims: ARR €50M, 7 patents, 45% CAGR, 47 enterprise clients
- Goals: validate valuation, confirm IP ownership, complete diligence by Q4 2025
- Risks: none identified yet
- Contradictions: none

---

### Step 2 — Financial contradiction (Doc 2: Financial Due Diligence)

This is the first governance intervention.

The facts agent extracts the revised financial picture. The drift agent compares it against the Step 1 baseline. It finds:
- **Factual drift (high):** ARR changed from €50M to €38M — a 24% discrepancy
- **Contradiction:** IP ownership claim changed from "7 clean patents" to "2 patents with co-ownership dispute"

The governance agent evaluates the transition `DriftChecked → ContextIngested`. The `governance-demo.yaml` rule fires:

```yaml
transition_rules:
  - from: DriftChecked
    to: ContextIngested
    block_when:
      drift_level: [high]
    reason: "High drift detected — cycle is blocked until the planner proposes a remediation action."
```

The state machine is blocked. The cycle does not reset. The system does not silently proceed as if this were normal context. The block is logged with the reason and the proposer identity.

At the same time, the governance rules recommend remediation actions to the planner:
- `open_investigation` (contradiction detected)
- `request_external_audit` (value discrepancy detected)

These appear in `GET /summary → drift.suggested_actions`.

Check the drift state:
```bash
curl -s http://localhost:3002/summary?raw=1 | python3 -m json.tool | grep -A10 '"drift"'
```

Expected state after Step 2:
- `drift.level: "high"`
- `drift.suggested_actions: ["open_investigation", "request_external_audit"]`
- State machine: blocked at DriftChecked (cannot advance to ContextIngested)
- Semantic graph: new contradiction edge between ARR claim nodes

---

### Step 3 — Risk accumulation (Doc 3: Technical Assessment)

The facts agent processes the technical review. New risk nodes are added:
- CTO departure (high severity)
- Two founding engineers departing (high severity)
- EU MDR compliance debt (medium severity)
- Third-party data provider risk (low-medium)

The drift agent detects medium drift: new risk class introduced, but no direct contradiction of existing claims. The governance rule fires:
- `escalate_to_risk_committee` (risk drift at medium level)

The finality evaluator's `risk_score_inverse` dimension degrades as the number of active critical risks grows.

Check the semantic graph:
```bash
curl -s http://localhost:3002/summary?raw=1 | python3 -m json.tool | grep -A10 '"state_graph"'
```

Expected state after Step 3:
- New risk nodes visible in `state_graph.nodes`
- `drift.level: "medium"` (risk drift)
- Goal score may decrease (risk dimension penalty)

---

### Step 4 — Escalation risk (Doc 4: Market Intelligence)

The patent litigation alert arrives. The key structural development: patent EP3847291 is now contested from two independent directions simultaneously — the Axion Corp lawsuit (Claim 1) and the pre-existing Haber co-ownership dispute.

The semantic graph builds a contradiction structure: the claim "NovaTech holds 7 clean patents" now has two contradicting claims. The finality evaluator looks at `contradictions.unresolved_count`. If this reaches 3 or more, the `ESCALATED` finality condition may trigger:

```yaml
finality:
  ESCALATED:
    mode: any
    conditions:
      - contradictions.unresolved_count: ">= 3"
      - scope.risk_score: ">= 0.75"
```

This is not a pipeline failure — it is a defined finality state with clear recovery semantics.

Check the finality dimension breakdown:
```bash
curl -s http://localhost:3002/summary?raw=1 | python3 -m json.tool | grep -A20 '"finality"'
```

Expected state after Step 4:
- Multiple unresolved contradictions in semantic graph
- Finality status: `ESCALATED` or approaching `near_finality`
- Risk score elevated

---

### Step 5 — Near-finality (Doc 5: Legal Review)

The legal team provides an assessment that partially resolves the outstanding contradictions:
- Axion Claims 2 and 3 are likely to be dismissed (resolution path exists)
- Axion Claim 1 can be settled (settlement range specified)
- Haber IP buyout path is clear (price range specified)
- Revised acquisition price: €270M–€290M
- Recommendation: proceed to final negotiation with conditions

The facts agent extracts these as resolution-typed edges in the semantic graph. Contradictions that had no resolution edge now gain one. The `contradiction_resolution` dimension of the goal score improves.

The finality evaluator runs after governance processes the Step 5 transition. If the goal score crosses the near-finality threshold (0.75), the system does **not** auto-resolve — it builds a structured finality review and sends it to the MITL queue.

The review includes:
- Current goal score (e.g., 0.78)
- Which dimensions are passing and which are not
- The specific blockers preventing auto-resolution
- An LLM-generated explanation of what would resolve each blocker

Check the MITL queue:
```bash
curl -s http://localhost:3001/pending | python3 -m json.tool
```

Or open [http://localhost:3002](http://localhost:3002) — the "Pending reviews" section shows the review card with action buttons.

Expected state after Step 5:
- `finality.status: "near_finality"`
- `finality.goal_score` between 0.75 and 0.92
- One item in the MITL pending queue (finality_review)
- Dimension breakdown showing which factors are above/below threshold

---

### Step 6 — Human review (HITL finality decision)

The pending finality review contains:
1. The current goal score and what it means
2. Which conditions are met and which are not
3. A structured explanation of each blocker with context from the knowledge graph
4. Four decision options

**Option 1: Approve finality**
Accept the current state as the final outcome of this due diligence scope. The swarm will mark the scope `RESOLVED` with the current knowledge state as the record.

**Option 2: Provide resolution**
Supply additional context that the system should integrate. For example: "The board has approved proceeding at €280M subject to three conditions." The resolution is fed back as a context event, the facts pipeline re-runs, and drift may clear on the next cycle.

**Option 3: Escalate**
Route the review to a higher authority. The scope remains open and a new escalation record is created in the audit log.

**Option 4: Defer**
Postpone the decision for N days. Useful when awaiting an external event (e.g., waiting for the FY 2024 audit sign-off).

To approve from the terminal:
```bash
PROPOSAL_ID="<id from GET /pending>"
curl -X POST http://localhost:3002/finality-response \
  -H "Content-Type: application/json" \
  -d "{\"proposal_id\": \"${PROPOSAL_ID}\", \"option\": \"approve_finality\"}"
```

Or use the web UI at [http://localhost:3002](http://localhost:3002).

---

### Step 7 — Closing the loop with a resolution

After the HITL decision, feed the final board decision back as a resolution event:

```bash
curl -X POST http://localhost:3002/context/resolution \
  -H "Content-Type: application/json" \
  -d '{
    "decision": "Board approved proceeding to exclusivity with NovaTech AG at a revised offer of €280M. Three conditions must be met before signing: (1) Axion Corp licensing settlement executed, (2) Dr. Haber IP buyout completed, (3) CTO retention package for 12 months post-close signed.",
    "summary": "Project Horizon approved at €280M with three pre-signing conditions"
  }'
```

The swarm processes this as a new context event:
- The facts agent extracts it as a resolution goal node
- The drift agent detects that contradictions referenced in the resolution are now addressed
- The finality evaluator re-runs; if the goal score exceeds 0.92, the scope auto-resolves
- The full decision chain is in the audit log: every document, every drift event, every governance decision, every human choice

---

## Key governance moments — quick reference

| Moment | What triggered it | Business meaning |
|---|---|---|
| **Cycle blocked after Doc 2** | High drift (ARR contradiction) hit the `transition_rules` block | The system will not treat a €12M financial discrepancy as normal context and move on |
| **`open_investigation` recommended** | Contradiction drift at high level matched a governance rule | The governance layer told the planner to flag this formally, not silently absorb it |
| **`request_external_audit` recommended** | Value discrepancy drift matched a governance rule | The system recognized that internal documents are insufficient to resolve a financial claim dispute |
| **`escalate_to_risk_committee` recommended** | Risk drift at medium level matched a governance rule | New critical risks require structured escalation, not just a note in the log |
| **Near-finality HITL triggered after Doc 5** | Goal score crossed 0.75 but not 0.92 | The system had enough evidence to recommend, but not enough to decide — exactly the right moment for human judgment |
| **Decision recorded in audit log** | Every HITL choice is stored in `scope_finality_decisions` | The decision officer's choice is part of the permanent record, regardless of what was decided |

---

## Governance modes

The demo uses `YOLO` mode, which auto-approves valid transitions. For regulated enterprise contexts, two other modes are available:

**MITL (Machine-in-the-Loop)**
Every governance proposal goes to the human queue before being executed. Nothing moves forward without explicit approval. Use when all state transitions must be auditable and human-reviewed — for example, in a clinical trial context or a regulated financial process.

To switch:
```yaml
# governance-demo.yaml
mode: MITL
```

**MASTER**
Deterministic rule-based path only. No LLM rationale is generated. Every decision is computed from the transition rules in `governance.yaml`. Use in contexts where LLM-generated content cannot appear in a decision record.

To switch:
```yaml
# governance-demo.yaml
mode: MASTER
```

The governance mode is a one-line change. The agents, the semantic graph, and the finality evaluator are unchanged.

---

## Enterprise readiness features

**Audit trail**
Every state transition is stored in the `context_events` Postgres table (append-only WAL) with: event type, timestamp, proposer agent ID, approver (governance agent or human), rationale, and the full event payload. Nothing is deleted or overwritten. Query the log directly:
```sql
SELECT seq, ts, data->>'type' as type, data->'payload'->>'rationale' as rationale
FROM context_events
ORDER BY seq DESC
LIMIT 20;
```

**Policy as code**
`governance.yaml` is a version-controlled file. Changes are tracked in git. A compliance team can diff the policy between versions, understand what changed, and audit the history without reading agent code. Adding a new governance rule is a one-line YAML change — not a code deployment.

**Identity-based access control (OpenFGA)**
Each agent has an identity. The governance agent checks, before approving any proposal, whether the proposing agent has write permission on the target state node for the current scope. An agent assigned to the `drift` role cannot propose transitions that require `facts` write permission. This uses a Zanzibar-style relationship model (OpenFGA) — the full permission model is a first-class auditable object.

**Multi-scope isolation**
Each acquisition target, project, or client is a separate scope with its own semantic graph, finality state, and MITL queue. A single swarm infrastructure can serve multiple scopes simultaneously. OpenFGA enforces isolation — an agent authorized for scope `horizon` cannot read or write nodes in scope `project-atlas`. New scopes are created by setting `SCOPE_ID`.

**Heterogeneous models**
The extraction model (facts-worker), the governance rationale model, and the HITL explanation model are independent configuration parameters. A lower-stakes scope can use a lighter, faster model; a regulated scope can use a larger model with stricter prompting. The governance and finality layers stay constant.

**Horizontal scale**
The NATS JetStream pull consumer model means you can run multiple instances of any agent against the same stream. Each picks up one job, processes it, and proposes an advance. Epoch-based compare-and-swap on the state graph prevents double-advances. Adding capacity means running another process — not changing architecture.

**Defined lifecycle states**
A scope does not run forever or stop arbitrarily. It has four defined terminal states:

| State | Meaning | Recovery |
|---|---|---|
| RESOLVED | All conditions met, no blockers | None needed — scope is complete |
| ESCALATED | Risk or contradiction thresholds exceeded | Human review required before re-opening |
| BLOCKED | System is stuck; progress has stopped with open issues | Requires intervention (new context, resolution, or escalation) |
| EXPIRED | Scope has been inactive for 30 days | Archived; can be reopened with new context |

---

## Exploring further

**Change the approval mode**
Edit `demo/scenario/governance-demo.yaml`, change `mode: YOLO` to `mode: MITL`, and restart the swarm. Every proposal will now go to the MITL queue before execution. Watch the throughput change and observe how each transition requires human sign-off.

**Add a governance rule**
Add a rule to `governance-demo.yaml` that fires when drift type is `goal` at medium level. Observe how the planner's recommendations change after the next document is fed. No code change. No deployment. Restart the governance agent to reload the config.

**Observe the semantic graph directly**
```sql
-- All nodes for the demo scope
SELECT type, content, confidence, status
FROM nodes
WHERE scope_id = 'default'
ORDER BY type, created_at;

-- Unresolved contradictions
SELECT n1.content as claim_a, n2.content as claim_b, e.metadata
FROM edges e
JOIN nodes n1 ON e.source_id = n1.id
JOIN nodes n2 ON e.target_id = n2.id
WHERE e.edge_type = 'contradicts'
  AND e.scope_id = 'default'
  AND NOT EXISTS (
    SELECT 1 FROM edges r
    WHERE r.scope_id = e.scope_id
      AND r.source_id = e.source_id
      AND r.target_id = e.target_id
      AND r.edge_type = 'resolves'
  );
```

**Run multiple scopes**
Start a second instance of the swarm with `SCOPE_ID=project-atlas` and feed different documents. Observe that the two scopes have completely independent knowledge graphs, drift states, and finality evaluations — sharing the same infrastructure, enforced by OpenFGA.

**Enable semantic embeddings**
Set `FACTS_SYNC_EMBED=1` in `.env` and ensure Ollama is serving `bge-m3`. Claim nodes will be embedded with 1024-d vectors, enabling semantic similarity search across the knowledge graph. Useful for finding related claims across documents without exact text matching.

---

## File reference

| Path | Purpose |
|---|---|
| `demo/demo-server.ts` | Demo UI server — `npm run demo` — opens at http://localhost:3003 |
| `demo/scenario/docs/` | The five Project Horizon documents |
| `demo/scenario/governance-demo.yaml` | M&A-specific governance rules for this demo |
| `demo/run-demo.sh` | Shell walkthrough (alternative to the UI) |
| `scripts/seed-demo.ts` | Programmatic document feeder (`npm run seed:demo`) |
| `governance.yaml` | Default governance config (not M&A-specific) |
| `finality.yaml` | Finality thresholds and state conditions |
| `src/feed.ts` | Feed server source (port 3002) |
| `src/agents/governanceAgent.ts` | Governance agent — the policy enforcement point |
| `src/finalityEvaluator.ts` | Finality scoring and HITL routing |
| `src/semanticGraph.ts` | Semantic graph operations |
