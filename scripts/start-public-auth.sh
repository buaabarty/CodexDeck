#!/usr/bin/env bash
set -euo pipefail

export CODEX_CONTROL_AUTH=account
export CODEX_CONTROL_HOST="${CODEX_CONTROL_HOST:-127.0.0.1}"
export CODEX_CONTROL_PORT="${CODEX_CONTROL_PORT:-5900}"
export CODEX_CONTROL_ACCOUNT_FILE="${CODEX_CONTROL_ACCOUNT_FILE:-$(pwd)/.runtime/account.json}"
export CODEX_CONTROL_COOKIE_SECURE="${CODEX_CONTROL_COOKIE_SECURE:-1}"

exec node server/index.js
