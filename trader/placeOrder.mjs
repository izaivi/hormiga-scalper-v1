import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClobClient, Side } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const arg = process.argv[2] ? JSON.parse(process.argv[2]) : {};
const tokenID = String(arg.tokenId || '');
const price = Number(arg.limitPrice);
const tradeUsd = Number(arg.tradeUsd || 2);
const ttlSeconds = Number(arg.ttlSeconds || 15);

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

if (!Number.isFinite(price) || price <= 0 || price >= 1) {
  console.log(JSON.stringify({ ok: false, error: 'bad_price' }));
  process.exit(2);
}

function roundToTick(p, tick) {
  const t = Number(tick);
  if (!Number.isFinite(t) || t <= 0) return p;
  // Round to nearest tick. (Alternative: Math.floor for strict limit.)
  const r = Math.round(p / t) * t;
  // Avoid FP noise
  const decimals = Math.max(0, String(t).split('.')[1]?.length || 0);
  return Number(r.toFixed(decimals));
}

function parseMinSizeFromErrorMessage(msg) {
  // Example: "Size (3.57) lower than the minimum: 5"
  const m = String(msg || '').match(/minimum\s*:\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

try {
  const tickSize = await client.getTickSize(tokenID);
  const negRisk = await client.getNegRisk(tokenID);

  const roundedPrice = roundToTick(price, tickSize ?? 0.01);

  // Convert USD spend into size (shares). For BUY: spend ~= price * size.
  const baseSize = tradeUsd / roundedPrice;
  const sizeBuffer = Number(arg.sizeBuffer || 1.05);
  let size = baseSize;

  const post = async () => {
    return await client.createAndPostOrder(
      { tokenID, price: roundedPrice, size, side: Side.BUY },
      { tickSize: String(tickSize ?? '0.01'), negRisk: Boolean(negRisk) }
    );
  };

  let orderResp;
  try {
    orderResp = await post();
  } catch (err) {
    const msg = err?.message || String(err);
    const minSize = parseMinSizeFromErrorMessage(msg);
    if (minSize && Number.isFinite(minSize)) {
      size = Math.max(size, minSize * sizeBuffer);
      orderResp = await post();
    } else {
      throw err;
    }
  }

  // Wait then cancel if still open
  await new Promise((r) => setTimeout(r, ttlSeconds * 1000));

  let cancelled = false;
  try {
    const open = await client.getOpenOrders();
    const stillOpen = Array.isArray(open) ? open.find((o) => o.orderID === orderResp.orderID) : null;
    if (stillOpen) {
      await client.cancelOrder({ orderID: orderResp.orderID });
      cancelled = true;
    }
  } catch {}

  // Post-TTL fills: fetch order + associated trades to compute avg fill price.
  let sizeMatched = null;
  let avgFillPrice = null;
  let slippage = null;
  let fills = [];
  try {
    const ord = await client.getOrder(orderResp.orderID);
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
        const avgRaw = wsum / totalSize;
        const slipRaw = avgRaw - roundedPrice;

        // Some endpoints can return complementary prices (p + limit ≈ 1).
        // Normalize for metrics/reporting only.
        const complementEps = Number(arg.complementEps || 0.02);
        const isComplement = Math.abs((avgRaw + roundedPrice) - 1) <= complementEps;

        avgFillPrice = isComplement ? (1 - avgRaw) : avgRaw;
        slippage = avgFillPrice - roundedPrice;

        // Attach raw values (non-breaking: extra fields).
        // eslint-disable-next-line no-unused-vars
        var avgFillPriceRaw = avgRaw;
        // eslint-disable-next-line no-unused-vars
        var slippageRaw = slipRaw;
      }
    }
  } catch {}

  const outObj = {
    ok: true,
    status: cancelled ? 'posted_then_cancelled' : 'posted',
    orderID: orderResp.orderID,
    tokenID,
    limitPrice: roundedPrice,
    size,
    sizeMatched,
    avgFillPrice,
    slippage,
    ttlSeconds,
    fills
  };

  // If we computed raw values in the block above, include them.
  try {
    if (typeof avgFillPriceRaw !== 'undefined') outObj.avgFillPriceRaw = avgFillPriceRaw;
    if (typeof slippageRaw !== 'undefined') outObj.slippageRaw = slippageRaw;
  } catch {}

  console.log(JSON.stringify(outObj));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err?.message || String(err) }));
  process.exit(1);
}
