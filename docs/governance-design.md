# Governance Functional Language & Policy Stack — Design Review

**Branch:** `feature/governance-design`
**Status:** Architecture Review — NOT YET IMPLEMENTING
**Date:** 2026-02-22

---

## Table of Contents

1. [PRD Summary](#1-prd-summary)
2. [Current State Analysis](#2-current-state-analysis)
3. [Critical Review of PRD](#3-critical-review-of-prd)
4. [Open Questions](#4-open-questions)
5. [Technology Assessment](#5-technology-assessment)
6. [Revised Architecture Recommendation](#6-revised-architecture-recommendation)
7. [High-Level Implementation Plan](#7-high-level-implementation-plan)
8. [Risk Register](#8-risk-register)
9. [Resources & References](#9-resources--references)

---

## 1. PRD Summary

The PRD proposes a **three-layer governance stack**:

| Layer | Engine | Role |
|-------|--------|------|
| L1 | OpenFGA | Relationship-based authorization (who can do what to which) |
| L2 | OPA (Rego) | Contextual admissibility (risk gating, rate limiting, oscillation) |
| L3 | XACML 3.0 | Business governance with obligations, combining algorithms, conflict resolution |

Plus a **custom DSL ("Luego-style")** that compiles deterministically into XACML PolicySets.

The layers execute sequentially: `FGA → OPA → XACML`, with short-circuit on denial. Each proposal generates an immutable `DecisionRecord` capturing all three verdicts, policy versions, and triggered obligations.

---

## 2. Current State Analysis

### What exists today

| Component | File | Lines | What it does |
|-----------|------|-------|-------------|
| Governance engine | `src/governance.ts` | 95 | YAML-based rule evaluation, transition gating |
| Governance agent | `src/agents/governanceAgent.ts` | 711 | Three-tier proposal processing (deterministic → oversight → LLM) |
| OpenFGA policy | `src/policy.ts` | 64 | `checkPermission(agent, relation, target)` via HTTP |
| State machine | `src/stateGraph.ts` | 172 | Atomic CAS state advance with governance checks |
| MITL server | `src/mitlServer.ts` | 272 | Human approval REST API |
| Finality evaluator | `src/finalityEvaluator.ts` | 472 | Goal-gradient scoring, condition evaluation |
| Convergence tracker | `src/convergenceTracker.ts` | 352 | Lyapunov stability, monotonicity, plateau detection |
| Audit (WAL) | `src/contextWal.ts` | 129 | Append-only event log in PostgreSQL |
| Metrics | `src/metrics.ts` | 100 | OpenTelemetry counters/histograms |
| Resilience | `src/resilience.ts` | 133 | Circuit breaker, retry with backoff |
| Governance DSL | `governance.yaml` | ~50 | Drift rules, transition rules, mode, scopes |
| Finality DSL | `finality.yaml` | ~80 | Condition rules, thresholds, weights |

### Current governance evaluation flow

```
Proposal arrives via NATS (swarm.proposals.>)
  │
  ├─ MASTER mode → auto-approve
  ├─ MITL mode → always pending (human required)
  └─ YOLO mode →
       │
       ├─ evaluateProposalDeterministic()
       │    ├─ Check epoch match
       │    ├─ Evaluate drift rules (governance.yaml)
       │    ├─ Check transition rules (canTransition)
       │    └─ Check OpenFGA policy (checkPermission)
       │
       ├─ runOversightAgent() [optional LLM triage]
       │    └─ acceptDeterministic | escalateToLLM | escalateToHuman
       │
       └─ processProposalWithAgent() [full LLM governance]
            └─ 7 tools: readState, readDrift, readGovernanceRules,
               checkTransition, checkPolicy, publishApproval, publishRejection
```

### What does NOT exist today

- **No OPA/Rego integration** — rules are custom YAML-evaluated TypeScript
- **No XACML** — no policy sets, no combining algorithms, no obligations
- **No obligation model** — actions are flat strings, no mandatory/advisory distinction
- **No agent reputation** — only scope-level risk scores and dimensional pressure
- **No policy versioning** — single `governance.yaml`, no hashes or version tracking
- **No conflict resolution** — first-match evaluation, no combining algorithms
- **No DSL compiler** — YAML interpreted directly, no AST/compilation step

---

## 3. Critical Review of PRD

### 3.1 Strengths

1. **Sound layering principle.** Separating identity/relationship auth (L1), contextual admissibility (L2), and business governance (L3) is architecturally correct. Each layer has a distinct concern and failure mode.

2. **Formal model.** The proposal definition `p = <id, agent, action, object, delta, context>` and the sequential `DECIDE(S, p)` function are well-defined. The short-circuit on denial is correct and efficient.

3. **Obligation model is the critical missing piece.** The current system has no concept of mandatory post-decision actions. Obligations like `require_dual_review`, `notify_compliance`, `freeze_object` are essential for regulated environments and directly address gaps in the current YOLO/MITL binary.

4. **Audit model is well-specified.** The `DecisionRecord` with policy version hashes enables full decision reconstruction — a significant upgrade from the current flat WAL events.

5. **Governance-of-governance.** Meta-governance (policy modifications requiring their own authorization) prevents silent policy drift — this is not addressed at all in the current system.

### 3.2 Issues and Gaps

#### Issue 1: XACML is the wrong engine for this stack

**Problem:** The PRD proposes XACML 3.0 as the L3 business governance engine. However:

- **No TypeScript XACML PDP exists.** The npm ecosystem is barren — the only packages are abandoned (v0.0.1 from 2014) or PEP-only clients. You would depend on a Java sidecar (AuthZForce) for every decision.
- **Java sidecar overhead.** AuthZForce requires 256–512MB JVM heap + 2–15ms per decision (vs. current sub-ms in-process evaluation). This is a 10–50x latency regression on a hot governance path.
- **XML policy authoring.** Even with ALFA (the XACML DSL), the compilation toolchain is proprietary to Axiomatics. There is no open-source TypeScript→XACML compiler.
- **Building a custom DSL→XACML compiler is very high effort** (estimated 6–10 weeks) for questionable value — you'd be targeting a format that no one on the team reads or debugs directly.

**Recommendation:** Adopt XACML's *conceptual model* (PolicySet, Policy, Rule, Target, Condition, Obligation, Advice, combining algorithms) without targeting actual XACML XML. Implement this natively in TypeScript or use a modern engine that supports obligation-like behavior (see Section 5).

#### Issue 2: Three external runtime dependencies is too many moving parts

**Problem:** Running OpenFGA + OPA + XACML PDP adds three network hops per governance decision, three services to deploy/monitor/upgrade, and three failure modes. The P95 budget of "< 50ms per layer" (Section 10) means 150ms total — 150x slower than the current in-process path.

**Recommendation:** Consider a two-layer architecture:
- **L1: OpenFGA** — relationship authorization (already deployed, keep it)
- **L2: Single policy engine** — handles both contextual admissibility AND business governance with obligations

This collapses OPA + XACML into one engine that can run in-process or as a single sidecar.

#### Issue 3: Missing agent reputation model

**Problem:** Section 5.2 references `input.agent.reputation > 0.6` in the OPA example, but the current system has no agent reputation tracking. The PRD doesn't define how reputation is computed, updated, or decayed.

**Current state:** Only scope-level risk scores exist (`semanticGraph.ts`), plus per-dimension pressure scoring (`convergenceTracker.ts`). There is no per-agent track record.

**Recommendation:** Define the reputation model explicitly:
- What signals feed reputation? (decision accuracy, escalation rate, error count, cycle time)
- How does reputation decay over time?
- Where is reputation stored? (PostgreSQL table, in-memory cache)
- How does reputation affect governance decisions beyond simple threshold gates?

#### Issue 4: Enrichment model is underspecified

**Problem:** Section 7 lists enrichment attributes but doesn't define:
- Where each attribute comes from (which service/table/computation)
- How stale data is handled (cache TTL, refresh triggers)
- What happens when enrichment fails (e.g., semantic graph unavailable)

**Current state:** The governance agent already collects drift info, finality snapshots, and convergence data — but ad-hoc, not as a formal enrichment pipeline.

**Recommendation:** Map each enrichment attribute to its concrete source:

| Attribute | Source | Latency | Failure mode |
|-----------|--------|---------|-------------|
| `fga_decision` | OpenFGA HTTP | 5-20ms | deny (or allow if `ALLOW_IF_UNAVAILABLE`) |
| `opa_decision` | OPA/embedded | <1ms | deny |
| `risk_score` | `semanticGraph.ts` → PG query | <10ms | use cached value or 0 |
| `contradiction_mass` | `semanticGraph.ts` → PG query | <10ms | use cached value or 0 |
| `evidence_coverage` | Not yet computed | — | needs implementation |
| `agent_metadata` | Agent registry (new) | <1ms | static defaults |
| `session_scope` | NATS message context | 0ms | required field |

#### Issue 5: DSL compilation target should not be XACML

**Problem:** Section 6 proposes `DSL → Typed AST → XACML PolicySet`. As argued in Issue 1, XACML XML is the wrong target. The DSL is a good idea — the compilation target is not.

**Recommendation:** `DSL → Typed AST → Native TypeScript policy objects` (or Cerbos YAML, or OPA Rego). The DSL provides the business-facing authoring experience; the compilation target should be whatever engine you actually evaluate at runtime.

#### Issue 6: No migration path from current system

**Problem:** The PRD describes the end state but not how to get there from the current `governance.yaml` + `governance.ts` + `governanceAgent.ts` system. A big-bang replacement risks breaking the working governance pipeline.

**Recommendation:** Define a phased migration where each phase is independently deployable and testable. The current deterministic evaluation path must remain functional throughout.

#### Issue 7: Combining algorithms need clearer defaults

**Problem:** Section 5.3 lists four combining algorithms but doesn't specify which to use where. The choice between `deny-overrides` and `first-applicable` has significant behavioral implications.

**Recommendation:**
- **PolicySet level (global):** `deny-overrides` — any safety rule can block regardless of other permissions
- **Policy level (per-domain):** `first-applicable` — ordered rules with deterministic priority
- **Scope overrides:** `ordered-deny-overrides` — scope-specific rules can add restrictions but never remove global ones

#### Issue 8: Performance target may be unachievable with three layers

**Problem:** "P95 per layer < 50ms" (Section 10) is achievable individually but the serial composition `FGA(5-20ms) → OPA(1-5ms) → XACML(5-15ms)` plus enrichment queries means P95 total is likely 30-80ms, with P99 potentially exceeding 150ms under load.

**Current baseline:** The in-process `evaluateProposalDeterministic()` runs in <5ms total.

**Recommendation:** Set a total budget, not per-layer budgets. Proposed: **P95 total < 30ms, P99 < 100ms**. Achieve this by:
- Running policy evaluation in-process (WASM or native TS), not via HTTP sidecar
- Caching OpenFGA results for the same agent/resource within a decision (tuple unlikely to change mid-evaluation)
- Parallel enrichment where possible

---

## 4. Open Questions

| # | Question | Impact | Options |
|---|----------|--------|---------|
| Q1 | Should we target XACML compliance for regulatory reasons, or is the conceptual model sufficient? | If regulation requires XACML audit artifacts, we need AuthZForce. If not, native TS is simpler. | A) Full XACML compliance via AuthZForce sidecar. B) XACML-inspired native TS engine. |
| Q2 | How critical is formal verification (SMT proofs) for governance policies? | Cedar offers provable safety properties. If needed for compliance, it changes the engine choice. | A) Required — use Cedar. B) Nice-to-have — use test suites instead. |
| Q3 | Will business users (non-engineers) author governance policies directly? | If yes, a custom DSL with IDE support (Langium) is justified. If no, YAML is sufficient. | A) Yes — build DSL with LSP. B) No — enhanced YAML with Zod validation. |
| Q4 | What is the expected policy volume? (10 rules? 100? 1000?) | Affects engine choice. <100 rules → any engine works. >100 → need rule indexing (OPA, Cedar). | Estimate from domain requirements. |
| Q5 | Is OPA's uncertain stewardship (Styra → Apple acquisition, 2025) acceptable? | OPA is CNCF graduated but lost its primary commercial backer. | A) Accept the risk — CNCF governance is sufficient. B) Prefer Cedar/Cerbos (stronger backing). |
| Q6 | How should agent reputation be computed and decayed? | Directly affects L2 admissibility rules. | Define signals, decay function, storage. |

---

## 5. Technology Assessment

### 5.1 OpenFGA (Layer 1) — KEEP

Already integrated in `src/policy.ts`. The PRD's L1 aligns with the current implementation.

| Aspect | Status |
|--------|--------|
| npm SDK | `@openfga/sdk` v0.9.1 — full TypeScript support |
| Docker | `openfga/openfga:v1.8.3` — already in docker-compose |
| MCP server | `aaguiarz/openfga-modeling-mcp` at `https://mcp.openfga.dev/mcp` — design-time modeling |
| Testing | `fga model test` CLI + `.fga.yaml` test files |
| Model DSL | Schema 1.2 with conditions (CEL), union/intersection/exclusion |

**Action needed:** Expand the current minimal model (agent→writer→node) to cover the PRD's full authorization surface: policy modification rights, scope ownership, escalation authority.

### 5.2 OPA (Layer 2 candidate) — STRONG OPTION

| Aspect | Details |
|--------|---------|
| npm SDK | `@open-policy-agent/opa` v2.0.0 — TypeScript SDK for remote eval |
| WASM | `@open-policy-agent/opa-wasm` ~1.8.x — in-process eval, sub-ms |
| Docker | `openpolicyagent/opa:latest` — 15MB image |
| Decision logs | Native — every decision logged with `decision_id`, input, result, bundle revision |
| Bundle mgmt | Tarball bundles from S3/MinIO, polling-based updates |
| Testing | `opa test` with coverage + `opa fmt`/`opa check --strict` |
| Performance | P95 0.02–3ms (server, indexed rules); P95 ~0.05ms (WASM, simple policies) |
| MCP server | Python only (ag2-mcp-servers); no TypeScript MCP |

**Rego maps directly to current governance rules:**

| Current (`governance.ts`) | Rego equivalent |
|--------------------------|-----------------|
| `evaluateRules(drift)` | `package swarm.governance.rules` |
| `canTransition(from, to, drift)` | `package swarm.governance.transitions` |
| `drift_level ∈ [medium, high]` | `input.drift_level in {"medium", "high"}` |
| risk gating | `input.context.risk_score < threshold` |
| rate limiting | Count recent actions per agent within time window |
| oscillation detection | Direction changes in convergence history |

**Concern:** Rego learning curve for business users. Rego is powerful but not business-readable.

### 5.3 XACML (Layer 3 candidate) — NOT RECOMMENDED AS RUNTIME

| Aspect | Details |
|--------|---------|
| npm PDP | **None exist.** Zero TypeScript XACML evaluation engines. |
| Best engine | AuthZForce `restful-pdp` (Java, Docker, REST/JSON profile) |
| Docker | `authzforce/restful-pdp:latest` — requires 256–512MB JVM heap |
| Performance | P95 2–15ms (sidecar), cache-dependent |
| Obligation model | **Best-in-class** — mandatory obligations + advisory advice, propagation through PolicySets |
| Combining algorithms | All 8 standard algorithms available |
| DSL | ALFA (proprietary compiler); ALFA 2.0 IETF draft |

**Verdict:** XACML's conceptual model (obligations, combining algorithms) is exactly what we need. XACML's runtime (Java PDP, XML policies) is not viable for our TypeScript stack.

### 5.4 Cedar (AWS) — STRONG OPTION FOR FORMAL VERIFICATION

| Aspect | Details |
|--------|---------|
| npm | `@cedar-policy/cedar-wasm` v4.8.2 — in-process WASM evaluation |
| Obligations | **None** — permit/forbid only |
| Formal verification | **Best-in-class** — SMT solver, Lean proofs, provable safety properties |
| Performance | Sub-ms (WASM, linear-time evaluation) |
| CNCF | Sandbox project (growing ecosystem) |

**Verdict:** Excellent for authorization decisions needing mathematical proofs. Cannot replace XACML for obligation-bearing governance policies.

### 5.5 Cerbos — STRONG OPTION FOR OBLIGATIONS

| Aspect | Details |
|--------|---------|
| npm | `@cerbos/grpc`, `@cerbos/http`, `@cerbos/embedded`, `@cerbos/opentelemetry` (8+ packages) |
| Docker | `ghcr.io/cerbos/cerbos:0.51.0` — Go binary, lightweight |
| Obligations | **Partial** — "outputs" mechanism returns structured data alongside decisions |
| Policy format | YAML (close to current `governance.yaml`) |
| Testing | `cerbos compile` with YAML test cases |
| MCP | Active demo: `cerbos/cerbos-mcp-authorization-demo` |
| OTEL | `@cerbos/opentelemetry` first-class package |
| Scoped policies | Native multi-tenant scoping (mirrors current `scopes:` concept) |

**Verdict:** Best balance of obligation support, TypeScript ecosystem, and operational maturity. YAML format minimizes migration effort from current system.

### 5.6 DSL Toolchains

| Tool | Type | Best for |
|------|------|----------|
| **Langium** | Full LSP framework | Production DSL with VS Code extension, auto-generated types |
| **Chevrotain** | Parser combinator | Medium DSL, full TS control, no code generation |
| **Peggy** | PEG generator | Simple grammars |
| **Ohm** | PEG-like with debug | Experimentation |
| **TypeScript itself** | Builder pattern | Developer-facing DSL with full type safety |

**Recommendation:** If a DSL is built (Phase 3), use **Langium** for full IDE support, or **Chevrotain** for a lighter approach.

### 5.7 Comparative Scoring

| Requirement | OPA | XACML (AuthZForce) | Cedar | Cerbos | Custom TS |
|-------------|-----|-------------------|-------|--------|-----------|
| Obligation support | Convention (2/5) | Native (5/5) | None (0/5) | Outputs (3/5) | Build it (4/5) |
| TypeScript fit | Good SDK (4/5) | No SDK (1/5) | WASM (4/5) | Excellent (5/5) | Native (5/5) |
| Business readability | Rego (2/5) | XML (1/5) | Good (4/5) | YAML (4/5) | Custom (3/5) |
| Formal verification | No (1/5) | No (1/5) | SMT proofs (5/5) | No (1/5) | No (1/5) |
| Performance (in-process) | WASM 0.05ms (5/5) | N/A (sidecar only) (2/5) | WASM <1ms (5/5) | Embedded (4/5) | Sub-ms (5/5) |
| Decision audit logging | Native (5/5) | XML logs (3/5) | Build it (2/5) | OTEL (4/5) | Build it (3/5) |
| MCP readiness | Python only (2/5) | None (0/5) | None (1/5) | Active demo (5/5) | Build it (2/5) |
| Combining algorithms | Custom Rego (3/5) | All 8 standard (5/5) | Fixed deny-wins (2/5) | Simple (2/5) | Build it (4/5) |
| Migration from current | Direct mapping (4/5) | Major rewrite (1/5) | Moderate (3/5) | YAML→YAML (5/5) | Incremental (5/5) |
| **Total** | **28** | **19** | **26** | **33** | **32** |

---

## 6. Revised Architecture Recommendation

### The two-and-a-half layer architecture

Rather than three external engines, we propose:

```
           ┌──────────────────────────────────────────────────┐
           │              GOVERNANCE PIPELINE                  │
           │                                                   │
Proposal → │ L1: OpenFGA        → Authorized?                 │
    p      │     (HTTP, cached)    ├─ No → DENY (short-circuit)│
           │                       └─ Yes ↓                    │
           │                                                   │
           │ L2: Policy Engine   → Admissible?                 │
           │     (in-process)      ├─ Deny → DENY              │
           │     OPA-WASM or       ├─ Permit → obligations[]   │
           │     Cerbos-embedded   └─ NotApplicable → default  │
           │                                                   │
           │ Obligation enforcer → Execute obligations         │
           │     (TypeScript)      ├─ require_dual_review      │
           │                       ├─ notify_compliance        │
           │                       ├─ freeze_object            │
           │                       └─ escalate_to_committee    │
           │                                                   │
           │ Audit recorder      → DecisionRecord to WAL      │
           │                                                   │
           └──────────────────────────────────────────────────┘
```

**Key decisions:**

1. **L1 stays OpenFGA** — already deployed, covers relationship authorization.

2. **L2 + L3 merge into a single in-process policy engine** — either:
   - **Option A: OPA via WASM** (`@open-policy-agent/opa-wasm`) — Rego policies, sub-ms eval, decision logging via wrapper. Convention-based obligations (Rego returns structured JSON with `obligations[]`).
   - **Option B: Cerbos embedded** (`@cerbos/embedded`) — YAML policies, outputs mechanism for obligations, native OTEL.
   - **Option C: Custom TypeScript engine** — XACML-inspired with native combining algorithms and first-class obligations. Evolve `governance.ts` incrementally.

3. **Obligation enforcement is a separate TypeScript layer** — regardless of engine choice, a `ObligationEnforcer` class dispatches obligations returned by the policy engine. This is mandatory semantics: if enforcement fails, the decision reverts to DENY (XACML obligation semantics).

4. **DSL is a Phase 3 concern** — start with YAML/Rego policies, build DSL only when business users need direct authoring.

### Recommended engine: **Option A (OPA-WASM) + Custom obligation layer**

**Rationale:**
- OPA-WASM gives sub-ms in-process evaluation with zero external dependencies at runtime
- Rego directly maps to current `governance.ts` rules (drift gating, transition blocking, rate limiting)
- OPA's bundle system leverages existing MinIO for policy distribution
- Decision logging is native and structured
- The obligation layer is custom TypeScript regardless of engine choice — OPA's structured JSON output is the cleanest interface for passing obligation lists
- CNCF graduated project with broad enterprise adoption
- `opa test` provides a mature policy testing framework

**Trade-off accepted:** Rego is not business-user-readable. This is mitigated by:
- YAML-to-Rego compilation for simple rules (Phase 2)
- Full DSL with IDE support if needed (Phase 3)
- Policy test suites as the primary governance artifact for business review

---

## 7. High-Level Implementation Plan

### Phase 0: Foundation (est. 1 week)

**Goal:** Establish infrastructure without changing governance behavior.

| Step | Description | Files |
|------|-------------|-------|
| 0.1 | **Add OPA to docker-compose** — `openpolicyagent/opa:latest`, port 8181, health check, `/policies` volume | `docker-compose.yml` |
| 0.2 | **Install npm packages** — `@open-policy-agent/opa` (server SDK), `@open-policy-agent/opa-wasm` (embedded) | `package.json` |
| 0.3 | **Create `policies/` directory** — Rego files + data + tests + bundle manifest | `policies/swarm/governance/*.rego` |
| 0.4 | **Create `src/policyEngine.ts`** — Abstract `PolicyEngine` interface with `evaluate(proposal, context) → PolicyDecision` | `src/policyEngine.ts` |
| 0.5 | **Define `PolicyDecision` type** — `{ decision, obligations[], advice[], reasons[], policyVersions }` | `src/types/governance.ts` |
| 0.6 | **Define `DecisionRecord` type** — Full audit record per PRD Section 8 | `src/types/governance.ts` |
| 0.7 | **Create `src/obligationEnforcer.ts`** — Registry of obligation handlers, enforcement with failure semantics | `src/obligationEnforcer.ts` |
| 0.8 | **Expand OpenFGA model** — Add policy modification rights, scope ownership, escalation authority | `openfga/model.fga` |

### Phase 1: OPA Integration — Contextual Admissibility (est. 2 weeks)

**Goal:** Replace `governance.ts` rule evaluation with OPA Rego policies evaluated in-process via WASM.

| Step | Description | Files |
|------|-------------|-------|
| 1.1 | **Port drift rules to Rego** — `policies/swarm/governance/drift.rego` matching current `evaluateRules()` behavior | `policies/swarm/governance/drift.rego` |
| 1.2 | **Port transition rules to Rego** — `policies/swarm/governance/transitions.rego` matching current `canTransition()` | `policies/swarm/governance/transitions.rego` |
| 1.3 | **Add risk gating rules** — Per PRD Section 5.2: block proposals when `risk_score >= threshold` | `policies/swarm/governance/risk.rego` |
| 1.4 | **Add rate limiting rules** — Count recent proposals per agent within sliding window | `policies/swarm/governance/rate_limit.rego` |
| 1.5 | **Add oscillation detection** — Direction change counting in convergence history | `policies/swarm/governance/oscillation.rego` |
| 1.6 | **Add monotonicity enforcement** — Block auto-resolve when goal score is non-monotonic | `policies/swarm/governance/monotonicity.rego` |
| 1.7 | **Implement `OpaWasmEngine`** — Loads compiled WASM bundle, implements `PolicyEngine` interface, returns structured decisions with obligations | `src/opaEngine.ts` |
| 1.8 | **Build enrichment pipeline** — `EnrichmentService` that collects `risk_score`, `contradiction_mass`, `convergence_data`, `agent_metadata`, `fga_decision` into a single context object | `src/enrichment.ts` |
| 1.9 | **Wire into governance agent** — Replace `evaluateProposalDeterministic()` internals with `policyEngine.evaluate()` + `obligationEnforcer.enforce()` | `src/agents/governanceAgent.ts` |
| 1.10 | **Write Rego tests** — `opa test` covering all current `test/unit/governance.test.ts` scenarios + new rules | `policies/swarm/governance/*_test.rego` |
| 1.11 | **Write TypeScript integration tests** — End-to-end: proposal → OPA eval → obligation enforcement → decision record | `test/unit/policyEngine.test.ts` |
| 1.12 | **Shadow mode** — Run OPA in parallel with current governance.ts, log discrepancies, don't use OPA result for decisions yet | `src/agents/governanceAgent.ts` |

### Phase 2: Obligation Model + Combining Algorithms (est. 2 weeks)

**Goal:** Add XACML-inspired obligations, combining algorithms, and structured decision records.

| Step | Description | Files |
|------|-------------|-------|
| 2.1 | **Implement combining algorithms** — `denyOverrides`, `permitOverrides`, `firstApplicable`, `orderedDenyOverrides` in TypeScript (~30 lines each) | `src/combiningAlgorithms.ts` |
| 2.2 | **Implement PolicySet/Policy/Rule model** — TypeScript types mirroring XACML structure but using native objects | `src/types/governance.ts` |
| 2.3 | **Implement obligation registry** — Map obligation IDs to handler functions: `require_dual_review → addMitlPending()`, `notify_compliance → publishEvent()`, `freeze_object → lockNode()`, `escalate_to_committee → createEscalation()` | `src/obligationEnforcer.ts` |
| 2.4 | **Implement DecisionRecord persistence** — Extend `context_events` table or create dedicated `decision_records` table | `src/decisionRecorder.ts` |
| 2.5 | **Add policy version tracking** — Hash governance.yaml, Rego bundle revision, OpenFGA model ID | `src/policyVersions.ts` |
| 2.6 | **Wire obligation enforcement into decision pipeline** — After OPA decision, execute obligations; if any mandatory obligation fails, revert to DENY | `src/agents/governanceAgent.ts` |
| 2.7 | **Governance-of-governance** — Policy modifications require: FGA authorization + OPA admissibility + event log + version increment | `src/policyGovernance.ts` |
| 2.8 | **Remove shadow mode** — Switch OPA from shadow to primary, remove old `governance.ts` evaluation path | `src/agents/governanceAgent.ts`, `src/governance.ts` |

### Phase 3: DSL + Business Authoring (est. 3–4 weeks, if needed)

**Goal:** Business users can author governance policies in a readable DSL with IDE support.

| Step | Description | Files |
|------|-------------|-------|
| 3.1 | **Design DSL grammar** — Based on PRD Section 6 syntax, refined with learnings from Phase 1–2 | `dsl/governance.langium` or `dsl/grammar.ts` |
| 3.2 | **Implement DSL parser** — Using Langium (full LSP) or Chevrotain (lighter) | `src/dsl/parser.ts` |
| 3.3 | **Implement DSL→Rego compiler** — Typed AST → Rego policy files | `src/dsl/compiler.ts` |
| 3.4 | **Implement DSL→test compiler** — Typed AST → `opa test` fixtures | `src/dsl/testGenerator.ts` |
| 3.5 | **VS Code extension** — Syntax highlighting, validation, autocomplete (auto-generated by Langium) | `vscode-extension/` |
| 3.6 | **CI pipeline** — `dsl compile → opa test → opa build → deploy bundle` | `.github/workflows/governance.yml` |

### Phase 4: Agent Reputation + Advanced Admissibility (est. 2 weeks, if needed)

**Goal:** Per-agent reputation scores feed into L2 admissibility rules.

| Step | Description | Files |
|------|-------------|-------|
| 4.1 | **Design reputation model** — Signals: decision accuracy, escalation rate, error count, convergence contribution | `docs/reputation-model.md` |
| 4.2 | **Create `agent_reputation` table** — `agent_id, reputation_score, last_updated, signal_history` | DB migration |
| 4.3 | **Implement reputation tracker** — Update scores after each governance decision outcome | `src/reputationTracker.ts` |
| 4.4 | **Push reputation data to OPA** — Via data API or bundle data.json | `src/opaEngine.ts` |
| 4.5 | **Add reputation-based Rego rules** — Agent clearance levels, rate adjustment by reputation | `policies/swarm/governance/reputation.rego` |

---

## 8. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | OPA-WASM performance degrades with large data sets (convergence history, agent registry) | Medium | Medium | Benchmark early (Phase 1.7); fall back to server mode if needed; keep data minimal |
| R2 | Rego learning curve slows policy development | High | Medium | Start with direct translation of existing YAML rules; provide Rego templates; consider YAML-to-Rego compiler in Phase 2 |
| R3 | Obligation enforcement adds latency to governance path | Low | Medium | Async obligations where possible (notifications); sync only for blocking obligations (dual review) |
| R4 | Shadow mode reveals behavioral differences between old and new evaluation | Medium | Low | Good — this is the point. Log discrepancies, fix before cutover. |
| R5 | OPA stewardship uncertainty (Styra → Apple acquisition) | Low | High | OPA is CNCF graduated; community governance is independent. Cerbos is viable fallback. |
| R6 | Policy engine abstraction leaks OPA-specific concepts | Medium | Medium | Keep `PolicyEngine` interface generic; test with mock engine |
| R7 | Combining algorithm edge cases (NotApplicable, Indeterminate) | Medium | High | Comprehensive test suite for each algorithm; XACML spec is unambiguous on these cases |
| R8 | Bundle deployment lag causes inconsistent policy evaluation across agents | Low | Medium | Pin bundle revision in decision record; detect version skew via OTEL metrics |

---

## 9. Resources & References

### npm Packages

| Package | Version | Purpose |
|---------|---------|---------|
| `@openfga/sdk` | 0.9.1 | OpenFGA TypeScript SDK |
| `@open-policy-agent/opa` | 2.0.0 | OPA TypeScript SDK (server eval) |
| `@open-policy-agent/opa-wasm` | ~1.8.x | OPA WASM in-process evaluation |
| `@cedar-policy/cedar-wasm` | 4.8.2 | Cedar WASM (if formal verification needed) |
| `@cerbos/grpc` | latest | Cerbos gRPC client (alternative to OPA) |
| `@cerbos/embedded` | latest | Cerbos embedded WASM (alternative to OPA) |
| `@cerbos/opentelemetry` | latest | Cerbos OTEL instrumentation |
| `langium` | latest | DSL framework with LSP (Phase 3) |
| `chevrotain` | latest | Parser combinator (Phase 3 alternative) |

### Docker Images

| Image | Port | Purpose |
|-------|------|---------|
| `openfga/openfga:v1.8.3` | 8080 | Relationship authorization (existing) |
| `openpolicyagent/opa:latest` | 8181 | Policy evaluation server (development/debugging) |
| `ghcr.io/cerbos/cerbos:0.51.0` | 3592/3593 | Alternative policy engine |
| `authzforce/restful-pdp:latest` | 8080 | XACML PDP (only if compliance requires) |

### MCP Servers

| Server | URL | Purpose |
|--------|-----|---------|
| OpenFGA Modeling MCP | `https://mcp.openfga.dev/mcp` | Design-time authorization modeling |
| Cerbos MCP Demo | `github.com/cerbos/cerbos-mcp-authorization-demo` | MCP tool authorization |

### Key Documentation

- [OpenFGA Docs](https://openfga.dev/docs)
- [OPA Documentation](https://www.openpolicyagent.org/docs/latest/)
- [OPA WASM](https://www.openpolicyagent.org/docs/latest/wasm/)
- [OPA Bundles](https://www.openpolicyagent.org/docs/management-bundles)
- [Rego Policy Language](https://www.openpolicyagent.org/docs/latest/policy-language/)
- [XACML 3.0 JSON Profile](https://docs.oasis-open.org/xacml/xacml-json-http/v1.1/os/xacml-json-http-v1.1-os.html)
- [Cedar Policy Language](https://www.cedarpolicy.com/)
- [Cerbos Documentation](https://docs.cerbos.dev/)
- [Cerbos Outputs (Obligations)](https://docs.cerbos.dev/cerbos/latest/policies/outputs.html)
- [Langium DSL Framework](https://langium.org/)
- [ALFA 2.0 IETF Draft](https://datatracker.ietf.org/doc/html/draft-brossard-alfa-authz-00)
