# Finality & Convergence Layer — Design Review

**Branch:** `feature/finality-design`
**Status:** Architecture Review — NOT YET IMPLEMENTING
**Date:** 2026-02-22
**Last updated:** 2026-02-22 — Incorporated stakeholder decisions and cross-domain research

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

## Stakeholder Decisions Log

| Decision | Resolution | Impact |
|----------|-----------|--------|
| Session/Round entities | **scope_id = session, epoch = round.** No new entities. Stay with existing model. | Issue 2 resolved — no new tables, extend existing scope/epoch |
| Gate A placement | **Gate A → governance layer.** Covered in `governance-design.md` Section 7. | Issue 3 resolved — finality evaluator handles Gates B, C, D only |
| Gate D design | **Maintain separation.** Time-bounded heuristic, not queue inspection. | Issue 4 confirmed — `idle_cycles + pressure == 0 + quiescence_window` |
| Severity/materiality | **Implement.** Cross-domain model based on 5-domain research below. | Issue 5 resolved — new section with full model |
| Evidence coverage | **Domain-dependent.** 5-domain research revealed universal 4-level hierarchy. | Issue 6 resolved — new section with cross-domain schema |
| Coordination signal | **Agent-to-agent uncommitting exchange plane.** 6 signal types, dual NATS/PG. | Issue 7 resolved — new architecture section below |
| Protocol switching | **YAML switch rules first.** More interesting models to explore later. | Issue 8 confirmed — YAML config in `finality.yaml` |
| Policy engine | **OPA-WASM confirmed.** Alignment with governance PRD. | Issue 9 resolved — single engine choice |

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

> **✅ Decided:** scope_id = session, epoch = round. Stay with existing model. No new entities.

**Problem:** The PRD defines `Session = ⟨session_id, scope, start_event, end_event?⟩` and `Round` as a time-bounded window. The codebase already has:
- **Scopes** (`scope_id`) — equivalent to sessions
- **Epochs** (integer, CAS-incremented in `stateGraph.ts`) — equivalent to rounds
- **State machine** (ContextIngested → FactsExtracted → DriftChecked → cycle) — round boundaries

**Resolution:** The existing `scope_id` and `epoch` serve as session and round respectively. No new abstractions needed.

| PRD Concept | Maps To | Notes |
|-------------|---------|-------|
| Session | `scope_id` | Already used as the unit of finality. Lifecycle events (`session_started`, `session_finalized`) added to WAL. |
| Round | `epoch` in `swarm_state` | CAS-incremented integer. Each epoch = one round. Metrics snapshots taken per epoch. |
| Start event | First `context_events` entry for scope | Formalize as `session_started` event type |
| End event | `evaluateFinality()` → RESOLVED | Formalize as `session_finalized` event type with certificate |

No `sessions` table needed. The `swarm_state` table already tracks `scope_id` + `epoch`. Session lifecycle is expressed through event types in the existing WAL.

#### Issue 3: Gate A (authorization stability) is governance, not finality

> **✅ Decided:** Gate A belongs in the governance layer. See `governance-design.md` Section 7 for full specification.

**Problem:** Gate A ("no pending high-impact actions remain blocked by missing permissions/approvals") is a governance gate, not a convergence gate. It checks authorization state, which is the domain of the governance pipeline (OpenFGA + OPA from the governance PRD).

**Resolution:** Gate A is implemented as a **governance precondition**. The finality evaluator queries Gate A status but does not execute governance logic:

```
Governance pipeline: evaluateGateA(scopeId) → { stable, blockers[] }
Finality evaluator: if !gateA.stable → skip evaluation, return ACTIVE
                    if gateA.stable → proceed with Gates B, C, D
```

Gate A is defined as OPA Rego policies in the governance bundle (`policies/swarm/governance/gate_a.rego`), evaluated via OPA-WASM. Full specification in `governance-design.md` Section 7.

#### Issue 4: Gate D (operational quiescence) needs careful definition

> **✅ Decided:** Maintain separation from governance. Implement as time-bounded heuristic.

**Problem:** "No pending proposals in queue that are admissible and relevant" requires the finality evaluator to inspect the NATS consumer queue, which breaks the current separation between event bus and evaluator.

