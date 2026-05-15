import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import express from 'express';
import http from 'node:http';
import pty from 'node-pty';
import { Server as SocketServer } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const nodeModulesDir = path.join(rootDir, 'node_modules');

const PORT = Number.parseInt(process.env.CODEX_CONTROL_PORT || process.env.PORT || '5900', 10);
const HOST = process.env.CODEX_CONTROL_HOST || process.env.HOST || '127.0.0.1';
const CODEX_BIN = process.env.CODEX_BIN || resolveCodexBinary();
const DEFAULT_CWD = path.resolve(process.env.CODEX_DEFAULT_CWD || process.cwd());
const CODEX_STATE_DB = process.env.CODEX_STATE_DB || path.join(os.homedir(), '.codex/state_5.sqlite');
const CODEX_SESSIONS_DIR = process.env.CODEX_SESSIONS_DIR || path.join(os.homedir(), '.codex/sessions');
const MAX_HISTORY_BYTES = Number.parseInt(process.env.CODEX_CONTROL_HISTORY_BYTES || '200000', 10);
const COMMAND_POLL_MS = Number.parseInt(process.env.CODEX_CONTROL_COMMAND_POLL_MS || '350', 10);
const TOKEN = process.env.CODEX_CONTROL_TOKEN || crypto.randomBytes(24).toString('base64url');
const ACCOUNT_FILE = process.env.CODEX_CONTROL_ACCOUNT_FILE || path.join(rootDir, '.runtime/account.json');
const AUTH_DISABLED =
  process.env.CODEX_CONTROL_AUTH === 'none' ||
  process.env.CODEX_CONTROL_DISABLE_AUTH === '1';
const AUTH_MODE = AUTH_DISABLED ? 'none' : (process.env.CODEX_CONTROL_AUTH === 'account' ? 'account' : 'token');
const TOKEN_SOURCE =
  AUTH_MODE === 'none'
    ? 'disabled'
    : (AUTH_MODE === 'account' ? 'account' : (process.env.CODEX_CONTROL_TOKEN ? 'env' : 'generated'));
const ALLOW_TOKEN_FALLBACK =
  AUTH_MODE === 'token' ||
  process.env.CODEX_CONTROL_ALLOW_TOKEN_FALLBACK === '1';
const COOKIE_NAME = 'codex_control_session';
const ACCOUNT_CONFIG = AUTH_MODE === 'account' ? loadAccountConfig() : null;

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, {
  cors: { origin: false }
});

const sessions = new Map();
let nextSessionId = 1;
let commandPollInFlight = false;

app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));

app.get('/health', (req, res) => {
  res.type('text/plain').send('codexdeck ok\n');
});

app.get('/whoami', (req, res) => {
  res.json({
    app: 'codexdeck',
    hostname: os.hostname(),
    user: os.userInfo().username,
    port: PORT,
    defaultCwd: DEFAULT_CWD
  });
});

