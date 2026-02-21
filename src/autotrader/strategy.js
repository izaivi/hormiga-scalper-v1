import { AUTOTRADER_CONFIG as C } from "./config.js";

// Converts the assistant's edge decision into a trade signal with a limit price.
// NOTE: This is intentionally conservative. We'll iterate.
export function buildSignal({ decision, marketYes, marketNo, bookUp, bookDown }) {
  if (!decision || decision.action !== "ENTER") return { action: "NO_TRADE", reason: decision?.reason || "no_signal" };

  const edge = decision.edge;
  if (edge !== null && edge < C.minEdge) return { action: "NO_TRADE", reason: `edge_below_${C.minEdge}` };

  const side = decision.side; // UP|DOWN
  const book = side === "UP" ? bookUp : bookDown;

  // Choose limit price based on best bid/ask if available, else fallback to the current CLOB price.
  const bestAsk = book?.bestAsk ?? null;
  const bestBid = book?.bestBid ?? null;

  const marketPrice = side === "UP" ? marketYes : marketNo;

  let limitPrice = null;
  if (bestAsk !== null) {
    // Try to join near the bid when spread exists.
    if (bestBid !== null && bestAsk > bestBid) {
      limitPrice = Math.min(bestAsk, bestBid + 0.01);
    } else {
      limitPrice = marketPrice;
    }
  } else {
    limitPrice = marketPrice;
  }

  if (limitPrice === null || !Number.isFinite(Number(limitPrice))) {
    return { action: "NO_TRADE", reason: "missing_limit_price" };
  }

  // Clamp to sane range.
  limitPrice = Math.max(0.01, Math.min(0.99, Number(limitPrice)));

  return {
    action: "BUY",
    outcome: side, // UP|DOWN
    limitPrice
  };
}
