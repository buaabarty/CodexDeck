#!/usr/bin/env bash
set -euo pipefail

export CODEX_CONTROL_DISABLE_AUTH="${CODEX_CONTROL_DISABLE_AUTH:-1}"
export CODEX_CONTROL_HOST="${CODEX_CONTROL_HOST:-127.0.0.1}"
export CODEX_CONTROL_PORT="${CODEX_CONTROL_PORT:-5900}"

exec node server/index.js
