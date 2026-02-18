#!/usr/bin/env bash
# Start all four swarm agents in the background (load .env via dotenv in each process).
set -e
cd "$(dirname "$0")/.."
( export AGENT_ROLE=facts AGENT_ID=facts-1; npm run swarm ) &
( export AGENT_ROLE=drift AGENT_ID=drift-1; npm run swarm ) &
( export AGENT_ROLE=planner AGENT_ID=planner-1; npm run swarm ) &
( export AGENT_ROLE=status AGENT_ID=status-1; npm run swarm ) &
echo "Started four agents (facts, drift, planner, status). They run in background."
