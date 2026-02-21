#!/usr/bin/env bash
set -euo pipefail

# Detached runner to avoid SIGHUP/TTY issues.
# Usage:
#   scripts/run_live_detached.sh [durationMinutes] [maxTrades]
# Example:
#   scripts/run_live_detached.sh 30 2

DUR_MIN="${1:-30}"
MAX_TRADES="${2:-2}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Load env vars (Telegram, CLOB creds, etc)
set -a
# shellcheck disable=SC1091
source .env.local
set +a

mkdir -p logs
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="logs/live_${STAMP}.out"
PIDFILE="logs/live_${STAMP}.pid"

# Run without TTY; index.js will auto-disable UI when stdout isn't a TTY.
# Use nohup to survive terminal disconnect; redirect stdout/stderr.
nohup env \
  AUTOTRADE=true \
  AUTOTRADE_MODE=live \
  SESSION_DURATION_MINUTES="$DUR_MIN" \
  MAX_TRADES_TOTAL="$MAX_TRADES" \
  node src/index.js \
  >"$OUT" 2>&1 < /dev/null &

echo $! > "$PIDFILE"
echo "started pid=$(cat "$PIDFILE")"
echo "log=$OUT"