**Resolution:** Quiescence is a **time-bounded heuristic**, not a queue inspection. Three conditions must hold simultaneously:

| Condition | Source | Rationale |
|-----------|--------|-----------|
| `scope.idle_cycles >= threshold` | `finality.yaml` (existing) | No state machine advancement for N cycles |
| `activation_pressure_total == 0` | `computePressure()` (existing) | No pressure-directed agents triggered |
| `scope.last_delta_age_ms >= quiescence_window_ms` | `swarm_state` timestamp | Real wall-clock time without activity (distinguishes "slow" from "done") |

The existing `scope.idle_cycles` condition in `finality.yaml` already approximates this. The implementation adds pressure check and age check as additional guards. No NATS queue inspection needed.

#### Issue 5: Contradiction "mass" needs a materiality model

> **✅ Decided:** Implement severity/materiality model. Full design below.

**Problem:** The PRD defines `mass(U) = weighted sum by severity/materiality` but doesn't specify how severity/materiality is assigned to contradictions. The current system counts unresolved contradictions but doesn't weight them.

**Resolution — Severity/Materiality Model:**

##### 5a. Severity classification

Severity is assigned **at contradiction detection time** by the facts agent, based on the type and scope of the contradiction:

| Severity | Weight | Criteria | Examples |
|----------|--------|----------|----------|
| `low` | 0.1 | Cosmetic or non-functional disagreement | Formatting differences, metadata conflicts |
| `medium` | 0.3 | Factual disagreement that doesn't block decisions | Divergent estimates within tolerance, conflicting secondary sources |
| `high` | 0.6 | Factual disagreement that could change outcomes | Conflicting financial figures, contradictory legal interpretations |
| `critical` | 1.0 | Contradiction on a hard-gate evidence item | Missing vs. present compliance certificate, contradictory regulatory status |

Severity assignment rules can be expressed in the evidence schema (see Issue 6) or as OPA policies. The facts agent proposes severity; the governance agent can override via policy.

##### 5b. Materiality scoring

Materiality is **domain-contextual** — it reflects the importance of what the contradiction touches. It is a `[0, 1]` normalized score derived from:

| Factor | Weight | Source |
|--------|--------|--------|
| Evidence category weight | 0.4 | From `evidence_schemas.yaml` — how important is this category in the domain? |
| Object financial exposure | 0.3 | From claim metadata — what dollar/risk amount is at stake? Normalized to `[0,1]` within the scope. |
| Dependency count | 0.2 | From semantic graph — how many other claims depend on the contradicted claims? |
| Temporal urgency | 0.1 | From claim metadata — is there a deadline associated with the contradicted claims? |

```typescript
function computeMateriality(contradiction: ContradictionEdge, schema: EvidenceSchema): number {
  const categoryWeight = schema.weights[contradiction.evidence_category] ?? 0.5;
  const exposure = normalizeExposure(contradiction.financial_exposure, scope.max_exposure);
  const deps = contradiction.dependency_count / scope.max_dependency_count;
  const urgency = contradiction.has_deadline ? 1.0 : 0.0;

  return 0.4 * categoryWeight + 0.3 * exposure + 0.2 * deps + 0.1 * urgency;
}
```

##### 5c. Mass computation

```typescript
// mass(U) = Σ severity_weight(e) × materiality(e) for e in unresolved contradictions
const SEVERITY_WEIGHTS = { low: 0.1, medium: 0.3, high: 0.6, critical: 1.0 };

function computeContradictionMass(unresolved: ContradictionEdge[], schema: EvidenceSchema): number {
  return unresolved.reduce((sum, e) => {
    const sw = SEVERITY_WEIGHTS[e.severity];
    const m = computeMateriality(e, schema);
    return sum + sw * m;
  }, 0);
}
```

##### 5d. Data model extension

```typescript
interface ContradictionEdge {
  type: "contradicts";
  source_id: string;            // claim A
  target_id: string;            // claim B
  severity: "low" | "medium" | "high" | "critical";
  evidence_category: string;    // links to evidence_schemas.yaml
  financial_exposure?: number;  // domain-specific, optional
  dependency_count: number;     // computed from semantic graph
  has_deadline: boolean;        // from claim metadata
  detected_at: string;          // ISO 8601
  detected_by: string;          // agent ID
}
```

