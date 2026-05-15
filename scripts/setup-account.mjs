#!/usr/bin/env node
import crypto from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const accountFile = process.env.CODEX_CONTROL_ACCOUNT_FILE || path.join(root, '.runtime/account.json');
const username = process.argv[2] || process.env.CODEX_CONTROL_USER || 'codexdeck';
const password = process.argv[3] || crypto.randomBytes(18).toString('base64url');

function base32Encode(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    output += alphabet[Number.parseInt(chunk, 2)];
  }
  return output;
}

function hashPassword(value) {
  const iterations = 210000;
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(value, salt, iterations, 32, 'sha256');
  return `pbkdf2-sha256$${iterations}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

const totpSecret = base32Encode(crypto.randomBytes(20));
const sessionSecret = crypto.randomBytes(32).toString('base64url');
const issuer = 'CodexDeck';
const label = `${issuer}:${username}@${os.hostname()}`;
const otpauth = `otpauth://totp/${encodeURIComponent(label)}?secret=${totpSecret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;

mkdirSync(path.dirname(accountFile), { recursive: true });
writeFileSync(accountFile, JSON.stringify({
  username,
  passwordHash: hashPassword(password),
  totpSecret,
  sessionSecret,
  createdAt: new Date().toISOString()
}, null, 2));
chmodSync(accountFile, 0o600);

console.log(`account file: ${accountFile}`);
console.log(`username: ${username}`);
console.log(`password: ${password}`);
console.log(`totp secret: ${totpSecret}`);
console.log(`otpauth uri: ${otpauth}`);
