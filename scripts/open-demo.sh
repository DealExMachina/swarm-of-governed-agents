#!/usr/bin/env bash
# Start the demo server if needed, wait for it, then open the demo in a browser.
# Usage: ./scripts/open-demo.sh
#   BROWSER=Chromium npm run demo:open   # prefer Chromium app (macOS)
#   BROWSER=chromium npm run demo:open   # use chromium binary if in PATH
#   BROWSER=firefox npm run demo:open
set -euo pipefail

DEMO_PORT="${DEMO_PORT:-3003}"
DEMO_URL="http://localhost:${DEMO_PORT}"
BROWSER="${BROWSER:-}"
WAIT_MAX="${WAIT_MAX:-20}"

cd "$(dirname "$0")/.."

# Wait for something to be listening on DEMO_PORT
wait_for_port() {
  local i=0
  while [ "$i" -lt "$WAIT_MAX" ]; do
    if lsof -iTCP:"$DEMO_PORT" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# Start demo server if port not in use
if ! lsof -iTCP:"$DEMO_PORT" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
  echo "Starting demo server on port ${DEMO_PORT}..."
  npm run demo > /tmp/demo.log 2>&1 &
  DEMO_PID=$!
  if ! wait_for_port; then
    echo "Demo server did not start in time. Check /tmp/demo.log"
    kill "$DEMO_PID" 2>/dev/null || true
    exit 1
  fi
  echo "Demo server ready."
else
  echo "Demo server already running at ${DEMO_URL}"
fi

# Open in browser
open_url() {
  local app="$1"
  if [ -n "$app" ]; then
    open -a "$app" "$DEMO_URL" 2>/dev/null && return 0
  fi
  if command -v chromium-browser >/dev/null 2>&1; then
    chromium-browser "$DEMO_URL" 2>/dev/null && return 0
  fi
  if command -v chromium >/dev/null 2>&1; then
    chromium "$DEMO_URL" 2>/dev/null && return 0
  fi
  open "$DEMO_URL" 2>/dev/null && return 0
  return 1
}

if [ -n "$BROWSER" ]; then
  open_url "$BROWSER" && echo "Opened ${DEMO_URL} in ${BROWSER}" || { echo "Could not open ${BROWSER}"; open_url ""; }
else
  # Default: try Chromium app, then Chrome, then default
  open_url "Chromium" || open_url "Google Chrome" || open_url "" || true
  echo "Opened ${DEMO_URL}"
fi
