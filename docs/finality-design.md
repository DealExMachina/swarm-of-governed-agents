# Finality & Convergence Layer — Design Review

**Branch:** `feature/finality-design`
**Status:** Architecture Review — NOT YET IMPLEMENTING
**Date:** 2026-02-22

---

## Table of Contents

1. [PRD Summary](#1-prd-summary)
2. [Current State Analysis](#2-current-state-analysis)
3. [Literature Review — What the Cited Papers Actually Say](#3-literature-review)
4. [Critical Review of PRD](#4-critical-review-of-prd)
5. [Open Questions](#5-open-questions)
6. [Revised Architecture](#6-revised-architecture)
7. [High-Level Implementation Plan](#7-high-level-implementation-plan)
8. [Risk Register](#8-risk-register)
9. [Resources & References](#9-resources--references)

---

## 1. PRD Summary

The PRD proposes a formal finality layer built on **four gates**:

| Gate | Name | Pass Condition |
|------|------|----------------|
| A | Authorization stability | No blocked high-impact actions, or all routed to humans |
| B | Epistemic stability | Contradiction mass ≤ ε, or all disputes routed with owners |
| C | Progress stability | No plateau or oscillation in metrics for k rounds |
| D | Operational quiescence | No admissible pending proposals for the session |

Plus: three **deliberation protocols** (evidence-first, debate-lite, diversity+confidence), **finality certificates**, **session/round boundaries**, **protocol switching**, and **six standard metrics** (evidence coverage, contradiction mass, decision confidence, risk score, activation pressure, coordination signal).

The PRD references 8 recent papers (2025–2026) on coordination benchmarks, emergent convergence, debate failure modes, runtime governance, and agentic scheduling.

---

## 2. Current State Analysis

### What already exists (substantial)

The codebase has a **mature finality and convergence layer** spanning ~1,900 lines of implementation + 776 lines of tests + 404 lines of documentation. This is NOT greenfield.

| Component | File | Lines | Status |
|-----------|------|-------|--------|
| Finality evaluator | `src/finalityEvaluator.ts` | 472 | **Fully implemented** — conditions, goal score, HITL routing, convergence integration |
| Convergence tracker | `src/convergenceTracker.ts` | 353 | **Fully implemented** — Lyapunov V, convergence rate α, monotonicity β, plateau τ, pressure |
| HITL finality | `src/hitlFinalityRequest.ts` | 160 | **Fully implemented** — LLM explanation, blocker analysis, MITL submission |
| Finality decisions | `src/finalityDecisions.ts` | 49 | **Fully implemented** — human decision persistence, short-circuit |
| Activation filters | `src/activationFilters.ts` | 423 | **Fully implemented** — pressure-directed routing, stigmergy |
| Semantic graph | `src/semanticGraph.ts` | 414 | **Fully implemented** — contradiction tracking, risk scores, snapshot aggregation |
| Finality config | `finality.yaml` | 56 | **Fully implemented** — conditions, thresholds, weights, convergence params |
| Convergence docs | `docs/convergence.md` | 404 | **Fully implemented** — five mechanisms, benchmarks, references |
| Tests | `test/unit/finalityEvaluator.test.ts` | 274 | 12 test cases |
| Tests | `test/unit/convergenceTracker.test.ts` | 369 | 18 test cases |
| Tests | `test/unit/hitlFinalityRequest.test.ts` | 133 | 5 test cases |

### Mapping PRD concepts to existing code

| PRD Concept | Current Implementation | Gap? |
|-------------|----------------------|------|
| **Gate A** (authorization stability) | Not explicit — OpenFGA checks in `governanceAgent.ts`, MITL pending in `mitlServer.ts` | **Yes** — no explicit "blocked high-impact count" metric |
| **Gate B** (epistemic stability) | `contradictions_unresolved_count` in `FinalitySnapshot`, condition `contradictions.unresolved_count: 0` | **Partial** — count exists but no weighted `mass(U)` by severity/materiality |
| **Gate C** (progress stability) | `analyzeConvergence()` with monotonicity β, plateau τ, EMA, Lyapunov V, convergence rate α | **Mostly done** — oscillation detection is basic (direction changes), no Fourier or cycle pattern detection |
| **Gate D** (operational quiescence) | Not implemented — no "no pending admissible proposals" check | **Yes** — significant gap |
| **Sessions** | Scopes (`scope_id`) serve as implicit sessions. No explicit `Session` object with start/end events | **Partial** — scope is the unit, but no formal session lifecycle |
| **Rounds** | Epochs (state machine ticks) serve as implicit rounds. No explicit round boundaries or time windows | **Partial** — epochs exist but aren't formalized as "rounds" with metrics snapshots |
| **Finality certificate** | `DecisionRecord` in `context_events` WAL; not a signed certificate | **Yes** — no cryptographic certificate, no multi-signature, no policy version hashes |
| **Evidence coverage** | Not computed — `FinalitySnapshot` lacks an evidence coverage dimension | **Yes** — significant gap; PRD metric #1 |
| **Contradiction mass** | Unresolved count only; no severity/materiality weighting | **Partial** — count exists, mass doesn't |
| **Decision confidence** | `computeGoalScore()` is a weighted aggregate, not a calibrated confidence | **Partial** — score exists, but it's a goal gradient, not "confidence" per se |
| **Activation pressure** | `computePressure()` per dimension; queue depth not integrated | **Partial** — pressure exists, SLA timers don't |
| **Coordination signal** | Not implemented | **Yes** — new concept |
| **Protocol switching** | Not implemented — single evaluation path (deterministic → oversight → LLM) | **Yes** — no debate-lite, no diversity+confidence, no vote |
| **Oscillation detection** | Basic: direction changes in `analyzeConvergence()` | **Partial** — no cycle pattern detection, no Fourier analysis |
| **HITL routing** | `submitFinalityReviewForScope()` with LLM explanation, dimension breakdown, blocker analysis | **Mostly done** — well-implemented |

### Current finality evaluation flow (already working)

```
swarm.finality.evaluate →
  evaluateFinality(scopeId) →
    1. Check prior human decision → short-circuit to RESOLVED
    2. loadFinalitySnapshot() → aggregate from semantic graph
    3. computeGoalScore() → weighted dimension scores
    4. recordConvergencePoint() → append to convergence_history
    5. getConvergenceState() → α, β-monotonicity, τ-plateau, V(t)
    6. Check conditions:
       Path A: all RESOLVED conditions + score ≥ 0.92 + is_monotonic → RESOLVED
       Path B: score ∈ [0.40, 0.92) → FinalityReviewRequest → HITL
       Path C: divergence (α < -0.05) → ESCALATED
       Path D: condition match → BLOCKED / EXPIRED
       Default: null → ACTIVE (continue processing)
```

---

## 3. Literature Review

### What the cited papers actually tell us

#### Paper 3 — Zhu et al. 2026 (Most impactful for this system)

**"Demystifying Multi-Agent Debate: The Role of Confidence and Diversity"**

**Key finding:** Under homogeneous agents and uniform belief updates, multi-agent debate is a **martingale** — no expected improvement over static voting. Two interventions break the martingale:
1. **Diversity-aware initialization** — heterogeneous starting positions
2. **Confidence-modulated updates** — weight belief changes by calibrated confidence

**Implication:** When our `plateau_threshold` triggers, the system is in a martingale. Injecting diversity or switching to confidence-weighted scoring is mathematically grounded, not just heuristic.

#### Paper 4 — Cui et al. 2025 (Free-MAD)

**"Consensus-Free Multi-Agent Debate"**

**Key finding:** Single-round debate with **trajectory-based scoring** outperforms multi-round consensus. Evaluating the *full debate history* rather than final-round snapshots is strictly better. **Anti-conformity mechanisms** (agents resisting majority) reduce groupthink.

**Implication:** Our `history_depth: 20` already stores trajectory. We should score finality by trajectory shape (monotonic convergence = high quality, oscillation = low quality), not just current values.

#### Paper 1 — Agashe et al. 2025 (Coordination Benchmark)

**Key finding:** LLM agents have **weak Theory of Mind** — they cannot reliably predict other agents' beliefs. Joint planning is their weakest capability.

**Implication:** Validates our architectural choice of an **external finality evaluator** rather than relying on agents to self-coordinate. Agents should not determine their own finality.

#### Paper 2 — Parfenova et al. 2025 (Emergent Convergence)

**Key finding:** Multi-agent groups achieve semantic alignment across rounds via **intrinsic dimensionality compression**. However, asymmetric influence dynamics emerge — some agents dominate without explicit role assignment.

**Implication:** Track semantic diversity across rounds. Declining diversity = convergence, but TOO-RAPID decline = possible groupthink. Monitor for agent dominance patterns.

#### Paper 5 — MI9 Framework (Runtime Governance)

**Key finding:** Six-component runtime governance: agency-risk index, semantic telemetry, continuous authorization, FSM conformance, goal-conditioned drift, graduated containment.

**Implication:** Validates our FSM-based transition rules, drift detection, and graduated finality states (RESOLVED/ESCALATED/BLOCKED/EXPIRED). Consider adding per-agent agency-risk index and semantic telemetry.

#### Papers 6, 7, 8 — Supporting Context

- **Flow (ICLR 2025):** Dynamic workflow refinement during execution — validates our adaptive governance approach. Critical path analysis applies to our claim/contradiction dependency graph.
- **Agent.xpu:** Priority scheduling with preemption — governance agent should preempt deliberation agents when critical drift detected.
- **OECD (2026):** Traceability, accountability, human oversight as governance mandates — finality certificates + HITL routing directly address these requirements.

#### ACL 2025 — Kaesberg et al. (Protocol Switching)

**Key finding:** Seven decision protocols tested. Voting outperforms consensus for reasoning tasks (+13.2%); consensus is better for knowledge tasks (+2.8%). **Collective Improvement** (no direct communication, agents only see previous-turn outputs) outperforms debate by +7.4%.

**Implication:** Protocol selection should be dynamic, based on task type and convergence behavior. The "All-Agents Drafting" initialization (+3.3%) should be default.

---

## 4. Critical Review of PRD

### 4.1 Strengths

1. **The four-gate model is sound.** Authorization (A), epistemic (B), progress (C), and quiescence (D) are orthogonal and collectively exhaustive. Any finality system that lacks one of these has a blind spot.

2. **Protocol diversity is well-motivated.** The literature strongly supports having multiple deliberation modes (Kaesberg 2025: +13.2% with protocol selection). The evidence-first/debate-lite/diversity+confidence trio covers the main scenarios.

3. **Finality certificates are a critical addition.** The current system logs decisions to a WAL but produces no signed, verifiable artifact. For regulated environments, this is a hard requirement.

4. **The metrics set is comprehensive.** Evidence coverage, contradiction mass, decision confidence, risk score, activation pressure, and coordination signal cover all dimensions of deliberation health.

5. **Strong grounding in recent literature.** The 8 citations are relevant and correctly interpreted. The PRD incorporates real findings rather than speculating.

### 4.2 Issues and Gaps

#### Issue 1: The PRD underestimates what's already built

**Problem:** The PRD reads as a greenfield design, but ~70% of the finality layer already exists. The five convergence mechanisms (Lyapunov V, α rate, β monotonicity, τ plateau, pressure-directed activation) are all implemented and tested. The HITL routing path is complete. The finality conditions engine processes YAML rules.

**Risk:** Treating this as a new build could lead to replacing working code rather than extending it.

**Recommendation:** Explicitly position this PRD as **incremental evolution** of the existing system. Map each new concept to its extension point in the current code.

#### Issue 2: "Session" and "Round" definitions overlap with existing scope/epoch model

**Problem:** The PRD defines `Session = ⟨session_id, scope, start_event, end_event?⟩` and `Round` as a time-bounded window. The codebase already has:
- **Scopes** (`scope_id`) — equivalent to sessions
- **Epochs** (integer, CAS-incremented in `stateGraph.ts`) — equivalent to rounds
- **State machine** (ContextIngested → FactsExtracted → DriftChecked → cycle) — round boundaries

Introducing new session/round abstractions alongside existing scope/epoch creates confusion unless they're explicitly mapped.

**Recommendation:** Define sessions as a **superset** of scopes: a session can span multiple scope lifecycles. Rounds should alias to epochs (or to explicit N-epoch windows if sub-epoch granularity is needed). Document the mapping:

| PRD Concept | Existing Code | Proposed Extension |
|-------------|--------------|-------------------|
| Session | `scope_id` | Add `session_id` as parent grouping; scope_id remains the unit of finality |
| Round | `epoch` in `swarm_state` | Optionally: N-epoch rounds for coarser metrics. Default: round = epoch. |
| Start event | First `context_events` entry for scope | Formalize as `session_started` event type |
| End event | `evaluateFinality()` → RESOLVED | Formalize as `session_finalized` event type with certificate |

#### Issue 3: Gate A (authorization stability) is governance, not finality

**Problem:** Gate A ("no pending high-impact actions remain blocked by missing permissions/approvals") is a governance gate, not a convergence gate. It checks authorization state, which is the domain of the governance pipeline (OpenFGA + OPA from the governance PRD).

Mixing governance checks into finality evaluation creates coupling between two layers that should be independent. The governance layer should clear authorization blockers *before* finality evaluates epistemic stability.

**Recommendation:** Gate A should be a **precondition** checked by the governance layer, not evaluated inside `evaluateFinality()`. If authorization blockers exist, the proposal should not even reach finality evaluation. Instead:

```
Governance pipeline: Check Gate A → if blocked, route to MITL
Finality evaluator: Check Gates B, C, D only (already partially the case)
```

The existing `governance.yaml` transition rules already block state advances on critical drift. Extend this to block on authorization gaps too.

#### Issue 4: Gate D (operational quiescence) needs careful definition

**Problem:** "No pending proposals in queue that are admissible and relevant" requires the finality evaluator to inspect the NATS consumer queue, which breaks the current separation between event bus and evaluator.

**Questions:**
- What counts as "admissible and relevant"? A proposal in the facts_extracted queue may be stale.
- How do you distinguish "no more work" from "slow producer"?
- What about proposals in-flight (being processed by an agent)?

**Recommendation:** Implement quiescence as a **time-bounded heuristic**, not a queue inspection:
- `scope.last_delta_age_ms >= quiescence_window` (e.g., 60s with no state change)
- Combined with `activation_pressure == 0` (no pressure-directed agents triggered)
- The existing `scope.idle_cycles` condition in `finality.yaml` already approximates this

#### Issue 5: Contradiction "mass" needs a materiality model

**Problem:** The PRD defines `mass(U) = weighted sum by severity/materiality` but doesn't specify how severity/materiality is assigned to contradictions. The current system counts unresolved contradictions but doesn't weight them.

**Questions:**
- Who assigns severity? The agent that detected the contradiction? A governance rule? A domain schema?
- What scale? (low/medium/high/critical? 0-1 continuous?)
- Does materiality come from the objects the contradiction touches (e.g., financial claims > informational claims)?

**Recommendation:** Model contradiction severity on the edge metadata in the semantic graph:

```typescript
// Current: edge type "contradicts" links two claim nodes
// Proposed: add severity to contradiction edges
interface ContradictionEdge {
  type: "contradicts";
  source_id: string;   // claim A
  target_id: string;   // claim B
  severity: "low" | "medium" | "high" | "critical";
  materiality: number; // domain-specific, e.g., financial amount at stake
}

// mass(U) = Σ severity_weight(e) × materiality(e) for e in unresolved
```

Severity weights: `{ low: 0.1, medium: 0.3, high: 0.6, critical: 1.0 }`.

#### Issue 6: Evidence coverage is undefined

**Problem:** The PRD lists "evidence coverage" as metric #1 but the codebase has no evidence coverage computation. There's no definition of "required evidence types" or "domain schema" for what constitutes complete evidence.

This is arguably the biggest implementation gap: you can't compute evidence coverage without knowing what evidence is required.

**Recommendation:** Implement evidence coverage as a **schema-driven checklist** per scope type:

```yaml
# evidence_schemas.yaml (new)
schemas:
  m_and_a_diligence:
    required:
      - financial_statements
      - legal_contracts
      - customer_data
      - ip_portfolio
      - regulatory_compliance
    optional:
      - market_analysis
      - employee_data
    weights:
      financial_statements: 0.25
      legal_contracts: 0.20
      customer_data: 0.15
      ip_portfolio: 0.15
      regulatory_compliance: 0.15
      market_analysis: 0.05
      employee_data: 0.05
```

Coverage = weighted sum of present evidence types / total weight. This requires tagging context documents and claims with evidence types.

#### Issue 7: "Coordination signal" is novel but vague

**Problem:** Metric #6 "coordination health" is described as a proxy for repeated failure modes, misalignment, and low ToM. But:
- What specific measurements compose it?
- How do you detect "low ToM" in a running system?
- Is this a single scalar or a vector?

**Recommendation:** Define coordination signal as an observable **aggregate of failure patterns**:

```typescript
interface CoordinationSignal {
  repeated_rejections: number;     // proposals rejected ≥2 times by same agent
  conflicting_proposals: number;   // proposals that contradict a recent approval
  stale_activations: number;       // agents activating on unchanged state
  convergence_reversals: number;   // score direction changes in last τ rounds
  agent_agreement_ratio: number;   // fraction of proposal pairs with consistent outcomes
}
```

This is measurable from existing data (context_events, proposal outcomes, convergence_history) without requiring ToM detection.

#### Issue 8: Protocol switching needs trigger definitions

**Problem:** The PRD describes three protocols (evidence-first, debate-lite, diversity+confidence) but doesn't define:
- What triggers a switch from one to another?
- Can protocols be used per-scope or only globally?
- How does the system detect that the current protocol is failing?

**Recommendation:** Define explicit switching triggers in `finality.yaml`:

```yaml
protocols:
  default: evidence_first
  switch_rules:
    - from: evidence_first
      to: debate_lite
      when:
        plateau_rounds: ">= 3"
        risk_score: "< 0.50"
    - from: evidence_first
      to: diversity_confidence
      when:
        plateau_rounds: ">= 3"
        risk_score: ">= 0.50"
    - from: debate_lite
      to: judge_adjudication
      when:
        rounds_in_protocol: ">= 2"
        convergence_rate: "< 0.01"
    - from: diversity_confidence
      to: judge_adjudication
      when:
        oscillation_detected: true
```

#### Issue 9: Integration with governance PRD needs alignment

**Problem:** The Finality PRD references XACML obligations for human routing and OPA monotonicity gates. The governance PRD (reviewed separately) recommends against XACML as a runtime engine and proposes OPA-WASM instead.

**Recommendation:** Align the two PRDs:
- **HITL routing obligations** → implement via the custom obligation enforcer from the governance design (not raw XACML)
- **OPA monotonicity gates** → implement as Rego policies in the governance OPA bundle (Phase 1 of governance plan)
- **OpenFGA reviewer assignment** → extend the OpenFGA model with `reviewer` relation (governance Phase 0)

#### Issue 10: "Finality certificate" needs format and signing specification

**Problem:** The PRD defines `Cert = ⟨session_id, timestamp, finality_state, metrics, unresolved_set, human_routes, policy_versions⟩` but doesn't specify:
- Signing algorithm
- Key management
- Verification procedure
- Storage format

**Recommendation:** Use **JWS General JSON Serialization** (RFC 7515) via the `jose` npm package:

```typescript
interface FinalityCertificatePayload {
  scope_id: string;
  session_id: string;
  timestamp: string;                    // ISO 8601
  finality_state: CaseStatus;
  goal_score: number;
  dimension_scores: Record<string, number>;
  convergence_trajectory_hash: string;  // SHA-256 of full history
  unresolved_set: string[];             // contradiction node IDs
  human_routes: Array<{ scope: string; reviewer: string; deadline: string }>;
  policy_versions: {
    finality_yaml_hash: string;
    governance_yaml_hash: string;
    openfga_model_id: string;
    opa_bundle_revision?: string;
  };
}

// JWS General JSON allows multiple independent signatures:
// - governance agent signature (primary attestation)
// - human reviewer signature (if MITL)
// - system signature (infrastructure attestation)
```

**npm package:** `jose` (panva) — zero dependencies, TypeScript-native, RFC compliant.

---

## 5. Open Questions

| # | Question | Impact |
|---|----------|--------|
| Q1 | Should sessions be a new entity, or should we extend the existing scope model? | Determines whether we add `sessions` table or add columns to `swarm_state` |
| Q2 | How are contradiction severity/materiality assigned? (Agent-determined? Schema-driven? Domain-expert-labeled?) | Affects the `mass(U)` computation and the data model for contradiction edges |
| Q3 | What evidence schemas exist per domain? (M&A diligence, insurance claim, sales pipeline) | Blocks evidence coverage implementation — can't compute without a schema |
| Q4 | Is protocol switching per-scope or per-session? Can different scopes within a session use different protocols? | Affects the protocol state machine granularity |
| Q5 | How is the governance PRD's timeline aligned with this one? (OPA integration must precede OPA monotonicity gates) | Sequencing dependency between the two PRDs |
| Q6 | What signing keys are used for finality certificates? Per-agent keys? Per-system keys? HSM-managed? | Affects key management architecture |
| Q7 | Should we track semantic diversity (embedding-space dimensionality) as a convergence metric? (Paper 2 evidence) | Adds ML pipeline dependency for embedding computation |

---

## 6. Revised Architecture

### What to keep (already working)

Everything in the current convergence layer is architecturally sound and well-tested:

- `evaluateFinality()` — the main evaluation function (extend, don't replace)
- `analyzeConvergence()` — the five pure analysis mechanisms (extend with new detectors)
- `FinalitySnapshot` — the aggregation model (add new fields)
- `finality.yaml` — the configuration DSL (add new sections)
- `submitFinalityReviewForScope()` — HITL routing (enhance with obligation model)
- Pressure-directed activation — stigmergic routing (keep as-is)

### What to add

```
┌─────────────────────────────────────────────────────────────┐
│                  FINALITY EVALUATION (revised)                │
│                                                               │
│  Gate A: ─── PRECONDITION (governance layer, not finality) ── │
│                                                               │
│  Gate B: Epistemic stability                                  │
│    ├─ contradiction_mass(U) with severity weighting  [NEW]    │
│    ├─ evidence_coverage via domain schema            [NEW]    │
│    └─ unresolved_count (existing)                             │
│                                                               │
│  Gate C: Progress stability                                   │
│    ├─ Lyapunov V, α rate, β monotonicity, τ plateau (existing)│
│    ├─ oscillation pattern detection (autocorrelation) [NEW]   │
│    ├─ trajectory quality score                        [NEW]   │
│    └─ confidence calibration (per-agent)              [NEW]   │
│                                                               │
│  Gate D: Operational quiescence                               │
│    ├─ idle_cycles >= threshold (existing condition)            │
│    ├─ activation_pressure == 0                        [NEW]   │
│    └─ no admissible proposals (heuristic)             [NEW]   │
│                                                               │
│  Protocol engine                                              │
│    ├─ evidence_first (default)                        [NEW]   │
│    ├─ debate_lite (plateau + low risk)                [NEW]   │
│    ├─ diversity_confidence (plateau + high risk)      [NEW]   │
│    └─ judge_adjudication (deadlock fallback)          [NEW]   │
│                                                               │
│  Session lifecycle                                            │
│    ├─ session_started / session_finalized events       [NEW]  │
│    └─ round metrics snapshots                          [NEW]  │
│                                                               │
│  Finality certificate                                         │
│    ├─ JWS General JSON with multi-signature            [NEW]  │
│    └─ policy version hashes                            [NEW]  │
│                                                               │
│  Coordination signal                                          │
│    ├─ repeated_rejections, conflicting_proposals       [NEW]  │
│    └─ agent_agreement_ratio, convergence_reversals     [NEW]  │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Metrics additions to `FinalitySnapshot`

```typescript
// Extend existing FinalitySnapshot
interface FinalitySnapshot {
  // ... existing fields ...

  // NEW: Gate B
  contradiction_mass: number;               // severity-weighted sum
  evidence_coverage: number;                // [0-1] per domain schema

  // NEW: Gate D
  activation_pressure_total: number;        // sum of all dimension pressures
  pending_admissible_count: number;         // heuristic from idle + pressure

  // NEW: Coordination signal
  coordination_signal: CoordinationSignal;

  // NEW: Confidence
  agent_confidence_spread: number;          // std dev of per-agent confidences
}
```

---

## 7. High-Level Implementation Plan

### Phase 0: Data Model Extensions (est. 1 week)

**Goal:** Extend existing types and tables without changing evaluation behavior.

| Step | Description | Files |
|------|-------------|-------|
| 0.1 | **Extend `FinalitySnapshot`** — add `contradiction_mass`, `evidence_coverage`, `activation_pressure_total`, `coordination_signal` fields | `src/finalityEvaluator.ts` |
| 0.2 | **Add contradiction severity to semantic graph** — `severity` column on contradiction edges, migration script | `src/semanticGraph.ts`, DB migration |
| 0.3 | **Create `evidence_schemas.yaml`** — domain evidence checklists (start with one domain, e.g., M&A diligence) | `evidence_schemas.yaml` |
| 0.4 | **Define `CoordinationSignal` type** — repeated rejections, conflicting proposals, stale activations, convergence reversals, agreement ratio | `src/types/finality.ts` |
| 0.5 | **Define `FinalityCertificatePayload` type** — scope, score, trajectory hash, unresolved set, policy versions | `src/types/finality.ts` |
| 0.6 | **Define `DeliberationProtocol` type** — protocol ID, switch rules, per-scope assignment | `src/types/finality.ts` |
| 0.7 | **Install `jose`** — JWS signing for finality certificates | `package.json` |
| 0.8 | **Install `simple-statistics`** — autocorrelation, standard deviation for oscillation detection | `package.json` |

### Phase 1: Gate B Enhancements — Epistemic Stability (est. 2 weeks)

**Goal:** Add contradiction mass and evidence coverage to finality evaluation.

| Step | Description | Files |
|------|-------------|-------|
| 1.1 | **Implement contradiction mass computation** — query contradiction edges with severity; compute `mass(U) = Σ severity_weight × materiality` | `src/semanticGraph.ts` |
| 1.2 | **Integrate mass into snapshot** — `loadFinalitySnapshot()` computes mass alongside count | `src/finalityEvaluator.ts` |
| 1.3 | **Add mass threshold to finality.yaml** — `contradiction_mass: "< 0.5"` as RESOLVED condition | `finality.yaml` |
| 1.4 | **Implement evidence coverage computation** — load schema for scope type; query which evidence types are present in context docs | `src/evidenceCoverage.ts` (new) |
| 1.5 | **Integrate evidence coverage into snapshot** — add to `loadFinalitySnapshot()` | `src/finalityEvaluator.ts` |
| 1.6 | **Add evidence_coverage condition** — `evidence_coverage: ">= 0.80"` as RESOLVED condition | `finality.yaml` |
| 1.7 | **Update dimension scoring** — add evidence_coverage as 5th dimension in goal score with weight | `src/finalityEvaluator.ts`, `src/convergenceTracker.ts` |
| 1.8 | **Blocker detection** — `buildBlockers()` includes evidence gaps and high-mass contradictions | `src/finalityEvaluator.ts` |
| 1.9 | **Tests** — mass computation, evidence coverage, updated goal score, new blocker types | `test/unit/finalityEvaluator.test.ts` |

### Phase 2: Gate C Enhancements — Advanced Progress Detection (est. 2 weeks)

**Goal:** Better oscillation detection, trajectory scoring, confidence calibration.

| Step | Description | Files |
|------|-------------|-------|
| 2.1 | **Implement autocorrelation-based oscillation detection** — detect periodic patterns in goal score history using `simple-statistics` | `src/convergenceTracker.ts` |
| 2.2 | **Implement trajectory quality score** — evaluate the shape of convergence history: monotonic = 1.0, oscillating = low, spike-and-drop = lower | `src/convergenceTracker.ts` |
| 2.3 | **Add confidence spread tracking** — compute std dev of per-agent confidence values; high spread = disagreement | `src/convergenceTracker.ts` |
| 2.4 | **Extend `analyzeConvergence()`** — return `oscillation_period`, `trajectory_quality`, `confidence_spread` alongside existing fields | `src/convergenceTracker.ts` |
| 2.5 | **Update finality evaluation** — trajectory quality gates RESOLVED (trajectory_quality >= 0.7 required alongside monotonicity) | `src/finalityEvaluator.ts` |
| 2.6 | **Coordination signal computation** — count repeated rejections, conflicting proposals, stale activations from `context_events` | `src/coordinationSignal.ts` (new) |
| 2.7 | **Integrate coordination signal into snapshot** | `src/finalityEvaluator.ts` |
| 2.8 | **Tests** — oscillation autocorrelation, trajectory scoring, coordination signal | `test/unit/convergenceTracker.test.ts` |

### Phase 3: Gate D + Session Lifecycle (est. 1–2 weeks)

**Goal:** Operational quiescence detection and formal session boundaries.

| Step | Description | Files |
|------|-------------|-------|
| 3.1 | **Implement quiescence heuristic** — combine `idle_cycles >= threshold` + `activation_pressure_total == 0` + `scope.last_delta_age_ms >= quiescence_window_ms` | `src/finalityEvaluator.ts` |
| 3.2 | **Add quiescence to finality.yaml** — new RESOLVED condition: `quiescence: true` (alongside existing conditions) | `finality.yaml` |
| 3.3 | **Formalize session lifecycle** — add `session_started` and `session_finalized` event types to context WAL | `src/contextWal.ts` |
| 3.4 | **Round metrics snapshots** — after each epoch, emit `RoundEvent` with full metrics snapshot to context WAL | `src/agents/governanceAgent.ts` |
| 3.5 | **Session table** (optional) — `sessions(session_id, scope_id, started_at, finalized_at, finality_state, certificate_id)` | DB migration |
| 3.6 | **Tests** — quiescence detection, session lifecycle events | `test/unit/finalityEvaluator.test.ts` |

### Phase 4: Finality Certificates (est. 1 week)

**Goal:** Cryptographically signed finality artifacts.

| Step | Description | Files |
|------|-------------|-------|
| 4.1 | **Implement certificate generation** — build `FinalityCertificatePayload`, compute trajectory hash (SHA-256), collect policy version hashes | `src/finalityCertificate.ts` (new) |
| 4.2 | **Implement JWS signing** — use `jose` GeneralSign to create multi-signature certificate; governance agent key as primary | `src/finalityCertificate.ts` |
| 4.3 | **Implement certificate verification** — use `jose` generalVerify; verify all signatures | `src/finalityCertificate.ts` |
| 4.4 | **Integrate into finality flow** — when `evaluateFinality()` returns RESOLVED, generate and persist certificate | `src/finalityEvaluator.ts` |
| 4.5 | **Key management** — generate Ed25519 key pair per system instance; store in env or secrets manager | Configuration |
| 4.6 | **Certificate storage** — persist to `finality_certificates` table and/or S3 | `src/finalityCertificate.ts` |
| 4.7 | **MITL certificate endpoint** — `GET /certificate/:scopeId` returns the signed certificate | `src/mitlServer.ts` |
| 4.8 | **Tests** — certificate generation, signing, verification, policy version inclusion | `test/unit/finalityCertificate.test.ts` |

### Phase 5: Protocol Engine (est. 3–4 weeks)

**Goal:** Multiple deliberation protocols with dynamic switching.

| Step | Description | Files |
|------|-------------|-------|
| 5.1 | **Define protocol interface** — `DeliberationProtocol { id, evaluateRound(scope, round), suggestAgents(scope, pressure), shouldSwitch(convergenceState) }` | `src/protocols/protocol.ts` (new) |
| 5.2 | **Implement evidence-first protocol** — the current default behavior, formalized as a Protocol implementation | `src/protocols/evidenceFirst.ts` (new) |
| 5.3 | **Implement debate-lite protocol** — single proposal turn, one rebuttal pass, judge/arbiter selects | `src/protocols/debateLite.ts` (new) |
| 5.4 | **Implement diversity+confidence protocol** — diversified initial seeds, confidence emission, weighted judge | `src/protocols/diversityConfidence.ts` (new) |
| 5.5 | **Implement judge adjudication fallback** — governance agent or designated judge agent evaluates full trajectory | `src/protocols/judgeAdjudication.ts` (new) |
| 5.6 | **Protocol state machine** — tracks current protocol per scope, evaluates switch rules, transitions | `src/protocols/protocolEngine.ts` (new) |
| 5.7 | **Add protocol config to finality.yaml** — switch rules, protocol-specific thresholds | `finality.yaml` |
| 5.8 | **Integrate into governance agent** — protocol engine advises which agents to activate and how to evaluate convergence | `src/agents/governanceAgent.ts` |
| 5.9 | **Anti-conformity detection** — flag unjustified position changes toward majority in claim updates | `src/protocols/antiConformity.ts` (new) |
| 5.10 | **Tests** — each protocol independently, protocol switching, anti-conformity | `test/unit/protocols/*.test.ts` |

### Phase 6: Agent Reputation Integration (est. 1–2 weeks, if needed)

**Goal:** Per-agent track record feeds into convergence weighting.

| Step | Description | Files |
|------|-------------|-------|
| 6.1 | **Define reputation model** — signals: proposal accuracy, escalation rate, contribution to convergence, consistency | `docs/reputation-model.md` |
| 6.2 | **Create `agent_reputation` table** — `agent_id, reputation_score, last_updated, decay_rate, signal_history` | DB migration |
| 6.3 | **Implement reputation tracker** — update after each governance decision outcome (accepted proposals improve reputation; rejected ones decay) | `src/reputationTracker.ts` (new) |
| 6.4 | **Weight claim confidence by agent reputation** — `effective_confidence = claim_confidence × agent_reputation` | `src/finalityEvaluator.ts` |
| 6.5 | **Confidence-modulated convergence** — agents with higher reputation contribute more to goal score | `src/convergenceTracker.ts` |
| 6.6 | **Expose reputation to governance policies** — push reputation data into OPA (governance PRD Phase 1) | `src/opaEngine.ts` |
| 6.7 | **Tests** — reputation update, decay, confidence weighting | `test/unit/reputationTracker.test.ts` |

---

## 8. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | Evidence schema definition bottleneck — can't compute coverage without domain schemas | High | High | Start with one domain (M&A); make schema structure generic so new domains are config, not code |
| R2 | Protocol switching introduces non-determinism — different protocols may reach different finality decisions | Medium | High | Log protocol transitions as audit events; finality conditions are protocol-independent (same gates regardless of protocol) |
| R3 | Oscillation detection false positives — autocorrelation may flag normal exploration as oscillation | Medium | Medium | Conservative thresholds; oscillation triggers protocol switch (not denial), so false positives are recoverable |
| R4 | Finality certificate key management complexity — key rotation, distribution, revocation | Medium | Medium | Start with single system key (Ed25519); defer multi-agent key infrastructure to Phase 6 |
| R5 | Contradiction mass gameable — agents might mark contradictions as "low severity" to reach finality | Low | High | Mass assignment should be deterministic (from domain schema or evidence metadata), not agent-controlled |
| R6 | Coordination signal computation expensive — scanning context_events for patterns | Low | Medium | Incremental computation: maintain running counts, update per round, not full scan |
| R7 | Protocol engine adds latency to governance loop | Low | Medium | Protocol selection runs once per round (per epoch), not per proposal |
| R8 | Dependency on governance PRD — OPA monotonicity gates, obligation enforcer | Medium | Medium | Phase 1–4 of finality plan are independent of governance PRD; Phase 5–6 may depend on governance Phase 1 |
| R9 | Too many new metrics overwhelm HITL reviewers | Medium | Low | Structured disagreement briefs show only relevant blockers; full metrics available on drill-down |

---

## 9. Resources & References

### npm Packages

| Package | Version | Purpose |
|---------|---------|---------|
| `jose` | latest | JWS General JSON Serialization for finality certificates |
| `simple-statistics` | latest | Autocorrelation, standard deviation for oscillation detection |
| Existing: `yaml` | — | Already used for finality.yaml parsing |
| Existing: `pg` | — | Already used for convergence_history persistence |

### Cited Papers (relevance summary)

| # | Paper | Key Takeaway for Our System |
|---|-------|-----------------------------|
| 1 | Agashe 2025 (Coordination benchmark) | External finality evaluator is correct; agents can't self-coordinate |
| 2 | Parfenova 2025 (Emergent convergence) | Track semantic diversity; declining dimensionality = convergence |
| 3 | Zhu 2026 (Debate failure) | **Critical:** Plateau = martingale. Inject diversity + confidence to break it |
| 4 | Cui 2025 (Free-MAD) | Trajectory scoring > final-round scoring. Anti-conformity prevents groupthink |
| 5 | MI9 (Runtime governance) | Validates FSM conformance, graduated containment, agency-risk index |
| 6 | Flow (ICLR 2025) | Dynamic workflow refinement; critical path analysis for claim dependencies |
| 7 | Agent.xpu (Scheduling) | Priority preemption; governance agent should preempt deliberation agents |
| 8 | OECD 2026 (Agentic AI) | Traceability + accountability mandates; finality certificates directly address |
| 9 | Kaesberg 2025 (Protocol switching) | Voting > consensus for reasoning (+13.2%); CI > debate (+7.4%) |

### Existing Documentation

| Document | Path | Relation |
|----------|------|----------|
| Convergence mechanisms | `docs/convergence.md` | Existing — extend, don't replace |
| Governance design | `docs/governance-design.md` | Companion PRD — alignment needed |
| Architecture | `docs/architecture.md` | System overview — update with finality additions |

### Database Tables (existing + new)

| Table | Status | Purpose |
|-------|--------|---------|
| `convergence_history` | Existing | Convergence points per scope/epoch |
| `scope_finality_decisions` | Existing | Human finality decisions |
| `context_events` | Existing | Append-only audit WAL |
| `mitl_pending` | Existing | Human review queue |
| `swarm_state` | Existing | State machine (scope, epoch) |
| `finality_certificates` | **New** | Signed finality artifacts |
| `sessions` | **New (optional)** | Session lifecycle tracking |
| `agent_reputation` | **New (Phase 6)** | Per-agent track record |
