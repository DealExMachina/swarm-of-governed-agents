# Review of existing non-PR'd branches

**Date:** 2026-02-24  
**Branches considered:** All local/remote branches with no open pull request.

---

## Summary

| Branch | Status vs main | Unique content | Recommendation |
|--------|----------------|----------------|-----------------|
| **feature/governance-design** | 2 commits ahead | New doc only | Open PR to add `docs/governance-design.md` |
| **feature/dual-temporality** | 3 commits ahead | Doc content may overlap main | Rebase on main; open PR only if diff is meaningful |
| **agent-hatching** | 7 commits behind main | None | Delete or rebase if reviving |
| **finality-gradient-descent** | Fully merged into main | None | Safe to delete |

---

## 1. feature/governance-design

- **Commits ahead of main:** 2  
  - `77d5dfd` — docs: governance functional language — design review & implementation plan  
  - `f6e201e` — docs: add Gate A (authorization stability) to governance design  
- **Diff:** Adds single file `docs/governance-design.md` (~675 lines).

**Content:** Design review for Issue #5 (Governance Functional Language & Policy Stack). Covers:

- Current state (governance.ts, YAML, OpenFGA, flow).
- Revised architecture: L1 OpenFGA, L2 OPA (Rego), L3 replaced by TypeScript obligation layer; Gate A (authorization stability) as governance precondition.
- Technology assessment (OPA-WASM, Cerbos, XACML).
- Implementation phases and risk register.

**Recommendation:** Open a PR to merge into main. The doc is not on main and is the design reference for Issue #5. Low risk (docs-only).

---

## 2. feature/dual-temporality

- **Commits ahead of main:** 3  
  - `bb2157e` — docs: finality & convergence layer — design review & implementation plan  
  - `65c838c` — docs: incorporate stakeholder decisions and cross-domain research into finality design  
  - `98ae69b` — docs: dual temporality PRD — bitemporal model for facts, entities & governance  
- **Diff:** Touches `docs/finality-design.md` and `docs/dual-temporality-design.md` (~1,952 lines in diff).

**Note:** `docs/finality-design.md` and `docs/dual-temporality-design.md` already exist on main (merged via PR #7 from `feature/finality-design`). The branch was created from a point before that merge, so the “ahead” commits duplicate the addition of those files. A direct diff of the two files between main and this branch shows ~1,964 lines of difference (likely different versions or line endings).

**Recommendation:**

1. Rebase `feature/dual-temporality` onto current main.
2. If the only remaining change is `docs/dual-temporality-design.md` (or small fixes to both docs), open a PR with that change.
3. If after rebase there are no unique changes, the branch can be deleted.

---

## 3. agent-hatching

- **Commits ahead of main:** 0  
- **Commits behind main:** 7 (citation fixes, robustness hardening merge, README/docs updates).

**Content:** The design for dynamic agent lifecycle (Agent Hatchery) lives on main in `docs/agent-hatching-design.md`. The branch itself has no commits that main does not have; it is an older tip that was never updated.

**Recommendation:** Delete the branch unless you plan to implement the hatchery and want a dedicated branch. If you do revive it, rebase onto main first.

---

## 4. finality-gradient-descent

- **Status:** Fully merged into main (commit `6914074` — “Merge finality-gradient-descent: convergence tracking with Lyapunov V, monotonicity gate, plateau detection…”).
- **Commits ahead of main:** 0.  
- Main is many commits ahead of this branch (subsequent citation, robustness, docs work).

**Recommendation:** Safe to delete. All unique work is already on main.

---

## Actions (suggested)

1. **feature/governance-design** — Open PR: “docs: governance design review (Issue #5)”.
2. **feature/dual-temporality** — Rebase onto main; then open PR only if there are unique doc changes, or delete if redundant.
3. **agent-hatching** — Delete or leave as-is; if keeping, rebase before any new work.
4. **finality-gradient-descent** — Delete (already merged).
