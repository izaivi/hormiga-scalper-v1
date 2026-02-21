import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClobClient, AssetType } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const arg = process.argv[2] ? JSON.parse(process.argv[2]) : {};
const tokenIds = Array.isArray(arg.tokenIds) ? arg.tokenIds.map(String).filter(Boolean) : [];

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

function n(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function nShares(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return null;
  return v > 1e6 ? v / 1e6 : v;
}

try {
  const collateral = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const collateralUSDC = n(collateral?.balance) != null ? n(collateral.balance) / 1e6 : null;

  const positions = [];
  let positionsValueUSDC = 0;

  for (const tid of tokenIds) {
    const bal = await client.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tid });
    const balShares = nShares(bal?.balance);
    if (!balShares || balShares <= 0) continue;

    let mid = null;
    try {
      const m = await client.getMidpoint(tid);
      mid = n(m);
    } catch {}

    const value = mid != null ? balShares * mid : null;
    if (value != null) positionsValueUSDC += value;

    positions.push({ tokenId: tid, shares: balShares, midpoint: mid, valueUSDC: value });
  }

  const equityUSDC = (collateralUSDC != null ? collateralUSDC : 0) + positionsValueUSDC;

  console.log(JSON.stringify({ ok: true, collateralUSDC, positionsValueUSDC, equityUSDC, positions }, null, 2));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err?.message || String(err) }));
  process.exit(1);
}
