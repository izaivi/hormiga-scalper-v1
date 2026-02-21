import fs from "node:fs";
import path from "node:path";

function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function createState({ logsDir }) {
  const startedAtMs = Date.now();
  return {
    logsDir,
    day: todayKey(),
    pnlUsd: 0,
    consecutiveLosses: 0,
    trades: [], // timestamps (ms)
    lastTradeAtMs: 0,
    startedAtMs,
    tradeCountTotal: 0,
    sessionOnSent: false,
    sessionOffSent: false,
    startBalanceUSDC: null,
    endBalanceUSDC: null,
    ordersPosted: 0,
    ordersCancelled: 0,
    gateCount: 0,
    lastGateReason: null,
    lastResourceSampleMs: 0,
    seenTokenIds: [],
    priceHistory: [],

    // End-of-session shutdown sequence state
    ending: false
  };
}

export function rotateDayIfNeeded(state, now = new Date()) {
  const k = todayKey(now);
  if (state.day !== k) {
    state.day = k;
    state.pnlUsd = 0;
    state.consecutiveLosses = 0;
    state.trades = [];
    state.lastTradeAtMs = 0;
    state.startedAtMs = Date.now();
    state.tradeCountTotal = 0;
    state.sessionOnSent = false;
    state.sessionOffSent = false;
    state.startBalanceUSDC = null;
    state.endBalanceUSDC = null;
    state.ordersPosted = 0;
    state.ordersCancelled = 0;
    state.gateCount = 0;
    state.lastGateReason = null;
    state.lastResourceSampleMs = 0;
    state.seenTokenIds = [];
    state.priceHistory = [];
    state.ending = false;
  }
}

export function recordTradeTimestamp(state, tsMs) {
  state.trades.push(tsMs);
  state.lastTradeAtMs = tsMs;
  state.tradeCountTotal += 1;
  // keep last 2h
  const cutoff = tsMs - 2 * 60 * 60 * 1000;
  state.trades = state.trades.filter((t) => t >= cutoff);
}

export function tradesLastHour(state, nowMs) {
  const cutoff = nowMs - 60 * 60 * 1000;
  return state.trades.filter((t) => t >= cutoff).length;
}

function rotateBySize(filePath, { maxBytes = 10 * 1024 * 1024, keep = 3 } = {}) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return;
    if (st.size <= maxBytes) return;

    // Keep last `keep` rotated files: .1 is newest backup.
    for (let i = keep; i >= 1; i -= 1) {
      const from = `${filePath}.${i}`;
      const to = `${filePath}.${i + 1}`;
      // shift up (keep+1 will be removed)
      if (fs.existsSync(from)) {
        if (i === keep) {
          try { fs.unlinkSync(from); } catch {}
        } else {
          try { fs.renameSync(from, to); } catch {}
        }
      }
    }

    // Move current -> .1
    try { fs.renameSync(filePath, `${filePath}.1`); } catch {}
  } catch {
    // ignore rotation failures
  }
}

export function logJsonl(state, obj, filename = "autotrader.jsonl") {
  try {
    if (!state.logsDir) return;
    fs.mkdirSync(state.logsDir, { recursive: true });
    const p = path.join(state.logsDir, filename);

    rotateBySize(p, { maxBytes: 10 * 1024 * 1024, keep: 3 });

    fs.appendFileSync(p, JSON.stringify(obj) + "\n");
  } catch {
    // ignore logging failures
  }
}
