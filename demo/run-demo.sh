#!/usr/bin/env bash
# =============================================================================
# Project Horizon — Governed Agent Swarm Demo
# M&A Due Diligence scenario for enterprise audiences
#
# Usage:
#   ./demo/run-demo.sh                   # interactive, full scenario
#   ./demo/run-demo.sh --fast            # skip pauses (automated run)
#   ./demo/run-demo.sh --step 2          # jump to specific step
#
# Prerequisites:
#   - Docker services running (docker compose up -d)
#   - Swarm started (npm run swarm:all in another terminal)
#   - Feed running on port 3002
# =============================================================================

set -eo pipefail

FEED_URL="${FEED_URL:-http://localhost:3002}"
MITL_URL="${MITL_URL:-http://localhost:3001}"
FAST="${FAST:-false}"
START_STEP="${START_STEP:-1}"
# When SWARM_API_TOKEN is set, add Bearer header to curl calls to feed/MITL
CURL_AUTH=()
if [ -n "${SWARM_API_TOKEN:-}" ]; then
  CURL_AUTH=(-H "Authorization: Bearer $SWARM_API_TOKEN")
fi

# Parse flags
for arg in "$@"; do
  case $arg in
    --fast) FAST=true ;;
    --step)
      shift
      START_STEP="${1:-1}"
      ;;
    --step=*) START_STEP="${arg#*=}" ;;
  esac
done

# -----------------------------------------------------------------------------
# Utilities
# -----------------------------------------------------------------------------

BOLD="\033[1m"
CYAN="\033[36m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
MAGENTA="\033[35m"
RESET="\033[0m"

print_header() {
  echo ""
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}${CYAN}  $1${RESET}"
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""
}

print_step() {
  echo ""
  echo -e "${BOLD}${MAGENTA}▶ STEP $1: $2${RESET}"
  echo ""
}

print_info() {
  echo -e "  ${CYAN}ℹ${RESET}  $1"
}

print_ok() {
  echo -e "  ${GREEN}✓${RESET}  $1"
}

print_warn() {
  echo -e "  ${YELLOW}⚠${RESET}  $1"
}

print_highlight() {
  echo ""
  echo -e "  ${BOLD}${YELLOW}┌─────────────────────────────────────────────────────────────┐${RESET}"
  echo -e "  ${BOLD}${YELLOW}│  $1${RESET}"
  echo -e "  ${BOLD}${YELLOW}└─────────────────────────────────────────────────────────────┘${RESET}"
  echo ""
}

pause() {
  if [ "$FAST" = "true" ]; then
    sleep 2
  else
    echo ""
    echo -e "  ${BOLD}Press [Enter] to continue...${RESET}"
    read -r
  fi
}

wait_for_processing() {
  local seconds="${1:-25}"
  if [ "$FAST" = "true" ]; then
    sleep 5
    return
  fi
  echo ""
  echo -e "  ${CYAN}Waiting ${seconds}s for agents to process...${RESET}"
  for i in $(seq "$seconds" -1 1); do
    printf "\r  ${CYAN}  %2ds remaining...${RESET}" "$i"
    sleep 1
  done
  printf "\r  ${GREEN}  Done.                    ${RESET}\n"
}

check_jq() {
  if command -v jq &>/dev/null; then
    echo "jq"
  else
    echo "cat"
  fi
}

fetch_summary() {
  curl -s "${CURL_AUTH[@]}" "${FEED_URL}/summary" 2>/dev/null || echo '{"error":"feed_unavailable"}'
}

fetch_pending() {
  curl -s "${CURL_AUTH[@]}" "${MITL_URL}/pending" 2>/dev/null || echo '{"pending":[]}'
}

show_summary_key_fields() {
  local jq_cmd
  jq_cmd=$(check_jq)
  local raw
  raw=$(fetch_summary)

  if [ "$jq_cmd" = "jq" ]; then
    echo "$raw" | jq '{
      state: .state.lastNode,
      epoch: .state.epoch,
      drift_level: .drift.level,
      drift_types: .drift.types,
      suggested_actions: .drift.suggested_actions,
      finality_status: .finality.status,
      goal_score: .finality.goal_score,
      goals: (.facts.goals // []),
      graph_nodes: .state_graph.nodes,
      graph_edges: .state_graph.edges
    }' 2>/dev/null || echo "$raw"
  else
    echo "$raw"
  fi
}

