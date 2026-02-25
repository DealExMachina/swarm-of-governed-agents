# Refactoring Plan

Plan for addressing code smells and refactoring opportunities identified in the codebase.

---

## Overview

| Phase | Focus | Estimated Effort |
|-------|--------|------------------|
| 1 | Extract drift loading, remove debug telemetry | Low |
| 2 | Centralize finality constants | Low |
| 3 | Consolidate factsToSemanticGraph upsert logic | Medium |
| 4 | Split governanceAgent (tools, proposal flow) | Medium |
| 5 | Split feed.ts by concern | Medium |

---

## Phase 1: Low-risk, high-impact cleanup

### 1.1 Add `loadDrift()` and replace duplicated logic

**Goal:** Single source of truth for loading and parsing `drift/latest.json`.

**Steps:**
1. In `src/agents/sharedTools.ts`, add `loadDrift(s3, bucket): Promise<{ level: string; types: string[] } | null>` that:
   - Calls `s3GetText(s3, bucket, "drift/latest.json")`
   - Parses JSON, returns typed object or null
   - Handles missing/invalid gracefully
2. Replace all 15+ call sites with `loadDrift()`:
   - `governanceAgent.ts` (5 sites)
   - `statusAgent.ts` (2 sites)
   - `plannerAgent.ts` (2 sites)
   - `actionExecutor.ts` (4 sites)
   - `feed.ts` (1 site)
   - `driftAgent.ts` (2 sites) — may keep local parsing if schema differs; verify
3. Remove or consolidate `KEY_DRIFT` constants (keep one in sharedTools or a drift module).
4. Run tests: `pnpm run test`; run E2E if available.

**Verification:** All agents that depend on drift still behave correctly (governance, status, planner, executor, feed).

---

### 1.2 Remove or replace hardcoded debug fetch calls

**Goal:** Remove ad hoc telemetry to `127.0.0.1:7243`; use OpenTelemetry or remove.

**Steps:**
1. Decide strategy: remove entirely, or replace with `telemetry.ts` span/event.
2. Remove or replace fetch calls in:
   - `src/agents/governanceAgent.ts` (1)
   - `src/actionExecutor.ts` (1)
   - `scripts/check-services.ts` (5) — scripts may be acceptable to leave if debug-only; document intent
   - `demo/demo-server.ts` (11) — demo-specific; consider env toggle or removal
3. If replacing: add lightweight helper in `telemetry.ts` for "agent log" events; wire to OpenTelemetry.
4. Run tests; verify no production paths hit 7243.

**Verification:** No `fetch('http://127.0.0.1:7243` in production code paths; demo/scripts optional.

---

## Phase 2: Centralize finality constants

### 2.1 Extract magic numbers and default weights

**Goal:** Single place for thresholds and weights; easier tuning and tests.

**Steps:**
1. In `src/finalityEvaluator.ts` (or `src/modelConfig.ts`), add:
   ```ts
   export const FINALITY_THRESHOLDS = {
     claim_min_confidence: 0.85,
     goal_completion_ok: 0.9,
     goal_completion_partial: 0.7,
     risk_ok: 0.2,
     risk_partial: 0.5,
     auto_resolve_score: 0.92,
   } as const;
   export const DEFAULT_FINALITY_WEIGHTS = {
     claim_confidence: 0.3,
     contradiction_resolution: 0.3,
     goal_completion: 0.25,
     risk_score: 0.15,
   } as const;
   ```
2. Replace inline literals in `computeGoalScore`, `buildDimensionBreakdown`, `buildBlockers`.
3. Ensure `finality.yaml` overrides still take precedence where config is loaded.
4. Run `pnpm run test`; specifically `test/unit/finalityEvaluator.test.ts`.

**Verification:** Finality behavior unchanged; weights/thresholds configurable from one place.

---

## Phase 3: Consolidate factsToSemanticGraph upsert logic

### 3.1 Generic sync for claims, goals, risks

**Goal:** DRY upsert logic; reduce maintenance and drift between entity types.

