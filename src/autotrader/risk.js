import { AUTOTRADER_CONFIG as C } from "./config.js";
import { tradesLastHour } from "./state.js";

export function canTrade({ state, nowMs, remainingSeconds, marketYes, marketNo, orderBookSummary }) {
  if (C.enabled !== true) return { ok: false, reason: "disabled" };

  // Track a small rolling window of market prices for volatility guardrails.
  try {
    state.priceHistory = Array.isArray(state.priceHistory) ? state.priceHistory : [];
    if (marketYes !== null && marketYes !== undefined && marketNo !== null && marketNo !== undefined) {
      const y = Number(marketYes);
      const n = Number(marketNo);
      if (Number.isFinite(y) && Number.isFinite(n)) state.priceHistory.push({ tsMs: nowMs, yes: y, no: n });
    }
    const pruneBefore = nowMs - Math.max(60_000, (C.volatilityLookbackSeconds || 30) * 1000 * 2);
    state.priceHistory = state.priceHistory.filter((p) => (p?.tsMs || 0) >= pruneBefore);
  } catch {}

  // Session hard stop
  if (nowMs - (state.startedAtMs || 0) >= C.sessionDurationMinutes * 60 * 1000) {
    return { ok: false, reason: "session_time_elapsed" };
  }

  if (state.tradeCountTotal >= C.maxTradesTotal) {
    return { ok: false, reason: "max_trades_total" };
  }

  if (!Number.isFinite(remainingSeconds) || remainingSeconds <= C.minSecondsLeft) {
    return { ok: false, reason: `too_late(${remainingSeconds}s)` };
  }

  // Guardrail: avoid the first N seconds of the contract (more violent/less stable).
  // For BTC 15m markets, duration is typically 900s.
  const dur = Number(C.contractDurationSeconds || 900);
  const age = Number.isFinite(dur) && dur > 0 ? Math.max(0, Math.min(dur, dur - remainingSeconds)) : null;
  if (age !== null && age < Number(C.minSecondsSinceContractStart || 0)) {
    return { ok: false, reason: `early_contract(${age}s)` };
  }

  // Guardrail: anti-volatility spike before entry.
  // If YES/NO moved > X% over the lookback window, skip.
  try {
    const lbMs = Math.max(1, Number(C.volatilityLookbackSeconds || 30) * 1000);
    const cutoff = nowMs - lbMs;
    const hist = Array.isArray(state.priceHistory) ? state.priceHistory : [];
    // pick the closest point at/older than cutoff
    const ref = [...hist].reverse().find((p) => (p?.tsMs || 0) <= cutoff) || hist[0];
    const yNow = Number(marketYes);
    const nNow = Number(marketNo);
    const yRef = Number(ref?.yes);
    const nRef = Number(ref?.no);
    const maxPct = Number(C.volatilityMaxPct || 0.10);

    if (Number.isFinite(maxPct) && maxPct > 0 && Number.isFinite(yNow) && Number.isFinite(yRef) && yRef > 0) {
      const dy = Math.abs(yNow - yRef) / yRef;
      if (Number.isFinite(dy) && dy > maxPct) return { ok: false, reason: `volatility_spike(yes:${dy.toFixed(3)})` };
    }
    if (Number.isFinite(maxPct) && maxPct > 0 && Number.isFinite(nNow) && Number.isFinite(nRef) && nRef > 0) {
      const dn = Math.abs(nNow - nRef) / nRef;
      if (Number.isFinite(dn) && dn > maxPct) return { ok: false, reason: `volatility_spike(no:${dn.toFixed(3)})` };
    }
  } catch {}

  if (nowMs - (state.lastTradeAtMs || 0) < C.cooldownSeconds * 1000) {
    return { ok: false, reason: "cooldown" };
  }

  if (tradesLastHour(state, nowMs) >= C.maxTradesPerHour) {
    return { ok: false, reason: "max_trades_per_hour" };
  }

  if (state.pnlUsd <= -Math.abs(C.maxDailyLossUsd)) {
    return { ok: false, reason: "max_daily_loss" };
  }

  if (state.consecutiveLosses >= C.maxConsecutiveLosses) {
    return { ok: false, reason: "max_consecutive_losses" };
  }

  if (marketYes !== null && marketNo !== null) {
    const sum = marketYes + marketNo;
    if (Number.isFinite(sum) && sum > C.maxSpreadSum) {
      return { ok: false, reason: `bad_spread_sum(${sum.toFixed(2)})` };
    }
  }

  // Optional: require order book spread not insane.
  const spread = orderBookSummary?.spread;
  if (spread !== null && spread !== undefined && Number.isFinite(Number(spread))) {
    if (spread > 0.10) return { ok: false, reason: `wide_book_spread(${Number(spread).toFixed(3)})` };
  }

  return { ok: true };
}
