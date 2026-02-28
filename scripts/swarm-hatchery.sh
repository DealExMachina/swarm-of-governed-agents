#!/usr/bin/env bash
# Single-process agent hatchery: spawns all agent loops as in-process async tasks
# with dynamic scaling, supervision, and heartbeat monitoring.
# Replaces swarm-all.sh (6 background processes) with one orchestrated process.
set -e
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}"
export DISABLE_FEED_AUTH="${DISABLE_FEED_AUTH:-1}"
export FACTS_WORKER_TIMEOUT_MS="${FACTS_WORKER_TIMEOUT_MS:-300000}"
if command -v pnpm >/dev/null 2>&1 && [ -f pnpm-lock.yaml ]; then RUNNER=pnpm; else RUNNER=npm; fi
LOG_DIR="${LOG_DIR:-/tmp}"
mkdir -p "$LOG_DIR"

echo "Checking services (Postgres, S3, NATS, facts-worker)..."
node --loader ts-node/esm scripts/check-services.ts
if [ $? -ne 0 ]; then
  echo "Preflight failed. Start Docker (e.g. docker compose up -d s3 postgres nats facts-worker) and ensure facts-worker is ready."
  echo "To wait for slow provisioning, run: CHECK_SERVICES_MAX_WAIT_SEC=300 $RUNNER run check:services"
  exit 1
fi

echo "Ensuring S3 bucket..."
node --loader ts-node/esm scripts/ensure-bucket.ts
if [ $? -ne 0 ]; then echo "ensure-bucket failed. Exiting."; exit 1; fi

echo "Ensuring DB schema (migrations)..."
node --loader ts-node/esm scripts/ensure-schema.ts
if [ $? -ne 0 ]; then echo "ensure-schema failed. Exiting."; exit 1; fi

echo "Ensuring NATS stream..."
node --loader ts-node/esm scripts/ensure-stream.ts
if [ $? -ne 0 ]; then echo "ensure-stream failed. Exiting."; exit 1; fi

if [ "${BOOTSTRAP:-0}" = "1" ]; then
  echo "Bootstrapping..."
  node --loader ts-node/esm scripts/bootstrap-once.ts
  if [ $? -ne 0 ]; then echo "bootstrap-once failed. Exiting."; exit 1; fi
fi

echo "Purging stale NATS consumers..."
node --loader ts-node/esm scripts/purge-consumers.ts || echo "purge-consumers failed (non-fatal, continuing)."

# Kill old agent processes and free ports before starting fresh
for port in 3001; do
  lsof -ti :$port 2>/dev/null | xargs kill -9 2>/dev/null || true
done
pkill -f "AGENT_ROLE=" 2>/dev/null || true
sleep 1

export AGENT_ROLE=hatchery
export AGENT_ID=hatchery-1
echo "Starting hatchery (single-process orchestrator). Log: $LOG_DIR/swarm-hatchery.log"
exec $RUNNER run swarm 2>&1 | tee "$LOG_DIR/swarm-hatchery.log"
