import { AUTOTRADER_CONFIG as C } from "./config.js";
import { spawn } from "node:child_process";
import path from "node:path";

function runNodeScript(scriptPath, argsObj, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, JSON.stringify(argsObj)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    let out = "";
    let err = "";

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, status: 'timeout', out, err });
    }, timeoutMs);

    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));

    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(out.trim()); } catch {}
      resolve({ ok: code === 0, code, out, err, parsed });
    });
  });
}

export async function executeSignal({ signal, context }) {
  const mode = C.mode;

  if (signal.action !== "BUY") return { ok: false, status: "no_action" };

  const tokenId = signal.outcome === "UP" ? context.tokens?.upTokenId : context.tokens?.downTokenId;
  const limitPrice = Number(signal.limitPrice);

  const tradeUsd = Number(signal.tradeUsd ?? C.tradeUsd);

  const order = {
    ts: new Date().toISOString(),
    mode,
    outcome: signal.outcome,
    limitPrice,
    tradeUsd,
    marketSlug: context.market?.slug,
    tokenId
  };

  if (mode === "paper") {
    return { ok: true, status: "paper_filled", order, fill: { price: limitPrice, usd: tradeUsd } };
  }

  if (mode === "dry") {
    // Dry mode should still exercise the full Hormiga cycle.
    // Simulate an immediate fill at limitPrice with 1 share.
    return {
      ok: true,
      status: "dry_filled",
      order,
      parsed: {
        ok: true,
        status: "dry_filled",
        tokenID: tokenId,
        limitPrice,
        sizeMatched: 1,
        avgFillPrice: limitPrice,
        slippage: 0,
        fills: [{ id: "dry", price: limitPrice, size: 1, match_time: String(Math.floor(Date.now() / 1000)) }]
      }
    };
  }

  // live
  const scriptPath = path.join(process.cwd(), 'trader', 'placeOrder.mjs');
  const args = {
    tokenId,
    outcome: signal.outcome,
    limitPrice,
    tradeUsd,
    ttlSeconds: C.limitOrderTtlSeconds,
    marketSlug: context.market?.slug || null
  };

  return await runNodeScript(scriptPath, args, Math.max(30_000, (C.limitOrderTtlSeconds + 10) * 1000));
}