function safeTokenEquals(value) {
  if (typeof value !== 'string' || !value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function loadAccountConfig() {
  if (!existsSync(ACCOUNT_FILE)) {
    throw new Error(`account auth enabled but account file is missing: ${ACCOUNT_FILE}`);
  }
  const config = JSON.parse(readFileSync(ACCOUNT_FILE, 'utf8'));
  for (const key of ['username', 'passwordHash', 'totpSecret', 'sessionSecret']) {
    if (!config[key]) throw new Error(`account file missing ${key}`);
  }
  return config;
}

function timingSafeStringEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookies(header = '') {
  const cookies = new Map();
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies.set(key, decodeURIComponent(value));
  }
  return cookies;
}

function parsePasswordHash(passwordHash) {
  const [algorithm, iterationsRaw, salt, hash] = String(passwordHash).split('$');
  const iterations = Number.parseInt(iterationsRaw, 10);
  if (algorithm !== 'pbkdf2-sha256' || !Number.isInteger(iterations) || !salt || !hash) {
    throw new Error('unsupported password hash format');
  }
  return { iterations, salt, hash };
}

function verifyPassword(password, passwordHash) {
  const { iterations, salt, hash } = parsePasswordHash(passwordHash);
  const candidate = crypto
    .pbkdf2Sync(String(password || ''), Buffer.from(salt, 'base64url'), iterations, 32, 'sha256')
    .toString('base64url');
  return timingSafeStringEquals(candidate, hash);
}

function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const raw of String(value || '').toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '')) {
    const index = alphabet.indexOf(raw);
    if (index < 0) throw new Error('invalid base32 secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function totpCode(secret, counter) {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

function verifyTotp(secret, value) {
  const normalized = String(value || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  const counter = Math.floor(Date.now() / 30000);
  for (const drift of [-1, 0, 1]) {
    if (timingSafeStringEquals(totpCode(secret, counter + drift), normalized)) return true;
  }
  return false;
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', ACCOUNT_CONFIG.sessionSecret)
    .update(body)
    .digest('base64url');
  return `${body}.${signature}`;
}

function verifySessionCookie(value) {
  if (!ACCOUNT_CONFIG || !value) return false;
  const [body, signature] = String(value).split('.');
  if (!body || !signature) return false;
  const expected = crypto
    .createHmac('sha256', ACCOUNT_CONFIG.sessionSecret)
    .update(body)
    .digest('base64url');
  if (!timingSafeStringEquals(expected, signature)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.u === ACCOUNT_CONFIG.username && payload.exp > Date.now();
  } catch {
    return false;
  }
}

function accountSessionFromRequest(req) {
  return parseCookies(req.get('cookie') || '').get(COOKIE_NAME);
}

function requestHasAccountSession(req) {
  return verifySessionCookie(accountSessionFromRequest(req));
}

function authCookieValue() {
  return signSession({
    u: ACCOUNT_CONFIG.username,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
    n: crypto.randomBytes(12).toString('base64url')
  });
}

function setSessionCookie(res, value) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=604800'
  ];
  if (process.env.CODEX_CONTROL_COOKIE_SECURE === '1') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function resolveCodexBinary() {
  try {
    return execFileSync('sh', ['-lc', 'command -v codex'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || 'codex';
  } catch {
    return 'codex';
  }
}

function buildCodexEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase();
    if (lower.startsWith('npm_') || lower === 'codex_managed_by_npm' || lower === 'codex_managed_by_bun') {
      delete env[key];
    }
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.NO_UPDATE_NOTIFIER = '1';
  env.NPM_CONFIG_UPDATE_NOTIFIER = 'false';
  env.npm_config_update_notifier = 'false';
  env.CODEX_DISABLE_AUTO_NOTIFY = '1';
  return env;
}

function tokenFromRequest(req) {
  const header = req.get('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  if (header.toLowerCase().startsWith('basic ')) {
    const encoded = header.slice(6).trim();
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator >= 0) {
      return decoded.slice(separator + 1);
    }
  }
  if (typeof req.query.token === 'string') {
    return req.query.token;
  }
  return '';
}

function requireAuth(req, res, next) {
  if (AUTH_MODE === 'none') {
    next();
    return;
  }
  if (AUTH_MODE === 'account' && requestHasAccountSession(req)) {
    next();
    return;
  }
  if (!ALLOW_TOKEN_FALLBACK || !safeTokenEquals(tokenFromRequest(req))) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

function normalizeCwd(value) {
  const cwd = value ? path.resolve(String(value)) : DEFAULT_CWD;
  if (!cwd.startsWith('/')) {
    throw new Error('working directory must be absolute');
  }
  return cwd;
}

function summarizeSession(session) {
  return {
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    command: [session.command, ...session.args].join(' '),
    pid: session.pid,
    mode: session.mode,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    status: session.status,
    exitCode: session.exitCode,
    signal: session.signal,
    historyBytes: session.historyBytes || 0,
    outputChunks: session.outputChunks || 0,
    lastOutputAt: session.lastOutputAt,
    lastInputAt: session.lastInputAt
  };
}

function appendHistory(session, data) {
  session.history += data;
  session.outputChunks += 1;
  session.lastOutputAt = new Date().toISOString();
  if (Buffer.byteLength(session.history, 'utf8') > MAX_HISTORY_BYTES) {
    session.history = session.history.slice(Math.floor(session.history.length / 2));
  }
  session.historyBytes = Buffer.byteLength(session.history, 'utf8');
}

function normalizeCommandLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function recordCommandEvent(session, command, options = {}) {
  const normalized = normalizeCommandLine(command);
  if (!normalized || normalized.length > 2000) return null;
  const key = options.pid ? `pid:${options.pid}:${normalized}` : `${options.source || 'manual'}:${normalized}`;
  if (session.seenCommandKeys.has(key)) return null;

  session.seenCommandKeys.add(key);
  const event = {
    id: `${session.id}-${session.nextCommandEventId++}`,
    at: new Date().toISOString(),
    source: options.source || 'process',
    pid: options.pid || null,
    cwd: session.cwd,
    command: normalized
  };
  session.commandEvents.push(event);
  if (session.commandEvents.length > 120) {
    session.commandEvents = session.commandEvents.slice(-100);
  }
  if (options.emit !== false) {
    io.to(`session:${session.id}`).emit('terminal:command', event);
  }
  return event;
}

function buildCodexArgs(body) {
  const args = [];
  const mode = body.mode || 'new';
  const threadId = String(body.threadId || '').trim();

  if (body.model) args.push('-m', String(body.model));
  if (body.profile) args.push('-p', String(body.profile));
  if (body.sandbox) args.push('-s', String(body.sandbox));
  if (body.approval) args.push('-a', String(body.approval));
  if (body.search) args.push('--search');
  if (body.noAltScreen) args.push('--no-alt-screen');
  if (body.fullAuto) args.push('--full-auto');
  if (body.bypassSandbox) args.push('--dangerously-bypass-approvals-and-sandbox');

  const addDirs = Array.isArray(body.addDirs) ? body.addDirs : [];
  for (const dir of addDirs) {
    if (dir) args.push('--add-dir', path.resolve(String(dir)));
  }

  if (mode === 'resume-last') {
    args.push('resume', '--last');
  } else if (mode === 'resume-thread') {
    if (!threadId) throw new Error('threadId is required for resume-thread');
    args.push('resume', threadId);
  } else if (mode === 'resume-picker') {
    args.push('resume');
  } else if (mode === 'fork-last') {
    args.push('fork', '--last');
  } else if (mode === 'fork-thread') {
    if (!threadId) throw new Error('threadId is required for fork-thread');
    args.push('fork', threadId);
  } else if (mode === 'exec') {
    args.push('exec');
  } else if (mode !== 'new') {
    throw new Error(`unsupported mode: ${mode}`);
  }

  const prompt = String(body.prompt || '').trim();
  if (prompt) args.push(prompt);

  return { args, mode };
}

function extractThreadId(command) {
  const match = command.match(/\b(?:resume|fork)\s+([0-9a-f]{8,}-[0-9a-f-]{8,})\b/i);
  return match ? match[1] : null;
}

function runningSessionForThread(threadId) {
  if (!threadId) return null;
  return Array.from(sessions.values()).find((session) => {
    return session.status === 'running' && extractThreadId([session.command, ...session.args].join(' ')) === threadId;
  }) || null;
}

function classifyCodexProcess(command) {
  const lower = command.toLowerCase();
  if (lower.includes(' app-server') || lower.includes('/codex app-server')) return 'app-server';
  if (lower.includes(' resume ')) return 'resume';
  if (lower.includes(' fork ')) return 'fork';
  if (lower.includes(' exec ')) return 'exec';
  return 'interactive';
}

function processCwd(pid) {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function isCodexProcess(command, pid) {
  const lower = command.toLowerCase();
  if (pid === process.pid) return false;
  if (lower.startsWith('systemd-inhibit ')) return false;
  if (lower.includes('server/index.js')) return false;
  if (lower.includes('/.tailscale/')) return false;
  if (lower.includes(' rg ') || lower.endsWith(' rg')) return false;
  if (lower.includes(' pgrep ')) return false;
  return (
    lower.includes('/bin/codex ') ||
    lower.includes('@openai/codex') ||
    lower.includes('/codex/codex ') ||
    lower.includes('/codex app-server') ||
    lower.includes(' codex app-server') ||
    /(^|[/\s])codex($|\s)/.test(lower)
  );
}

function createSession(body) {
  const cwd = normalizeCwd(body.cwd);
  const cols = Number.parseInt(body.cols || '120', 10);
  const rows = Number.parseInt(body.rows || '32', 10);
  const { args, mode } = buildCodexArgs(body);
  if (mode === 'resume-thread') {
    const existing = runningSessionForThread(extractThreadId(args.join(' ')));
    if (existing) return existing;
  }
  const id = String(nextSessionId++);
  const name = String(body.name || `codex-${id}`).slice(0, 80);

  const term = pty.spawn(CODEX_BIN, args, {
    name: 'xterm-256color',
    cols: Number.isFinite(cols) ? cols : 120,
    rows: Number.isFinite(rows) ? rows : 32,
    cwd,
    env: buildCodexEnv()
  });

  const session = {
    id,
    name,
    cwd,
    command: CODEX_BIN,
    args,
    mode,
    term,
    pid: term.pid,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'running',
    exitCode: null,
    signal: null,
    history: '',
    historyBytes: 0,
    outputChunks: 0,
    lastOutputAt: null,
    lastInputAt: null,
    commandEvents: [],
    nextCommandEventId: 1,
    seenCommandKeys: new Set()
  };

  sessions.set(id, session);
  recordCommandEvent(session, [CODEX_BIN, ...args].join(' '), { source: 'session', emit: false });

  term.onData((data) => {
    appendHistory(session, data);
    io.to(`session:${id}`).emit('terminal:data', data);
  });

  term.onExit(({ exitCode, signal }) => {
    session.status = 'exited';
    session.exitCode = exitCode;
    session.signal = signal;
    session.endedAt = new Date().toISOString();
    io.to(`session:${id}`).emit('terminal:exit', summarizeSession(session));
  });

  return session;
}

function listProcesses() {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-eo', 'pid=,ppid=,stat=,tty=,etime=,command='], { maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }

      const managedPids = new Map(
        Array.from(sessions.values()).map((session) => [session.pid, session.id])
      );

      const rows = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
          if (!match) return null;
          const pid = Number.parseInt(match[1], 10);
          const command = match[6];
          if (!isCodexProcess(command, pid)) return null;
          return {
            pid,
            ppid: Number.parseInt(match[2], 10),
            stat: match[3],
            tty: match[4],
            elapsed: match[5],
            command,
            cwd: processCwd(pid),
            kind: classifyCodexProcess(command),
            threadId: extractThreadId(command),
            managedSessionId: managedPids.get(pid) || null
          };
        })
        .filter(Boolean);

      resolve(rows);
    });
  });
}

