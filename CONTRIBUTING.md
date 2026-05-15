# Contributing

Thanks for improving CodexDeck.

## Development setup

```bash
npm ci
npm run check
npm test
npm start
```

Use Node.js 20 or newer. Keep local secrets in `.env`, `.runtime/`, or your shell environment; none of those should be committed.

## Pull request checklist

- Keep changes focused and explain the user-facing behavior.
- Run `npm run ci` before opening a PR.
- Add or update tests for behavior that can be checked without a live Codex process.
- Update `README.md` or `CHANGELOG.md` when the user workflow changes.
- Do not include screenshots or logs containing tokens, project secrets, or private paths.

## Security-sensitive changes

CodexDeck can control local shell-capable agents. Treat auth, tunneling, process signaling, PTY input, and log rendering changes as security-sensitive. Prefer conservative defaults and document exposure risks.
