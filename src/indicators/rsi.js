import { clamp } from "../utils.js";

// RSI for the most recent point (Wilder-style simple average over the last `period` diffs).
export function computeRsi(closes, period) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const cur = closes[i];
    const diff = cur - prev;
    if (diff > 0) gains += diff;
    else losses += -diff;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  return clamp(rsi, 0, 100);
}

// Full RSI series in O(n) time, O(n) memory.
// Returns an array aligned to `closes` indices, with `null` until the first computable point.
export function computeRsiSeries(closes, period) {
  if (!Array.isArray(closes) || closes.length === 0) return [];
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;

  // Initial averages over first `period` diffs.
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss += -diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;

  const rsiAt = () => {
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return clamp(100 - 100 / (1 + rs), 0, 100);
  };

  out[period] = rsiAt();

  // Wilder smoothing for subsequent points.
  for (let i = period + 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = rsiAt();
  }

  return out;
}

export function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(values.length - period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

export function slopeLast(values, points) {
  if (!Array.isArray(values) || values.length < points) return null;
  const slice = values.slice(values.length - points);
  const first = slice[0];
  const last = slice[slice.length - 1];
  return (last - first) / (points - 1);
}