**Steps:**
1. Extract `syncEntityNodes<T>(params)` helper:
   - `scopeId`, `source`, `entityType` (claim|goal|risk)
   - `items: string[]`, `confidence?: number`
   - `existingNodes`, `contentToId` (or derive from existing)
   - Per-entity differences (e.g. claims: upsert-if-better; goals/risks: upsert-or-insert) via options
2. Refactor claim sync to use `syncEntityNodes` with claim-specific options.
3. Refactor goal sync to use `syncEntityNodes` with goal-specific options.
4. Refactor risk sync to use `syncEntityNodes` with risk-specific options.
5. Run `pnpm run test`; `test/unit/factsToSemanticGraph.test.ts`.

**Verification:** Semantic graph output identical for same input; monotonicity preserved.

---

## Phase 4: Split governanceAgent

### 4.1 Extract tool creation

**Goal:** Shorter, focused functions; easier to test and reason about.

**Steps:**
1. Move `createGovernanceTools` body into a new module `src/agents/governanceTools.ts`.
2. Split into smaller factories, e.g.:
   - `createReadStateTool()`
   - `createCheckRulesTool()`
   - `createCheckPolicyTool()` (if OpenFGA)
   - `createDriftTool()` — use `loadDrift()` from Phase 1
3. Compose them in `createGovernanceTools()`.
4. governanceAgent imports and uses the composed tools.

**Verification:** Governance agent tests pass; tools behave the same.

---

### 4.2 Extract proposal evaluation and processing

**Goal:** Shorter functions; clearer separation between deterministic eval and LLM/oversight paths.

**Steps:**
1. Extract `evaluateProposalDeterministic` into `src/governanceEvaluator.ts` or keep in governance module but in a separate function file.
2. Split `processProposal` into:
   - `routeProposal(proposal)` — MASTER/MITL/YOLO routing
   - `handleMasterOrMitl(proposal)` — direct process
   - `handleYolo(proposal)` — deterministic + oversight
3. Keep `processProposal` as a thin orchestrator calling these.
4. Run governance tests and E2E governance-path verification.

**Verification:** `verify:governance-paths` still passes; audit trail unchanged.

---

## Phase 5: Split feed.ts

### 5.1 Extract feed utilities (DONE)

**Completed:** Extracted `src/feed/feedBus.ts` (EventBus singleton) and `src/feed/utils.ts` (getPathname, getQuery, sendJson, readJsonBody). `feed.ts` imports from these. Handlers and routing remain in feed.ts for now.

**Remaining (optional):**
- Extract handlers to `handlers.ts`
- Extract SSE logic to `sse.ts`
- Extract INDEX_HTML to `ui.ts`

**Verification:** Feed API and demo UI behavior unchanged.

---

## Execution order

1. **Phase 1.1** — loadDrift (enables simpler governance/executor code in Phase 4).
2. **Phase 1.2** — Remove debug fetches (independent, quick).
3. **Phase 2.1** — Finality constants (independent).
4. **Phase 3.1** — factsToSemanticGraph (independent).
5. **Phase 4.1–4.2** — governanceAgent (can use loadDrift from 1.1).
6. **Phase 5.1** — feed.ts (can be deferred; lower priority).

---

## Testing checkpoints

After each phase:

- `pnpm run test` (unit tests)
- `./scripts/run-e2e.sh` after Phase 1, 4 (full stack)
- `pnpm run verify:governance-paths` after Phase 4
- `npx tsx scripts/benchmark-convergence.ts` after Phase 2

---

## Risk and rollback

| Phase | Risk | Rollback |
|-------|------|----------|
| 1 | Low — additive helper, straightforward replace | Revert to inline drift loading |
| 2 | Low — constants only | Revert constant extraction |
| 3 | Medium — logic change in sync | Revert to per-entity loops |
| 4 | Medium — governance is critical path | Revert module splits; keep behavior |
| 5 | Low — structure only | Revert to monolithic feed.ts |

---

## Out of scope (future)

- **agent-hatching-design.md** — dynamic agent lifecycle (separate initiative)
- **rust-evaluation.md** — performance/rewrite (depends on profiling)
- OpenFGA model setup, HITL UX, resolutions-to-goals (feature work, not refactor)