##### 5e. Finality gate integration

```yaml
# finality.yaml addition
conditions:
  contradiction_mass:
    operator: "<="
    threshold: 0.5      # max acceptable mass for RESOLVED
    critical_threshold: 2.0  # above this → ESCALATED (mandatory human review)
```

The mass value feeds into Gate B (epistemic stability) alongside evidence coverage. The finality evaluator blocks RESOLVED status when `mass > threshold` and triggers ESCALATED when `mass > critical_threshold`.

#### Issue 6: Evidence coverage is domain-dependent — cross-domain research

> **✅ Decided:** Revisited with 5-domain research. Universal 4-level hierarchy discovered.

**Problem:** The PRD lists "evidence coverage" as metric #1 but the codebase has no evidence coverage computation. Evidence requirements are heavily domain-dependent.

**Research:** Cross-domain analysis across 5 domains revealed a universal structural pattern despite domain-specific content.

##### 6a. Universal 4-level hierarchy

Every domain examined follows the same evidence structure:

```
Domain → Category → Item → Metadata
```

| Level | Description | Example (M&A) | Example (Clinical) |
|-------|-------------|---------------|-------------------|
| **Domain** | The top-level scope type | `m_and_a_diligence` | `clinical_trial_phase_iii` |
| **Category** | A group of related evidence | `financial_statements` | `primary_endpoints` |
| **Item** | A specific piece of evidence | `audited_annual_report_fy2025` | `efficacy_data_primary` |
| **Metadata** | Properties of the item | `{ source, date, quality }` | `{ protocol, population, p_value }` |

##### 6b. Cross-domain research findings (5 domains)

| Domain | Categories | Hard Gates | Conditional Reqs | Dependencies |
|--------|-----------|------------|------------------|-------------|
| **M&A Due Diligence** | Financial, Legal, Commercial, IP, Regulatory, Tax, HR, Environmental | Audited financials, material contracts, compliance certificates | IP valuation needed only if tech company; environmental review only if manufacturing | Legal ← Financial (contracts reference financials) |
| **Insurance Claims** | Policy verification, Loss documentation, Investigation, Coverage analysis, Liability, Reserves | Policy in force, proof of loss, insurable interest | Subrogation analysis only if third-party involvement; SIU referral only if fraud indicators | Coverage ← Policy verification; Reserves ← Investigation |
| **Clinical Trials** | Regulatory compliance, Protocol adherence, Data integrity, Safety monitoring, Efficacy endpoints, Statistical analysis | IRB/Ethics approval, informed consent, SAE reporting | Adaptive design amendments only if interim futility; dose-escalation only in Phase I | Efficacy ← Protocol adherence ← Regulatory |
| **Regulatory Compliance Audit** | Licensing, Reporting obligations, Internal controls, Risk management, Consumer protection, AML/KYC | Current license, SAR filing compliance, board risk oversight | Enhanced DD only if high-risk jurisdiction; stress testing only if systemic institution | Controls ← Risk mgmt ← Licensing |
| **Litigation/Legal Case Preparation** | Pleadings, Discovery, Evidence authentication, Expert testimony, Procedural compliance | Standing, jurisdiction, statute of limitations | Class certification only if class action; Daubert challenge only if expert testimony | Expert ← Discovery ← Pleadings |

##### 6c. Seven expressivity requirements

Cross-domain analysis reveals 7 constructs that any evidence schema must support:

| # | Requirement | Description | Found In |
|---|------------|-------------|----------|
| 1 | **Conditional requirements** | Evidence X is required only if condition Y holds | All 5 domains |
| 2 | **Dependency DAG** | Evidence X cannot be assessed until evidence Y is present | All 5 domains |
| 3 | **Hard gates** | Specific items that must be present for ANY finality (regardless of coverage score) | All 5 domains |
| 4 | **Weighted scoring** | Categories have different importance weights | All 5 domains |
| 5 | **Per-category completeness** | Each category has its own item checklist and threshold | 4 of 5 domains |
| 6 | **Temporal constraints** | Some evidence has expiration dates or must be obtained within windows | 4 of 5 domains |
| 7 | **Aggregation modes** | Some categories use quorum (M of N items sufficient), others use all-or-nothing | 3 of 5 domains |

