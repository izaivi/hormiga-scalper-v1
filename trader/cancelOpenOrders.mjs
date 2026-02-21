import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

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

try {
  const open = await client.getOpenOrders();
  const orders = Array.isArray(open) ? open : [];

  let cancelled = 0;
  const errors = [];

  for (const o of orders) {
    const orderID = o?.orderID || o?.order_id;
    if (!orderID) continue;
    try {
      await client.cancelOrder({ orderID });
      cancelled += 1;
    } catch (e) {
      errors.push({ orderID, error: e?.message || String(e) });
    }
  }

  console.log(JSON.stringify({ ok: true, open: orders.length, cancelled, errors }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e?.message || String(e) }));
  process.exit(1);
}
