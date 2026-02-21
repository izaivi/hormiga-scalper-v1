import fs from 'node:fs';
import path from 'node:path';

export function registryPath(logsDir) {
  return path.join(logsDir, 'positions-tokenids.json');
}

export function readRegistry(logsDir) {
  const p = registryPath(logsDir);
  try {
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw);
    const ids = Array.isArray(j?.tokenIds) ? j.tokenIds : Array.isArray(j) ? j : [];
    return [...new Set(ids.map(String).filter(Boolean))];
  } catch {
    return [];
  }
}

export function writeRegistryAtomic(logsDir, tokenIds) {
  const p = registryPath(logsDir);
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });

  const ids = [...new Set((tokenIds || []).map(String).filter(Boolean))].sort();
  const payload = { tokenIds: ids, updatedAt: new Date().toISOString() };

  const tmp = p + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, p);
}

export function mergeIntoRegistry(logsDir, tokenIds) {
  const cur = readRegistry(logsDir);
  const merged = [...new Set([...cur, ...(tokenIds || []).map(String)])].filter(Boolean);
  writeRegistryAtomic(logsDir, merged);
  return merged;
}
