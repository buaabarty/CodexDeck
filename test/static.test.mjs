import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function text(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('package metadata is publishable', async () => {
  const pkg = JSON.parse(await text('package.json'));
  assert.equal(pkg.name, 'codexdeck');
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository.url, 'git+ssh://git@github.com/buaabarty/CodexDeck.git');
});

test('repository excludes local secrets and runtime state', async () => {
  const gitignore = await text('.gitignore');
  for (const pattern of ['.runtime/', '.tailscale/', '.env', 'node_modules/']) {
    assert.match(gitignore, new RegExp(pattern.replace('.', '\\.')));
  }
});

test('source does not contain local machine paths or private tailnet hostnames', async () => {
  const forbidden = [
    new RegExp('/home/' + 'barty'),
    new RegExp('tail' + '6366d7'),
    new RegExp('codex' + '-wsl')
  ];
  const files = [
    'server/index.js',
    'public/app.js',
    'README.md',
    'scripts/setup-account.mjs',
    'scripts/tailscale-up.sh'
  ];
  for (const file of files) {
    const source = await text(file);
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern);
  }
});

test('readme documents security, quick start, and release flow', async () => {
  const readme = await text('README.md');
  for (const heading of ['## Security Model', '## Quick Start', '## Release', '## Star History']) {
    assert.match(readme, new RegExp(heading.replace('#', '\\#')));
  }
});
