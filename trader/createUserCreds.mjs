import dotenv from 'dotenv';
import fs from 'node:fs';
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
  console.error('PRIVATE_KEY missing');
  process.exit(2);
}

const signer = new Wallet(pk);
const client = new ClobClient(HOST, CHAIN_ID, signer);

let apiCreds;
try {
  apiCreds = await client.deriveApiKey();
} catch (e1) {
  try {
    apiCreds = await client.createApiKey();
  } catch (e2) {
    // Re-throw with the more specific error message
    const msg = e2?.message || e1?.message || 'Could not derive/create api key';
    throw new Error(msg);
  }
}

// Write back to .env.local as USER_* keys (do not print secrets)
const envPath = path.join(__dirname, '..', '.env.local');
let txt = fs.readFileSync(envPath, 'utf8');

function setLine(key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (re.test(txt)) txt = txt.replace(re, line);
  else txt += (txt.endsWith('\n') ? '' : '\n') + line + '\n';
}

const apiKey = apiCreds?.apiKey || apiCreds?.key;
const secret = apiCreds?.secret;
const passphrase = apiCreds?.passphrase;

if (!apiKey || !secret || !passphrase) {
  const dbg = {
    ok: false,
    gotType: typeof apiCreds,
    gotKeys: apiCreds && typeof apiCreds === 'object' ? Object.keys(apiCreds) : null,
    apiKeyLen: apiKey ? String(apiKey).length : null,
    secretLen: secret ? String(secret).length : null,
    passLen: passphrase ? String(passphrase).length : null
  };
  console.log(JSON.stringify(dbg, null, 2));
  throw new Error('API creds missing fields after derive/create');
}

setLine('USER_CLOB_API_KEY', apiKey);
setLine('USER_CLOB_API_SECRET', secret);
setLine('USER_CLOB_API_PASSPHRASE', passphrase);

fs.writeFileSync(envPath, txt, 'utf8');

console.log(JSON.stringify({ ok: true, address: signer.address, wrote: ['USER_CLOB_API_KEY','USER_CLOB_API_SECRET','USER_CLOB_API_PASSPHRASE'] }, null, 2));