function parseProcessRows(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number.parseInt(match[1], 10),
        ppid: Number.parseInt(match[2], 10),
        command: match[3]
      };
    })
    .filter(Boolean);
}

function collectDescendants(rows, rootPid) {
  const byParent = new Map();
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }

  const found = [];
  const queue = [...(byParent.get(rootPid) || [])];
  while (queue.length) {
    const row = queue.shift();
    found.push(row);
    queue.push(...(byParent.get(row.pid) || []));
  }
  return found;
}

function shouldIgnoreObservedCommand(command) {
  const lower = String(command || '').toLowerCase();
  if (!lower) return true;
  if (lower.includes('server/index.js')) return true;
  if (lower.includes('/.tailscale/')) return true;
  if (lower.startsWith('ps -eo ')) return true;
  const executable = lower.split(/\s+/)[0] || '';
  return (
    executable === 'codex' ||
    executable.endsWith('/bin/codex') ||
    executable.endsWith('/codex/codex') ||
    lower.includes('@openai/codex') ||
    lower.includes('/codex app-server') ||
    lower.includes(' codex app-server')
  );
}

function pollSessionChildCommands() {
  if (commandPollInFlight || COMMAND_POLL_MS <= 0) return;
  const running = Array.from(sessions.values()).filter((session) => session.status === 'running');
  if (!running.length) return;

  commandPollInFlight = true;
  execFile('ps', ['-eo', 'pid=,ppid=,command='], { maxBuffer: 1024 * 1024 }, (error, stdout) => {
    commandPollInFlight = false;
    if (error) return;
    const rows = parseProcessRows(stdout);
    for (const session of running) {
      for (const row of collectDescendants(rows, session.pid)) {
        if (shouldIgnoreObservedCommand(row.command)) continue;
        recordCommandEvent(session, row.command, {
          source: 'process',
          pid: row.pid
        });
      }
    }
  });
}