# -----------------------------------------------------------------------------
# Pre-flight
# -----------------------------------------------------------------------------

check_services() {
  print_info "Checking feed at ${FEED_URL}..."
  if ! curl -s --max-time 5 "${CURL_AUTH[@]}" "${FEED_URL}/summary" > /dev/null 2>&1; then
    echo -e "  ${RED}Feed is not reachable at ${FEED_URL}.${RESET}"
    echo "  Start it with: npm run swarm:all"
    echo "  Or: docker compose up -d && npm run swarm:all"
    exit 1
  fi
  print_ok "Feed is reachable."
}

# -----------------------------------------------------------------------------
# Feed a document and display its title
# -----------------------------------------------------------------------------

feed_document() {
  local file="$1"
  local doc_path
  doc_path="$(dirname "$0")/scenario/docs/${file}"

  if [ ! -f "$doc_path" ]; then
    echo -e "  ${RED}Document not found: ${doc_path}${RESET}"
    exit 1
  fi

  local title
  title=$(echo "$file" | sed 's/.txt$//' | sed 's/^[0-9]*-//' | sed 's/-/ /g' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1))substr($i,2)}1')
  local body
  body=$(cat "$doc_path")

  local response
  response=$(curl -s -X POST "${FEED_URL}/context/docs" \
    -H "Content-Type: application/json" \
    "${CURL_AUTH[@]}" \
    -d "{\"title\": \"${title}\", \"body\": $(echo "$body" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" \
    2>/dev/null)

  local seq
  seq=$(echo "$response" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("seq","?"))' 2>/dev/null || echo "?")

  print_ok "Document fed: \"${title}\" (seq: ${seq})"
}

# -----------------------------------------------------------------------------
# Main demo flow
# -----------------------------------------------------------------------------

print_header "PROJECT HORIZON — GOVERNED AGENT SWARM DEMO"

echo "  Scenario: M&A Due Diligence for NovaTech AG"
echo "  Acquirer: Anonymous strategic buyer (pharmaceutical distribution)"
echo "  Target:   NovaTech AG — B2B SaaS, supply chain compliance software"
echo ""
echo "  This demo shows how a governed agent swarm:"
echo "    1. Extracts structured claims, risks, and goals from unstructured documents"
echo "    2. Detects contradictions and drift between successive documents"
echo "    3. Applies declarative governance rules to block unsafe state transitions"
echo "    4. Routes human review only when the system cannot self-resolve"
echo "    5. Produces a full audit trail of every decision and approval"
echo ""
echo "  Five documents arrive in sequence, each revealing new information."
echo "  Watch how the swarm's knowledge state evolves — and where governance intervenes."

pause
check_services

# =============================================================================
# STEP 1 — Initial analyst briefing
# =============================================================================

if [ "$START_STEP" -le 1 ]; then
  print_step "1" "Initial Analyst Briefing — Baseline Assessment"
  echo "  Document: 01-analyst-briefing.txt"
  echo ""
  echo "  The deal team receives the Corporate Development team's initial assessment."
  echo "  NovaTech AG looks strong: €50M ARR, 45% CAGR, 7 patents, low risk."
  echo ""
  echo "  What to watch:"
  echo "  • The facts agent extracts claims, goals, and risks into the semantic graph"
  echo "  • Drift agent: no prior context → no drift (first cycle)"
  echo "  • Governance: YOLO mode → auto-approves the transition (nothing to block)"
  echo "  • Finality: goal score will be low — we are at the start of diligence"

  pause
  feed_document "01-analyst-briefing.txt"
  wait_for_processing 25

  print_info "Summary after Step 1:"
  show_summary_key_fields
  echo ""
  print_highlight "Expected: drift.level = none or low | finality.goal_score ≈ 0.15–0.30 | claims about ARR €50M, 7 patents in graph"
fi

# =============================================================================
# STEP 2 — Financial due diligence (contradiction detected)
# =============================================================================

