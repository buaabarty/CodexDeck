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
  assert.equal(pkg.scripts['docker:build'], 'docker build -t codexdeck:local .');
});

test('repository excludes local secrets and runtime state', async () => {
  const gitignore = await text('.gitignore');
  for (const pattern of ['.runtime/', '.tailscale/', '.env', 'node_modules/']) {
    assert.match(gitignore, new RegExp(pattern.replace('.', '\\.')));
  }
  const dockerignore = await text('.dockerignore');
  for (const pattern of ['.runtime', '.tailscale', '.env', 'node_modules']) {
    assert.match(dockerignore, new RegExp(pattern.replace('.', '\\.')));
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
  for (const heading of ['## Security Model', '## Quick Start', '## Docker Image', '## Release', '## Star History']) {
    assert.match(readme, new RegExp(heading.replace('#', '\\#')));
  }
  assert.match(readme, /ghcr\.io\/buaabarty\/codexdeck:latest/);
});

test('citation metadata uses the public author name', async () => {
  const citation = await text('CITATION.cff');
  assert.match(citation, /given-names: "Boyang"/);
  assert.match(citation, /family-names: "Yang"/);
});

test('docker workflow publishes to GHCR', async () => {
  const workflow = await text('.github/workflows/docker.yml');
  assert.match(workflow, /ghcr\.io/);
  assert.match(workflow, /buaabarty\/codexdeck/);
  assert.match(workflow, /docker\/build-push-action@[0-9a-f]{40}/);
  const actionRefs = [...workflow.matchAll(/uses:\s+[\w-]+\/[\w.-]+@([^\s]+)/g)].map((match) => match[1]);
  assert.ok(actionRefs.length >= 6);
  for (const ref of actionRefs) {
    assert.match(ref, /^[0-9a-f]{40}$/);
  }
});
