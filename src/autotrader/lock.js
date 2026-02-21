import fs from "node:fs";
import path from "node:path";

function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock({ logsDir, name = "autotrader" }) {
  const lockPath = path.join(logsDir, `${name}.lock.json`);

  // If lock exists, check if it's stale.
  if (fs.existsSync(lockPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      const prevPid = Number(prev?.pid);
      if (pidAlive(prevPid)) {
        return { ok: false, reason: "already_running", lockPath, prev };
      }
      // stale lock
      fs.unlinkSync(lockPath);
    } catch {
      // If unreadable, try removing it.
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }

  const payload = {
    pid: process.pid,
    ppid: process.ppid,
    startedAt: new Date().toISOString(),
    argv: process.argv
  };

  // Create exclusively
  const fd = fs.openSync(lockPath, "wx");
  try {
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
  } finally {
    try { fs.closeSync(fd); } catch {}
  }

  const release = () => {
    try {
      // only remove if it's ours
      const cur = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (Number(cur?.pid) === process.pid) fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  };

  return { ok: true, lockPath, payload, release };
}