if [ "$START_STEP" -le 2 ]; then
  print_step "2" "Financial Due Diligence — Contradictions Surface"
  echo "  Document: 02-financial-due-diligence.txt"
  echo ""
  echo "  The financial advisory team reports: ARR is actually €38M, not €50M."
  echo "  Two patents have a contested co-ownership dispute."
  echo "  The €12M overstatement represents 24% of reported ARR."
  echo ""
  echo "  What to watch:"
  echo "  • Drift agent detects HIGH drift: factual contradiction on ARR, IP ownership"
  echo "  • Governance rule fires: 'open_investigation' recommended for contradiction"
  echo "  • Governance rule fires: 'request_external_audit' for value_discrepancy"
  echo "  • Transition rule: HIGH drift BLOCKS the state machine from resetting the cycle"
  echo "    → The swarm cannot 'move on' until the planner proposes remediation"
  echo "  • Finality: goal score drops (unresolved contradiction degrades score)"
  echo ""
  print_warn "This is the first governance intervention: the cycle is blocked by policy."

  pause
  feed_document "02-financial-due-diligence.txt"
  wait_for_processing 30

  print_info "Summary after Step 2:"
  show_summary_key_fields
  echo ""
  print_highlight "Expected: drift.level = high | suggested_actions includes open_investigation, request_external_audit | transition blocked"
fi

# =============================================================================
# STEP 3 — Technical assessment (risk accumulation)
# =============================================================================

if [ "$START_STEP" -le 3 ]; then
  print_step "3" "Technical Assessment — Talent Risk Identified"
  echo "  Document: 03-technical-assessment.txt"
  echo ""
  echo "  Good news: the core technology is solid and differentiated."
  echo "  Bad news: the CTO and two founding engineers are departing in Q4 2025."
  echo "  They wrote 61% of the core codebase. This is a critical risk."
  echo ""
  echo "  What to watch:"
  echo "  • New risk nodes added to semantic graph (talent, compliance debt)"
  echo "  • Drift: MEDIUM drift as new risk class is introduced"
  echo "  • Governance rule: 'escalate_to_risk_committee' triggered for risk drift"
  echo "  • Planner adds retention package to recommended actions"
  echo "  • Finality: score adjusts — risk_score_inverse dimension penalizes new risks"

  pause
  feed_document "03-technical-assessment.txt"
  wait_for_processing 25

  print_info "Summary after Step 3:"
  show_summary_key_fields
  echo ""
  print_highlight "Expected: new risk nodes in graph | drift.types includes 'risk' | goal_score decreases from risk dimension"
fi

# =============================================================================
# STEP 4 — Market intelligence (external threat escalates)
# =============================================================================

if [ "$START_STEP" -le 4 ]; then
  print_step "4" "Market Intelligence — Patent Litigation Filed"
  echo "  Document: 04-market-intelligence.txt"
  echo ""
  echo "  A competitor (Axion Corp) filed a patent infringement suit on 3 claims."
  echo "  The same patent EP3847291 is now under attack from two directions:"
  echo "  the Axion lawsuit AND the pre-existing Haber co-ownership dispute."
  echo "  NovaTech's largest client (21.6% of ARR) is evaluating competitors."
  echo ""
  echo "  What to watch:"
  echo "  • Contradiction edges added: the claim 'NovaTech holds 7 clean patents'"
  echo "    is now contradicted by both the Haber dispute AND the Axion suit"
  echo "  • Risk score rises: multiple critical risks active simultaneously"
  echo "  • Finality may evaluate ESCALATED condition (risk_score ≥ 0.75)"
  echo "  • Planner: several parallel remediation actions in flight"

  pause
  feed_document "04-market-intelligence.txt"
  wait_for_processing 25

  print_info "Summary after Step 4:"
  show_summary_key_fields
  echo ""
  print_highlight "Expected: multiple unresolved contradictions | finality.status may be ESCALATED or near_finality | high risk score"
fi

# =============================================================================
# STEP 5 — Legal review (resolution path emerges)
# =============================================================================

