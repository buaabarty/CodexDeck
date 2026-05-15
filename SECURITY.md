# Security Policy

## Supported versions

Security fixes target the latest released version.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose local files, shells, credentials, Codex sessions, or tunnel access.

Report privately through GitHub Security Advisories:

https://github.com/buaabarty/CodexDeck/security/advisories/new

If that is not available, open a minimal issue asking for a private contact without sharing exploit details.

## Deployment guidance

- Bind to `127.0.0.1` by default.
- Prefer SSH port forwarding or Tailscale Serve for remote access.
- Use account + TOTP auth before any public tunnel.
- Never commit `.runtime/`, `.tailscale/`, `.env`, account files, tokens, or tunnel state.
- Treat anyone with CodexDeck access as able to operate local Codex sessions and local project files.
