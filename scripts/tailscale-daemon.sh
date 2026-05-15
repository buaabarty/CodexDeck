#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOCKET="$ROOT/.runtime/tailscaled.sock"
STATE="$ROOT/.tailscale/state/tailscaled.state"
STATEDIR="$ROOT/.tailscale/state"
LOG="$ROOT/.runtime/tailscaled.log"
PIDFILE="$ROOT/.runtime/tailscaled.pid"

mkdir -p "$ROOT/.runtime" "$STATEDIR"

if [[ -f "$PIDFILE" ]]; then
  PID="$(cat "$PIDFILE")"
  if [[ "$PID" =~ ^[0-9]+$ ]] && kill -0 "$PID" >/dev/null 2>&1; then
    if [[ -S "$SOCKET" ]] && "$ROOT/.tailscale/bin/tailscale" --socket="$SOCKET" status --json >/dev/null 2>&1; then
      echo "tailscaled already running as pid $PID"
      exit 0
    fi
    kill "$PID" >/dev/null 2>&1 || true
    sleep 1
  fi
fi

if [[ -S "$SOCKET" ]] && "$ROOT/.tailscale/bin/tailscale" --socket="$SOCKET" status --json >/dev/null 2>&1; then
  echo "tailscaled already running on $SOCKET"
  exit 0
fi

rm -f "$SOCKET"
setsid "$ROOT/.tailscale/bin/tailscaled" \
  --tun=userspace-networking \
  --socket="$SOCKET" \
  --state="$STATE" \
  --statedir="$STATEDIR" \
  > "$LOG" 2>&1 < /dev/null &

echo "$!" > "$PIDFILE"
sleep 2
"$ROOT/.tailscale/bin/tailscale" --socket="$SOCKET" status || true
echo "tailscaled pid $(cat "$PIDFILE")"
