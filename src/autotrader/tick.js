import { AUTOTRADER_CONFIG as C } from "./config.js";
import { rotateDayIfNeeded, logJsonl, recordTradeTimestamp } from "./state.js";
import { canTrade } from "./risk.js";
import { buildSignal } from "./strategy.js";
import { executeSignal } from "./executor.js";
import { execSync } from "node:child_process";
import path from "node:path";
import { tgSend } from "./telegram.js";
import { getUsdcBalance } from "./balance.js";
import { getOpenPositions, closePosition, cancelOpenOrders } from "./positions.js";
import { fetchFeeRate } from "../data/polymarket.js";

export async function autotraderTick({ state, snapshot }) {
  if (C.enabled !== true) return;

  async function runEndSequence(reason) {
    // Don't spam Telegram; caller controls when to mark sessionOffSent.
    const dust = 0.001;

    // Phase 1: cancel open orders
    const cancelRes = await cancelOpenOrders();
    const openN = cancelRes.ok ? Number(cancelRes.open || 0) : 0;

    // Phase 2: close all positions (based on current open positions)
    let closedX = 0;
    let residualY = 0;

    // We may need more than one pass (fills/cancels are async). Keep it small.
    for (let pass = 0; pass < 3; pass += 1) {
      const posRes = await getOpenPositions({ tokenIds: state.seenTokenIds || [], discoverTradesPages: 6, discoverTradesMax: 600 });
      const open = posRes.ok && Array.isArray(posRes.open) ? posRes.open : [];

      const actionable = open.filter((p) => Number(p?.shares || 0) >= dust);
      if (actionable.length === 0) {
        residualY = open.reduce((s, p) => s + Math.max(0, Number(p?.shares || 0)), 0);
        break;
      }

      for (const p of actionable) {
        const tokenId = String(p.tokenId);
        const shares = Number(p.shares);
        if (!tokenId || !Number.isFinite(shares) || shares < dust) continue;
        const r = await closePosition({ tokenId, shares, ttlSeconds: C.limitOrderTtlSeconds, maxRetries: 2 });
        if (r.ok) closedX += 1;
      }

      // Small pause before verifying again.
      await new Promise((r) => setTimeout(r, 1200));
    }

    // Phase 3: verify flat
    const verify = await getOpenPositions({ tokenIds: state.seenTokenIds || [], discoverTradesPages: 6, discoverTradesMax: 600 });
    const open2 = verify.ok && Array.isArray(verify.open) ? verify.open : [];
    const residual = open2.reduce((s, p) => s + Math.max(0, Number(p?.shares || 0)), 0);
    const residualAdj = residual < dust ? 0 : residual;
    const flat = open2.every((p) => Number(p?.shares || 0) < dust);

    // Snapshot end balance (best-effort) so we can report equity even when no trades happened.
    let endBalanceUSDC = null;
    try {
      const b = await getUsdcBalance();
      if (b.ok) endBalanceUSDC = b.balanceUSDC;
    } catch {}
    if (endBalanceUSDC !== null) state.endBalanceUSDC = endBalanceUSDC;

    const pnlUSDC = (state.startBalanceUSDC !== null && endBalanceUSDC !== null)
      ? (Number(endBalanceUSDC) - Number(state.startBalanceUSDC))
      : null;

    const lines = [
      `end_phase: cancel_open_orders (open=${openN})`,
      `end_phase: close_positions (closed=${closedX} residual=${residualAdj.toFixed(6)})`,
      `end_phase: verify_flat (flat=${flat} residual=${residualAdj.toFixed(6)})`,
      `summary: trades=${state.tradeCountTotal || 0} orders_posted=${state.ordersPosted || 0} cancelled=${state.ordersCancelled || 0} gates=${state.gateCount || 0} last_gate=${state.lastGateReason || '-'}`,
      `summary: startBalance≈${(state.startBalanceUSDC ?? 0).toFixed(6)} USDC endBalance≈${(endBalanceUSDC ?? 0).toFixed(6)} USDC` + (pnlUSDC !== null ? ` pnl≈${pnlUSDC.toFixed(6)} USDC` : '')
    ];

    // Only mark OFF (and stop the session) if we're flat.
    if (flat) {
      // Persist a final summary line in jsonl for auditing.
      logJsonl(state, {
        ts: new Date().toISOString(),
        type: 'session_summary',
        reason,
        flat: true,
        residual: residualAdj,
        startBalanceUSDC: state.startBalanceUSDC,
        endBalanceUSDC,
        pnlUSDC,
        trades: state.tradeCountTotal || 0,
        ordersPosted: state.ordersPosted || 0,
        ordersCancelled: state.ordersCancelled || 0,
        gates: state.gateCount || 0,
        lastGateReason: state.lastGateReason || null
      });

      if (!state.sessionOffSent) {
        state.sessionOffSent = true;
        await tgSend(lines.join('\n'));
      }

      // Also print to stdout so detached runs always include a tail summary.
      try { console.log('\n' + lines.join('\n') + '\n'); } catch {}

      return { stop: true, reason, flat: true, residual: residualAdj, endBalanceUSDC, pnlUSDC };
    }

    // Not flat: do NOT send Session OFF. Keep ending mode and try again next tick.
    state.ending = true;
    return { stop: false, reason: 'end_not_flat', flat: false, residual: residualAdj, lines };
  }

  // If we're in end-of-session mode, keep trying to flatten and do nothing else.
  if (state.ending) {
    const end = await runEndSequence('ending');
    return { stop: Boolean(end.stop), reason: end.stop ? 'ending_done' : end.reason };
  }

  if (!state.sessionOnSent) {
    state.sessionOnSent = true;
    const balRes = await getUsdcBalance();
    if (balRes.ok) state.startBalanceUSDC = balRes.balanceUSDC;

    await tgSend(
      `[Autotrader] Session ON mode=${C.mode} duration=${C.sessionDurationMinutes}m trade=$${C.tradeUsd} maxTrades=${C.maxTradesTotal}\n` +
      `startBalance≈${(state.startBalanceUSDC ?? 0).toFixed(6)} USDC`
    );
  }

  const now = new Date();
  const nowMs = now.getTime();
  rotateDayIfNeeded(state, now);

  const remainingSeconds = Math.floor((snapshot.remainingMinutes ?? 0) * 60);

  const gate = canTrade({
    state,
    nowMs,
    remainingSeconds,
    marketYes: snapshot.marketYes,
    marketNo: snapshot.marketNo,
    orderBookSummary: snapshot.orderBookSummary
  });

  if (!gate.ok) {
    state.gateCount = (state.gateCount || 0) + 1;
    const reasonChanged = gate.reason !== state.lastGateReason;
    state.lastGateReason = gate.reason;

    const shouldLogGate = reasonChanged || (C.logEveryGateN > 0 && (state.gateCount % C.logEveryGateN === 0));
    if (shouldLogGate) {
      logJsonl(state, {
        ts: now.toISOString(),
        type: "gate",
        ok: false,
        reason: gate.reason,
        market: snapshot.market?.slug || null
      });
    }

    if (gate.reason === "session_time_elapsed" || gate.reason === "max_trades_total") {
      const end = await runEndSequence(gate.reason);
      if (end.stop) return { stop: true, reason: gate.reason };
      // Not flat yet: keep running but do not trade.
      return { stop: false, reason: end.reason };
    }

    // Throttle a bit when we're gating repeatedly (reduces CPU + log spam).
    const minMs = Math.max(0, C.gateSleepMsMin || 0);
    const maxMs = Math.max(minMs, C.gateSleepMsMax || minMs);
    const sleepMs = Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
    if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));

    return { stop: false, reason: gate.reason };
  }

  // Optional: sample resource usage every N seconds
  if ((C.resourceSampleEverySeconds || 0) > 0) {
    const everyMs = C.resourceSampleEverySeconds * 1000;
    const last = state.lastResourceSampleMs || 0;
    if (nowMs - last >= everyMs) {
      state.lastResourceSampleMs = nowMs;
      try {
        const out = execSync(`ps -o pid,%cpu,%mem,etime,command -p ${process.pid}`, { encoding: 'utf8' }).trim();
        logJsonl(state, { ts: now.toISOString(), type: 'resource', pid: process.pid, ps: out });
      } catch (e) {
        logJsonl(state, { ts: now.toISOString(), type: 'resource', pid: process.pid, error: e?.message || String(e) });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Modo Hormiga v1: control de posición (1 posición activa, TP/SL/timeout, y cierre antes de resolución)
  // ─────────────────────────────────────────────────────────────

  function bookForOutcome(outcome) {
    const o = String(outcome || '').toUpperCase();
    return o === 'UP' ? snapshot.orderbooks?.up : o === 'DOWN' ? snapshot.orderbooks?.down : null;
  }

  function bestBidForOutcome(outcome) {
    const b = bookForOutcome(outcome);
    const v = b?.bestBid;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function computeWeightedAvgPriceFromAttempts(attempts) {
    const all = [];
    for (const a of Array.isArray(attempts) ? attempts : []) {
      for (const f of Array.isArray(a?.fills) ? a.fills : []) {
        all.push({ price: Number(f.price), size: Number(f.size) });
      }
    }
    const total = all.reduce((s, x) => s + (Number.isFinite(x.size) ? x.size : 0), 0);
    const wsum = all.reduce((s, x) => s + (Number.isFinite(x.size) && Number.isFinite(x.price) ? x.size * x.price : 0), 0);
    return total > 0 ? wsum / total : null;
  }

  async function ensurePositionKnownAndMaybeClose() {
    // Strict: if ANY open position exists, do not open a new one.
    // We attempt to close based on TP/SL/time/force rules.

    const remainingSecondsToResolution = remainingSeconds;

    // Detect positions (live only). In paper/dry, we only use state.position.
    let open = [];
    if (C.mode === 'live') {
      try {
        // Strict single-market: only consider positions for the CURRENT market tokens.
        // (Registry can include resolved/illiquid tokens without an orderbook.)
        const up = snapshot.tokens?.upTokenId ? String(snapshot.tokens.upTokenId) : null;
        const down = snapshot.tokens?.downTokenId ? String(snapshot.tokens.downTokenId) : null;
        const tokenIds = [up, down].filter(Boolean);

        const res = await getOpenPositions({ tokenIds, discoverTradesPages: 0, discoverTradesMax: 0 });
        if (res.ok) open = Array.isArray(res.open) ? res.open : [];
      } catch {}
    } else {
      if (state.position?.tokenId) open = [{ tokenId: state.position.tokenId, shares: state.position.shares ?? null }];
    }

    // If we have an open position but state.position is empty, create a placeholder.
    if (open.length && !state.position) {
      const p0 = open[0];
      state.position = {
        tokenId: String(p0.tokenId),
        shares: p0.shares ?? null,
        outcome: null,
        entryPrice: null,
        entryTimestampMs: nowMs
      };
    }

    if (!open.length) {
      // No open positions
      if (state.position) delete state.position;
      return { hasPosition: false };
    }

    // Single position strict: pick first
    const tokenId = String(open[0]?.tokenId);
    const shares = Number(open[0]?.shares ?? state.position?.shares ?? 0) || null;

    // Derive outcome if possible from current market tokens
    let outcome = state.position?.outcome || null;
    if (!outcome && snapshot.tokens) {
      if (String(snapshot.tokens?.upTokenId) === tokenId) outcome = 'UP';
      if (String(snapshot.tokens?.downTokenId) === tokenId) outcome = 'DOWN';
    }

    const entryPrice = state.position?.entryPrice ?? null;
    const entryTs = Number(state.position?.entryTimestampMs ?? nowMs);
    const holdSeconds = Math.max(0, Math.floor((nowMs - entryTs) / 1000));

    const bestBid = outcome ? bestBidForOutcome(outcome) : null;

    const tp = entryPrice ? entryPrice * C.tpMultiplier : null;
    const sl = entryPrice ? entryPrice * C.slMultiplier : null;

    let reason = null;

    // Rule 6: never allow settlement proximity
    if (remainingSecondsToResolution < C.forceCloseIfSecondsToResolutionLt) {
      reason = 'FORCE_BEFORE_RESOLUTION';
    } else if (entryPrice && bestBid != null && tp != null && bestBid >= tp) {
      reason = 'TP';
    } else if (entryPrice && bestBid != null && sl != null && bestBid <= sl) {
      reason = 'SL';
    } else if (holdSeconds >= C.maxHoldSeconds) {
      reason = 'TIME';
    }

    if (!reason) {
      // We have a position, but no exit condition met. Block new entries.
      return { hasPosition: true, tokenId, outcome, holdSeconds, entryPrice, bestBid, closing: false };
    }

    // Execute close
    await tgSend(`[Autotrader] Close attempt reason=${reason} token=${tokenId}${outcome ? ` outcome=${outcome}` : ''}`);

    if (C.mode === 'paper') {
      // paper: simulate close at bestBid if available, else entryPrice
      const exitPrice = bestBid ?? entryPrice;
      const pnlPercent = (entryPrice && exitPrice) ? (exitPrice / entryPrice - 1) : null;
      logJsonl(state, {
        ts: now.toISOString(),
        type: 'close',
        reason,
        tokenId,
        outcome,
        entryPrice,
        exitPrice,
        holdSeconds,
        pnlPercent
      });
      delete state.position;
      return { hasPosition: false, closed: true, reason, exitPrice };
    }

    if (C.mode !== 'live') {
      // dry: simulate close at bestBid if possible so we can compute pnl metrics
      const exitPrice = bestBid ?? entryPrice;
      const pnlPercent = (entryPrice && exitPrice) ? (exitPrice / entryPrice - 1) : null;
      const exitShares = Number(state.position?.shares ?? 1) || 1;
      const pnlUSDC = (entryPrice && exitPrice) ? (exitPrice - entryPrice) * exitShares : null;

      logJsonl(state, {
        ts: now.toISOString(),
        type: 'close',
        ok: true,
        status: 'dry_closed',
        reason,
        tokenId,
        outcome,
        entryPrice,
        exitPrice,
        holdSeconds,
        pnlUSDC,
        pnlPercent,
        note: 'dry_mode_simulated_close'
      });
      delete state.position;
      return { hasPosition: false, closed: true, reason, exitPrice, pnlUSDC, pnlPercent };
    }

    const closeRes = await closePosition({ tokenId, shares, ttlSeconds: C.limitOrderTtlSeconds, maxRetries: 2 });

    const exitPrice = computeWeightedAvgPriceFromAttempts(closeRes.attempts);
    const exitShares = (Array.isArray(closeRes.attempts)
      ? closeRes.attempts.reduce((s, a) => s + (Number(a?.sizeMatched) || 0), 0)
      : null);

    const pnlPercent = (entryPrice && exitPrice) ? (exitPrice / entryPrice - 1) : null;
    const pnlUSDC = (entryPrice && exitPrice && exitShares) ? (exitPrice - entryPrice) * exitShares : null;

    logJsonl(state, {
      ts: now.toISOString(),
      type: 'close',
      ok: closeRes.ok,
      status: closeRes.status,
      reason,
      tokenId,
      outcome,
      entryPrice,
      exitPrice,
      holdSeconds,
      pnlUSDC,
      pnlPercent,
      close: closeRes
    });

    const remaining = (closeRes.remaining == null ? null : Number(closeRes.remaining));
    const tol = Number(C.closeRemainingToleranceShares || 0.01);

    if (closeRes.ok && (closeRes.status === 'no_position' || remaining == null || remaining <= tol)) {
      await tgSend(
        `[Autotrader] Closed reason=${reason}` +
        (entryPrice && exitPrice ? ` entry=${entryPrice.toFixed(4)} exit=${exitPrice.toFixed(4)}` : '') +
        (pnlUSDC != null ? ` pnl≈${pnlUSDC.toFixed(6)} USDC` : '') +
        ` hold=${holdSeconds}s`
      );
    } else {
      await tgSend(
        `[Autotrader] Close FAIL reason=${reason} token=${tokenId} err=${String(closeRes.error || 'unknown').slice(0, 180)}`
      );
    }

    // Clear position regardless; end-of-session flatten still acts as safety net.
    delete state.position;

    return { hasPosition: false, closed: true, reason, exitPrice, pnlUSDC, pnlPercent };
  }

  const posCtrl = await ensurePositionKnownAndMaybeClose();
  if (posCtrl?.closed) {
    // Close happened this tick; wait for next tick before evaluating new entries.
    return { stop: false, reason: 'position_closed_wait_next_tick' };
  }
  if (posCtrl.hasPosition) {
    // Strict one position: never enter while any position is open.
    logJsonl(state, {
      ts: now.toISOString(),
      type: 'position_block',
      tokenId: posCtrl.tokenId,
      outcome: posCtrl.outcome,
      holdSeconds: posCtrl.holdSeconds,
      entryPrice: posCtrl.entryPrice,
      bestBid: posCtrl.bestBid,
      remainingSeconds
    });
    return { stop: false, reason: 'position_open_skip_entry' };
  }

  // Anti-entrada tardía (no entrar a <5 min de resolución)
  if (remainingSeconds < C.skipEnterIfSecondsToResolutionLt) {
    logJsonl(state, {
      ts: now.toISOString(),
      type: 'signal',
      action: 'NO_TRADE',
      reason: `skip_enter_seconds_to_resolution_lt_${C.skipEnterIfSecondsToResolutionLt}`,
      remainingSeconds,
      decision: snapshot.decision,
      market: snapshot.market?.slug || null
    });
    return { stop: false, reason: 'skip_enter_too_late' };
  }

  const signal = buildSignal({
    decision: snapshot.decision,
    marketYes: snapshot.marketYes,
    marketNo: snapshot.marketNo,
    bookUp: snapshot.orderbooks?.up,
    bookDown: snapshot.orderbooks?.down
  });

  if (signal.action !== "BUY") {
    logJsonl(state, {
      ts: now.toISOString(),
      type: "signal",
      action: "NO_TRADE",
      reason: signal.reason,
      decision: snapshot.decision,
      market: snapshot.market?.slug || null
    });
    return { stop: false, reason: signal.reason };
  }

  // Ensure we don't submit orders below minimum size.
  // Rule: tradeUsd >= ceil(minSize * price * buffer)
  const price = Number(signal.limitPrice);
  const minSize = Number(C.minOrderSize || 0);
  const buf = Number(C.minOrderUsdBuffer || 1.0);
  const minUsd = (minSize > 0 && Number.isFinite(price) && price > 0)
    ? Math.ceil(minSize * price * buf * 100) / 100
    : C.tradeUsd;
  const tradeUsdEffective = Math.max(C.tradeUsd, minUsd);

  // Fee-rate observability (lightweight): log once per token per session.
  // Purpose: detect fee regime changes without spamming logs.
  if (C.mode === 'live') {
    try {
      const up = snapshot.tokens?.upTokenId ? String(snapshot.tokens.upTokenId) : null;
      const down = snapshot.tokens?.downTokenId ? String(snapshot.tokens.downTokenId) : null;
      const tokenId = String(signal.outcome || '').toUpperCase() === 'UP' ? up : down;

      if (tokenId) {
        if (!state.feeRateByToken) state.feeRateByToken = {};
        if (state.feeRateByToken[tokenId] == null) {
          const fr = await fetchFeeRate({ tokenId });
          // Store baseFee (number or null)
          state.feeRateByToken[tokenId] = fr?.baseFee ?? null;
          logJsonl(state, {
            ts: now.toISOString(),
            type: 'fee_rate',
            tokenId,
            baseFee: fr?.baseFee ?? null,
            market: snapshot.market?.slug || null
          });
        }
      }
    } catch (e) {
      // Best-effort only; do not block trading.
      logJsonl(state, {
        ts: now.toISOString(),
        type: 'fee_rate',
        ok: false,
        error: String(e?.message || e).slice(0, 200),
        market: snapshot.market?.slug || null
      });
    }
  }

  await tgSend(`[Autotrader] Signal BUY ${signal.outcome} @ ${signal.limitPrice} ($${tradeUsdEffective})\nmarket=${snapshot.market?.slug || "-"}`);

  const execRes = await executeSignal({
    signal: { ...signal, tradeUsd: tradeUsdEffective },
    context: {
      market: snapshot.market,
      tokens: snapshot.tokens
    }
  });

  logJsonl(state, {
    ts: now.toISOString(),
    type: "execute",
    signal,
    result: execRes,
    decision: snapshot.decision,
    marketYes: snapshot.marketYes,
    marketNo: snapshot.marketNo,
    orderBookSummary: snapshot.orderBookSummary
  });

  if (execRes?.ok) {
    const status = execRes.parsed?.status || execRes.status || 'ok';
    // Update counters
    state.ordersPosted += 1;
    if (status === 'posted_then_cancelled') state.ordersCancelled += 1;

    // If we got any fill, start/refresh the single active position tracking.
    try {
      const tid = execRes?.parsed?.tokenID || signal?.tokenId || null;
      const sizeMatched = execRes?.parsed?.sizeMatched;
      const avgFillPrice = execRes?.parsed?.avgFillPrice;
      const filled = Number(sizeMatched) > 0 || (Array.isArray(execRes?.parsed?.fills) && execRes.parsed.fills.length > 0);
      if (filled && tid) {
        state.position = {
          tokenId: String(tid),
          outcome: String(signal?.outcome || '').toUpperCase() || null,
          entryPrice: Number(avgFillPrice ?? signal?.limitPrice ?? null),
          entryTimestampMs: nowMs,
          shares: Number(sizeMatched) || null
        };
      }
    } catch {}

    // Track tokenIds touched for end-of-session equity snapshot
    const tid = execRes?.parsed?.tokenID || signal?.tokenId || null;
    if (tid) {
      if (!Array.isArray(state.seenTokenIds)) state.seenTokenIds = [];
      if (!state.seenTokenIds.includes(String(tid))) state.seenTokenIds.push(String(tid));
      // Persist tokenId registry for global flatten.
      try {
        const { mergeIntoRegistry } = await import('./registry.js');
        mergeIntoRegistry(path.join(process.cwd(), 'logs'), [String(tid)]);
      } catch {}
    }

    recordTradeTimestamp(state, nowMs);
    await tgSend(`[Autotrader] Execute OK: ${status}`);

    const shouldStop = state.tradeCountTotal >= C.maxTradesTotal;
    if (shouldStop) {
      const end = await runEndSequence('max_trades_total');
      return { stop: Boolean(end.stop), reason: end.stop ? 'max_trades_total' : end.reason };
    }

    return { stop: false, reason: "trade_done" };
  }

  const msg = execRes?.parsed?.error || execRes?.status || execRes?.err || execRes?.out || "unknown";
  await tgSend(`[Autotrader] Execute FAIL: ${String(msg).slice(0, 1500)}`);
  return { stop: false, reason: "execute_fail" };
}
