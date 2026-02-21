import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const arg = process.argv[2] ? JSON.parse(process.argv[2]) : {};
const orderID = String(arg.orderID || '');

if (!orderID) {
  console.log(JSON.stringify({ ok: false, error: 'missing_orderID' }));
  process.exit(2);
}

const HOST = process.env.CLOB_HOST || 'https://clob.polymarket.com';
const CHAIN_ID = Number(process.env.CLOB_CHAIN_ID || 137);
const signer = new Wallet(process.env.PRIVATE_KEY);

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

function n(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

try {
  const ord = await client.getOrder(orderID);
  const tokenId = String(ord?.asset_id || '');

  let tickSize = null;
  try {
    tickSize = await client.getTickSize(tokenId);
  } catch {}

  const assoc = Array.isArray(ord?.associate_trades) ? ord.associate_trades : [];
  const trades = [];
  for (const id of assoc) {
    try {
      const t = await client.getTrades({ id }, true);
      if (Array.isArray(t) && t[0]) trades.push(t[0]);
    } catch {}
  }

  const fills = trades.map((t) => ({
    id: t.id,
    price: n(t.price),
    size: n(t.size),
    match_time: t.match_time
  }));

  const totalSize = fills.reduce((s, f) => s + (Number.isFinite(f.size) ? f.size : 0), 0);
  const wsum = fills.reduce((s, f) => s + (Number.isFinite(f.size) && Number.isFinite(f.price) ? f.size * f.price : 0), 0);
  const avgFillPriceFromAssoc = totalSize > 0 ? wsum / totalSize : null;

  console.log(
    JSON.stringify(
      {
        ok: true,
        orderID,
        tokenId,
        tickSize,
        order: {
          side: ord?.side,
          price: n(ord?.price),
          size: n(ord?.size),
          size_matched: n(ord?.size_matched),
          status: ord?.status,
          created_at: ord?.created_at,
          maker: ord?.maker,
          taker: ord?.taker
        },
        associate_trades: assoc,
        fills,
        avgFillPriceFromAssoc
      },
      null,
      2
    )
  );
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e?.message || String(e) }));
  process.exit(1);
}