##### 6d. Proposed evidence schema format

```yaml
# evidence_schemas.yaml
schemas:
  m_and_a_diligence:
    categories:
      financial_statements:
        weight: 0.25
        completeness_threshold: 0.80
        aggregation: "weighted"  # weighted | quorum | all_required
        hard_gates:
          - audited_annual_report     # must be present for ANY finality
          - management_accounts
        items:
          - id: audited_annual_report
            weight: 0.40
            temporal_constraint: { max_age_days: 365 }
          - id: management_accounts
            weight: 0.30
            temporal_constraint: { max_age_days: 90 }
          - id: tax_returns
            weight: 0.15
          - id: cash_flow_projections
            weight: 0.15

      legal_contracts:
        weight: 0.20
        completeness_threshold: 0.75
        aggregation: "quorum"    # 3 of 5 sufficient
        quorum: { min: 3, of: 5 }
        items:
          - id: material_contracts
            weight: 0.30
          - id: customer_agreements
            weight: 0.20
          - id: supplier_agreements
            weight: 0.20
          - id: employment_contracts
            weight: 0.15
          - id: lease_agreements
            weight: 0.15
        conditions:
          - item: ip_license_agreements
            when: { scope_tag: "technology_company" }
            weight: 0.25

      regulatory_compliance:
        weight: 0.15
        completeness_threshold: 1.00  # all required — no partial credit
        aggregation: "all_required"
        hard_gates:
          - compliance_certificates
        items:
          - id: compliance_certificates
            weight: 0.50
          - id: regulatory_filings
            weight: 0.30
          - id: pending_actions
            weight: 0.20
        conditions:
          - item: environmental_review
            when: { scope_tag: "manufacturing" }
            weight: 0.30

    dependencies:
      # DAG: category A depends on category B
      - from: legal_contracts
        to: financial_statements
        reason: "Contracts reference financial terms"
      - from: ip_portfolio
        to: legal_contracts
        reason: "IP valuation requires license review"
```

##### 6e. Coverage computation algorithm

```typescript
interface CoverageResult {
  total: number;              // [0, 1] overall weighted coverage
  per_category: Record<string, number>;  // per-category scores
  hard_gate_met: boolean;     // all hard gates satisfied?
  unmet_hard_gates: string[]; // which hard gates are missing?
  blocked_by_deps: string[];  // categories blocked by unmet dependencies
  expired_items: string[];    // items past their temporal constraint
}

function computeEvidenceCoverage(
  schema: DomainSchema,
  present: Set<string>,       // item IDs present in context
  scopeTags: Set<string>,     // scope tags for conditional requirements
  now: Date
): CoverageResult {
  // 1. Resolve conditional requirements
  const activeItems = resolveConditionals(schema, scopeTags);

  // 2. Check dependency DAG — block categories with unmet dependencies
  const blockedCategories = checkDependencyDAG(schema.dependencies, present);

  // 3. Per-category completeness
  const perCategory = {};
  for (const [catId, cat] of Object.entries(activeItems)) {
    if (blockedCategories.has(catId)) {
      perCategory[catId] = 0;  // dependency not met
      continue;
    }
    perCategory[catId] = computeCategoryScore(cat, present, now);
  }

  // 4. Check hard gates
  const hardGates = collectHardGates(activeItems);
  const unmetHardGates = hardGates.filter(g => !present.has(g));

  // 5. Weighted total
  const total = weightedSum(perCategory, schema.categories);

  return {
    total,
    per_category: perCategory,
    hard_gate_met: unmetHardGates.length === 0,
    unmet_hard_gates: unmetHardGates,
    blocked_by_deps: [...blockedCategories],
    expired_items: findExpiredItems(activeItems, present, now),
  };
}
```

##### 6f. Integration with finality

Evidence coverage feeds into Gate B (epistemic stability):

```yaml
# finality.yaml
conditions:
  evidence_coverage:
    operator: ">="
    threshold: 0.80          # minimum for RESOLVED
    hard_gates_required: true # all hard gates must pass regardless of score
```

