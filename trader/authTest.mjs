import 'dotenv/config';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClobClient, AssetType } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load parent .env.local (do not print it)
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const HOST = process.env.CLOB_HOST || 'https://clob.polymarket.com';
const CHAIN_ID = Number(process.env.CLOB_CHAIN_ID || 137);

const apiKey = process.env.USER_CLOB_API_KEY || process.env.CLOB_API_KEY;
const apiCreds = {
  // clob-client (v5.x) uses `key`; docs show `apiKey`. Provide both.
  key: apiKey,
  apiKey,
  secret: process.env.USER_CLOB_API_SECRET || process.env.CLOB_API_SECRET,
  passphrase: process.env.USER_CLOB_API_PASSPHRASE || process.env.CLOB_API_PASSPHRASE
};

const signatureType = Number(process.env.POLY_SIGNATURE_TYPE || 2);
const funder = process.env.POLY_FUNDER_ADDRESS || process.env.POLY_ADDRESS;

const pk = process.env.PRIVATE_KEY;
if (!pk) {
  console.log(JSON.stringify({ ok: false, error: 'PRIVATE_KEY missing (needed to sign orders / L1)', need: ['PRIVATE_KEY', 'POLY_FUNDER_ADDRESS or POLY_ADDRESS', 'POLY_SIGNATURE_TYPE'] }, null, 2));
  process.exit(2);
}
if (!apiCreds.apiKey || !apiCreds.secret || !apiCreds.passphrase) {
  console.log(JSON.stringify({ ok: false, error: 'CLOB API creds missing', need: ['CLOB_API_KEY','CLOB_API_SECRET','CLOB_API_PASSPHRASE'] }, null, 2));
  process.exit(2);
}
if (!funder) {
  console.log(JSON.stringify({ ok: false, error: 'Funder address missing', need: ['POLY_FUNDER_ADDRESS (proxy) or POLY_ADDRESS'] }, null, 2));
  process.exit(2);
}

const signer = new Wallet(pk);

// Initialize L2 client
const client = new ClobClient(HOST, CHAIN_ID, signer, apiCreds, signatureType, funder);

try {
  // Basic authenticated endpoints that do NOT place orders.
  // getBalanceAllowance is the most useful for ensuring funds/allowance.
  const bal = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  console.log(JSON.stringify({ ok: true, address: signer.address, signatureType, funder, balanceAllowance: bal }, null, 2));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2));
  process.exit(1);
}