if [ "$START_STEP" -le 5 ]; then
  print_step "5" "Legal Review — Resolution Path Recommended"
  echo "  Document: 05-legal-review.txt"
  echo ""
  echo "  The IP and M&A legal team assesses all open risks:"
  echo "  - Axion Claims 2 & 3 are weak and likely to be dismissed"
  echo "  - Claim 1 can be settled for €1.5M–€2M + 4% ARR royalty"
  echo "  - Dr. Haber IP buyout: €800K–€1.2M — must happen before close"
  echo "  - Revised acquisition price: €270M–€290M (vs. original €400M–€430M)"
  echo "  - Recommendation: PROCEED to final negotiation with conditions"
  echo ""
  echo "  What to watch:"
  echo "  • Resolution edges added to semantic graph (contradictions partially resolving)"
  echo "  • Goals completion improves: 'validate IP ownership' and 'validate ARR'"
  echo "    now have resolution paths, even if not yet fully executed"
  echo "  • Finality goal score rises toward near_finality threshold (0.75)"
  echo "  • If score passes 0.75: HITL review is queued automatically"
  echo ""
  print_warn "This is the second governance intervention: near-finality triggers human review."

  pause
  feed_document "05-legal-review.txt"
  wait_for_processing 30

  print_info "Summary after Step 5:"
  show_summary_key_fields
  echo ""
  print_highlight "Expected: finality.status = near_finality | goal_score ≈ 0.75–0.85 | pending HITL review in MITL queue"
fi

# =============================================================================
# STEP 6 — Human review (HITL finality decision)
# =============================================================================

if [ "$START_STEP" -le 6 ]; then
  print_step "6" "Human-in-the-Loop — Finality Review"
  echo "  The swarm has reached near-finality: it has processed all available evidence"
  echo "  and built a coherent knowledge graph, but is not confident enough to"
  echo "  self-resolve. Human judgment is required."
  echo ""
  echo "  Checking the MITL queue for pending finality reviews..."
  echo ""

  local_pending=$(fetch_pending)
  echo "$local_pending" | python3 -c "
import json, sys
data = json.load(sys.stdin)
pending = data.get('pending', [])
if not pending:
    print('  No pending reviews yet. The finality evaluator may still be running.')
    print('  Retry: curl http://localhost:3001/pending | python3 -m json.tool')
else:
    for item in pending:
        pid = item.get('proposal_id', '?')
        prop = item.get('proposal', {})
        payload = prop.get('payload', {})
        print(f'  Proposal ID : {pid}')
        print(f'  Scope       : {payload.get(\"scope_id\", \"?\")}')
        gs = payload.get('goal_score')
        print(f'  Goal score  : {gs * 100:.1f}%' if gs else '  Goal score  : ?')
        blockers = payload.get('blockers', [])
        if blockers:
            print(f'  Blockers:')
            for b in blockers:
                print(f'    - {b.get(\"type\",\"\")}: {b.get(\"description\",\"\")}')
        print('')
" 2>/dev/null || echo "$local_pending"

  echo ""
  echo "  The MITL server is waiting for a decision. Available options:"
  echo ""
  echo "  1. approve_finality   — Accept current state as final (deal scope complete)"
  echo "  2. provide_resolution — Supply additional context to improve confidence"
  echo "  3. escalate           — Escalate to a higher decision authority"
  echo "  4. defer              — Postpone the decision (with expiry in N days)"
  echo ""
  echo "  To decide from the terminal, replace PROPOSAL_ID below:"
  echo ""
  if [ -n "${SWARM_API_TOKEN:-}" ]; then
    echo "  curl -X POST ${FEED_URL}/finality-response \\"
    echo "    -H 'Content-Type: application/json' \\"
    echo "    -H \"Authorization: Bearer \$SWARM_API_TOKEN\" \\"
    echo "    -d '{\"proposal_id\": \"PROPOSAL_ID\", \"option\": \"approve_finality\"}'"
  else
    echo "  curl -X POST ${FEED_URL}/finality-response \\"
    echo "    -H 'Content-Type: application/json' \\"
    echo "    -d '{\"proposal_id\": \"PROPOSAL_ID\", \"option\": \"approve_finality\"}'"
  fi
  echo ""
  echo "  Or use the web UI at: http://localhost:3003"
  echo ""
  print_highlight "For the demo: open http://localhost:3003 in a browser → 'Pending reviews' section → click 'Approve finality'"

  pause
fi

# =============================================================================
# STEP 7 — Resolution
# =============================================================================

