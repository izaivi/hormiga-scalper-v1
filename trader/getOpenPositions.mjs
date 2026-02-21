import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClobClient, AssetType } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const arg = process.argv[2] ? JSON.parse(process.argv[2]) : {};
let tokenIds = Array.isArray(arg.tokenIds) ? arg.tokenIds.map(String).filter(Boolean) : [];
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
  // SDK may return balances in base units (1e6). Normalize to shares.
  const v = Number(x);
  if (!Number.isFinite(v)) return null;
  // Heuristic: if absurdly large, treat as 6-decimal fixed.
  return v > 1e6 ? v / 1e6 : v;
}

try {
  const discovered = await discoverTokenIds();
  tokenIds = [...new Set([...tokenIds, ...discovered].map(String))];

  const open = [];
  const errors = [];

  for (const tokenId of tokenIds) {
    try {
      const bal = await client.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId });
      const shares = nShares(bal?.balance);
      if (!(shares && shares > 0)) continue;

      // Only treat it as an "open position" if an orderbook exists and there's at least one bid or ask.
      // This avoids residual/resolved tokens (no orderbook) blocking Hormiga v1.
      let book;
      try {
        book = await client.getOrderBook(tokenId);
      } catch (e) {
        errors.push({ tokenId, error: 'no_orderbook', detail: e?.message || String(e) });
        continue;
      }

      const bids = Array.isArray(book?.bids) ? book.bids : [];
      const asks = Array.isArray(book?.asks) ? book.asks : [];
      if (!bids.length && !asks.length) {
        errors.push({ tokenId, error: 'empty_orderbook' });
        continue;
      }

      open.push({ tokenId, shares });
    } catch (e) {
      errors.push({ tokenId, error: e?.message || String(e) });
    }
  }

  console.log(JSON.stringify({ ok: true, open, scanned: tokenIds.length, errors }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e?.message || String(e) }));
  process.exit(1);
}
