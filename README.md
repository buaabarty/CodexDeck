# CodexDeck

[![CI](https://github.com/buaabarty/CodexDeck/actions/workflows/ci.yml/badge.svg)](https://github.com/buaabarty/CodexDeck/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/buaabarty/CodexDeck?include_prereleases)](https://github.com/buaabarty/CodexDeck/releases)
[![License](https://img.shields.io/github/license/buaabarty/CodexDeck)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.0-339933?logo=node.js&logoColor=white)](package.json)
[![OpenAI Codex](https://img.shields.io/badge/OpenAI-Codex-412991?logo=openai&logoColor=white)](https://github.com/openai/codex)
[![Tailscale ready](https://img.shields.io/badge/Tailscale-ready-242424?logo=tailscale&logoColor=white)](#private-remote-access)

Browser-first control deck for local Codex CLI sessions.

CodexDeck turns a workstation into a private web control plane for Codex: start sessions, attach from a phone, stream structured replies, expand command output, watch existing threads, and keep the raw terminal available when you need it.

## Features

- Browser UI for local `codex` interactive sessions.
- Mobile-friendly input box, session picker, and compact control buttons.
- PTY-backed managed sessions with live Socket.IO streaming.
- Structured Codex log view for replies, message times, and expandable command output.
- Read-only watch mode for existing external Codex threads.
- Resume mode to start a browser-controlled continuation of a recent thread.
- Account + password + TOTP mode for public tunnels.
- Tailscale Serve/Funnel helper scripts for private or authenticated remote access.

## Security Model

CodexDeck can type into local Codex sessions, start shell-capable agents, terminate processes, and read local Codex session metadata. Treat it like remote shell access.

Recommended exposure order:

1. `127.0.0.1` plus SSH port forwarding.
2. `127.0.0.1` plus Tailscale Serve inside your private tailnet.
3. Public tunnel only with account auth, strong password, and TOTP.

Avoid exposing CodexDeck directly to the public internet without authentication. Never commit `.runtime/`, `.tailscale/`, `.env`, account files, tokens, or Tailscale state.

## Requirements

- Node.js 20 or newer.
- npm 10 or newer.
- OpenAI Codex CLI available as `codex` on `PATH`, or set `CODEX_BIN`.
- Linux/macOS/WSL-style environment for PTY support.
- Optional: Tailscale for private remote access.

## Quick Start

```bash
git clone git@github.com:buaabarty/CodexDeck.git
cd CodexDeck
npm ci
CODEX_CONTROL_TOKEN="$(openssl rand -base64 32)" npm start
```

Open the local URL printed by the server. By default CodexDeck listens on:

```text
http://127.0.0.1:5900
```

Useful environment variables:

```bash
CODEX_CONTROL_HOST=127.0.0.1
CODEX_CONTROL_PORT=5900
CODEX_CONTROL_TOKEN=replace-with-a-long-random-token
CODEX_DEFAULT_CWD=/path/to/projects
CODEX_BIN=codex
```

If `CODEX_CONTROL_TOKEN` is not set, CodexDeck generates a one-time token and prints it to the server log.

## Private Remote Access

Keep CodexDeck bound to localhost and expose it through Tailscale Serve:

```bash
CODEX_CONTROL_HOST=127.0.0.1 CODEX_CONTROL_PORT=5900 npm start
tailscale serve --bg 5900
tailscale serve status
```

For a tailnet-only setup where Tailscale is the access boundary:

```bash
npm run start:tailnet
```

That disables app-level auth and relies on your private network boundary. Use it only when the service is not reachable outside your trusted tailnet or local tunnel.

## Account + TOTP Mode

For public tunnels, create a local account file and require a six-digit authenticator code:

```bash
npm run setup:account -- your-name
npm run start:public-auth
```

The setup command prints a password and an `otpauth://` URI for your authenticator app. The account file is written to `.runtime/account.json` and must be treated as secret.

Public Tailscale Funnel example:

```bash
tailscale funnel --bg 5900
tailscale funnel status
```

Public mode disables token fallback by default and accepts only the account session cookie unless `CODEX_CONTROL_ALLOW_TOKEN_FALLBACK=1` is set.

## WSL Without sudo

If you cannot run a system Tailscale daemon, place Tailscale binaries under `.tailscale/bin` and use the included user-space scripts:

```bash
npm run tailscale:daemon
npm run tailscale:up
npm run tailscale:serve
```

Override the device name with:

```bash
TAILSCALE_HOSTNAME=codexdeck npm run tailscale:up
```

## How Sessions Work

CodexDeck distinguishes two cases:

- **Managed sessions** are started by CodexDeck. They have a PTY, so the browser can send input, Ctrl-C, Ctrl-D, arrow keys, and mobile key controls.
- **External sessions** were started in another terminal. CodexDeck cannot hijack their PTY safely, so it uses Codex's JSONL rollout log for read-only watch mode.

When you want full browser control of an old thread, click **Resume**. CodexDeck starts a new managed `codex resume <thread-id>` session and attaches to that PTY.

## Development

```bash
npm ci
npm run check
npm test
npm start
```

CI runs the same checks on Node 20 and Node 22.

## Release

Releases are tag-driven. From a clean `main` branch:

```bash
npm version patch --no-git-tag-version
npm install --package-lock-only
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main --tags
```

The `Release` workflow validates the project and creates a GitHub Release from the tag.

## Star History

<a href="https://www.star-history.com/#buaabarty/CodexDeck&Date">
  <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=buaabarty/CodexDeck&type=Date" />
</a>

## Citation

If CodexDeck helps your research or engineering workflow, cite it through GitHub's **Cite this repository** button or use [`CITATION.cff`](CITATION.cff).

## License

MIT. See [LICENSE](LICENSE).
