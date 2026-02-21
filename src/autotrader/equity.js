import { spawn } from 'node:child_process';
import path from 'node:path';

function run(scriptPath, argsObj, timeoutMs = 25_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, JSON.stringify(argsObj)], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let out = '';
    let err = '';
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
      resolve({ ok: code === 0, code, parsed, out, err });
    });
  });
}

export async function getEquitySnapshot(tokenIds) {
  const scriptPath = path.join(process.cwd(), 'trader', 'getEquity.mjs');
  const res = await run(scriptPath, { tokenIds: Array.isArray(tokenIds) ? tokenIds : [] });
  if (!res.ok) return { ok: false, error: res.parsed?.error || res.err || res.out || 'equity_failed' };
  return { ok: true, ...res.parsed };
}
