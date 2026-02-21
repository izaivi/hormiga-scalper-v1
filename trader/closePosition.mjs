import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClobClient, Side, AssetType } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const arg = process.argv[2] ? JSON.parse(process.argv[2]) : {};
const tokenID = String(arg.tokenId || '');
const ttlSeconds = Number(arg.ttlSeconds || 15);
const maxRetries = Number(arg.maxRetries || 2);
const sharesArg = arg.shares != null ? Number(arg.shares) : null;

if (!tokenID) {
  console.log(JSON.stringify({ ok: false, error: 'missing_tokenId' }));
  process.exit(2);
}

const HOST = process.env.CLOB_HOST || 'https://clob.polymarket.com';
const CHAIN_ID = Number(process.env.CLOB_CHAIN_ID || 137);

const pk = process.env.PRIVATE_KEY;
if (!pk) {
  console.log(JSON.stringify({ ok: false, error: 'PRIVATE_KEY missing' }));
  process.exit(2);
}
const signer = new Wallet(pk);

const apiKey = process.env.USER_CLOB_API_KEY || process.env.CLOB_API_KEY;
const apiCreds = {
  key: apiKey,
  apiKey,
  secret: process.env.USER_CLOB_API_SECRET || process.env.CLOB_API_SECRET,
  passphrase: process.env.USER_CLOB_API_PASSPHRASE || process.env.CLOB_API_PASSPHRASE
};

const signatureType = Number(process.env.POLY_SIGNATURE_TYPE || 2);
const funder = process.env.POLY_FUNDER_ADDRESS || process.env.POLY_ADDRESS;

const client = new ClobClient(HOST, CHAIN_ID, signer, apiCreds, signatureType, funder);

function nShares(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return null;
  return v > 1e6 ? v / 1e6 : v;
}

function n(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function roundToTick(p, tick) {
  const t = Number(tick);
  if (!Number.isFinite(t) || t <= 0) return p;
  const r = Math.round(p / t) * t;
  const decimals = Math.max(0, String(t).split('.')[1]?.length || 0);
  return Number(r.toFixed(decimals));
}

async function cancelIfOpen(orderID) {
  try {
    const open = await client.getOpenOrders();
    const stillOpen = Array.isArray(open) ? open.find((o) => o.orderID === orderID) : null;
    if (stillOpen) {
      await client.cancelOrder({ orderID });
      return true;
    }
  } catch {}
  return false;
}

async function getFillsForOrder(orderID, limitPrice) {
  let sizeMatched = null;
  let avgFillPrice = null;
  let slippage = null;
  let fills = [];

  try {
    const ord = await client.getOrder(orderID);
    sizeMatched = ord?.size_matched != null ? Number(ord.size_matched) : null;
    const assoc = Array.isArray(ord?.associate_trades) ? ord.associate_trades : [];
    if (assoc.length) {
      const trades = await Promise.all(
        assoc.map(async (id) => {
          try {
            const t = await client.getTrades({ id }, true);
            return Array.isArray(t) ? t[0] : null;
          } catch {
            return null;
          }
        })
      );
      fills = trades.filter(Boolean).map((t) => ({
        id: t.id,
        price: Number(t.price),
        size: Number(t.size),
        match_time: t.match_time
      }));

      const totalSize = fills.reduce((s, f) => s + (Number.isFinite(f.size) ? f.size : 0), 0);
      const wsum = fills.reduce((s, f) => s + (Number.isFinite(f.size) && Number.isFinite(f.price) ? f.size * f.price : 0), 0);
      if (totalSize > 0) {
        const lp = Number(limitPrice);
        const avgRaw = wsum / totalSize;
        const slipRaw = avgRaw - lp;

        const complementEps = Number(arg.complementEps || 0.02);
        const isComplement = Number.isFinite(lp) && Math.abs((avgRaw + lp) - 1) <= complementEps;

        avgFillPrice = isComplement ? (1 - avgRaw) : avgRaw;
        slippage = avgFillPrice - lp;

        // Attach raw values
        // eslint-disable-next-line no-unused-vars
        var avgFillPriceRaw = avgRaw;
        // eslint-disable-next-line no-unused-vars
        var slippageRaw = slipRaw;
      }
    }
  } catch {}

  return { sizeMatched, avgFillPrice, slippage, fills };
}

try {
  // Determine shares to sell
  let shares = sharesArg;
  if (!(shares && shares > 0)) {
    const bal = await client.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenID });
    shares = nShares(bal?.balance);
  }

  if (!shares || shares <= 0) {
    console.log(JSON.stringify({ ok: true, status: 'no_position', tokenID, shares: shares ?? 0 }));
    process.exit(0);
  }

  // Pull orderbook for best bid + tick
  const book = await client.getOrderBook(tokenID);
  const tickSize = book?.tick_size || '0.01';
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const bestBid = bids.length ? n(bids[0]?.price) : null;
  if (!bestBid || bestBid <= 0) {
    console.log(JSON.stringify({ ok: false, error: 'no_bids', tokenID }));
    process.exit(1);
  }

  const prices = [bestBid];
  for (let i = 1; i <= maxRetries; i++) prices.push(bestBid - i * Number(tickSize || 0.01));
  const clean = prices
    .filter((p) => Number.isFinite(p) && p > 0)
    .map((p) => roundToTick(p, tickSize));
  const uniqPrices = [...new Set(clean.map((p) => p.toFixed(6)))].map((s) => Number(s));

  let remaining = shares;
  const attempts = [];

  for (const price of uniqPrices) {
    let orderResp;
    try {
      orderResp = await client.createAndPostOrder(
        { tokenID, price, size: remaining, side: Side.SELL },
        { tickSize: String(tickSize ?? '0.01'), negRisk: Boolean(book?.neg_risk) }
      );
    } catch (e) {
      attempts.push({ ok: false, price, error: e?.message || String(e) });
      continue;
    }

    await new Promise((r) => setTimeout(r, ttlSeconds * 1000));
    const cancelled = await cancelIfOpen(orderResp.orderID);
    const fillsInfo = await getFillsForOrder(orderResp.orderID, price);

    attempts.push({ ok: true, price, orderID: orderResp.orderID, cancelled, ...fillsInfo });
    // Keep raw metrics if present
    try {
      if (typeof fillsInfo?.avgFillPriceRaw !== 'undefined') attempts[attempts.length-1].avgFillPriceRaw = fillsInfo.avgFillPriceRaw;
      if (typeof fillsInfo?.slippageRaw !== 'undefined') attempts[attempts.length-1].slippageRaw = fillsInfo.slippageRaw;
    } catch {}

    if (fillsInfo.sizeMatched && fillsInfo.sizeMatched > 0) {
      remaining = Math.max(0, remaining - fillsInfo.sizeMatched);
      if (remaining <= 1e-9) break;
    }
  }

  console.log(JSON.stringify({ ok: true, status: 'close_attempted', tokenID, shares, remaining, attempts }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e?.message || String(e) }));
  process.exit(1);
}
