export const AUTOTRADER_CONFIG = {
  // Modo Hormiga v1 (micro-scalping)
  maxHoldSeconds: Number(process.env.MAX_HOLD_SECONDS || 180),
  tpMultiplier: Number(process.env.TP_MULTIPLIER || 1.03),
  slMultiplier: Number(process.env.SL_MULTIPLIER || 0.95),
  skipEnterIfSecondsToResolutionLt: Number(process.env.SKIP_ENTER_IF_SECONDS_TO_RESOLUTION_LT || 300),
  forceCloseIfSecondsToResolutionLt: Number(process.env.FORCE_CLOSE_IF_SECONDS_TO_RESOLUTION_LT || 120),
  enabled: (process.env.AUTOTRADE || "false").toLowerCase() === "true",
  mode: (process.env.AUTOTRADE_MODE || "dry").toLowerCase(), // paper|dry|live

  tradeUsd: Number(process.env.TRADE_USD || 2),
  // Min order size observed on Polymarket BTC 15m markets is often 5 shares.
  minOrderSize: Number(process.env.MIN_ORDER_SIZE || 5),
  // Extra buffer to avoid rounding/min-size rejections.
  minOrderUsdBuffer: Number(process.env.MIN_ORDER_USD_BUFFER || 1.05),

  // Throttle when we're repeatedly gating (ms).
  gateSleepMsMin: Number(process.env.GATE_SLEEP_MS_MIN || 250),
  gateSleepMsMax: Number(process.env.GATE_SLEEP_MS_MAX || 1000),

  // Reduce log spam: only log 1 gate every N ticks unless reason changes.
  logEveryGateN: Number(process.env.LOG_EVERY_GATE_N || 50),

  // Optional: sample process resources every N seconds (0 disables).
  resourceSampleEverySeconds: Number(process.env.RESOURCE_SAMPLE_EVERY_SECONDS || 0),
  maxDailyLossUsd: Number(process.env.MAX_DAILY_LOSS_USD || 2),
  maxTradesPerHour: Number(process.env.MAX_TRADES_PER_HOUR || 3),

  cooldownSeconds: Number(process.env.COOLDOWN_SECONDS || 120),
  minSecondsLeft: Number(process.env.MIN_SECONDS_LEFT || 90),

  // If UP+DOWN is close to 1.0, you're paying a big spread/fee. Skip.
  maxSpreadSum: Number(process.env.MAX_SPREAD_SUM || 0.98),

  // Require some edge & probability.
  minEdge: Number(process.env.MIN_EDGE || 0.10),
  minModelProb: Number(process.env.MIN_MODEL_PROB || 0.65),

  // Safety: stop after consecutive losses.
  maxConsecutiveLosses: Number(process.env.MAX_CONSECUTIVE_LOSSES || 2),

  // Guardrails v1.1 (minimal changes)
  contractDurationSeconds: Number(process.env.CONTRACT_DURATION_SECONDS || 900),
  minSecondsSinceContractStart: Number(process.env.MIN_SECONDS_SINCE_CONTRACT_START || 120),
  volatilityLookbackSeconds: Number(process.env.VOLATILITY_LOOKBACK_SECONDS || 30),
  volatilityMaxPct: Number(process.env.VOLATILITY_MAX_PCT || 0.10),

  // Execution
  limitOrderTtlSeconds: Number(process.env.LIMIT_ORDER_TTL_SECONDS || 15),

  maxTradesTotal: Number(process.env.MAX_TRADES_TOTAL || 1),
  sessionDurationMinutes: Number(process.env.SESSION_DURATION_MINUTES || 60)
};
