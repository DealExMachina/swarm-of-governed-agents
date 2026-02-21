#!/usr/bin/env bash
# E2E: start stack, migrations, seed, bootstrap, swarm, POST doc, verify DB.
set -e
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi

# Facts-worker in Docker: use OpenAI from .env when available, else local Ollama on host
# - OPENAI_API_KEY set: worker uses OpenAI (no host Ollama needed)
# - Otherwise: use host.docker.internal so container reaches host Ollama
if [ -n "$OPENAI_API_KEY" ]; then
  export OLLAMA_BASE_URL=""
else
  export OLLAMA_BASE_URL="http://host.docker.internal:11434"
fi

echo "[E2E] 1. Starting Docker (postgres, s3, nats, facts-worker, feed)..."
docker compose up -d postgres s3 nats facts-worker feed

echo "[E2E] 2. Waiting for Postgres..."
until docker compose exec -T postgres pg_isready -U "${POSTGRES_USER:-swarm}" -d "${POSTGRES_DB:-swarm}" 2>/dev/null; do
  sleep 2
done
echo "[E2E] Postgres ready."
echo "[E2E] Waiting for all services (facts-worker, feed; may take a few minutes on first run)..."
CHECK_FEED=1 CHECK_SERVICES_MAX_WAIT_SEC=300 node --loader ts-node/esm scripts/check-services.ts
if [ $? -ne 0 ]; then
  echo "[E2E] Preflight failed. Check Docker logs: docker logs swarm-v01-facts-worker-1"
  exit 1
fi

echo "[E2E] 2b. Reset to clean sheet (DB, S3, NATS)..."
node --loader ts-node/esm scripts/reset-e2e.ts 2>/dev/null || true

echo "[E2E] 3. Running migrations..."
export PGPASSWORD="${POSTGRES_PASSWORD:-swarm}"
psql -h localhost -p 5433 -U "${POSTGRES_USER:-swarm}" -d "${POSTGRES_DB:-swarm}" -f migrations/002_context_wal.sql -q
psql -h localhost -p 5433 -U "${POSTGRES_USER:-swarm}" -d "${POSTGRES_DB:-swarm}" -f migrations/003_swarm_state.sql -q
psql -h localhost -p 5433 -U "${POSTGRES_USER:-swarm}" -d "${POSTGRES_DB:-swarm}" -f migrations/005_semantic_graph.sql -q
psql -h localhost -p 5433 -U "${POSTGRES_USER:-swarm}" -d "${POSTGRES_DB:-swarm}" -f migrations/006_scope_finality_decisions.sql -q
echo "[E2E] Migrations done."

echo "[E2E] 4. Ensure S3 bucket and NATS stream..."
node --loader ts-node/esm scripts/ensure-bucket.ts
node --loader ts-node/esm scripts/ensure-stream.ts

echo "[E2E] 5. Seed from seed-docs and bootstrap..."
node --loader ts-node/esm scripts/seed-all.ts
node --loader ts-node/esm scripts/bootstrap-once.ts

echo "[E2E] 5b. Ensure pull consumers (remove any existing push consumers)..."
node --loader ts-node/esm scripts/ensure-pull-consumers.ts 2>/dev/null || true

echo "[E2E] 6. Starting swarm (4 agents + governance + executor)..."
LOG_DIR="${LOG_DIR:-/tmp}"
mkdir -p "$LOG_DIR"
: > "$LOG_DIR/swarm-facts.log"
: > "$LOG_DIR/swarm-drift.log"
: > "$LOG_DIR/swarm-planner.log"
: > "$LOG_DIR/swarm-status.log"
: > "$LOG_DIR/swarm-governance.log"
: > "$LOG_DIR/swarm-executor.log"
( export AGENT_ROLE=facts AGENT_ID=facts-1; npm run swarm >> "$LOG_DIR/swarm-facts.log" 2>&1 ) &
( export AGENT_ROLE=drift AGENT_ID=drift-1; npm run swarm >> "$LOG_DIR/swarm-drift.log" 2>&1 ) &
( export AGENT_ROLE=planner AGENT_ID=planner-1; npm run swarm >> "$LOG_DIR/swarm-planner.log" 2>&1 ) &
( export AGENT_ROLE=status AGENT_ID=status-1; npm run swarm >> "$LOG_DIR/swarm-status.log" 2>&1 ) &
( export AGENT_ROLE=governance AGENT_ID=governance-1; npm run swarm >> "$LOG_DIR/swarm-governance.log" 2>&1 ) &
( export AGENT_ROLE=executor; npm run swarm >> "$LOG_DIR/swarm-executor.log" 2>&1 ) &
echo "[E2E] Swarm started. Waiting 50s for pipeline..."
sleep 50

echo "[E2E] 7. Summary (after bootstrap)..."
curl -s http://localhost:3002/summary | head -80

echo "[E2E] 8. POST a doc..."
curl -s -X POST http://localhost:3002/context/docs -H "Content-Type: application/json" \
  -d '{"title":"E2E doc","body":"We use TypeScript and Postgres. Goal: run full E2E. Claim: the system has a semantic graph."}'
echo ""
echo "[E2E] Waiting 40s for facts to run..."
sleep 40

echo "[E2E] 9. Summary (after doc)..."
curl -s http://localhost:3002/summary | head -80

echo "[E2E] 10. Nodes in DB (semantic graph)..."
PGPASSWORD="${POSTGRES_PASSWORD:-swarm}" psql -h localhost -p 5433 -U "${POSTGRES_USER:-swarm}" -d "${POSTGRES_DB:-swarm}" -t -c "SELECT type, COUNT(*) FROM nodes GROUP BY type;"

echo "[E2E] 11. Edges count..."
PGPASSWORD="${POSTGRES_PASSWORD:-swarm}" psql -h localhost -p 5433 -U "${POSTGRES_USER:-swarm}" -d "${POSTGRES_DB:-swarm}" -t -c "SELECT edge_type, COUNT(*) FROM edges GROUP BY edge_type;"

echo "[E2E] Done. Logs: $LOG_DIR/swarm-*.log"
