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
# NOTE: Allow caller to override selected vars even if .env.local sets them.
PRE_AUTOTRADE="${AUTOTRADE-}"
PRE_AUTOTRADE_MODE="${AUTOTRADE_MODE-}"
PRE_TRADE_USD="${TRADE_USD-}"
PRE_BTC_SESSION_BUDGET_USD="${BTC_SESSION_BUDGET_USD-}"
PRE_NODE_OPTIONS="${NODE_OPTIONS-}"

set -a
# shellcheck disable=SC1091
source .env.local
set +a

# Re-apply caller overrides (if provided)
if [[ -n "${PRE_AUTOTRADE}" ]]; then AUTOTRADE="$PRE_AUTOTRADE"; fi
if [[ -n "${PRE_AUTOTRADE_MODE}" ]]; then AUTOTRADE_MODE="$PRE_AUTOTRADE_MODE"; fi
if [[ -n "${PRE_TRADE_USD}" ]]; then TRADE_USD="$PRE_TRADE_USD"; fi
if [[ -n "${PRE_BTC_SESSION_BUDGET_USD}" ]]; then BTC_SESSION_BUDGET_USD="$PRE_BTC_SESSION_BUDGET_USD"; fi
if [[ -n "${PRE_NODE_OPTIONS}" ]]; then NODE_OPTIONS="$PRE_NODE_OPTIONS"; fi

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
