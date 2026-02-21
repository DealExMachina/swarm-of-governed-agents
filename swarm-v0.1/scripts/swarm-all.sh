#!/usr/bin/env bash
# Ensure NATS stream exists, optionally bootstrap, then start four agents + two processes:
# agents: facts, drift, planner, status (LLM/tools when configured). processes: governance, executor (rule-based loop).
# Logs: LOG_DIR/swarm-<role>.log (default /tmp).
set -e
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
LOG_DIR="${LOG_DIR:-/tmp}"
mkdir -p "$LOG_DIR"

echo "Checking services (Postgres, S3, NATS, facts-worker)..."
node --loader ts-node/esm scripts/check-services.ts
if [ $? -ne 0 ]; then
  echo "Preflight failed. Start Docker (e.g. docker compose up -d s3 postgres nats facts-worker) and ensure facts-worker is ready."
  echo "To wait for slow provisioning, run: CHECK_SERVICES_MAX_WAIT_SEC=300 npm run check:services"
  exit 1
fi

echo "Ensuring S3 bucket..."
node --loader ts-node/esm scripts/ensure-bucket.ts
if [ $? -ne 0 ]; then
  echo "ensure-bucket failed. Exiting."
  exit 1
fi

echo "Ensuring DB schema (migrations)..."
node --loader ts-node/esm scripts/ensure-schema.ts
if [ $? -ne 0 ]; then
  echo "ensure-schema failed (check DATABASE_URL and Postgres). Exiting."
  exit 1
fi

echo "Ensuring NATS stream..."
node --loader ts-node/esm scripts/ensure-stream.ts
if [ $? -ne 0 ]; then
  echo "ensure-stream failed (is NATS with JetStream running?). Exiting."
  exit 1
fi

if [ "${BOOTSTRAP:-0}" = "1" ]; then
  echo "Bootstrapping..."
  node --loader ts-node/esm scripts/bootstrap-once.ts
  if [ $? -ne 0 ]; then
    echo "bootstrap-once failed. Exiting."
    exit 1
  fi
fi

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
echo "Started 4 agents (facts, drift, planner, status) + 2 processes (governance, executor). Logs: $LOG_DIR/swarm-<role>.log (fresh each start)"
