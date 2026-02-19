#!/usr/bin/env bash
# Ensure NATS stream exists, optionally bootstrap, then start all four swarm agents.
# Logs are written to LOG_DIR (default /tmp) as swarm-<role>.log.
set -e
cd "$(dirname "$0")/.."
LOG_DIR="${LOG_DIR:-/tmp}"
mkdir -p "$LOG_DIR"

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
( export AGENT_ROLE=facts AGENT_ID=facts-1; npm run swarm >> "$LOG_DIR/swarm-facts.log" 2>&1 ) &
( export AGENT_ROLE=drift AGENT_ID=drift-1; npm run swarm >> "$LOG_DIR/swarm-drift.log" 2>&1 ) &
( export AGENT_ROLE=planner AGENT_ID=planner-1; npm run swarm >> "$LOG_DIR/swarm-planner.log" 2>&1 ) &
( export AGENT_ROLE=status AGENT_ID=status-1; npm run swarm >> "$LOG_DIR/swarm-status.log" 2>&1 ) &
echo "Started four agents (facts, drift, planner, status). Logs: $LOG_DIR/swarm-<role>.log (fresh each start)"
