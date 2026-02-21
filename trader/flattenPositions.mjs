import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClobClient, Side, AssetType } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const arg = process.argv[2] ? JSON.parse(process.argv[2]) : {};
let tokenIds = Array.isArray(arg.tokenIds) ? arg.tokenIds.map(String).filter(Boolean) : [];
const ttlSeconds = Number(arg.ttlSeconds || 15);
const maxRetries = Number(arg.maxRetries || 2); // after initial attempt
const discoverTradesPages = Number(arg.discoverTradesPages || 6);
const discoverTradesMax = Number(arg.discoverTradesMax || 500);

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

async function discoverTokenIds() {
  // Best-effort discovery: look at recent trades for this maker_address and collect asset_id.
  // This approximates "all positions" since we don't have a direct list-positions endpoint.
  const maker = funder;
  const seen = new Set();
  let next = undefined;
  let fetched = 0;

  for (let page = 0; page < discoverTradesPages; page++) {
    let res;
    try {
      res = await client.getTradesPaginated({ maker_address: maker }, next);
    } catch {
      break;
    }

    const trades = Array.isArray(res?.trades) ? res.trades : [];
    for (const t of trades) {
      const tid = t?.asset_id;
      if (tid) seen.add(String(tid));
    }

    fetched += trades.length;
    next = res?.next_cursor;
    if (!next || trades.length === 0 || fetched >= discoverTradesMax) break;
  }

  return [...seen];
}

function nShares(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return null;
  return v > 1e6 ? v / 1e6 : v;
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

async function trySellToken(tokenId, shares) {
  const attempts = [];
  let remaining = shares;

  // Pull orderbook for best bid + tick
  let book = null;
  try {
    book = await client.getOrderBook(tokenId);
  } catch (e) {
    return { ok: false, tokenId, error: 'orderbook_failed', detail: e?.message || String(e) };
  }

  const tickSize = book?.tick_size || '0.01';
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const bestBid = bids.length ? n(bids[0]?.price) : null;
  if (!bestBid || bestBid <= 0) {
    return { ok: false, tokenId, error: 'no_bids' };
  }

  // Price ladder: start at best bid; then slightly more aggressive (lower) to get filled.
  const prices = [bestBid];
  for (let i = 1; i <= maxRetries; i++) {
    prices.push(bestBid - i * Number(tickSize || 0.01));
  }

  // Make sure we don't go <=0
  const cleanPrices = prices
    .filter((p) => Number.isFinite(p) && p > 0)
    .map((p) => roundToTick(p, tickSize));

  // If duplicate prices due to rounding, unique them.
  const uniqPrices = [...new Set(cleanPrices.map((p) => p.toFixed(6)))].map((s) => Number(s));

  for (let i = 0; i < uniqPrices.length; i++) {
    const price = uniqPrices[i];
    let orderResp = null;
    let cancelled = false;

    try {
      orderResp = await client.createAndPostOrder(
        { tokenID: tokenId, price, size: remaining, side: Side.SELL },
        { tickSize: String(tickSize ?? '0.01'), negRisk: Boolean(book?.neg_risk) }
      );
    } catch (e) {
      attempts.push({ ok: false, price, error: e?.message || String(e) });
      continue;
    }

    await new Promise((r) => setTimeout(r, ttlSeconds * 1000));
    cancelled = await cancelIfOpen(orderResp.orderID);

    // Determine matched size via getOrder
    let sizeMatched = null;
    try {
      const ord = await client.getOrder(orderResp.orderID);
      sizeMatched = ord?.size_matched != null ? Number(ord.size_matched) : null;
    } catch {}

    attempts.push({ ok: true, price, orderID: orderResp.orderID, cancelled, sizeMatched });

    // If we sold (fully or partially), update remaining.
    if (sizeMatched && sizeMatched > 0) {
      remaining = Math.max(0, remaining - sizeMatched);
      // If fully flat, stop.
      if (remaining <= 1e-9) break;
    }

    // If nothing matched and we cancelled, try next more aggressive price.
  }

  return { ok: true, tokenId, shares, remaining, attempts };
}

try {
  const results = [];
  const errors = [];

  // Always try to add discovered tokenIds (best-effort global)
  const discovered = await discoverTokenIds();
  tokenIds = [...new Set([...tokenIds, ...discovered].map(String))];

  for (const tokenId of tokenIds) {
    // Get conditional token balance (shares)
    let bal = null;
    try {
      bal = await client.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId });
    } catch (e) {
      errors.push({ tokenId, error: 'balance_failed', detail: e?.message || String(e) });
      continue;
    }

    const shares = nShares(bal?.balance);
    if (!shares || shares <= 0) continue;

    const r = await trySellToken(tokenId, shares);
    if (!r.ok && r.error === 'no_bids') {
      // Residual/resolved/illiquid token. Can't flatten.
      errors.push({ tokenId, error: 'no_bids' });
      continue;
    }
    results.push(r);
  }

  console.log(JSON.stringify({ ok: true, ttlSeconds, maxRetries, results, errors }, null, 2));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err?.message || String(err) }));
  process.exit(1);
}
