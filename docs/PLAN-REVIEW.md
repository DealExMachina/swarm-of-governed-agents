# Plan review — correctness vs current codebase

Short audit of STATUS.md and the design docs (governance-design.md, finality-design.md) against the actual implementation. Done so the "plan" stays accurate.

---

## What is correct

**STATUS.md**

- Core stack (WAL, state, NATS, agents, governance, executor), Docker Compose, migrations 002–010, 012, 013.
- Finality: finality.yaml, evaluator, Gates B/C/D (contradiction mass, evidence coverage, trajectory_quality, quiescence), certificates (JWS), session_finalized, convergence tracker, HITL, MITL.
- Semantic graph: bitemporal columns, time-travel queries, supersedeNode/supersedeEdge, loadFinalitySnapshot (contradiction_mass, evidence_coverage), getEvidenceCoverageForScope.
- Governance: YAML engine, decision records, obligation enforcer, combining algorithms, policy version hashes, OpenFGA.
- Demo, E2E flow, check-services, seed scripts, test counts (283 tests across 38 suites).
- "Next steps" and "Not yet done" match reality (resolutions→goals, HITL UX, embeddings, etc.).

**docs/finality-design.md**

- Implementation plan Phases 0–4 align with what exists (data model, Gate B/C/D, quiescence, certificates).
- Phases 5–6 (protocol engine, agent reputation) correctly marked as not implemented.
- "Current State Analysis" table (Gate B/C/D Done, certificates Done, etc.) is accurate.

**docs/governance-design.md**

- Revised architecture (two-and-a-half layer, OPA-WASM + obligation layer) matches the code layout.
- Implementation plan Phases 0–2 (PolicyEngine, DecisionRecord, OPA module, combining algorithms, obligations, persistence) reflect what was built.

---

## What is incorrect or misleading

**1. OPA-WASM is not wired**

- **STATUS.md** says: "policy engine (YAML default; **optional OPA-WASM via OPA_WASM_PATH**)".
- **Reality:** The governance agent always uses `createYamlPolicyEngine()`. There is no read of `OPA_WASM_PATH` and no call to `createOPAPolicyEngine()`. OPA-WASM exists in `src/opaPolicyEngine.ts` and can be built with `pnpm run build:opa`, but it is not used at runtime.
- **Fix:** Describe as "YAML default; OPA-WASM implementation available but not wired (no env switch)."

**2. semanticGraph and runInTransaction**

- **STATUS.md** lists under semanticGraph.ts: "**runInTransaction**, deleteNodesBySource".
- **Reality:** `runInTransaction` was removed from semanticGraph; it lives only in `db.ts`. Callers (e.g. factsToSemanticGraph, seed-hitl-scenario) import it from `db.js`.
- **Fix:** Remove "runInTransaction" from the semanticGraph bullet; keep deleteNodesBySource.

**3. ensure-schema not in package.json**

- **STATUS.md** and **README** say "pnpm run ensure-schema" and "ensure-schema runs all in order".
- **Reality:** There is no `ensure-schema` script in package.json. The script is `scripts/ensure-schema.ts`, run by `swarm-all.sh` via `node --loader ts-node/esm scripts/ensure-schema.ts`.
- **Fix:** Add to package.json: `"ensure-schema": "node --loader ts-node/esm scripts/ensure-schema.ts"` so "pnpm run ensure-schema" works as documented. Optionally add `ensure-bucket` the same way.

**4. Migration 011 fails on fresh Postgres**

- **Plan:** Migrations 002–013 (including 011 bitemporal) applied via ensure-schema.
- **Reality:** On a clean DB, 011 fails with: "functions in index predicate must be marked IMMUTABLE". The partial indexes in 011 use `valid_to > now()`; `now()` is STABLE, so PostgreSQL rejects it in an index predicate.
- **Fix:** Change 011 to use index predicates that do not use `now()` (e.g. only `superseded_at IS NULL` and optionally `valid_to IS NULL`), or drop those partial indexes and rely on non-partial indexes. Application code already filters `valid_to > now()` at query time.

**5. Design doc headers still say "NOT YET IMPLEMENTING"**

- **docs/governance-design.md** and **docs/finality-design.md** open with "Status: Architecture Review — NOT YET IMPLEMENTING".
- **Reality:** A large part of both plans is implemented (governance Phases 0–2, finality Phases 0–4).
- **Fix:** Update the status line to something like "Status: Partially implemented (Governance Phases 0–2; Finality Phases 0–4). Design review complete."

**6. Governance "What does NOT exist today" is out of date**

- **docs/governance-design.md** lists "No OPA/Rego integration", "No policy versioning", "No obligation model", etc.
- **Reality:** OPA-WASM module exists (not wired); policy versioning (hashes) and decision records exist; obligation enforcer exists; combining algorithms exist.
- **Fix:** Add a short "Implementation update" subsection or adjust "What does NOT exist" so it distinguishes "not wired at runtime" (OPA) from "exists" (versioning, obligations, combining algorithms).

---

## Summary

| Item | Correct? | Action |
|------|-----------|--------|
| STATUS — core/finality/semantic graph | Yes | — |
| STATUS — OPA-WASM via OPA_WASM_PATH | No | Say "available but not wired" |
| STATUS — semanticGraph runInTransaction | No | Remove from list |
| ensure-schema in package.json | No | Add script |
| Migration 011 on fresh DB | No | Fix index predicates |
| Design doc status line | Misleading | Set "Partially implemented" |
| Governance "what does not exist" | Out of date | Update for Phase 0–2 |

The overall plan (governance + finality + bitemporal) is correct; the main gaps are documentation and one migration, not the architecture.