**Note on "Luego" and "Provingly":** Cross-domain research found no established evidence management frameworks under these names. The 4-level hierarchy and 7 expressivity requirements above are synthesized from domain-specific standards (AICPA DD guides, ISO 14971, Basel III/IV, FRCP) rather than any single existing tool.

#### Issue 7: Coordination signal — agent-to-agent uncommitting exchange plane

> **✅ Decided:** Redesigned as a full agent-to-agent uncommitting exchange plane, not just a failure-pattern aggregate.

**Problem:** The original PRD described "coordination health" as a vague proxy. The stakeholder reframed this as: **"an agent-to-agent uncommitting plane to exchange information and signals."**

**Resolution — Coordination Signal Architecture:**

##### 7a. Design philosophy

The coordination signal layer is an **uncommitting exchange plane** — agents publish soft signals that carry no governance weight. These signals are:
- **Non-binding** — they don't trigger state transitions or governance rules
- **Ephemeral** — they decay with TTL and are not part of the permanent audit trail
- **Stigmergic** — agents observe the signal environment indirectly; no direct agent-to-agent messaging

This is grounded in Wu & Ito (2025): implicit consensus through shared environment outperforms explicit consensus protocols. And Habiba et al. (2025): gossip-based dissemination with decay achieves faster convergence than flooding.

##### 7b. Six signal types

| Type | Semantics | Example | TTL |
|------|----------|---------|-----|
| `OBSERVATION` | "I noticed X" — factual, no judgment | "Document D contains financial data" | 5 rounds |
| `CONFIDENCE` | "My confidence in claim C is X" | `{ claim_id, confidence: 0.82, basis: "3 sources" }` | 3 rounds |
| `ATTENTION` | "Topic T needs examination" — soft priority signal | "IP licensing terms need review" | 5 rounds |
| `INTENTION` | "I plan to do X next" — coordination without commitment | "Planning to extract facts from document D" | 2 rounds |
| `CONCERN` | "I see a potential issue with X" — soft warning | "Risk score increasing in financial category" | 5 rounds |
| `REQUEST` | "Can someone address X?" — non-binding request | "Need expertise on regulatory compliance" | 10 rounds |

##### 7c. Signal data model

```typescript
interface CoordinationSignal {
  signal_id: string;           // UUID
  signal_type: SignalType;     // OBSERVATION | CONFIDENCE | ATTENTION | INTENTION | CONCERN | REQUEST
  emitter_agent: string;       // agent ID
  scope_id: string;            // scope context
  epoch: number;               // round when emitted
  payload: Record<string, any>; // type-specific structured data
  ttl_rounds: number;          // rounds until decay
  reinforcement_count: number; // how many agents echoed this signal
  created_at: string;          // ISO 8601
}
```

##### 7d. Dual storage: NATS (hot) + PG (warm)

| Layer | Technology | Purpose | Retention |
|-------|-----------|---------|-----------|
| **Hot** | NATS subject `swarm.signals.{scope_id}` | Real-time dissemination to active agents | In-memory, stream with `max_age: 1h` |
| **Warm** | PostgreSQL `coordination_signals` table | Query for aggregation, pattern detection, coordination health | 24h rolling window |

Agents subscribe to the NATS signal subject alongside their normal event subjects. Signals are published with `AckPolicy.None` (fire-and-forget — uncommitting).

##### 7e. Signal reinforcement (stigmergy)

When an agent observes a signal that aligns with its own analysis, it can **reinforce** it by publishing a reinforcement event. This increments the `reinforcement_count` on the original signal.

Reinforcement mechanics:
- A signal with `reinforcement_count >= 3` is a **strong signal** — multiple agents independently agree
- Strong CONCERN signals elevate the scope's risk profile (soft, not governance-binding)
- Strong ATTENTION signals influence pressure-directed activation (which agent activates next)
- Reinforcement does NOT create governance obligations — it's purely informational

##### 7f. Coordination health metric (composite scalar)

The coordination signal layer produces a single `coordination_health` scalar in `[0, 1]` that feeds into the finality evaluator:

```typescript
function computeCoordinationHealth(signals: CoordinationSignal[], epoch: number): number {
  const active = signals.filter(s => epoch - s.epoch <= s.ttl_rounds);

  // Component 1: Signal diversity — are different signal types being emitted?
  const typesCovered = new Set(active.map(s => s.signal_type)).size;
  const diversity = typesCovered / 6;  // 6 signal types

  // Component 2: Reinforcement ratio — are agents agreeing with each other?
  const reinforced = active.filter(s => s.reinforcement_count >= 2);
  const reinforcementRatio = active.length > 0 ? reinforced.length / active.length : 0;

  // Component 3: Concern ratio (inverted) — fewer concerns = healthier coordination
  const concerns = active.filter(s => s.signal_type === 'CONCERN');
  const concernRatio = 1 - Math.min(concerns.length / Math.max(active.length, 1), 1);

  // Component 4: Intention fulfillment — did agents follow through on stated intentions?
  const intentions = active.filter(s => s.signal_type === 'INTENTION');
  const fulfilled = intentions.filter(s => intentionFulfilled(s, epoch));
  const fulfillmentRatio = intentions.length > 0 ? fulfilled.length / intentions.length : 1;

  // Weighted composite
  return 0.20 * diversity
       + 0.30 * reinforcementRatio
       + 0.25 * concernRatio
       + 0.25 * fulfillmentRatio;
}
```

##### 7g. Integration with finality

```yaml
# finality.yaml addition
conditions:
  coordination_health:
    operator: ">="
    threshold: 0.50   # minimum for RESOLVED — agents must show basic coordination
```

Low coordination health doesn't block finality by itself — it contributes to the overall goal score as a dimension. Very low coordination health (< 0.3) triggers a CONCERN-level flag that influences HITL routing.

#### Issue 8: Protocol switching needs trigger definitions

> **✅ Decided:** YAML switch rules first. More interesting models (learned switching, RL-based) to explore later.

**Problem:** The PRD describes three protocols (evidence-first, debate-lite, diversity+confidence) but doesn't define trigger conditions.

**Resolution:** Protocol switching is configured via YAML in `finality.yaml`. Switch rules are evaluated per-scope at each epoch boundary. The protocol engine checks conditions and transitions if matched.

