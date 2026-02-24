# Dual Temporality of Facts, Entities & Governance — PRD & Design Review

**Branch:** `feature/dual-temporality`
**Parent:** `feature/finality-design`
**Status:** Architecture Review — NOT YET IMPLEMENTING
**Date:** 2026-02-24

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Core Concepts](#2-core-concepts)
3. [Current State Analysis](#3-current-state-analysis)
4. [Requirements](#4-requirements)
5. [Critical Issues in Current System](#5-critical-issues-in-current-system)
6. [Proposed Architecture](#6-proposed-architecture)
7. [Data Model](#7-data-model)
8. [Temporal Queries](#8-temporal-queries)
9. [Impact on Existing Subsystems](#9-impact-on-existing-subsystems)
10. [High-Level Implementation Plan](#10-high-level-implementation-plan)
11. [Risk Register](#11-risk-register)
12. [Open Questions](#12-open-questions)
13. [Resources & References](#13-resources--references)

---

## 1. Problem Statement

The swarm currently treats time as a single dimension: **when did we record it?** Every fact, entity, governance decision, and event carries a single `created_at` or `ts` timestamp — the moment the system persisted the record. This is **transaction time**.

What the system does not track is the equally critical second dimension: **when is/was the fact valid or invalid in the real world?** This is **valid time**.

The absence of valid time creates five concrete failure modes:

### 1.1 Late-arriving facts cannot be temporally placed

An agent ingests an audited financial report dated FY2025 (valid Jan–Dec 2025) on February 15, 2026. The system records `created_at = 2026-02-15` but loses the information that the facts within are valid for the 2025 fiscal year. If another agent later ingests a preliminary (unaudited) report for the same period, the system cannot determine which fact was valid at which time — it only knows the order of ingestion.

### 1.2 Evidence staleness is invisible

A compliance certificate was obtained 11 months ago (valid time). It has a 12-month validity window. In one month, the evidence will be stale, but the system has no way to express this because facts don't carry validity windows. The evidence coverage metric (finality Gate B) cannot account for temporal expiry.

### 1.3 Contradictions lack temporal context

Two claims contradict each other, but they may refer to different time periods. "Revenue was $8M" (FY2024) and "Revenue was $10M" (FY2025) are not contradictions — they're successive truths. Without valid time on claims, the contradiction detector (semantic graph) cannot distinguish temporal succession from genuine disagreement.

### 1.4 Governance decisions cannot be reconstructed

When the system evaluates governance rules, it uses the current `governance.yaml` and `finality.yaml`. There is no record of which policy version was in effect at the time a past decision was made. For audit reconstruction ("what rule authorized this action at epoch 47?"), the system is blind.

### 1.5 Finality over stale knowledge is unsound

The finality evaluator may declare RESOLVED based on facts that were valid when ingested but have since expired in the real world. Without valid time, the system cannot detect that its knowledge base has decayed.

---

## 2. Core Concepts

### 2.1 The two times

Every fact in the system exists in two temporal dimensions:

| Dimension | Question it answers | Example |
|-----------|-------------------|---------|
| **Valid time** (Tv) | When is/was this fact true or false in the real world? | "Revenue was $10M" is valid from Jan 1 2025 to Dec 31 2025 |
| **Transaction time** (Tt) | When did the system learn about this fact, making it applicable for decisions? | "We ingested the audited report on Feb 15 2026" |

These dimensions are **orthogonal**. A fact can be:

| State | Valid? | Known? | Meaning |
|-------|--------|--------|---------|
| **Known & valid** | ✓ | ✓ | Normal operating state — fact is in the knowledge base and currently true |
| **Known & expired** | ✗ | ✓ | Fact was ingested but its real-world validity has passed (stale evidence) |
| **Unknown & valid** | ✓ | ✗ | True in reality but the system hasn't learned it yet (blind spot) |
| **Unknown & expired** | ✗ | ✗ | Irrelevant — neither true nor known |

### 2.2 Temporal intervals vs instants

- **Valid time** is typically an **interval** `[Tv_from, Tv_to)`: a fact is true from one point to another. Open-ended intervals (`Tv_to = NULL`) mean "still valid as far as we know."
- **Transaction time** is typically an **instant** `Tt`: the moment the system recorded the fact. For superseded records, we add `Tt_superseded`: the moment a newer version replaced this record.

### 2.3 The four temporal states of a record

Combining both dimensions, every record has a lifecycle:

```
                    Transaction Time →
                    ┌─────────────────────────────────┐
                    │  Tt_recorded     Tt_superseded   │
                    │      │                │          │
  Valid Time ↓      │      ▼                ▼          │
  ┌─────────────────┼──────┬────────────────┬──────────┤
  │ Tv_from         │      │   CURRENT      │ HISTORY  │
  │                 │      │   (active)      │ (old     │
  │                 │      │                │  version) │
  │ Tv_to           │      │                │          │
  └─────────────────┼──────┴────────────────┴──────────┤
                    │                                   │
                    │  Before Tt_recorded: UNKNOWN      │
                    │  After Tt_superseded: SUPERSEDED  │
                    └─────────────────────────────────┘
```

### 2.4 Bitemporal queries

The dual time model enables four fundamental query types:

| Query | Description | SQL Pattern |
|-------|-------------|-------------|
| **Current** | What do we know now about what's true now? | `Tt_superseded IS NULL AND Tv_to IS NULL` |
| **As-of valid time** | What do we know now about what was true at time T? | `Tt_superseded IS NULL AND Tv_from <= T AND (Tv_to IS NULL OR Tv_to > T)` |
| **As-of transaction time** | What did we know at time T' about what's true now? | `Tt_recorded <= T' AND (Tt_superseded IS NULL OR Tt_superseded > T') AND Tv_to IS NULL` |
| **Full bitemporal** | What did we know at time T' about what was true at time T? | Both filters combined |

---

## 3. Current State Analysis

### 3.1 Temporal inventory

Comprehensive codebase audit reveals the system uses **single-timestamp, transaction-time-only** tracking everywhere:

| Subsystem | File(s) | Timestamps Present | Valid Time? | History? |
|-----------|---------|-------------------|-------------|---------|
| Semantic graph (nodes) | `semanticGraph.ts`, `005_semantic_graph.sql` | `created_at`, `updated_at`, `version` (counter) | ✗ | ✗ — `updated_at` overwrites |
| Semantic graph (edges) | same | `created_at` | ✗ | ✗ |
| Context WAL | `contextWal.ts`, `002_context_wal.sql` | `ts` (transaction time), `seq` (logical order) | ✗ | ✓ — append-only |
| State machine | `stateGraph.ts`, `003_swarm_state.sql` | `updated_at`, `epoch` (logical clock) | ✗ | ✗ — single row per scope |
| Convergence history | `convergenceTracker.ts`, `010_convergence_tracker.sql` | `created_at`, `epoch` | ✗ | ✓ — append-only |
| Finality decisions | `finalityDecisions.ts`, `006_scope_finality_decisions.sql` | `created_at` | ✗ | ✓ — latest wins |
| Governance policy | `governance.ts`, `governance.yaml` | None (loaded at startup) | ✗ | ✗ — no versioning |
| Finality policy | `finalityEvaluator.ts`, `finality.yaml` | None (loaded at startup) | ✗ | ✗ — no versioning |
| Agent memory | `activationFilters.ts` | `lastActivatedAt`, `updatedAt` | ✗ | ✗ |
| MITL queue | `mitlServer.ts`, `008_mitl_pending.sql` | `created_at` | ✗ | ✗ |
| Message dedup | `messageDedup.ts`, `009_processed_messages.sql` | `processed_at` | ✗ | ✓ — append-only |

### 3.2 What works as transaction time (keep)

The `context_events` WAL is already an excellent transaction-time log:
- Append-only with `seq` (monotonic) + `ts` (wall clock)
- Captures every state transition, fact extraction, governance decision
- Can reconstruct system knowledge at any past `seq` or `ts`

The convergence history is also append-only with `epoch` + `created_at` — this is transaction-time history of convergence state.

### 3.3 What's missing (valid time)

No table in the system carries `valid_from` / `valid_to`. Specifically:

- **Nodes** have `created_at` (when ingested) but not "when was this claim true?"
- **Edges** have `created_at` (when relationship was detected) but not "when was this relationship valid?"
- **Contradiction edges** have no temporal scope — can't distinguish "contradicts at time T" from "contradicts always"
- **Governance policies** have no effective date — can't reconstruct which rules were active at epoch N
- **Evidence items** have no `obtained_at` or expiry — the `temporal_constraint: { max_age_days: N }` in evidence schemas has no anchor date to count from

### 3.4 Consequences on finality

The finality design (`finality-design.md`) identifies several gaps that are directly caused by missing valid time:

| Finality Concept | Temporal Dependency | Currently Broken? |
|-----------------|--------------------|--------------------|
| Evidence coverage | Needs `obtained_at` + `max_age_days` to check staleness | ✓ — cannot compute temporal validity |
| Contradiction mass | Needs `valid_from`/`valid_to` to determine if claims truly conflict or are temporally successive | ✓ — over-counts contradictions |
| Finality certificate | Needs policy version hashes (which policy was active?) | Partially — hashes are designed but no version tracking exists |
| BLOCKED status | Needs `last_delta_age_ms` — requires wall-clock age computation | ✓ — condition is declared but never evaluated |
| EXPIRED status | Needs `last_active_age_ms` — requires wall-clock staleness | ✓ — condition is declared but never evaluated |

---

## 4. Requirements

### 4.1 Functional requirements

| # | Requirement | Priority |
|---|------------|----------|
| FR1 | Every fact (node) in the semantic graph must carry a valid time interval `[Tv_from, Tv_to)` expressing when the fact is true in the real world | P0 |
| FR2 | Every relationship (edge) in the semantic graph must carry a valid time interval expressing when the relationship holds | P0 |
| FR3 | The system must be able to answer: "What facts were valid at time T, as we knew them at time T'?" (full bitemporal query) | P0 |
| FR4 | Governance policies must be versioned with effective dates: "Which policy was in force at time T?" | P0 |
| FR5 | Evidence items must carry `obtained_at` timestamps so that temporal constraints (`max_age_days`) can be evaluated against valid time, not transaction time | P0 |
| FR6 | Contradiction detection must consider temporal overlap: two claims are contradictory only if their valid time intervals overlap | P1 |
| FR7 | The finality evaluator must detect knowledge staleness: facts whose valid time has expired since ingestion | P1 |
| FR8 | Late-arriving facts (transaction time >> valid time) must be insertable without disrupting the current knowledge state | P1 |
| FR9 | Superseded facts (replaced by a newer version) must remain queryable for audit reconstruction | P1 |
| FR10 | The finality certificate must include the valid-time window of the knowledge base it certifies | P2 |
| FR11 | NATS events must carry both `published_at` (transaction time) and `valid_from`/`valid_to` (valid time) when applicable | P2 |
| FR12 | Time-travel queries: reconstruct the full semantic graph state as it was known at any past epoch | P2 |

### 4.2 Non-functional requirements

| # | Requirement | Target |
|---|------------|--------|
| NFR1 | Adding valid time columns must not degrade query performance by more than 10% | P95 of current queries |
| NFR2 | Bitemporal queries must complete in < 50ms for a typical scope (< 500 nodes, < 2000 edges) | P95 |
| NFR3 | Migration must be non-breaking: existing nodes without valid time default to `[created_at, NULL)` | Zero downtime |
| NFR4 | Storage overhead for bitemporal columns: < 20% increase in table size | Measured |

---

## 5. Critical Issues in Current System

### Issue 1: `updated_at` overwrites destroy history

**Problem:** When `updateNodeConfidence()` or `updateNodeStatus()` is called on a semantic graph node, `updated_at` is set to `now()` and the previous value is lost. The `version` counter increments but there is no record of what the previous confidence/status was.

**Impact:** Cannot answer "what was the confidence of claim X at epoch 30?" — only the latest value exists.

**Root cause:** The `nodes` table uses UPDATE semantics for confidence/status changes. There is no history table and no append-only versioning.

**Proposed fix:** Adopt insert-over-update semantics for node changes. Each change creates a new row with updated `Tt_recorded` and the previous row gets `Tt_superseded = now()`. This is the standard bitemporal "closing the old record" pattern.

### Issue 2: Contradiction detection ignores time

**Problem:** The semantic graph creates `contradicts` edges between claims that have opposing content. But it does not check whether the claims refer to the same time period. "Revenue was $8M" (FY2024) and "Revenue was $10M" (FY2025) would be flagged as contradictory when they are sequential truths.

**Impact:** Over-counting contradictions inflates `contradiction_mass`, making Gate B (epistemic stability) harder to pass. False contradictions waste agent time on resolution and can trigger unnecessary HITL escalation.

**Proposed fix:** Contradiction detection must check `tstzrange(a.valid_from, a.valid_to) && tstzrange(b.valid_from, b.valid_to)` — only claims with overlapping valid times can contradict.

### Issue 3: Evidence has no anchor for temporal constraints

**Problem:** The evidence schema defines `temporal_constraint: { max_age_days: 365 }` (finality-design.md Issue 6d) but there is no `obtained_at` field on evidence items. The constraint cannot be evaluated because there's no start date to count from.

**Impact:** Evidence coverage computation (`computeEvidenceCoverage()`) cannot detect stale evidence. Finality may be declared over expired knowledge.

**Proposed fix:** Evidence items carry `obtained_at` (when the evidence was obtained in the real world — valid time) and `recorded_at` (when it entered the system — already `created_at`). Staleness check: `obtained_at + max_age_days >= now()`.

### Issue 4: Governance has no temporal versioning

**Problem:** `governance.yaml` and `finality.yaml` are loaded at startup. There is no record of:
- When a policy was activated
- When a policy was superseded by a new version
- Which policy version was in force at a given epoch

**Impact:** Audit reconstruction is impossible. If a governance rule is changed, all historical decisions become un-reproducible — you cannot determine what rule authorized action X at epoch Y.

**Proposed fix:** Policy version table with bitemporal tracking: `effective_from` (valid time — when the policy takes effect), `recorded_at` (transaction time — when the system loaded it). Content hash + full content stored for reconstruction.

### Issue 5: BLOCKED and EXPIRED finality statuses are non-functional

**Problem:** `finality.yaml` defines temporal conditions:
```yaml
BLOCKED:
  conditions:
    - scope.idle_cycles: ">= 5"
    - scope.last_delta_age_ms: ">= 300000"  # 5 minutes
EXPIRED:
  conditions:
    - scope.last_active_age_ms: ">= 2592000000"  # 30 days
```

But `scope.last_delta_age_ms` and `scope.last_active_age_ms` are **never computed or stored**. The finality evaluator cannot evaluate these conditions.

**Impact:** Scopes that should be BLOCKED or EXPIRED remain ACTIVE indefinitely.

**Proposed fix:** Compute `last_delta_age_ms` from `swarm_state.updated_at` and `last_active_age_ms` from the latest `context_events.ts` for the scope. These are derived from existing timestamps but currently not wired into the finality snapshot.

### Issue 6: No time-travel queries possible

**Problem:** Because nodes are updated in-place and no history table exists, the system cannot reconstruct the semantic graph as it was at any past point. The only history is the WAL (context_events), which logs events but does not store snapshots.

**Impact:** Cannot reproduce a past finality decision. Cannot debug "why did the system think X at epoch Y?" Cannot perform retroactive analysis when new information arrives.

**Proposed fix:** Bitemporal node/edge tables with system versioning. Old versions are preserved with `superseded_at` timestamps. Time-travel queries filter by `recorded_at <= T' AND (superseded_at IS NULL OR superseded_at > T')`.

---

## 6. Proposed Architecture

### 6.1 Design principles

1. **Valid time is a first-class citizen on every fact** — every node and edge carries `valid_from` / `valid_to`
2. **Transaction time is preserved by the WAL** — the `context_events` table is already the transaction-time log; we extend it to reference node versions
3. **Append-over-update** — node changes create new versions rather than modifying existing rows
4. **Backward compatible** — existing nodes default to `valid_from = created_at, valid_to = NULL` (open-ended validity)
5. **PostgreSQL-native** — use `TIMESTAMPTZ` columns and `tstzrange` for overlap queries with GiST indexes; no external temporal database

### 6.2 Bitemporal semantic graph

```
┌─────────────────────────────────────────────────────────────────┐
│                    BITEMPORAL SEMANTIC GRAPH                      │
│                                                                   │
│  nodes table (append-over-update)                                │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ node_id | scope_id | type | content | confidence | status  │ │
│  │ ────────┼──────────┼──────┼─────────┼────────────┼──────── │ │
│  │         │          │      │         │            │         │ │
│  │  VALID TIME                    TRANSACTION TIME             │ │
│  │  valid_from  | valid_to        recorded_at | superseded_at │ │
│  │  (real-world)  (real-world)    (system)      (system)      │ │
│  │                                                             │ │
│  │  version (monotonic counter within same node_id lineage)   │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  edges table (same pattern)                                      │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ edge_id | source_id | target_id | type | weight            │ │
│  │ valid_from | valid_to | recorded_at | superseded_at        │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  QUERIES                                                         │
│  ├─ Current state: superseded_at IS NULL AND valid_to IS NULL   │
│  ├─ Valid-time slice: superseded_at IS NULL AND T ∈ [vf, vt)   │
│  ├─ Transaction-time slice: T' ∈ [recorded, superseded)        │
│  └─ Full bitemporal: both filters combined                      │
│                                                                   │
│  CONTRADICTION DETECTION                                         │
│  └─ Only flag contradictions when valid time intervals overlap  │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 6.3 Bitemporal governance

```
┌─────────────────────────────────────────────────────────────────┐
│                    BITEMPORAL GOVERNANCE                          │
│                                                                   │
│  policy_versions table                                           │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ version_id | policy_type | content_hash | content (JSONB)  │ │
│  │ effective_from | effective_to | recorded_at                 │ │
│  │                                                             │ │
│  │ • effective_from/to = valid time (when is this policy       │ │
│  │   applicable in the real world?)                            │ │
│  │ • recorded_at = transaction time (when did the system       │ │
│  │   learn about this policy version?)                         │ │
│  │                                                             │ │
│  │ Policy lookup:                                              │ │
│  │   "Which governance.yaml was in force at epoch E?"          │ │
│  │   → JOIN swarm_state ON epoch = E to get updated_at         │ │
│  │   → SELECT * FROM policy_versions                           │ │
│  │     WHERE effective_from <= updated_at                      │ │
│  │       AND (effective_to IS NULL OR effective_to > updated_at)│ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  decision_records table (extension of context_events)            │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ • Each governance decision references the policy_version_id │ │
│  │   that was in force when the decision was made              │ │
│  │ • Enables: "Under which rules was proposal P evaluated?"    │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 6.4 Evidence temporal validity

```
┌─────────────────────────────────────────────────────────────────┐
│                    EVIDENCE VALIDITY                              │
│                                                                   │
│  Evidence items in semantic graph carry:                         │
│  ├─ valid_from: when the evidence was produced/obtained          │
│  ├─ valid_to: computed from valid_from + max_age_days            │
│  │            (from evidence_schemas.yaml temporal_constraint)   │
│  └─ recorded_at: when the system ingested it (created_at)       │
│                                                                   │
│  Evidence lifecycle:                                             │
│  ┌──────────┬──────────────────────┬───────────────┐            │
│  │ obtained │  ← VALID WINDOW →   │  EXPIRED      │            │
│  │ (real    │  (counts toward      │  (remains in  │            │
│  │  world)  │   coverage)          │   graph but   │            │
│  │          │                      │   not counted)│            │
│  └──────────┴──────────────────────┴───────────────┘            │
│       Tv_from                Tv_to = Tv_from + max_age          │
│                                                                   │
│  Staleness detection:                                            │
│  └─ computeEvidenceCoverage() checks: now() < valid_to          │
│     for each evidence item. Expired items → excluded from       │
│     coverage score, flagged as stale.                            │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 6.5 Late-arriving facts

```
┌─────────────────────────────────────────────────────────────────┐
│                    LATE-ARRIVING FACT HANDLING                    │
│                                                                   │
│  Timeline:                                                       │
│  ─────────────────────────────────────────────────────────→ time │
│       │                          │                               │
│    Tv_from                    Tt_recorded                        │
│    (fact was true              (system learns                    │
│     back here)                  about it now)                    │
│                                                                   │
│  Example:                                                        │
│  • Feb 24: Agent ingests FY2025 audited report                  │
│    → valid_from = 2025-01-01, valid_to = 2025-12-31             │
│    → recorded_at = 2026-02-24                                    │
│                                                                   │
│  On insertion:                                                    │
│  1. Insert node with valid_from in the past                     │
│  2. Check for temporal overlaps with existing active nodes       │
│  3. If overlap found with conflicting content →                 │
│     create contradiction edge (both nodes in same valid window) │
│  4. If overlap found with consistent content →                  │
│     supersede older node (same fact, newer version)             │
│  5. Log the late arrival as a WAL event for audit               │
│                                                                   │
│  This does NOT disrupt current-state queries:                    │
│  • Current state = superseded_at IS NULL AND valid_to IS NULL   │
│  • Past-valid-time queries can see the back-dated fact          │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 7. Data Model

### 7.1 Nodes table (bitemporal extension)

```sql
-- Migration: Add bitemporal columns to nodes
ALTER TABLE nodes ADD COLUMN valid_from  TIMESTAMPTZ;
ALTER TABLE nodes ADD COLUMN valid_to    TIMESTAMPTZ;
ALTER TABLE nodes ADD COLUMN recorded_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE nodes ADD COLUMN superseded_at TIMESTAMPTZ;  -- NULL = current version

-- Backfill: existing nodes get open-ended validity from creation time
UPDATE nodes SET valid_from = created_at WHERE valid_from IS NULL;

-- Make valid_from NOT NULL after backfill
ALTER TABLE nodes ALTER COLUMN valid_from SET NOT NULL;

-- GiST index for temporal overlap queries
CREATE INDEX idx_nodes_valid_period
  ON nodes USING GIST (scope_id, tstzrange(valid_from, valid_to));

-- Index for current-state queries (most common)
CREATE INDEX idx_nodes_current
  ON nodes (scope_id, type, status)
  WHERE superseded_at IS NULL;

-- Index for transaction-time queries
CREATE INDEX idx_nodes_recorded
  ON nodes (scope_id, recorded_at DESC)
  WHERE superseded_at IS NULL;
```

### 7.2 Edges table (bitemporal extension)

```sql
ALTER TABLE edges ADD COLUMN valid_from    TIMESTAMPTZ;
ALTER TABLE edges ADD COLUMN valid_to      TIMESTAMPTZ;
ALTER TABLE edges ADD COLUMN recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE edges ADD COLUMN superseded_at TIMESTAMPTZ;

UPDATE edges SET valid_from = created_at WHERE valid_from IS NULL;
ALTER TABLE edges ALTER COLUMN valid_from SET NOT NULL;

CREATE INDEX idx_edges_valid_period
  ON edges USING GIST (tstzrange(valid_from, valid_to));

CREATE INDEX idx_edges_current
  ON edges (source_id, target_id, type)
  WHERE superseded_at IS NULL;
```

### 7.3 Policy versions table (new)

```sql
CREATE TABLE policy_versions (
  version_id     SERIAL PRIMARY KEY,
  policy_type    TEXT NOT NULL,       -- 'governance' | 'finality' | 'evidence_schema'
  content_hash   TEXT NOT NULL,       -- SHA-256 of YAML content
  content        JSONB NOT NULL,      -- parsed policy content
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),  -- valid time: when policy takes effect
  effective_to   TIMESTAMPTZ,         -- valid time: when policy stops being in effect (NULL = current)
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),  -- transaction time: when system loaded this version
  source_path    TEXT,                -- file path or URL of the policy source
  change_reason  TEXT                 -- human-readable reason for the change
);

CREATE INDEX idx_policy_versions_lookup
  ON policy_versions (policy_type, effective_from DESC);

-- Constraint: no overlapping effective periods for the same policy type
-- (can use EXCLUDE constraint or check in application code)
ALTER TABLE policy_versions ADD CONSTRAINT policy_versions_no_overlap
  EXCLUDE USING GIST (
    policy_type WITH =,
    tstzrange(effective_from, effective_to) WITH &&
  );
```

### 7.4 TypeScript types

```typescript
// Bitemporal envelope — applied to any temporal entity
interface BitemporalRecord {
  // Valid time: when is this true in the real world?
  valid_from: string;       // ISO 8601
  valid_to: string | null;  // ISO 8601, null = still valid

  // Transaction time: when did the system learn about this?
  recorded_at: string;      // ISO 8601
  superseded_at: string | null; // ISO 8601, null = current version
}

// Extended node type
interface BitemporalNode extends BitemporalRecord {
  node_id: string;
  scope_id: string;
  type: string;
  content: string;
  confidence: number;
  status: string;
  version: number;
  source_ref: Record<string, unknown>;
  metadata: Record<string, unknown>;
  embedding?: number[];
}

// Extended edge type
interface BitemporalEdge extends BitemporalRecord {
  edge_id: string;
  source_id: string;
  target_id: string;
  type: string;
  weight: number;
}

// Policy version
interface PolicyVersion {
  version_id: number;
  policy_type: 'governance' | 'finality' | 'evidence_schema';
  content_hash: string;
  content: Record<string, unknown>;
  effective_from: string;  // valid time
  effective_to: string | null;
  recorded_at: string;     // transaction time
  source_path: string | null;
  change_reason: string | null;
}

// Temporal query parameters
interface TemporalQuery {
  valid_at?: string;         // "what was true at this time?"
  transaction_at?: string;   // "what did we know at this time?"
}

// Event envelope with dual temporality
interface TemporalSwarmEvent {
  id: string;
  ts: string;               // transaction time (when published)
  source: string;
  correlation_id: string;
  valid_from?: string;       // valid time (when the fact is true), optional
  valid_to?: string;         // valid time end, optional
  payload: Record<string, unknown>;
}
```

### 7.5 Append-over-update pattern

Current update flow (destructive):
```typescript
// Current: destroys history
await pool.query(
  'UPDATE nodes SET confidence = $1, updated_at = now(), version = version + 1 WHERE node_id = $2',
  [newConfidence, nodeId]
);
```

Proposed bitemporal flow (preserves history):
```typescript
// Proposed: close old version, insert new version
async function updateNodeBitemporal(
  pool: Pool, nodeId: string, updates: Partial<BitemporalNode>
): Promise<string> {
  return pool.query('BEGIN').then(async () => {
    // 1. Close the current version
    await pool.query(
      'UPDATE nodes SET superseded_at = now() WHERE node_id = $1 AND superseded_at IS NULL',
      [nodeId]
    );

    // 2. Insert new version (same node_id lineage, new row)
    const result = await pool.query(
      `INSERT INTO nodes (node_id, scope_id, type, content, confidence, status, version,
                          valid_from, valid_to, recorded_at, superseded_at, source_ref, metadata)
       SELECT $1, scope_id, type,
              COALESCE($2, content),
              COALESCE($3, confidence),
              COALESCE($4, status),
              version + 1,
              COALESCE($5, valid_from), COALESCE($6, valid_to),
              now(), NULL,
              source_ref, metadata
       FROM nodes WHERE node_id = $1 AND superseded_at = now()
       RETURNING *`,
      [nodeId, updates.content, updates.confidence, updates.status,
       updates.valid_from, updates.valid_to]
    );

    await pool.query('COMMIT');
    return result.rows[0];
  });
}
```

> **Note:** This changes the cardinality of the `nodes` table: `node_id` is no longer unique — it identifies a lineage, not a single row. The primary key becomes `(node_id, recorded_at)` or a surrogate `row_id`. All queries that previously used `WHERE node_id = X` must add `AND superseded_at IS NULL` for current-state queries.

---

## 8. Temporal Queries

### 8.1 Current state (most common — no change in behavior)

```sql
-- "What do we know now about what's currently true?"
SELECT * FROM nodes
WHERE scope_id = $1
  AND superseded_at IS NULL    -- latest version
  AND status = 'active'
  AND (valid_to IS NULL OR valid_to > now());  -- still valid
```

### 8.2 Valid-time slice

```sql
-- "What facts were true at time T, as we know them now?"
SELECT * FROM nodes
WHERE scope_id = $1
  AND superseded_at IS NULL    -- latest version
  AND status = 'active'
  AND valid_from <= $2          -- T
  AND (valid_to IS NULL OR valid_to > $2);
```

### 8.3 Transaction-time slice

```sql
-- "What did we know at time T' (regardless of valid time)?"
SELECT * FROM nodes
WHERE scope_id = $1
  AND recorded_at <= $2         -- T'
  AND (superseded_at IS NULL OR superseded_at > $2)
  AND status = 'active';
```

### 8.4 Full bitemporal query

```sql
-- "What did we know at time T' about what was true at time T?"
SELECT * FROM nodes
WHERE scope_id = $1
  AND recorded_at <= $2         -- T' (transaction time)
  AND (superseded_at IS NULL OR superseded_at > $2)
  AND valid_from <= $3          -- T (valid time)
  AND (valid_to IS NULL OR valid_to > $3)
  AND status = 'active';
```

### 8.5 Temporal contradiction detection

```sql
-- "Find claims that overlap in valid time and may contradict"
SELECT a.node_id AS claim_a, b.node_id AS claim_b,
       a.content AS content_a, b.content AS content_b,
       tstzrange(a.valid_from, a.valid_to) * tstzrange(b.valid_from, b.valid_to) AS overlap
FROM nodes a
JOIN nodes b ON a.scope_id = b.scope_id
  AND a.type = b.type
  AND a.node_id < b.node_id
  AND a.superseded_at IS NULL AND b.superseded_at IS NULL
  AND a.status = 'active' AND b.status = 'active'
WHERE tstzrange(a.valid_from, a.valid_to) && tstzrange(b.valid_from, b.valid_to);
```

### 8.6 Stale evidence detection

```sql
-- "Which evidence items have expired?"
SELECT n.node_id, n.content, n.valid_from, n.valid_to,
       now() - n.valid_to AS expired_since
FROM nodes n
WHERE n.scope_id = $1
  AND n.type = 'evidence'
  AND n.superseded_at IS NULL
  AND n.status = 'active'
  AND n.valid_to IS NOT NULL
  AND n.valid_to < now();
```

### 8.7 Policy reconstruction

```sql
-- "Which governance policy was in force at epoch E?"
SELECT pv.*
FROM policy_versions pv
JOIN swarm_state ss ON ss.scope_id = $1
WHERE pv.policy_type = 'governance'
  AND pv.effective_from <= ss.updated_at
  AND (pv.effective_to IS NULL OR pv.effective_to > ss.updated_at);
```

---

## 9. Impact on Existing Subsystems

### 9.1 Semantic graph (`semanticGraph.ts`)

| Function | Change Required |
|----------|----------------|
| `upsertNode()` | Accept `valid_from`, `valid_to` parameters. Default `valid_from = now()` if not provided. |
| `updateNodeConfidence()` | **Major change:** switch from UPDATE to append-over-update (close old row, insert new). |
| `updateNodeStatus()` | Same append-over-update pattern. |
| `getActiveNodes()` | Add `AND superseded_at IS NULL AND (valid_to IS NULL OR valid_to > now())` |
| `getContradictions()` | Add temporal overlap check: `tstzrange(a.valid_from, a.valid_to) && tstzrange(b.valid_from, b.valid_to)` |
| `loadFinalitySnapshot()` | Add stale evidence detection, expired fact count. |
| All `SELECT` queries | Default to current-state filter (`superseded_at IS NULL`); expose `TemporalQuery` parameter for time-travel. |

### 9.2 Finality evaluator (`finalityEvaluator.ts`)

| Concept | Change Required |
|---------|----------------|
| Evidence coverage | Wire `valid_to` check: exclude evidence where `now() > valid_to` |
| Contradiction mass | Use temporal contradiction detection (only overlapping valid times) |
| Knowledge staleness | New metric: count of facts where `valid_to < now()` as fraction of total active facts |
| BLOCKED/EXPIRED | Compute `last_delta_age_ms` from `swarm_state.updated_at`; compute `last_active_age_ms` from latest WAL event |
| Finality certificate | Include `knowledge_valid_from` (earliest `valid_from` in scope) and `knowledge_valid_to` (earliest `valid_to` about to expire) |

### 9.3 Convergence tracker (`convergenceTracker.ts`)

| Concept | Change Required |
|---------|----------------|
| Convergence points | No change — already append-only with `created_at` + `epoch` |
| `analyzeConvergence()` | No change — pure function over convergence history |
| Knowledge freshness dimension | **New:** Add a freshness score based on fraction of non-stale facts, fed into goal score |

### 9.4 Governance (`governance.ts`, `governanceAgent.ts`)

| Concept | Change Required |
|---------|----------------|
| Policy loading | On startup, hash and store policy content in `policy_versions` table |
| Policy hot-reload | When policy file changes, close current version (`effective_to = now()`), insert new version |
| Decision records | Include `policy_version_id` reference in every governance decision event |
| Gate A | No change — Gate A queries live state, not historical |

### 9.5 Context WAL (`contextWal.ts`)

| Concept | Change Required |
|---------|----------------|
| Event recording | Extend `SwarmEvent` with optional `valid_from` / `valid_to` for events that carry temporal facts |
| Append semantics | No change — WAL is already append-only |

### 9.6 Facts agent / Context ingestion

| Concept | Change Required |
|---------|----------------|
| Fact extraction | Extract valid time from source documents (e.g., "FY2025" → `valid_from: 2025-01-01, valid_to: 2025-12-31`) |
| Default valid time | If source document doesn't specify, default to `[now(), NULL)` (valid from now, open-ended) |
| LLM extraction prompt | Include instruction: "For each fact, extract the time period it refers to (if stated in the document)" |

### 9.7 Coordination signal layer

| Concept | Change Required |
|---------|----------------|
| Signal `ttl_rounds` | Already time-bounded. No change needed. |
| Signal staleness | Signals are inherently temporal (TTL decay). No additional valid time needed. |

---

## 10. High-Level Implementation Plan

### Phase 0: Schema migration & backward compatibility (est. 1 week)

**Goal:** Add bitemporal columns without changing any runtime behavior.

| Step | Description | Files |
|------|-------------|-------|
| 0.1 | **Add migration: bitemporal columns on `nodes`** — `valid_from`, `valid_to`, `recorded_at`, `superseded_at`. Backfill `valid_from = created_at`. | `migrations/0XX_bitemporal_nodes.sql` |
| 0.2 | **Add migration: bitemporal columns on `edges`** — same four columns | `migrations/0XX_bitemporal_edges.sql` |
| 0.3 | **Add migration: `policy_versions` table** — with EXCLUDE constraint on `(policy_type, tstzrange)` | `migrations/0XX_policy_versions.sql` |
| 0.4 | **Add GiST indexes** for `tstzrange(valid_from, valid_to)` on nodes and edges | Same migration files |
| 0.5 | **Add partial index** `idx_nodes_current` for `superseded_at IS NULL` — accelerates current-state queries | Same migration files |
| 0.6 | **Define TypeScript types** — `BitemporalRecord`, `BitemporalNode`, `BitemporalEdge`, `PolicyVersion`, `TemporalQuery` | `src/types/temporal.ts` (new) |
| 0.7 | **Verify all existing queries still work** — `superseded_at IS NULL` for all existing rows (default), `valid_from = created_at` for backfilled rows | Test suite must still pass (233 tests) |

### Phase 1: Fact valid time — extraction & storage (est. 2 weeks)

**Goal:** Facts entering the system carry valid time from source documents.

| Step | Description | Files |
|------|-------------|-------|
| 1.1 | **Update `upsertNode()` signature** — accept optional `valid_from`, `valid_to`. Default `valid_from = now()`. | `src/semanticGraph.ts` |
| 1.2 | **Update `upsertEdge()` signature** — same | `src/semanticGraph.ts` |
| 1.3 | **Update facts agent LLM prompt** — instruct: "For each fact, extract the time period it refers to" | `src/agents/factsAgent.ts` |
| 1.4 | **Parse temporal references** — utility to convert "FY2025", "Q3 2025", "as of March 2025" → `[valid_from, valid_to]` | `src/temporalParser.ts` (new) |
| 1.5 | **Wire valid time into context ingestion** — documents carry `obtained_at` (from document metadata); facts extracted from them inherit document's valid time range | `src/agents/contextAgent.ts` |
| 1.6 | **Tests** — facts with explicit valid time, facts with default valid time, temporal parsing | `test/unit/temporalParser.test.ts`, `test/unit/semanticGraph.test.ts` |

### Phase 2: Temporal contradiction detection (est. 1 week)

**Goal:** Contradiction detection considers temporal overlap; non-overlapping claims are not contradictions.

| Step | Description | Files |
|------|-------------|-------|
| 2.1 | **Update contradiction detection query** — add `tstzrange(a.valid_from, a.valid_to) && tstzrange(b.valid_from, b.valid_to)` | `src/semanticGraph.ts` |
| 2.2 | **Update `computeContradictionMass()`** — temporal overlap is a factor in severity assessment | `src/semanticGraph.ts` |
| 2.3 | **Handle temporally successive facts** — "Revenue $8M" (FY2024) and "Revenue $10M" (FY2025) are not contradictions, they're a time series | `src/semanticGraph.ts` |
| 2.4 | **Tests** — overlapping contradictions, non-overlapping successors, partial overlap | `test/unit/semanticGraph.test.ts` |

### Phase 3: Append-over-update & time-travel (est. 2 weeks)

**Goal:** Node updates preserve history; time-travel queries become possible.

| Step | Description | Files |
|------|-------------|-------|
| 3.1 | **Implement `updateNodeBitemporal()`** — close old version (`superseded_at = now()`), insert new version | `src/semanticGraph.ts` |
| 3.2 | **Replace `updateNodeConfidence()` internals** — delegate to `updateNodeBitemporal()` | `src/semanticGraph.ts` |
| 3.3 | **Replace `updateNodeStatus()` internals** — delegate to `updateNodeBitemporal()` | `src/semanticGraph.ts` |
| 3.4 | **Update all SELECT queries** — add `superseded_at IS NULL` to current-state queries | `src/semanticGraph.ts` |
| 3.5 | **Implement `getNodesAtTime(scopeId, validAt, transactionAt)`** — full bitemporal query | `src/semanticGraph.ts` |
| 3.6 | **Implement `getGraphSnapshotAtEpoch(scopeId, epoch)`** — reconstruct semantic graph as it was at a past epoch (uses `swarm_state.updated_at` for epoch→timestamp mapping) | `src/semanticGraph.ts` |
| 3.7 | **Tests** — version history, time-travel queries, graph snapshot reconstruction | `test/unit/semanticGraph.test.ts` |

### Phase 4: Evidence staleness & finality integration (est. 1 week)

**Goal:** Evidence coverage accounts for temporal validity; finality detects stale knowledge.

| Step | Description | Files |
|------|-------------|-------|
| 4.1 | **Update `computeEvidenceCoverage()`** — check `now() < valid_to` for each evidence item; exclude expired items | `src/evidenceCoverage.ts` |
| 4.2 | **Add knowledge freshness metric** — fraction of active facts where `valid_to IS NULL OR valid_to > now()` | `src/finalityEvaluator.ts` |
| 4.3 | **Wire BLOCKED/EXPIRED conditions** — compute `last_delta_age_ms` from `swarm_state.updated_at`, `last_active_age_ms` from latest WAL event | `src/finalityEvaluator.ts` |
| 4.4 | **Update finality certificate payload** — add `knowledge_valid_from`, `knowledge_valid_to`, `stale_facts_count` | `src/types/finality.ts` |
| 4.5 | **Tests** — stale evidence exclusion, freshness metric, BLOCKED/EXPIRED evaluation | `test/unit/finalityEvaluator.test.ts` |

### Phase 5: Governance policy versioning (est. 1 week)

**Goal:** Policy changes are tracked bitemporally; decisions reference the policy version in force.

| Step | Description | Files |
|------|-------------|-------|
| 5.1 | **On startup: hash + store current policies** — compute SHA-256 of `governance.yaml`, `finality.yaml`, `evidence_schemas.yaml`; insert into `policy_versions` if hash differs from latest | `src/governance.ts`, `src/finalityEvaluator.ts` |
| 5.2 | **On policy change: close old version, insert new** — `effective_to = now()` on old; `effective_from = now()` on new | `src/governance.ts` |
| 5.3 | **Include `policy_version_id` in governance decisions** — every `DecisionRecord` references the policy version | `src/agents/governanceAgent.ts` |
| 5.4 | **Include `policy_version_id` in finality certificates** — alongside content hash | `src/finalityCertificate.ts` |
| 5.5 | **Implement `getPolicyAtTime(type, time)`** — retrieve the policy that was in effect at a given time | `src/governance.ts` |
| 5.6 | **Tests** — policy versioning, version lookup by time, decision-to-policy linkage | `test/unit/governance.test.ts` |

### Phase 6: Late-arriving fact handling (est. 1 week)

**Goal:** Facts with `valid_from` in the past are correctly inserted and trigger temporal contradiction checks.

| Step | Description | Files |
|------|-------------|-------|
| 6.1 | **Implement temporal overlap check on insert** — when a node is inserted with `valid_from` < `now()`, check for overlapping active nodes | `src/semanticGraph.ts` |
| 6.2 | **Auto-create contradiction edges for temporal overlaps** — if overlapping nodes have conflicting content | `src/semanticGraph.ts` |
| 6.3 | **Auto-supersede consistent duplicates** — if overlapping nodes have consistent content, newer version supersedes older | `src/semanticGraph.ts` |
| 6.4 | **Log late-arrival events** — WAL event `fact_late_arrival` with delta between `valid_from` and `recorded_at` | `src/contextWal.ts` |
| 6.5 | **Tests** — late arrival with contradiction, late arrival with supersession, late arrival metrics | `test/unit/semanticGraph.test.ts` |

---

## 11. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | **Table growth from append-over-update** — nodes table grows with every confidence/status update instead of updating in place | High | Medium | Partition by `superseded_at IS NULL` vs history. Periodic archival of old versions to cold storage. Monitor table size. |
| R2 | **Query performance regression** — all queries need `AND superseded_at IS NULL` filter | Medium | Medium | Partial index `idx_nodes_current WHERE superseded_at IS NULL` makes current-state queries as fast as before. GiST index for temporal range queries. Benchmark Phase 0. |
| R3 | **Valid time extraction from documents is unreliable** — LLM may misparse "FY2025" or fail to extract dates | High | Medium | Default to `[now(), NULL)` when no temporal reference is found. Temporal parsing utility with regex fallbacks. Confidence-weighted: explicitly dated facts get higher confidence. |
| R4 | **Breaking change to node_id uniqueness** — many queries assume `node_id` is unique. Append-over-update makes it non-unique. | High | High | Phase 3 is the critical migration. Use surrogate `row_id BIGSERIAL PRIMARY KEY` alongside `node_id` (lineage ID). All queries updated to filter `superseded_at IS NULL`. Comprehensive test coverage before and after. |
| R5 | **Policy version table unbounded growth** — every config reload creates a new version | Low | Low | Policies change rarely. Even with daily reloads, 365 rows/year is trivial. Add `content_hash` dedup: skip insertion if hash unchanged. |
| R6 | **Temporal parsing adds latency to fact extraction** — parsing "FY2025" → date range | Low | Low | Temporal parsing is string matching + lookup table, sub-ms. Not a bottleneck. |
| R7 | **Backward compatibility during migration** — existing tests expect single-row-per-node semantics | Medium | Medium | Phase 0 is additive only (new columns, default values). Phase 3 changes semantics. Tests must be updated in Phase 3 alongside the code. |
| R8 | **Contradiction over-detection during transition** — during migration, some nodes have real `valid_from` and others have `valid_from = created_at` (backfilled). Overlap queries may produce false matches. | Medium | Medium | Flag backfilled nodes with `metadata.valid_time_source = 'backfill'` vs `'extracted'`. Contradiction detector can weight backfilled valid times lower. |

---

## 12. Open Questions

| # | Question | Impact | Options |
|---|----------|--------|---------|
| Q1 | Should `node_id` remain the lineage identifier, or should we introduce a separate `lineage_id` with `node_id` as a version-unique surrogate? | Affects every query and foreign key in the system | A) `node_id` = lineage, add `row_id BIGSERIAL PK` B) Add `lineage_id`, keep `node_id` unique per version |
| Q2 | Should valid time be mandatory on all nodes, or optional (nullable `valid_from` meaning "unspecified")? | Affects contradiction detection — nodes without valid time can't be temporally compared | A) Mandatory with default `[now(), NULL)` B) Optional, with NULL meaning "atemporal" |
| Q3 | How aggressive should temporal archival be? (How long to keep superseded versions?) | Storage vs audit capability trade-off | A) Keep forever (append-only) B) Archive after N days C) Configurable per scope type |
| Q4 | Should the finality evaluator require a minimum knowledge freshness score? | If yes, adds a new gate condition; if no, stale knowledge only warns | A) Hard gate: `freshness >= 0.8` required for RESOLVED B) Soft metric: contributes to goal score but doesn't block |
| Q5 | For governance policy versioning, should we support retroactive policy changes? (e.g., "this policy was wrong, apply corrected version retroactively") | Retroactive changes require replaying decisions — extremely complex | A) No retroactive changes — new version is always forward-only B) Support retroactive with replay (Phase 7+) |
| Q6 | How should valid time interact with the coordination signal layer? Should signals carry valid time? | Signals are ephemeral (TTL-based) — valid time may add unnecessary complexity | A) Signals are atemporal (current TTL is sufficient) B) Signals carry valid time for temporal correlation |

---

## 13. Resources & References

### Academic Foundations

| Source | Relevance |
|--------|-----------|
| Snodgrass, R. (1992). "Temporal Databases" — SQL temporal extensions | Foundational bitemporal model; basis for SQL:2011 standard |
| Fowler, M. "Bitemporal History" — martinfowler.com | Practical patterns for implementing bitemporal data in applications |
| Fowler, M. "Temporal Patterns" — martinfowler.com | Temporal Property, Temporal Object, Bi-Temporal Collection patterns |
| Anselma et al. (2025). "Bitemporal Property Graphs" — Springer | Directly applicable: extends property graphs with valid + transaction time |
| Tansel, Wu, Wang (2025). "BiTemporal RDF (BiTRDF)" — MDPI Mathematics | Temporal references as first-class citizens in knowledge graphs |
| "Confidence is not Timeless" (ACL 2024) | Temporal validity for rule-based temporal knowledge graph forecasting |
| SagaLLM (VLDB 2025) | Temporal consistency in multi-agent systems via saga patterns |

### Databases & Tooling

| Technology | Relevance |
|-----------|-----------|
| PostgreSQL 18 `WITHOUT OVERLAPS` | Native temporal PK/UNIQUE constraints — future migration target |
| PostgreSQL `tstzrange` + GiST | Current implementation target for temporal range queries |
| `temporal_tables` PL/pgSQL (nearform) | Pure PL/pgSQL system versioning — works on managed PostgreSQL |
| XTDB (formerly Crux) | Reference architecture for native bitemporality (JVM, not for direct use) |
| Datomic | Reference architecture for immutable datom model with time-travel (Clojure, not for direct use) |

### npm Packages

| Package | Purpose |
|---------|---------|
| `pg` (existing) | PostgreSQL client — already used; supports `tstzrange` via text encoding |
| `date-fns` or `luxon` | Temporal arithmetic (date ranges, intervals, overlap detection) — evaluate need |
| No bitemporal TS library exists | Application-level bitemporal patterns must be hand-built |

### Related Design Documents

| Document | Relationship |
|----------|-------------|
| `docs/governance-design.md` | Policy engine design — Phase 5 of this PRD adds policy versioning |
| `docs/finality-design.md` | Finality gates — Phase 4 of this PRD wires temporal validity into Gates B, C, D |
| `docs/convergence.md` | Convergence mechanisms — minimal impact (already append-only) |

### Key PostgreSQL References

| Topic | Source |
|-------|--------|
| SQL:2011 temporal features in PostgreSQL | [PostgreSQL Wiki](https://wiki.postgresql.org/wiki/SQL2011Temporal) |
| PostgreSQL 18 temporal constraints | [Neon blog](https://neon.com/postgresql/postgresql-18/temporal-constraints), [Aiven blog](https://aiven.io/blog/exploring-how-postgresql-18-conquered-time-with-temporal-constraints) |
| GiST index performance for temporal ranges | [Hettie Dombrovskaya blog](https://hdombrovskaya.wordpress.com/2024/05/05/3937/) |
| System-versioned tables in Postgres | [Hypirion blog](https://hypirion.com/musings/implementing-system-versioned-tables-in-postgres) |
