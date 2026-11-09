#!/bin/bash
# ─── wsl-up ──────────────────────────────────────────────────────────────────
# Dev rig inside WSL2: start the provider daemon (and optionally a local node
# daemon) plus the TCP bridges for Windows, then print readiness.
# Daemon = pure upstream cb33092e dvpnd (`run --home H --instance pN`).
# S13 links node-4's nodes, so the local node is off unless NODE=1.
#
#   wsl -d Ubuntu -u root -e bash <repo path inside WSL>/scripts/dev/wsl-up.sh
#   wsl -d Ubuntu -e bash .../wsl-up.sh down     # stop everything it started
#
# Binary: cross-built from a git archive of upstream cb33092e with devnet ldflags
# (memory/handoff-plans-solana.md, STATE). Pre-cb33 homes (/root/dvpnd-provider,
# /root/dvpnd-node) are kept untouched as the rollback.
set -uo pipefail
export PATH=/root/.local/share/solana/install/active_release/bin:/usr/local/go/bin:$PATH

D=${D:-/root/cb33/dvpnd}
NH=${NH:-/root/dvpnd-node-cb33}
PH=${PH:-/root/dvpnd-provider-cb33}
NODE=${NODE:-0}
BRIDGE_PORT=${BRIDGE_PORT:-50052}
HERE="$(cd "$(dirname "$0")" && pwd)"
LOGDIR=/root/plans-solana-dev
mkdir -p "$LOGDIR"

wait_ready() { local i; for i in $(seq 1 60); do grep -q '"message":"ready"' "$1" 2>/dev/null && return 0; sleep 2; done; return 1; }

start_daemon() {  # <log> <home> <instance>  — retries the start-up preflight on RPC 429
  local log=$1 home=$2 inst=$3 a
  if pgrep -f "dvpnd run --home $home" >/dev/null; then echo "    already running: $home"; return 0; fi
  for a in 1 2 3 4; do
    nohup "$D" run --home "$home" --instance "$inst" >"$log" 2>&1 &
    wait_ready "$log" && return 0
    grep -q 429 "$log" || return 1
    pkill -TERM -f "dvpnd run --home $home" 2>/dev/null; sleep $((a * 20))
  done
  return 1
}

if [ "${1:-}" = "down" ]; then
  pkill -f "daemon-bridge.py" 2>/dev/null
  for h in "$PH" "$NH"; do pkill -TERM -f "dvpnd run --home $h" 2>/dev/null; done
  for _ in $(seq 1 10); do pgrep -f 'dvpnd run' >/dev/null || break; sleep 1; done
  echo "down."
  exit 0
fi

[ -x "$D" ] || { echo "dvpnd binary missing at $D — cross-build cb33 dvpnd (see handoff STATE)"; exit 1; }
"$D" version | grep -q J52dyXW3a6mkatvrQct3fo6dA9vqUtcsdBt5gGqrTBXs || { echo "$D has the wrong build identity"; exit 1; }

if [ "$NODE" = "1" ]; then
  echo "=== node daemon ==="
  start_daemon "$LOGDIR/node-cb33.log" "$NH" n1 && echo "    node ready" || { echo "    node FAILED: $(tail -2 "$LOGDIR/node-cb33.log")"; exit 1; }
fi
echo "=== provider daemon ==="
start_daemon "$LOGDIR/provider-cb33.log" "$PH" p1 && echo "    provider ready" || { echo "    provider FAILED: $(tail -2 "$LOGDIR/provider-cb33.log")"; exit 1; }

echo "=== bridges ==="
# The provider API already listens on *:9443 inside WSL, so the loopback bridge
# for Windows uses 19443 → set DVPND_PROVIDER_APIS=<providerPda>=https://127.0.0.1:19443
API_PORT=${API_PORT:-19443}
start_bridge() {  # <listen port> <target>
  if pgrep -f "daemon-bridge.py $1 " >/dev/null; then echo "    already running: $1 -> $2"; return 0; fi
  nohup python3 "$HERE/daemon-bridge.py" "$1" "$2" >"$LOGDIR/bridge-$1.log" 2>&1 &
  sleep 1; pgrep -f "daemon-bridge.py $1 " >/dev/null && echo "    127.0.0.1:$1 -> $2" || { echo "    bridge $1 FAILED: $(cat "$LOGDIR/bridge-$1.log")"; return 1; }
}
start_bridge "$BRIDGE_PORT" "unix:$PH/daemon.sock" || exit 1
start_bridge "$API_PORT" "tcp:127.0.0.1:9443" || exit 1

echo "=== sockets ==="
ss -xl 2>/dev/null | grep -o "/root/dvpnd-[a-z0-9-]*/daemon.sock" | sed 's/^/    /'
echo "logs: $LOGDIR"
