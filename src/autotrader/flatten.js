import { spawn } from 'node:child_process';
import path from 'node:path';

function run(scriptPath, argsObj, timeoutMs = 120_000) {
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

export async function flattenPositions({ tokenIds, ttlSeconds = 15, maxRetries = 2, discoverTradesPages = 6, discoverTradesMax = 500 }) {
  const scriptPath = path.join(process.cwd(), 'trader', 'flattenPositions.mjs');
  const res = await run(scriptPath, { tokenIds, ttlSeconds, maxRetries, discoverTradesPages, discoverTradesMax }, 120_000);
  if (!res.ok) return { ok: false, error: res.parsed?.error || res.err || res.out || 'flatten_failed' };
  return { ok: true, ...res.parsed };
}
