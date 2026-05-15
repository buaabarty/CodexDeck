#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOCKET="$ROOT/.runtime/tailscaled.sock"
PORT="${CODEX_CONTROL_PORT:-5900}"

"$ROOT/scripts/tailscale-daemon.sh" >/dev/null

"$ROOT/.tailscale/bin/tailscale" --socket="$SOCKET" serve --bg "$PORT"
"$ROOT/.tailscale/bin/tailscale" --socket="$SOCKET" serve status