if [ "$START_STEP" -le 7 ]; then
  print_step "7" "Post-Resolution — Feeding the Deal Decision"
  echo "  Once the HITL review is approved, you can feed the final decision"
  echo "  back into the context as a resolution event. This closes the loop:"
  echo "  the swarm re-runs facts extraction, drift clears, and finality may"
  echo "  self-resolve on the next cycle."
  echo ""
  echo "  Example resolution (run this in a separate terminal or in the web UI):"
  echo ""
  if [ -n "${SWARM_API_TOKEN:-}" ]; then
    echo "  curl -X POST ${FEED_URL}/context/resolution \\"
    echo "    -H 'Content-Type: application/json' \\"
    echo "    -H \"Authorization: Bearer \$SWARM_API_TOKEN\" \\"
  else
    echo "  curl -X POST ${FEED_URL}/context/resolution \\"
    echo "    -H 'Content-Type: application/json' \\"
  fi
  echo "    -d '{"
  echo "      \"decision\": \"Board approved proceeding to exclusivity with NovaTech AG"
  echo "        at a revised offer of €280M. Conditions: (1) Axion Corp settlement"
  echo "        executed before signing, (2) Dr. Haber IP buyout completed,"
  echo "        (3) CTO retention package signed for 12 months post-close.\","
  echo "      \"summary\": \"Project Horizon approved at €280M with three conditions\""
  echo "    }'"
  echo ""
  echo "  After this, the swarm will process the resolution as new context."
  echo "  The contradictions that referenced the IP dispute will gain resolution edges."
  echo "  On the next finality evaluation, the scope may auto-resolve (score ≥ 0.92)."

  pause

  print_info "Current final summary:"
  show_summary_key_fields
fi

# =============================================================================
# RECAP
# =============================================================================

print_header "WHAT YOU JUST WITNESSED"

echo "  In this scenario, a governed agent swarm processed 5 documents"
echo "  over a simulated due diligence lifecycle. Here is what each"
echo "  governance feature did:"
echo ""
echo "  FACTS AGENT"
echo "  ───────────"
echo "  Extracted claims, goals, and risks from each document as structured nodes"
echo "  in the semantic graph. Every claim is addressable: confidence-scored,"
echo "  typed (claim / goal / risk / assessment), and linked to its source."
echo ""
echo "  DRIFT AGENT"
echo "  ───────────"
echo "  After each document, compared the new facts against the prior state."
echo "  Detected the €12M ARR discrepancy as high-severity factual drift."
echo "  Identified the IP ownership contradiction as a contradiction-type drift."
echo "  These are not keyword alerts — they emerge from the semantic graph structure."
echo ""
echo "  GOVERNANCE AGENT"
echo "  ────────────────"
echo "  Applied declarative rules from governance-demo.yaml at every transition."
echo "  When high drift was detected: BLOCKED the state machine from resetting."
echo "  No agent could proceed past DriftChecked until the planner acted."
echo "  Every proposal was logged: proposer, decision, rationale, timestamp."
echo ""
echo "  PLANNER AGENT"
echo "  ─────────────"
echo "  Synthesized all active context to recommend the next actions."
echo "  Governance rule outputs (open_investigation, request_external_audit)"
echo "  became inputs to the planner, which incorporated them into recommendations."
echo ""
echo "  FINALITY EVALUATOR"
echo "  ──────────────────"
echo "  After each governance cycle, evaluated whether the scope was complete."
echo "  Computed a goal score from: claim confidence, contradiction resolution,"
echo "  goal completion, and risk score. When the score passed 0.75 (near-finality),"
echo "  it did not auto-resolve — it queued a structured review for human judgment."
echo ""
echo "  HUMAN-IN-THE-LOOP"
echo "  ─────────────────"
echo "  The MITL server held the finality review with a structured explanation:"
echo "  what the system knew, what it didn't, what would resolve each blocker."
echo "  The decision officer had four options — no free-form ambiguity."
echo "  The decision is recorded in the audit log regardless of which option was chosen."
echo ""
print_highlight "The system never made a final decision on its own. It worked until it couldn't, then asked the right person the right question."

echo ""
echo "  Full audit trail available at: ${FEED_URL}/summary"
echo "  Raw events: curl ${FEED_URL}/summary?raw=1 | python3 -m json.tool"
echo ""
