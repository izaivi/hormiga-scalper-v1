#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
source .env.local
set +a

LOGS="logs/autotrader.jsonl"

echo "== Demo 1: DRY 30m =="
START1=$(python3 - <<'PY'
from datetime import datetime, timezone
print(datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'))
PY
)
AUTOTRADE=true AUTOTRADE_MODE=dry SESSION_DURATION_MINUTES=30 MAX_TRADES_TOTAL=50 MAX_TRADES_PER_HOUR=50 COOLDOWN_SECONDS=5 LIMIT_ORDER_TTL_SECONDS=15 node src/index.js || true
END1=$(python3 - <<'PY'
from datetime import datetime, timezone
print(datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'))
PY
)

echo "== Demo 2: DRY 10m (edge cases) =="
START2=$(python3 - <<'PY'
from datetime import datetime, timezone
print(datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'))
PY
)
AUTOTRADE=true AUTOTRADE_MODE=dry SESSION_DURATION_MINUTES=10 MAX_TRADES_TOTAL=50 MAX_TRADES_PER_HOUR=50 COOLDOWN_SECONDS=1 SKIP_ENTER_IF_SECONDS_TO_RESOLUTION_LT=300 FORCE_CLOSE_IF_SECONDS_TO_RESOLUTION_LT=120 LIMIT_ORDER_TTL_SECONDS=15 node src/index.js || true
END2=$(python3 - <<'PY'
from datetime import datetime, timezone
print(datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'))
PY
)

python3 - <<'PY'
import json, os
from datetime import datetime

def iso_to_dt(s):
  # Accept Z
  return datetime.fromisoformat(s.replace('Z','+00:00'))

log_path = os.path.join('logs','autotrader.jsonl')
lines=[]
try:
  with open(log_path,'r',encoding='utf-8') as f:
    for l in f:
      l=l.strip()
      if l.startswith('{'):
        try:
          lines.append(json.loads(l))
        except:
          pass
except FileNotFoundError:
  pass

start1=iso_to_dt(os.environ.get('START1')) if os.environ.get('START1') else None
end1=iso_to_dt(os.environ.get('END1')) if os.environ.get('END1') else None
start2=iso_to_dt(os.environ.get('START2')) if os.environ.get('START2') else None
end2=iso_to_dt(os.environ.get('END2')) if os.environ.get('END2') else None

# But env vars aren't exported from bash subshell into python here; we pass via heredoc by printing markers.
PY

echo "START1=$START1"
echo "END1=$END1"
echo "START2=$START2"
echo "END2=$END2"

python3 - <<PY
import json
from datetime import datetime

def iso_to_dt(s):
  return datetime.fromisoformat(s.replace('Z','+00:00'))

start1=iso_to_dt('$START1')
end1=iso_to_dt('$END1')
start2=iso_to_dt('$START2')
end2=iso_to_dt('$END2')

path='logs/autotrader.jsonl'
items=[]
with open(path,'r',encoding='utf-8') as f:
  for l in f:
    l=l.strip()
    if not l.startswith('{'): continue
    try: j=json.loads(l)
    except: continue
    ts=j.get('ts') or j.get('timestamp')
    if not ts: continue
    try: t=iso_to_dt(ts)
    except: continue
    j['_dt']=t
    items.append(j)

def summarize(window_start, window_end):
  closes=[j for j in items if j.get('type')=='close' and window_start <= j['_dt'] <= window_end]
  counts={}
  pnls=[]
  for c in closes:
    r=c.get('reason') or 'UNKNOWN'
    counts[r]=counts.get(r,0)+1
    p=c.get('pnlUSDC')
    if isinstance(p,(int,float)):
      pnls.append(p)
  avg = sum(pnls)/len(pnls) if pnls else None
  return counts, avg, len(closes)

c1, avg1, n1 = summarize(start1,end1)
c2, avg2, n2 = summarize(start2,end2)

print('--- SUMMARY JSON ---')
print(json.dumps({
  'demo1': {'start': '$START1', 'end': '$END1', 'closeCount': n1, 'closeByReason': c1, 'avgPnlUSDC': avg1},
  'demo2': {'start': '$START2', 'end': '$END2', 'closeCount': n2, 'closeByReason': c2, 'avgPnlUSDC': avg2},
}, indent=2))
PY