```yaml
protocols:
  default: evidence_first
  scope: per_scope              # each scope can run a different protocol
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

**Future exploration:** The YAML switch rules are a starting point. More expressive models to investigate:
- **Learned switching:** Train a classifier on historical (protocol, outcome) data to predict optimal protocol
- **RL-based:** Treat protocol selection as a bandit problem with convergence speed as reward
- **Bayesian:** Maintain posterior beliefs about protocol effectiveness per domain type
- **Hybrid:** Use YAML rules as constraints and RL within the feasible set

These are Phase 5+ concerns. YAML rules are sufficient for initial deployment.

#### Issue 9: Integration with governance PRD needs alignment

> **✅ Decided:** OPA-WASM confirmed. Both PRDs now aligned.

**Problem:** The Finality PRD referenced XACML obligations and OPA monotonicity gates without knowing which engine the governance layer would use.

**Resolution:** Both PRDs are now aligned on the same engine stack:

| Component | Engine | Integration Point |
|-----------|--------|------------------|
| HITL routing obligations | Custom obligation enforcer (TypeScript) from governance design | `evaluateFinality() → HITL` triggers `require_human_review` obligation |
| Monotonicity gates | OPA Rego policies via OPA-WASM | `policies/swarm/governance/monotonicity.rego` gates proposals when goal score is non-monotonic |
| Gate A authorization | OPA Rego policies via OPA-WASM | `policies/swarm/governance/gate_a.rego` checks MITL pending, FGA denials |
| Reviewer assignment | OpenFGA `reviewer` relation | Governance Phase 0 extends FGA model |

No XACML anywhere in the stack.

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

| # | Question | Impact | Status |
|---|----------|--------|--------|
| Q1 | Should sessions be a new entity, or should we extend the existing scope model? | Determines whether we add `sessions` table or add columns to `swarm_state` | **✅ Decided:** scope_id = session, epoch = round. No new entities. |
| Q2 | How are contradiction severity/materiality assigned? | Affects the `mass(U)` computation and the data model for contradiction edges | **✅ Decided:** Full model in Issue 5. Facts agent proposes severity; governance can override. Materiality from evidence schema + exposure + dependencies. |
| Q3 | What evidence schemas exist per domain? | Blocks evidence coverage implementation — can't compute without a schema | **✅ Decided:** 5-domain research complete. Universal 4-level hierarchy. Schema format defined in Issue 6. Start with M&A domain. |
| Q4 | Is protocol switching per-scope or per-session? | Affects the protocol state machine granularity | **✅ Decided:** Per-scope. Each scope can run a different protocol. YAML switch rules. |
| Q5 | How is the governance PRD's timeline aligned with this one? | Sequencing dependency between the two PRDs | **✅ Decided:** OPA-WASM in both. Finality Phases 0–4 are independent; Phase 5–6 may depend on governance Phase 1. |
| Q6 | What signing keys are used for finality certificates? | Affects key management architecture | Open — start with single system key (Ed25519); defer multi-agent key infrastructure. |
| Q7 | Should we track semantic diversity (embedding-space dimensionality)? | Adds ML pipeline dependency for embedding computation | Open — deferred. Coordination signal layer covers diversity measurement without embeddings. |

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
┌─────────────────────────────────────────────────────────────────┐
│                  FINALITY EVALUATION (revised)                    │
│                                                                   │
│  Gate A: ─── PRECONDITION (governance layer) ──────────────────  │
│    └─ evaluateGateA() via OPA-WASM (see governance-design.md)    │
│                                                                   │
│  Gate B: Epistemic stability                                      │
│    ├─ contradiction_mass(U) with severity/materiality    [NEW]    │
│    ├─ evidence_coverage via domain schema (4-level)      [NEW]    │
│    ├─ hard gate check (must-have evidence items)         [NEW]    │
│    └─ unresolved_count (existing)                                 │
│                                                                   │
│  Gate C: Progress stability                                       │
│    ├─ Lyapunov V, α rate, β monotonicity, τ plateau (existing)   │
│    ├─ oscillation pattern detection (autocorrelation)    [NEW]    │
│    ├─ trajectory quality score                           [NEW]    │
│    └─ confidence calibration (per-agent)                 [NEW]    │
│                                                                   │
│  Gate D: Operational quiescence (time-bounded heuristic)          │
│    ├─ idle_cycles >= threshold (existing condition)                │
│    ├─ activation_pressure_total == 0                     [NEW]    │
│    └─ last_delta_age_ms >= quiescence_window             [NEW]    │
│                                                                   │
│  Protocol engine (YAML switch rules)                              │
│    ├─ evidence_first (default)                           [NEW]    │
│    ├─ debate_lite (plateau + low risk)                   [NEW]    │
│    ├─ diversity_confidence (plateau + high risk)         [NEW]    │
│    └─ judge_adjudication (deadlock fallback)             [NEW]    │
│                                                                   │
│  Session lifecycle (scope_id = session, epoch = round)            │
│    ├─ session_started / session_finalized events          [NEW]   │
│    └─ round metrics snapshots per epoch                   [NEW]   │
│                                                                   │
│  Finality certificate                                             │
│    ├─ JWS General JSON with multi-signature               [NEW]   │
│    └─ policy version hashes                               [NEW]   │
│                                                                   │
│  Coordination signal layer (uncommitting exchange plane)          │
│    ├─ 6 signal types: OBSERVATION, CONFIDENCE, ATTENTION,        │
│    │  INTENTION, CONCERN, REQUEST                         [NEW]   │
│    ├─ Dual NATS (hot) + PG (warm) storage                [NEW]   │
│    ├─ Stigmergic reinforcement with TTL decay            [NEW]   │
│    └─ coordination_health composite scalar → Gate B/C    [NEW]   │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### Metrics additions to `FinalitySnapshot`

```typescript
// Extend existing FinalitySnapshot
interface FinalitySnapshot {
  // ... existing fields ...

  // NEW: Gate B — Epistemic stability
  contradiction_mass: number;               // severity × materiality weighted sum
  evidence_coverage: CoverageResult;        // per-domain schema (see Issue 6)
  hard_gates_met: boolean;                  // all must-have evidence items present

