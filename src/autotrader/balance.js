import { spawn } from 'node:child_process';
import path from 'node:path';

function run(scriptPath, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
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

export async function getUsdcBalance() {
  const scriptPath = path.join(process.cwd(), 'trader', 'getBalance.mjs');
  const res = await run(scriptPath);
  if (!res.ok) return { ok: false, error: res.parsed?.error || res.err || res.out || 'balance_failed' };

  const raw = res.parsed?.balanceAllowance?.balance;
  const n = raw !== undefined && raw !== null ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return { ok: false, error: 'balance_not_numeric' };

  // USDC has 6 decimals
  return { ok: true, balanceUSDC: n / 1e6 };
}
