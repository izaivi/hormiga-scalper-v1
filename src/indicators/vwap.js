export function computeSessionVwap(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  let pv = 0;
  let v = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume;
    v += c.volume;
  }
  if (v === 0) return null;
  return pv / v;
}

// Important: keep this O(n) and avoid per-point slicing (O(n^2) allocations).
export function computeVwapSeries(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const series = new Array(candles.length);
  let pv = 0;
  let v = 0;

  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume;
    v += c.volume;
    series[i] = v === 0 ? null : pv / v;
  }

  return series;
}
