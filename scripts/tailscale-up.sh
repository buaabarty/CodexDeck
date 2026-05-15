#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOCKET="$ROOT/.runtime/tailscaled.sock"
HOSTNAME="${TAILSCALE_HOSTNAME:-codexdeck}"

"$ROOT/scripts/tailscale-daemon.sh" >/dev/null

"$ROOT/.tailscale/bin/tailscale" \
  --socket="$SOCKET" \
  up \
  --hostname="$HOSTNAME" \
  --accept-dns=false \
  --reset