function listThreads(limit = 40) {
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 40, 100));
  const sql = `
    select
      id,
      substr(coalesce(title, id), 1, 240) as title,
      substr(coalesce(cwd, ''), 1, 260) as cwd,
      updated_at,
      updated_at_ms,
      created_at,
      created_at_ms,
      rollout_path,
      model,
      approval_mode,
      sandbox_policy
    from threads
    where archived = 0
    order by coalesce(updated_at_ms, updated_at * 1000) desc, id desc
    limit ${safeLimit}
  `;

  return new Promise((resolve, reject) => {
    execFile('sqlite3', ['-json', CODEX_STATE_DB, sql], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        const rows = JSON.parse(stdout || '[]');
        resolve(rows.map((row) => ({
          id: row.id,
          title: row.title || row.id,
          cwd: row.cwd || '',
          updatedAt: row.updated_at_ms || row.updated_at * 1000 || null,
          createdAt: row.created_at_ms || row.created_at * 1000 || null,
          rolloutPath: row.rollout_path || '',
          model: row.model || '',
          approvalMode: row.approval_mode || '',
          sandboxPolicy: row.sandbox_policy || ''
        })));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function assertThreadId(value) {
  const id = String(value || '').trim();
  if (!/^[0-9a-f]{8,}-[0-9a-f-]{8,}$/i.test(id)) {
    throw new Error('invalid thread id');
  }
  return id;
}

function getThreadDetails(threadId) {
  const id = assertThreadId(threadId);
  const sql = `
    select
      id,
      substr(coalesce(title, id), 1, 240) as title,
      substr(coalesce(cwd, ''), 1, 260) as cwd,
      rollout_path,
      updated_at,
      updated_at_ms
    from threads
    where id = ${sqlString(id)}
    limit 1
  `;

  return new Promise((resolve, reject) => {
    execFile('sqlite3', ['-json', CODEX_STATE_DB, sql], { maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        const [row] = JSON.parse(stdout || '[]');
        if (!row) {
          reject(new Error('thread not found'));
          return;
        }
        resolve({
          id: row.id,
          title: row.title || row.id,
          cwd: row.cwd || '',
          rolloutPath: row.rollout_path || '',
          updatedAt: row.updated_at_ms || row.updated_at * 1000 || null
        });
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

function safeRolloutPath(rolloutPath) {
  const resolved = path.resolve(String(rolloutPath || ''));
  const root = path.resolve(CODEX_SESSIONS_DIR);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('thread log path is outside Codex sessions directory');
  }
  if (!existsSync(resolved)) throw new Error('thread log file not found');
  return resolved;
}

function textFromMessageContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => part?.text || part?.input_text || part?.output_text || '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function truncateLogText(value, max = 6000) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

function formatDuration(duration) {
  if (!duration || typeof duration !== 'object') return '';
  const seconds = Number(duration.secs || 0) + Number(duration.nanos || 0) / 1e9;
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return seconds >= 10 ? `${seconds.toFixed(1)}s` : `${seconds.toFixed(2)}s`;
}

function commandFromExecPayload(payload) {
  const parsed = Array.isArray(payload.parsed_cmd) && payload.parsed_cmd[0]?.cmd
    ? payload.parsed_cmd[0].cmd
    : '';
  const command = parsed || (Array.isArray(payload.command) ? payload.command.join(' ') : '');
  const output = payload.aggregated_output || payload.stdout || payload.stderr || '';
  return {
    command: truncateLogText(command, 4000),
    cwd: payload.cwd || '',
    status: payload.status || '',
    exitCode: payload.exit_code ?? null,
    duration: formatDuration(payload.duration),
    output: truncateLogText(output, 12000)
  };
}

function parseToolArguments(argumentsValue) {
  if (!argumentsValue) return {};
  if (typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)) return argumentsValue;
  try {
    const parsed = JSON.parse(String(argumentsValue));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function commandFromFunctionCallPayload(payload) {
  const args = parseToolArguments(payload.arguments);
  const command = typeof args.cmd === 'string'
    ? args.cmd
    : Array.isArray(args.command)
      ? args.command.join(' ')
      : String(args.command || '');
  if (payload.name !== 'exec_command' && !command) return null;
  return {
    command: truncateLogText(command || payload.name || 'command', 4000),
    cwd: args.workdir || args.cwd || '',
    status: 'running',
    exitCode: null,
    duration: '',
    output: ''
  };
}

function outputFromFunctionCallPayload(payload) {
  if (typeof payload.output === 'string') return truncateLogText(payload.output, 12000);
  if (payload.output === undefined || payload.output === null) return '';
  return truncateLogText(JSON.stringify(payload.output), 12000);
}

function mergeCommandOutput(command, output) {
  const next = { ...command, output: truncateLogText(output, 12000) };
  const exitMatch = next.output.match(/Process exited with code\s+(-?\d+)/);
  if (exitMatch) {
    next.exitCode = Number.parseInt(exitMatch[1], 10);
    next.status = next.exitCode === 0 ? 'completed' : 'failed';
  } else {
    next.status = next.status === 'running' ? 'completed' : next.status;
  }
  const wallTimeMatch = next.output.match(/Wall time:\s*([^\n]+)/);
  if (wallTimeMatch) next.duration = wallTimeMatch[1].trim();
  return next;
}

function makeCommandGroupEvent(commands, index) {
  return {
    id: `commands-${index}`,
    at: commands[commands.length - 1]?.at || null,
    kind: 'codex',
    title: 'Codex activity',
    body: '',
    commands
  };
}

function groupLogEvents(events) {
  const grouped = [];
  let currentCodex = null;
  let pendingCommands = [];
  const pendingCalls = new Map();

  const attachCommand = (command) => {
    if (!command) return;
    if (currentCodex) {
      currentCodex.commands = currentCodex.commands || [];
      currentCodex.commands.push(command);
    } else {
      pendingCommands.push(command);
    }
  };

  const flushOpenCommandCalls = () => {
    for (const command of pendingCalls.values()) attachCommand(command);
    pendingCalls.clear();
  };

  const flushPendingCommands = () => {
    if (!pendingCommands.length) return;
    grouped.push(makeCommandGroupEvent(pendingCommands, grouped.length));
    pendingCommands = [];
  };

  for (const event of events) {
    if (event.kind === 'command_start') {
      pendingCalls.set(event.callId, {
        ...event.command,
        at: event.at
      });
      continue;
    }

    if (event.kind === 'command_output') {
      const command = pendingCalls.get(event.callId);
      if (!command) continue;
      pendingCalls.delete(event.callId);
      attachCommand(mergeCommandOutput(command, event.output));
      continue;
    }

    if (event.kind === 'command') {
      attachCommand(event.command);
      continue;
    }

    if (event.kind === 'user') {
      flushOpenCommandCalls();
      flushPendingCommands();
      currentCodex = null;
      grouped.push(event);
      continue;
    }

    if (event.kind === 'codex') {
      if (pendingCommands.length) {
        event.commands = [...pendingCommands, ...(event.commands || [])];
        pendingCommands = [];
      }
      grouped.push(event);
      currentCodex = event;
      continue;
    }

    grouped.push(event);
  }

  flushOpenCommandCalls();
  if (pendingCommands.length) {
    if (currentCodex) currentCodex.commands = [...(currentCodex.commands || []), ...pendingCommands];
    else flushPendingCommands();
  }

  return grouped;
}

function eventFromRolloutLine(line, index) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  const payload = record.payload || {};
  const at = record.timestamp || null;

  if (record.type === 'response_item' && payload.type === 'message') {
    if (payload.role !== 'user') return null;
    const text = textFromMessageContent(payload.content);
    if (!text) return null;
    return {
      id: `line-${index}`,
      at,
      kind: 'user',
      title: 'You',
      body: truncateLogText(text)
    };
  }

  if (record.type === 'response_item' && payload.type === 'function_call') {
    if (!payload.call_id) return null;
    const command = commandFromFunctionCallPayload(payload);
    if (!command) return null;
    return {
      id: `line-${index}`,
      at,
      kind: 'command_start',
      callId: payload.call_id,
      command
    };
  }

  if (record.type === 'response_item' && payload.type === 'function_call_output') {
    if (!payload.call_id) return null;
    return {
      id: `line-${index}`,
      at,
      kind: 'command_output',
      callId: payload.call_id,
      output: outputFromFunctionCallPayload(payload)
    };
  }

  if (record.type === 'event_msg' && payload.type === 'agent_message') {
    if (!payload.message) return null;
    return {
      id: `line-${index}`,
      at,
      kind: 'codex',
      title: payload.phase === 'final_answer' ? 'Codex final' : 'Codex',
      body: truncateLogText(payload.message)
    };
  }

  if (record.type === 'event_msg' && payload.type === 'exec_command_end') {
    return {
      id: `line-${index}`,
      at,
      kind: 'command',
      command: {
        ...commandFromExecPayload(payload),
        at
      }
    };
  }

  if (record.type === 'event_msg' && payload.type === 'task_started') {
    return {
      id: `line-${index}`,
      at,
      kind: 'system',
      title: 'Task',
      body: 'Task started'
    };
  }

  if (record.type === 'event_msg' && payload.type === 'task_complete') {
    return {
      id: `line-${index}`,
      at,
      kind: 'system',
      title: 'Task',
      body: 'Task complete'
    };
  }

  if (record.type === 'event_msg' && payload.type === 'turn_aborted') {
    return {
      id: `line-${index}`,
      at,
      kind: 'system',
      title: 'Interrupted',
      body: 'Turn was interrupted'
    };
  }

  return null;
}

async function readThreadLog(threadId, limit = 80) {
  const thread = await getThreadDetails(threadId);
  const rolloutPath = safeRolloutPath(thread.rolloutPath);
  const safeLimit = Math.max(20, Math.min(Number.parseInt(limit, 10) || 80, 200));
  const lineLimit = safeLimit * 20;

  return new Promise((resolve, reject) => {
    execFile('tail', ['-n', String(lineLimit), rolloutPath], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const stats = statSync(rolloutPath);
      const lines = stdout.split('\n').filter(Boolean);
      const events = lines
        .map((line, index) => eventFromRolloutLine(line, index))
        .filter(Boolean);
      resolve({
        thread,
        log: {
          path: rolloutPath,
          size: stats.size,
          mtimeMs: stats.mtimeMs
        },
        events: groupLogEvents(events).slice(-safeLimit)
      });
    });
  });
}

app.get('/api/auth/status', (req, res) => {
  res.json({
    mode: AUTH_MODE,
    authenticated:
      AUTH_MODE === 'none' ||
      (AUTH_MODE === 'account' && requestHasAccountSession(req)),
    username: ACCOUNT_CONFIG?.username || null
  });
});

app.post('/api/auth/login', (req, res) => {
  if (AUTH_MODE === 'none') {
    res.json({ ok: true, mode: AUTH_MODE });
    return;
  }
  if (AUTH_MODE !== 'account') {
    res.status(400).json({ error: 'account auth is not enabled' });
    return;
  }
  const { username, password, otp } = req.body || {};
  const valid =
    timingSafeStringEquals(String(username || ''), ACCOUNT_CONFIG.username) &&
    verifyPassword(password, ACCOUNT_CONFIG.passwordHash) &&
    verifyTotp(ACCOUNT_CONFIG.totpSecret, otp);
  if (!valid) {
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }
  setSessionCookie(res, authCookieValue());
  res.json({ ok: true, mode: AUTH_MODE, username: ACCOUNT_CONFIG.username });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/config', requireAuth, (req, res) => {
  res.json({
    ok: true,
    host: HOST,
    port: PORT,
    hostname: os.hostname(),
    user: os.userInfo().username,
    home: os.homedir(),
    defaultCwd: DEFAULT_CWD,
    codexBin: CODEX_BIN,
    tokenSource: TOKEN_SOURCE,
    authMode: AUTH_MODE,
    accountUser: ACCOUNT_CONFIG?.username || null
  });
});

app.get('/api/sessions', requireAuth, (req, res) => {
  res.json({ sessions: Array.from(sessions.values()).map(summarizeSession) });
});

app.post('/api/sessions', requireAuth, (req, res) => {
  try {
    const session = createSession(req.body || {});
    res.status(201).json({ session: summarizeSession(session) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/sessions/:id/resize', requireAuth, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  const cols = Number.parseInt(req.body?.cols || '120', 10);
  const rows = Number.parseInt(req.body?.rows || '32', 10);
  session.term.resize(cols, rows);
  res.json({ ok: true });
});

app.post('/api/sessions/:id/signal', requireAuth, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  const signal = String(req.body?.signal || 'SIGTERM');
  try {
    session.term.kill(signal);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/processes', requireAuth, async (req, res) => {
  try {
    res.json({ processes: await listProcesses() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/threads', requireAuth, async (req, res) => {
  try {
    res.json({ threads: await listThreads(req.query.limit) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/threads/:id/log', requireAuth, async (req, res) => {
  try {
    res.json(await readThreadLog(req.params.id, req.query.limit));
  } catch (error) {
    const status = /not found|invalid thread id/i.test(error.message) ? 404 : 500;
    res.status(status).json({ error: error.message });
  }
});

app.post('/api/processes/:pid/signal', requireAuth, (req, res) => {
  const pid = Number.parseInt(req.params.pid, 10);
  const signal = String(req.body?.signal || 'SIGTERM');
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    res.status(400).json({ error: 'invalid pid' });
    return;
  }
  try {
    process.kill(pid, signal);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

io.use((socket, next) => {
  if (AUTH_MODE === 'none') {
    next();
    return;
  }
  if (AUTH_MODE === 'account') {
    const session = parseCookies(socket.handshake.headers.cookie || '').get(COOKIE_NAME);
    if (verifySessionCookie(session)) {
      next();
      return;
    }
  }
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!ALLOW_TOKEN_FALLBACK || !safeTokenEquals(token)) {
    next(new Error('unauthorized'));
    return;
  }
  next();
});

io.on('connection', (socket) => {
  let attachedSessionId = null;

  socket.on('terminal:attach', ({ sessionId }) => {
    const session = sessions.get(String(sessionId));
    if (!session) {
      socket.emit('terminal:error', 'session not found');
      return;
    }
    if (attachedSessionId) socket.leave(`session:${attachedSessionId}`);
    attachedSessionId = session.id;
    socket.join(`session:${session.id}`);
    socket.emit('terminal:history', {
      session: summarizeSession(session),
      data: session.history,
      commands: session.commandEvents || []
    });
  });

  socket.on('terminal:input', (data) => {
    if (!attachedSessionId) return;
    const session = sessions.get(attachedSessionId);
    if (session && session.status === 'running') {
      session.lastInputAt = new Date().toISOString();
      session.term.write(String(data));
    }
  });

  socket.on('terminal:resize', ({ cols, rows }) => {
    if (!attachedSessionId) return;
    const session = sessions.get(attachedSessionId);
    if (!session || session.status !== 'running') return;
    const nextCols = Number.parseInt(cols, 10);
    const nextRows = Number.parseInt(rows, 10);
    if (Number.isInteger(nextCols) && Number.isInteger(nextRows)) {
      session.term.resize(nextCols, nextRows);
    }
  });
});

const noStoreStatic = {
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  }
};

app.use('/vendor/xterm', express.static(path.join(nodeModulesDir, '@xterm/xterm/lib'), noStoreStatic));
app.use('/vendor/xterm-fit', express.static(path.join(nodeModulesDir, '@xterm/addon-fit/lib'), noStoreStatic));
app.use(express.static(publicDir, noStoreStatic));
app.get('*splat', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

if (COMMAND_POLL_MS > 0) {
  const commandPollTimer = setInterval(pollSessionChildCommands, COMMAND_POLL_MS);
  commandPollTimer.unref?.();
}

server.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? os.hostname() : HOST;
  const url =
    TOKEN_SOURCE === 'generated'
      ? `http://${displayHost}:${PORT}/?token=${encodeURIComponent(TOKEN)}`
      : `http://${displayHost}:${PORT}/`;
  console.log(`codexdeck listening on ${HOST}:${PORT}`);
  console.log(`auth token source: ${TOKEN_SOURCE}`);
  console.log(`local URL: ${url}`);
  if (AUTH_MODE === 'none') {
    console.log('login token: disabled; rely on private tailnet access');
  } else if (AUTH_MODE === 'account') {
    console.log(`account auth: enabled for ${ACCOUNT_CONFIG.username}`);
  } else if (TOKEN_SOURCE === 'env') {
    console.log('login token: CODEX_CONTROL_TOKEN');
  }
  console.log(`tailnet exposure: tailscale serve --bg ${PORT}`);
});