  // NEW: Gate C — Progress stability (extend convergence)
  oscillation_period: number | null;        // detected cycle length, or null
  trajectory_quality: number;               // [0-1] shape quality score
  agent_confidence_spread: number;          // std dev of per-agent confidences

  // NEW: Gate D — Quiescence
  activation_pressure_total: number;        // sum of all dimension pressures
  last_delta_age_ms: number;               // wall-clock ms since last state change
  quiescent: boolean;                       // composite heuristic

  // NEW: Coordination signal layer
  coordination_health: number;              // [0-1] composite scalar
  active_signals_count: number;             // non-expired signals in scope
  strong_concerns_count: number;            // CONCERN signals with reinforcement >= 3
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
| 0.4 | **Define `CoordinationSignal` type** — 6 signal types (OBSERVATION, CONFIDENCE, ATTENTION, INTENTION, CONCERN, REQUEST), reinforcement model, TTL decay | `src/types/finality.ts` |
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
| 2.6 | **Implement coordination signal storage** — NATS subject `swarm.signals.{scope_id}` (hot, `AckPolicy.None`) + PG `coordination_signals` table (warm, 24h rolling) | `src/coordinationSignal.ts` (new), `src/eventBus.ts` |
| 2.7 | **Implement signal emission API** — `emitSignal(type, payload, ttl)` called by agents; publish to NATS + insert PG | `src/coordinationSignal.ts` |
| 2.8 | **Implement signal reinforcement** — `reinforceSignal(signal_id)` increments count; strong signals (count >= 3) marked for attention | `src/coordinationSignal.ts` |
| 2.9 | **Implement `computeCoordinationHealth()`** — composite scalar from diversity, reinforcement ratio, concern ratio, intention fulfillment | `src/coordinationSignal.ts` |
| 2.10 | **Integrate coordination health into snapshot** — add to `loadFinalitySnapshot()` as a dimension | `src/finalityEvaluator.ts` |
| 2.11 | **Wire signal subscription into agents** — agents subscribe to `swarm.signals.{scope_id}` alongside normal subjects; signals inform but don't bind | `src/agentLoop.ts` |
| 2.12 | **Tests** — signal emission, reinforcement, TTL decay, coordination health, oscillation autocorrelation, trajectory scoring | `test/unit/coordinationSignal.test.ts`, `test/unit/convergenceTracker.test.ts` |

### Phase 3: Gate D + Session Lifecycle (est. 1–2 weeks)

**Goal:** Operational quiescence detection and formal session boundaries.

| Step | Description | Files |
|------|-------------|-------|
| 3.1 | **Implement quiescence heuristic** — combine `idle_cycles >= threshold` + `activation_pressure_total == 0` + `scope.last_delta_age_ms >= quiescence_window_ms` | `src/finalityEvaluator.ts` |
| 3.2 | **Add quiescence to finality.yaml** — new RESOLVED condition: `quiescence: true` (alongside existing conditions) | `finality.yaml` |
| 3.3 | **Formalize session lifecycle** — add `session_started` and `session_finalized` event types to context WAL | `src/contextWal.ts` |
| 3.4 | **Round metrics snapshots** — after each epoch, emit `RoundEvent` with full metrics snapshot to context WAL | `src/agents/governanceAgent.ts` |
| 3.5 | **Tests** — quiescence detection, session lifecycle events, round metrics snapshots | `test/unit/finalityEvaluator.test.ts` |

*Note: No `sessions` table needed — `scope_id` is the session, `epoch` is the round. Session lifecycle is expressed through WAL event types.*

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
| `context_events` | Existing | Append-only audit WAL (also serves as session lifecycle via event types) |
| `mitl_pending` | Existing | Human review queue |
| `swarm_state` | Existing | State machine (scope_id = session, epoch = round) |
| `coordination_signals` | **New (Phase 2)** | Agent-to-agent uncommitting signals, 24h rolling window |
| `finality_certificates` | **New (Phase 4)** | Signed finality artifacts (JWS General JSON) |
| `agent_reputation` | **New (Phase 6)** | Per-agent track record |

*Note: No `sessions` table — scope_id is the session. No new entity needed.*
