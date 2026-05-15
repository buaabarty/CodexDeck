(function () {
  const qs = new URLSearchParams(window.location.search);
  const tokenFromUrl = qs.get('token');
  if (tokenFromUrl) {
    localStorage.setItem('codex-control-token', tokenFromUrl);
    qs.delete('token');
    const next = `${window.location.pathname}${qs.toString() ? `?${qs}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', next);
  }

  const state = {
    token: localStorage.getItem('codex-control-token') || '',
    authDisabled: false,
    config: null,
    sessions: [],
    processes: [],
    threads: [],
    activeSessionId: null,
    socket: null,
    rawTerminalInputArmed: false,
    connected: false,
    view: localStorage.getItem('codex-control-view') || 'page',
    streamText: '',
    liveMessageBody: null,
    pendingStreamText: '',
    streamFlushScheduled: false,
    streamGeneration: 0,
    commandLineBuffer: '',
    lastCommand: '',
    liveIdleTimer: null,
    sessionSheetOpenedAt: 0,
    watchThreadId: null,
    watchThread: null,
    watchTimer: null,
    watchOnly: false,
    pendingAttachInput: '',
    openCommandKeys: new Set(),
    suppressAutoScroll: false
  };

  const els = {
    machine: document.getElementById('machine'),
    refresh: document.getElementById('refresh'),
    toggleSidebar: document.getElementById('toggle-sidebar'),
    sidebar: document.querySelector('.sidebar'),
    form: document.getElementById('session-form'),
    cwd: document.getElementById('cwd'),
    sessions: document.getElementById('sessions'),
    processes: document.getElementById('processes'),
    threads: document.getElementById('threads'),
    sessionCount: document.getElementById('session-count'),
    processCount: document.getElementById('process-count'),
    threadCount: document.getElementById('thread-count'),
    activeTitle: document.getElementById('active-title'),
    activeStatus: document.getElementById('active-status'),
    activeSubtitle: document.getElementById('active-subtitle'),
    liveIndicator: document.getElementById('live-indicator'),
    workspace: document.querySelector('.workspace'),
    openSessions: document.getElementById('open-sessions'),
    sessionSheet: document.getElementById('session-sheet'),
    closeSessionSheet: document.getElementById('close-session-sheet'),
    quickSessions: document.getElementById('quick-sessions'),
    quickThreads: document.getElementById('quick-threads'),
    quickSessionCount: document.getElementById('quick-session-count'),
    quickThreadCount: document.getElementById('quick-thread-count'),
    viewPage: document.getElementById('view-page'),
    viewTerminal: document.getElementById('view-terminal'),
    mobileKeys: document.querySelector('.mobile-keys'),
    stream: document.getElementById('stream'),
    composer: document.getElementById('composer'),
    composerInput: document.getElementById('composer-input'),
    terminal: document.getElementById('terminal'),
    ctrlC: document.getElementById('send-ctrl-c'),
    ctrlD: document.getElementById('send-ctrl-d'),
    terminate: document.getElementById('terminate'),
    login: document.getElementById('login'),
    loginForm: document.getElementById('login-form'),
    usernameInput: document.getElementById('username-input'),
    passwordInput: document.getElementById('password-input'),
    otpInput: document.getElementById('otp-input'),
    tokenInput: document.getElementById('token-input'),
    loginError: document.getElementById('login-error')
  };

  const term = new Terminal({
    cursorBlink: true,
    allowProposedApi: false,
    convertEol: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    theme: {
      background: '#080a0e',
      foreground: '#edf0f4',
      cursor: '#58a6ff',
      selectionBackground: '#264f78'
    }
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(els.terminal);

  function fitTerminal() {
    if (state.view !== 'terminal') return;
    requestAnimationFrame(() => {
      fitAddon.fit();
      const dimensions = fitAddon.proposeDimensions();
      if (dimensions && state.socket && state.activeSessionId && state.rawTerminalInputArmed) {
        state.socket.emit('terminal:resize', dimensions);
      }
    });
  }

  function setView(view) {
    state.view = view;
    localStorage.setItem('codex-control-view', view);
    els.workspace.dataset.view = view;
    els.viewPage.classList.toggle('active', view === 'page');
    els.viewTerminal.classList.toggle('active', view === 'terminal');
    if (view === 'terminal') fitTerminal();
    if (view === 'page') els.composerInput.focus();
  }

  function sendTerminalInput(data) {
    if (state.socket && state.activeSessionId) {
      state.socket.emit('terminal:input', data);
    }
  }

  function armRawTerminalInput() {
    if (state.rawTerminalInputArmed) return;
    state.rawTerminalInputArmed = true;
    appendSystemMessage('Raw terminal keyboard input enabled for this attachment.');
  }

  function setControlsCollapsed(collapsed) {
    els.sidebar.classList.toggle('collapsed', collapsed);
    localStorage.setItem('codex-controls-collapsed', collapsed ? '1' : '0');
    setTimeout(fitTerminal, 80);
  }

  function openSessionSheet() {
    const now = Date.now();
    if (now - state.sessionSheetOpenedAt < 250) return;
    state.sessionSheetOpenedAt = now;
    els.sessionSheet.hidden = false;
    els.sessionSheet.removeAttribute('hidden');
    els.sessionSheet.setAttribute('aria-hidden', 'false');
    els.sessionSheet.classList.add('visible');
    if (state.sessions.length) renderQuickSessions();
    else els.quickSessions.innerHTML = '<div class="meta">Loading sessions...</div>';
    if (state.threads.length) renderQuickThreads();
    else els.quickThreads.innerHTML = '<div class="meta">Loading recent threads...</div>';
    refreshSessionSheetData();
  }

  function closeSessionSheet() {
    els.sessionSheet.hidden = true;
    els.sessionSheet.setAttribute('aria-hidden', 'true');
    els.sessionSheet.classList.remove('visible');
  }

  window.codexOpenSessions = openSessionSheet;

  function defaultControlsCollapsed() {
    const saved = localStorage.getItem('codex-controls-collapsed');
    if (saved) return saved === '1';
    return window.matchMedia('(max-width: 920px) and (orientation: portrait)').matches;
  }

  function authHeaders() {
    return state.token ? { authorization: `Bearer ${state.token}` } : {};
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        ...authHeaders(),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || response.statusText);
    }
    return payload;
  }

  function showLogin(message) {
    els.login.classList.add('visible');
    els.loginError.textContent = message || '';
    els.tokenInput.value = message === 'Invalid token.' ? '' : state.token;
    els.usernameInput.focus();
  }

  function hideLogin() {
    els.login.classList.remove('visible');
    els.loginError.textContent = '';
    els.passwordInput.value = '';
    els.otpInput.value = '';
  }

  function setLiveIndicator(text, active) {
    els.liveIndicator.textContent = text;
    els.liveIndicator.classList.toggle('receiving', Boolean(active));
    els.liveIndicator.classList.toggle('idle', !active);
  }

  function markRealtimeActivity() {
    const at = new Date();
    setLiveIndicator('Receiving', true);
    window.clearTimeout(state.liveIdleTimer);
    state.liveIdleTimer = window.setTimeout(() => {
      const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setLiveIndicator(`Last ${time}`, false);
    }, 1500);
  }

  function formatEventTime(value) {
    if (!value) return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function compactPath(value) {
    const home = state.config?.home || '';
    const raw = String(value || '');
    const path = raw.startsWith(home) ? `~${raw.slice(home.length)}` : raw;
    if (path.length <= 58) return path;
    const parts = path.split('/').filter(Boolean);
    if (parts.length < 3) return `...${path.slice(-55)}`;
    const tail = parts.slice(-2).join('/');
    const head = path.startsWith('~') ? '~' : `/${parts[0]}`;
    return `${head}/.../${tail}`;
  }

  function setStatusPill(status) {
    const value = status || 'detached';
    els.activeStatus.textContent = value[0].toUpperCase() + value.slice(1);
    els.activeStatus.className = `status-pill ${value}`;
  }

  function setActiveHeader(session) {
    if (!session) {
      els.activeTitle.textContent = 'No session';
      els.activeSubtitle.textContent = 'Tap Sessions to attach or resume.';
      els.composerInput.placeholder = '输入给 Codex，Enter 发送，Shift+Enter 换行';
      setStatusPill('idle');
      setLiveIndicator('Idle', false);
      return;
    }
    els.activeTitle.textContent = session.name;
    els.composerInput.placeholder = '输入给 Codex，Enter 发送，Shift+Enter 换行';
    setStatusPill(session.status || 'running');
    const lastOutput = session.lastOutputAt
      ? ` · out ${new Date(session.lastOutputAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
      : '';
    els.activeSubtitle.textContent = `${compactPath(session.cwd)} · pid ${session.pid || 'n/a'}${lastOutput}`;
  }

  function cleanTerminalText(data) {
    return String(data)
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
      .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[()][A-Za-z0-9]/g, '')
      .replace(/\x1b[=>]/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
  }

  function cleanPageStreamText(data) {
    const text = cleanTerminalText(data)
      .replace(/■?\s*Conversation interrupted[\s\S]{0,360}?Hit\s+`?\/feedback`?\s+to report the issue\.?/gi, '');

    return text
      .split('\n')
      .filter((line) => {
        const compact = line.replace(/\s+/g, ' ').trim();
        if (!compact) return true;
        if (/Conversation interrupted|Something went wrong|\/feedback/i.test(compact)) return false;
        if (/Context \d+%.*(?:left|used)/i.test(compact) && /\bgpt-|S+t+a+r+t|Starting/i.test(compact)) return false;
        if (/^[•·\s]*S+t+a+r+t/i.test(compact)) return false;
        return true;
      })
      .join('\n');
  }

  function resetStream(data, session, commands) {
    state.streamGeneration += 1;
    state.streamText = '';
    state.liveMessageBody = null;
    state.pendingStreamText = '';
    state.streamFlushScheduled = false;
    state.commandLineBuffer = '';
    state.lastCommand = '';
    els.stream.innerHTML = '';
    const commandEvents = Array.isArray(commands) ? commands : [];
    if (commandEvents.length) {
      for (const event of commandEvents) appendCommandEvent(event);
    } else if (session) {
      appendSessionCommand(session);
    }
    if (!data) return;
    appendStream(data || '');
  }

  function renderRawAttachedStream(data, session, commands) {
    state.watchThreadId = null;
    state.watchThread = null;
    resetStream(data, session, commands);
  }

  function startAttachedThreadLog(session) {
    const threadId = session?.threadId || threadIdFromCommand(session?.command);
    if (!threadId) return false;
    state.watchOnly = false;
    state.watchThreadId = threadId;
    state.watchThread = {
      id: threadId,
      title: session.name || `Thread ${threadId.slice(0, 8)}`,
      cwd: session.cwd || ''
    };
    state.streamGeneration += 1;
    state.liveMessageBody = null;
    state.pendingStreamText = '';
    state.streamFlushScheduled = false;
    state.commandLineBuffer = '';
    state.lastCommand = '';
    els.stream.innerHTML = '';
    appendSystemMessage('Attached. Stream is rendering the structured Codex log; Terminal keeps the raw TUI.');
    loadThreadLog(threadId).catch((error) => appendSystemMessage(`Log failed: ${error.message}`));
    state.watchTimer = window.setInterval(() => {
      loadThreadLog(threadId).catch(() => {});
    }, 2000);
    return true;
  }

  function addMessage(kind, title, body, options = {}) {
    const item = document.createElement('article');
    item.className = `message ${kind}`;
    item.dataset.messageKey = options.messageKey || '';
    const header = document.createElement('div');
    header.className = 'message-header';
    const left = document.createElement('span');
    left.textContent = title;
    const right = document.createElement('span');
    right.textContent = formatEventTime(options.at);
    header.append(left, right);
    const pre = document.createElement('pre');
    pre.className = 'message-body';
    pre.textContent = body || '';
    item.append(header, pre);
    pre._messageItem = item;
    if (Array.isArray(options.commands) && options.commands.length) {
      addCommandsToMessage(item, options.commands);
    }
    els.stream.appendChild(item);
    if (!state.suppressAutoScroll) els.stream.scrollTop = els.stream.scrollHeight;
    return pre;
  }

  function commandTitle(command, index) {
    const at = command.at ? formatEventTime(command.at) : '';
    const status = command.status || (command.exitCode === 0 ? 'completed' : '');
    const exit = command.exitCode === null || command.exitCode === undefined ? '' : `exit ${command.exitCode}`;
    const duration = command.duration ? command.duration : '';
    const suffix = [at, status, exit, duration].filter(Boolean).join(' · ');
    return `Command ${index + 1}${suffix ? ` · ${suffix}` : ''}`;
  }

  function commandStateKey(command, messageKey, index) {
    const hasStableTime = Boolean(command?.at);
    return [
      state.watchThreadId || state.activeSessionId || 'detached',
      hasStableTime ? '' : (messageKey || ''),
      command?.at || '',
      command?.cwd || '',
      command?.command || '',
      hasStableTime ? '' : String(index)
    ].join('\u001f');
  }

  function addCommandsToMessage(item, commands) {
    if (!item || !Array.isArray(commands) || !commands.length) return;
    if (!item._commandList) {
      const list = document.createElement('div');
      list.className = 'command-list';
      item._commandList = list;
      item.appendChild(list);
    }

    for (const command of commands) {
      const index = item._commandList.children.length;
      const key = commandStateKey(command, item.dataset.messageKey, index);
      const details = document.createElement('details');
      details.className = 'command-detail';
      details.dataset.commandKey = key;
      details.open = state.openCommandKeys.has(key);
      details.addEventListener('toggle', () => {
        if (details.open) state.openCommandKeys.add(key);
        else state.openCommandKeys.delete(key);
      });
      const summary = document.createElement('summary');
      summary.textContent = commandTitle(command, index);
      details.appendChild(summary);

      if (command.cwd) {
        const cwd = document.createElement('div');
        cwd.className = 'command-meta-line';
        cwd.textContent = `cwd: ${command.cwd}`;
        details.appendChild(cwd);
      }

      if (command.command) {
        const cmd = document.createElement('pre');
        cmd.className = 'command-code';
        cmd.textContent = command.command;
        details.appendChild(cmd);
      }

      const output = document.createElement('pre');
      output.className = 'command-output';
      output.textContent = command.output || '(no output)';
      details.appendChild(output);

      item._commandList.appendChild(details);
    }
  }

  function appendUserMessage(text) {
    addMessage('user', 'You', text);
  }

  function appendSystemMessage(text) {
    addMessage('system', 'System', text);
  }

  function appendSessionCommand(session) {
    if (!session?.command) return;
    appendCommandEvent({
      source: 'session',
      cwd: session.cwd || '',
      command: session.command
    });
  }

  function appendCommandEvent(event) {
    const command = normalizeCommand(event?.command);
    if (!command || command === state.lastCommand) return;
    state.lastCommand = command;
    const details = {
      command,
      cwd: event?.cwd || '',
      status: event?.source === 'session' ? 'session' : '',
      exitCode: null,
      duration: '',
      output: event?.pid ? `pid: ${event.pid}` : ''
    };
    if (state.liveMessageBody?._messageItem) {
      addCommandsToMessage(state.liveMessageBody._messageItem, [details]);
      els.stream.scrollTop = els.stream.scrollHeight;
      return;
    }
    const title = event?.source === 'session' ? 'Session command' : 'Command';
    addMessage('command', title, '', { commands: [details] });
  }

  function normalizeCommand(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/^`+|`+$/g, '')
      .trim();
  }

  function isLikelyShellCommand(value) {
    const command = normalizeCommand(value);
    if (!command || command.length < 2 || command.length > 800) return false;
    return /^(?:npm|npx|pnpm|yarn|node|python|python3|pip|pip3|git|rg|grep|sed|awk|cat|ls|find|tail|head|curl|wget|docker|docker-compose|kubectl|systemctl|journalctl|tailscale|sqlite3|ps|pgrep|pkill|kill|chmod|chown|mkdir|rm|cp|mv|rsync|tar|zip|unzip|make|cmake|cargo|go|rustc|pytest|uv|corepack|bash|sh|zsh|ssh|scp|apply_patch)\b/.test(command);
  }

  function commandFromLine(line) {
    const text = normalizeCommand(line);
    if (!text) return null;

    let match = text.match(/^(?:\$|>)\s+(.+)$/);
    if (match && isLikelyShellCommand(match[1])) return normalizeCommand(match[1]);

    match = text.match(/^(?:running|executing|executed|ran)(?: shell)?(?: command)?:\s*(.+)$/i);
    if (match) return normalizeCommand(match[1]);

    match = text.match(/^(?:shell|command|cmd):\s*(.+)$/i);
    if (match) return normalizeCommand(match[1]);

    match = text.match(/"cmd"\s*:\s*"([^"]+)"/i);
    if (match) return normalizeCommand(match[1].replace(/\\"/g, '"'));

    return isLikelyShellCommand(text) ? text : null;
  }

  function appendCommandMessage(command) {
    const normalized = normalizeCommand(command);
    if (!normalized || normalized === state.lastCommand) return;
    state.lastCommand = normalized;
    const details = {
      command: normalized,
      cwd: '',
      status: '',
      exitCode: null,
      duration: '',
      output: ''
    };
    if (state.liveMessageBody?._messageItem) {
      addCommandsToMessage(state.liveMessageBody._messageItem, [details]);
      return;
    }
    addMessage('command', 'Command', '', { commands: [details] });
  }

  function processCommandHints(text) {
    state.commandLineBuffer = `${state.commandLineBuffer}${text}`.slice(-6000);
    const lines = state.commandLineBuffer.split('\n');
    state.commandLineBuffer = lines.pop() || '';
    for (const line of lines) {
      const command = commandFromLine(line);
      if (command) appendCommandMessage(command);
    }
  }

  function scheduleStreamFlush() {
    if (state.streamFlushScheduled) return;
    const generation = state.streamGeneration;
    state.streamFlushScheduled = true;
    requestAnimationFrame(() => {
      state.streamFlushScheduled = false;
      if (generation !== state.streamGeneration) {
        state.pendingStreamText = '';
        return;
      }
      const text = state.pendingStreamText;
      state.pendingStreamText = '';
      if (!text) return;
      if (!state.liveMessageBody) {
        state.liveMessageBody = addMessage('codex', 'Codex stream', '');
      }
      state.liveMessageBody.textContent += text;
      if (state.liveMessageBody.textContent.length > 120000) {
        state.liveMessageBody.textContent = state.liveMessageBody.textContent.slice(-80000);
      }
      els.stream.scrollTop = els.stream.scrollHeight;
    });
  }

  function appendStream(data) {
    markRealtimeActivity();
    const cleaned = cleanPageStreamText(data);
    if (!cleaned) return;
    processCommandHints(cleaned);
    state.streamText += cleaned;
    if (state.streamText.length > 120000) {
      state.streamText = state.streamText.slice(-80000);
    }
    state.pendingStreamText += cleaned;
    scheduleStreamFlush();
  }

  function sessionById(id) {
    return state.sessions.find((session) => session.id === id);
  }

  function threadIdFromCommand(command) {
    const match = String(command || '').match(/\b(?:resume|fork)\s+([0-9a-f]{8,}-[0-9a-f-]{8,})\b/i);
    return match ? match[1] : null;
  }

  function managedSessionForThread(threadId) {
    if (!threadId) return null;
    return state.sessions.find((session) => {
      return session.status === 'running' && threadIdFromCommand(session.command) === threadId;
    }) || null;
  }

  function externalProcessForThread(threadId) {
    if (!threadId) return null;
    return state.processes.find((proc) => {
      return proc.threadId === threadId && !proc.managedSessionId;
    }) || null;
  }

  function threadFromProcess(proc) {
    const existing = state.threads.find((thread) => thread.id === proc.threadId);
    return existing || {
      id: proc.threadId,
      title: `Thread ${String(proc.threadId || '').slice(0, 8)}`,
      cwd: proc.cwd || state.config?.defaultCwd || '',
      updatedAt: Date.now()
    };
  }

  function threadControls(thread) {
    const managed = managedSessionForThread(thread.id);
    if (managed) {
      return {
        hint: `managed session #${managed.id}`,
        actions: [
          { label: 'Attach', run: () => attachSession(managed.id) },
          { label: 'Watch', run: () => watchThread(thread) }
        ]
      };
    }

    const external = externalProcessForThread(thread.id);
    return {
      hint: external ? `external pid ${external.pid}` : 'recent thread',
      actions: [
        { label: 'Resume', run: () => resumeThread(thread) },
        { label: 'Watch', run: () => watchThread(thread) }
      ]
    };
  }

  function runUiAction(action) {
    Promise.resolve()
      .then(action.run)
      .catch((error) => appendSystemMessage(error.message || 'Action failed'));
  }

  function showExternalThreadWarning(proc) {
    const message = `External Codex process pid ${proc.pid} cannot be attached as a PTY. Use Watch for read-only live log, or start a new session from this web UI next time if you need browser input/output control.`;
    appendSystemMessage(message);
    if (els.sessionSheet.hidden) openSessionSheet();
  }

  function renderSessions() {
    els.sessionCount.textContent = String(state.sessions.length);
    els.sessions.innerHTML = '';
    renderQuickSessions();
    if (!state.sessions.length) {
      els.sessions.innerHTML = '<div class="meta">No managed sessions yet.</div>';
      return;
    }

    for (const session of state.sessions) {
      const item = document.createElement('div');
      item.className = `item${session.id === state.activeSessionId ? ' active' : ''}`;
      item.innerHTML = `
        <div class="item-title">
          <strong title="${escapeHtml(session.name)}">${escapeHtml(session.name)}</strong>
          <span class="status ${session.status}">${escapeHtml(session.status)}</span>
        </div>
        <div class="meta">pid ${session.pid || 'n/a'} | ${escapeHtml(session.mode)}</div>
        <div class="command" title="${escapeHtml(session.command)}">${escapeHtml(session.command)}</div>
        <div class="item-actions">
          <button data-action="attach">Attach</button>
          <button data-action="sigint">SIGINT</button>
          <button data-action="term" class="danger">TERM</button>
        </div>
      `;
      item.querySelector('[data-action="attach"]').addEventListener('click', () => attachSession(session.id));
      item.querySelector('[data-action="sigint"]').addEventListener('click', () => signalSession(session.id, 'SIGINT'));
      item.querySelector('[data-action="term"]').addEventListener('click', () => signalSession(session.id, 'SIGTERM'));
      els.sessions.appendChild(item);
    }
  }

  function renderQuickSessions() {
    els.quickSessionCount.textContent = String(state.sessions.length);
    els.quickSessions.innerHTML = '';
    if (!state.sessions.length) {
      els.quickSessions.innerHTML = '<div class="meta">No managed sessions yet.</div>';
      return;
    }

    for (const session of state.sessions) {
      const item = document.createElement('div');
      item.className = `quick-card${session.id === state.activeSessionId ? ' active' : ''}`;
      item.innerHTML = `
        <div class="item-title">
          <strong title="${escapeHtml(session.name)}">${escapeHtml(session.name)}</strong>
          <span class="status ${session.status}">${escapeHtml(session.status)}</span>
        </div>
        <div class="meta">${escapeHtml(session.cwd)}</div>
        <div class="meta">pid ${session.pid || 'n/a'} | ${escapeHtml(session.mode)}</div>
        <div class="item-actions">
          <button data-action="attach">Attach</button>
          <button data-action="sigint">Ctrl-C</button>
          <button data-action="term" class="danger">TERM</button>
        </div>
      `;
      item.querySelector('[data-action="attach"]').addEventListener('click', () => {
        closeSessionSheet();
        attachSession(session.id);
      });
      item.querySelector('[data-action="sigint"]').addEventListener('click', () => signalSession(session.id, 'SIGINT'));
      item.querySelector('[data-action="term"]').addEventListener('click', () => signalSession(session.id, 'SIGTERM'));
      els.quickSessions.appendChild(item);
    }
  }

  function renderThreads() {
    els.threadCount.textContent = String(state.threads.length);
    els.threads.innerHTML = '';
    renderQuickThreads();
    if (!state.threads.length) {
      els.threads.innerHTML = '<div class="meta">No recent threads found.</div>';
      return;
    }

    for (const thread of state.threads) {
      const item = document.createElement('div');
      item.className = 'item thread-item';
      const title = String(thread.title || thread.id).replace(/\s+/g, ' ').trim();
      const time = thread.updatedAt ? new Date(thread.updatedAt).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      const controls = threadControls(thread);
      item.innerHTML = `
        <div class="item-title">
          <strong title="${escapeHtml(title)}">${escapeHtml(title.slice(0, 80))}</strong>
          <span class="meta">${escapeHtml(time)}</span>
        </div>
        <div class="meta" title="${escapeHtml(thread.cwd)}">${escapeHtml(thread.cwd || '')}</div>
        <div class="meta">thread ${escapeHtml(thread.id)}</div>
        ${controls.hint ? `<div class="meta">${escapeHtml(controls.hint)}</div>` : ''}
        <div class="item-actions">
          ${controls.actions.map((action, index) => `<button data-action="thread-${index}">${escapeHtml(action.label)}</button>`).join('')}
        </div>
      `;
      controls.actions.forEach((action, index) => {
        item.querySelector(`[data-action="thread-${index}"]`).addEventListener('click', () => runUiAction(action));
      });
      els.threads.appendChild(item);
    }
  }

  function renderQuickThreads() {
    els.quickThreadCount.textContent = String(state.threads.length);
    els.quickThreads.innerHTML = '';
    if (!state.threads.length) {
      els.quickThreads.innerHTML = '<div class="meta">No recent threads found.</div>';
      return;
    }

    for (const thread of state.threads.slice(0, 12)) {
      const item = document.createElement('div');
      item.className = 'quick-card';
      const title = String(thread.title || thread.id).replace(/\s+/g, ' ').trim();
      const time = thread.updatedAt ? new Date(thread.updatedAt).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      const controls = threadControls(thread);
      item.innerHTML = `
        <div class="item-title">
          <strong title="${escapeHtml(title)}">${escapeHtml(title.slice(0, 70))}</strong>
          <span class="meta">${escapeHtml(time)}</span>
        </div>
        <div class="meta" title="${escapeHtml(thread.cwd)}">${escapeHtml(thread.cwd || '')}</div>
        ${controls.hint ? `<div class="meta">${escapeHtml(controls.hint)}</div>` : ''}
        <div class="item-actions">
          ${controls.actions.map((action, index) => `<button data-action="thread-${index}">${escapeHtml(action.label)}</button>`).join('')}
        </div>
      `;
      controls.actions.forEach((action, index) => {
        item.querySelector(`[data-action="thread-${index}"]`).addEventListener('click', () => {
          closeSessionSheet();
          runUiAction(action);
        });
      });
      els.quickThreads.appendChild(item);
    }
  }

  function renderProcesses() {
    els.processCount.textContent = String(state.processes.length);
    els.processes.innerHTML = '';
    if (!state.processes.length) {
      els.processes.innerHTML = '<div class="meta">No external Codex processes found.</div>';
      return;
    }

    for (const proc of state.processes) {
      const item = document.createElement('div');
      item.className = 'item';
      const label = proc.managedSessionId ? `managed #${proc.managedSessionId}` : 'external';
      const attachButton = proc.managedSessionId
        ? '<button data-action="attach">Attach</button>'
        : '';
      const watchButton = !proc.managedSessionId && proc.threadId
        ? '<button data-action="watch">Watch</button>'
        : '';
      const resumeButton = !proc.managedSessionId && proc.threadId
        ? '<button data-action="resume">Resume</button>'
        : '';
      const pickerButton = proc.cwd && !proc.managedSessionId
        ? '<button data-action="threads">Threads</button>'
        : '';
      item.innerHTML = `
        <div class="item-title">
          <strong>pid ${proc.pid}</strong>
          <span class="meta">${escapeHtml(label)} | ${escapeHtml(proc.kind || 'codex')}</span>
        </div>
        <div class="meta">ppid ${proc.ppid} | ${escapeHtml(proc.stat)} | ${escapeHtml(proc.tty || '?')} | ${escapeHtml(proc.elapsed)}</div>
        ${proc.threadId ? `<div class="meta">thread ${escapeHtml(proc.threadId)}</div>` : ''}
        ${proc.threadId && !proc.managedSessionId ? '<div class="meta">external terminal is watch-only; Resume starts browser control</div>' : ''}
        ${proc.cwd ? `<div class="meta" title="${escapeHtml(proc.cwd)}">${escapeHtml(proc.cwd)}</div>` : ''}
        <div class="command" title="${escapeHtml(proc.command)}">${escapeHtml(proc.command)}</div>
        <div class="item-actions">
          ${attachButton}
          ${watchButton}
          ${resumeButton}
          ${pickerButton}
          <button data-action="sigterm" class="danger">TERM</button>
        </div>
      `;
      const attach = item.querySelector('[data-action="attach"]');
      if (attach) attach.addEventListener('click', () => attachSession(proc.managedSessionId));
      const watch = item.querySelector('[data-action="watch"]');
      if (watch) watch.addEventListener('click', () => watchThread(threadFromProcess(proc)));
      const resume = item.querySelector('[data-action="resume"]');
      if (resume) resume.addEventListener('click', () => forceResumeProcess(proc).catch((error) => alert(error.message)));
      const threads = item.querySelector('[data-action="threads"]');
      if (threads) threads.addEventListener('click', () => showThreadsForProcess(proc));
      item.querySelector('[data-action="sigterm"]').addEventListener('click', () => signalProcess(proc.pid, 'SIGTERM'));
      els.processes.appendChild(item);
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
      }[char];
    });
  }

  function compactThreadPayload(thread) {
    const title = String(thread.title || thread.id).replace(/\s+/g, ' ').trim();
    const cwd = String(thread.cwd || '');
    return {
      ...thread,
      title: title.length > 180 ? `${title.slice(0, 177)}...` : title,
      cwd: cwd.length > 120 ? `...${cwd.slice(-117)}` : cwd
    };
  }

  async function refreshSessionsAndProcesses() {
    const [sessionsPayload, processesPayload] = await Promise.all([
      api('/api/sessions'),
      api('/api/processes')
    ]);
    state.sessions = sessionsPayload.sessions;
    state.processes = processesPayload.processes;
    renderSessions();
    renderProcesses();
    setActiveHeader(sessionById(state.activeSessionId));
  }

  async function refreshSessionsOnly() {
    const sessionsPayload = await api('/api/sessions');
    state.sessions = sessionsPayload.sessions;
    renderSessions();
    setActiveHeader(sessionById(state.activeSessionId));
  }

  async function refreshProcessesOnly() {
    const processesPayload = await api('/api/processes');
    state.processes = processesPayload.processes;
    renderProcesses();
  }

  async function refreshThreads(limit = 12) {
    const threadsPayload = await api(`/api/threads?limit=${limit}`);
    state.threads = threadsPayload.threads.map(compactThreadPayload);
    renderThreads();
  }

  async function refresh(options = {}) {
    const includeThreads = options.threads !== false;
    await refreshSessionsAndProcesses();
    if (includeThreads) await refreshThreads(options.threadLimit || 12);
  }

  function refreshSessionSheetData() {
    refreshSessionsOnly()
      .then(() => {
        renderQuickSessions();
      })
      .catch((error) => {
        const message = escapeHtml(error.message || 'Unable to refresh sessions');
        els.quickSessions.innerHTML = `<div class="meta error-inline">${message}</div>`;
      });

    refreshProcessesOnly()
      .catch(() => {})
      .finally(() => {
        window.setTimeout(() => {
          refreshThreads(10).catch((error) => {
            const message = escapeHtml(error.message || 'Unable to load recent threads');
            els.quickThreads.innerHTML = `<div class="meta error-inline">${message}</div>`;
          });
        }, 40);
      });
  }

  async function loadConfig() {
    state.config = await api('/api/config');
    state.authDisabled = state.config.tokenSource === 'disabled';
    els.machine.textContent = `${state.config.user}@${state.config.hostname} | ${state.config.codexBin}`;
    els.cwd.value = state.config.defaultCwd;
  }

  async function connect() {
    try {
      await loadConfig();
      hideLogin();
      state.connected = true;
      await refresh();
      fitTerminal();
    } catch (error) {
      state.connected = false;
      if (error.message === 'unauthorized') {
        state.token = '';
        localStorage.removeItem('codex-control-token');
        showLogin('Invalid token.');
      } else {
        showLogin(error.message);
      }
    }
  }

  async function createSession(event) {
    event.preventDefault();
    const form = new FormData(els.form);
    const body = {
      name: form.get('name'),
      cwd: form.get('cwd'),
      mode: form.get('mode'),
      model: form.get('model'),
      sandbox: form.get('sandbox'),
      approval: form.get('approval'),
      search: Boolean(form.get('search')),
      noAltScreen: Boolean(form.get('noAltScreen')),
      prompt: form.get('prompt'),
      cols: term.cols,
      rows: term.rows
    };
    const payload = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    await refresh();
    if (window.matchMedia('(max-width: 920px)').matches) setControlsCollapsed(true);
    attachSession(payload.session.id);
  }

  function attachSession(sessionId) {
    stopWatchThread();
    state.watchOnly = false;
    state.activeSessionId = String(sessionId);
    state.rawTerminalInputArmed = false;
    if (window.matchMedia('(max-width: 920px)').matches) setControlsCollapsed(true);
    if (state.socket) state.socket.disconnect();
    term.clear();
    term.write('\r\nConnecting...\r\n');
    state.socket = io({
      auth: state.token ? { token: state.token } : {},
      reconnectionAttempts: 5,
      transports: ['websocket', 'polling']
    });
    state.socket.on('connect', () => {
      state.socket.emit('terminal:attach', { sessionId: state.activeSessionId });
      fitTerminal();
    });
    state.socket.on('terminal:history', ({ session, data, commands }) => {
      term.clear();
      if (data) term.write(data);
      const hasStructuredLog = startAttachedThreadLog(session);
      if (!hasStructuredLog) renderRawAttachedStream(data, session, commands);
      state.liveMessageBody = null;
      appendSystemMessage('Attached in observe-only mode. No input is sent unless you press Send, Ctrl-C/Ctrl-D, mobile keys, or tap the terminal to enable raw keyboard input.');
      setActiveHeader(session);
      renderSessions();
      if (state.pendingAttachInput) {
        const pending = state.pendingAttachInput;
        state.pendingAttachInput = '';
        appendUserMessage(pending);
        state.liveMessageBody = null;
        sendTerminalInput(`${pending}\n`);
      }
    });
    state.socket.on('terminal:command', (event) => {
      appendCommandEvent(event);
    });
    state.socket.on('terminal:data', (data) => {
      term.write(data);
      if (!state.watchThreadId) appendStream(data);
    });
    state.socket.on('terminal:exit', async (session) => {
      setActiveHeader(session);
      appendSystemMessage(`Session exited: code ${session.exitCode ?? 'n/a'}, signal ${session.signal ?? 'n/a'}`);
      await refresh().catch(() => {});
    });
    state.socket.on('terminal:error', (message) => {
      term.write(`\r\n${message}\r\n`);
      appendSystemMessage(message);
    });
    state.socket.on('connect_error', (error) => {
      term.write(`\r\nsocket error: ${error.message}\r\n`);
      appendSystemMessage(`Socket error: ${error.message}`);
    });
  }

  function stopWatchThread() {
    if (state.watchTimer) {
      window.clearInterval(state.watchTimer);
      state.watchTimer = null;
    }
    state.watchThreadId = null;
    state.watchThread = null;
  }

  function setWatchedHeader(thread) {
    els.activeTitle.textContent = thread.title || `Thread ${thread.id.slice(0, 8)}`;
    setStatusPill('watching');
    els.activeSubtitle.textContent = `${compactPath(thread.cwd || '')} · watch log · Send resumes in browser`;
    els.composerInput.placeholder = 'Watch 模式：输入后会启动可操作的 resume 会话并发送';
    setLiveIndicator('Watching', true);
  }

  function renderThreadLog(payload) {
    const thread = payload.thread || {};
    const events = Array.isArray(payload.events) ? payload.events : [];
    if (thread.id) state.watchThread = thread;
    const wasNearBottom = els.stream.scrollHeight - els.stream.scrollTop - els.stream.clientHeight < 80;
    const previousScrollTop = els.stream.scrollTop;
    state.streamGeneration += 1;
    state.liveMessageBody = null;
    state.pendingStreamText = '';
    state.streamFlushScheduled = false;
    state.suppressAutoScroll = true;
    els.stream.innerHTML = '';
    if (state.watchOnly) setWatchedHeader(thread);
    if (!events.length) {
      appendSystemMessage('No visible log events yet.');
      state.suppressAutoScroll = false;
      return;
    }
    for (const event of events) {
      addMessage(event.kind || 'system', event.title || 'Event', event.body || '', {
        commands: event.commands || [],
        messageKey: event.id || `${event.kind || 'event'}:${event.at || ''}:${event.title || ''}`,
        at: event.at
      });
    }
    state.suppressAutoScroll = false;
    els.stream.scrollTop = wasNearBottom ? els.stream.scrollHeight : previousScrollTop;
    const stamp = payload.log?.mtimeMs
      ? new Date(payload.log.mtimeMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLiveIndicator(`${state.watchOnly ? 'Log' : 'Synced'} ${stamp}`, false);
  }

  async function loadThreadLog(threadId) {
    const payload = await api(`/api/threads/${encodeURIComponent(threadId)}/log?limit=80`);
    if (state.watchThreadId !== threadId) return;
    renderThreadLog(payload);
  }

  function watchThread(thread) {
    if (state.socket) {
      state.socket.disconnect();
      state.socket = null;
    }
    state.activeSessionId = null;
    state.rawTerminalInputArmed = false;
    state.watchOnly = true;
    stopWatchThread();
    state.watchThreadId = thread.id;
    state.watchThread = thread;
    setView('page');
    if (window.matchMedia('(max-width: 920px)').matches) setControlsCollapsed(true);
    els.stream.innerHTML = '';
    appendSystemMessage('Opening live Codex log. Type below to start a browser-controlled resume for this thread.');
    loadThreadLog(thread.id).catch((error) => appendSystemMessage(`Watch failed: ${error.message}`));
    state.watchTimer = window.setInterval(() => {
      loadThreadLog(thread.id).catch(() => {});
    }, 2500);
  }

  async function signalSession(sessionId, signal) {
    await api(`/api/sessions/${sessionId}/signal`, {
      method: 'POST',
      body: JSON.stringify({ signal })
    });
    await refresh();
  }

  async function signalProcess(pid, signal) {
    await api(`/api/processes/${pid}/signal`, {
      method: 'POST',
      body: JSON.stringify({ signal })
    });
    await refresh();
  }

  async function resumeProcess(proc) {
    if (!proc.threadId) return;
    if (proc.managedSessionId) {
      attachSession(proc.managedSessionId);
      return;
    }
    return forceResumeProcess(proc);
  }

  async function forceResumeProcess(proc) {
    if (!proc.threadId) return;
    const payload = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: `resume-${proc.threadId.slice(0, 8)}`,
        cwd: proc.cwd || state.config?.defaultCwd,
        mode: 'resume-thread',
        threadId: proc.threadId,
        search: proc.command.includes('--search'),
        noAltScreen: true,
        bypassSandbox: proc.command.includes('--dangerously-bypass-approvals-and-sandbox'),
        fullAuto: proc.command.includes('--full-auto'),
        cols: term.cols,
        rows: term.rows
      })
    });
    await refresh();
    appendSystemMessage(`Started browser-controlled resume for thread ${proc.threadId.slice(0, 8)}. The external terminal remains separate.`);
    attachSession(payload.session.id);
  }

  async function startControlForThread(thread, initialPrompt = '') {
    const managed = managedSessionForThread(thread.id);
    if (managed) {
      setView('page');
      if (window.matchMedia('(max-width: 920px)').matches) setControlsCollapsed(true);
      state.pendingAttachInput = initialPrompt;
      attachSession(managed.id);
      return;
    }

    const external = externalProcessForThread(thread.id);
    if (external) {
      appendSystemMessage(`Starting a browser-controlled resume for thread ${thread.id.slice(0, 8)}. The external pid ${external.pid} remains a separate terminal session.`);
    } else {
      appendSystemMessage(`Starting a browser-controlled resume for thread ${thread.id.slice(0, 8)}.`);
    }

    const payload = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: `thread-${thread.id.slice(0, 8)}`,
        cwd: thread.cwd || state.config?.defaultCwd,
        mode: 'resume-thread',
        threadId: thread.id,
        prompt: initialPrompt,
        noAltScreen: true,
        bypassSandbox: String(thread.sandboxPolicy || '').includes('danger-full-access'),
        cols: term.cols,
        rows: term.rows
      })
    });
    await refresh();
    setView('page');
    if (window.matchMedia('(max-width: 920px)').matches) setControlsCollapsed(true);
    attachSession(payload.session.id);
  }

  async function resumeThread(thread) {
    return startControlForThread(thread, '');
  }

  async function resumePickerForProcess(proc) {
    const payload = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: `picker-${proc.pid}`,
        cwd: proc.cwd || state.config?.defaultCwd,
        mode: 'resume-picker',
        noAltScreen: true,
        bypassSandbox: proc.command.includes('--dangerously-bypass-approvals-and-sandbox'),
        fullAuto: proc.command.includes('--full-auto'),
        cols: term.cols,
        rows: term.rows
      })
    });
    await refresh();
    setView('terminal');
    attachSession(payload.session.id);
  }

  function showThreadsForProcess(proc) {
    setControlsCollapsed(false);
    const hint = proc.cwd ? `Select a recent thread for ${proc.cwd}` : 'Select a recent thread';
    appendSystemMessage(hint);
    requestAnimationFrame(() => els.threads.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }

  term.onData((data) => {
    if (state.rawTerminalInputArmed) sendTerminalInput(data);
  });

  els.form.addEventListener('submit', (event) => {
    createSession(event).catch((error) => alert(error.message));
  });

  els.refresh.addEventListener('click', () => refresh().catch((error) => alert(error.message)));
  els.openSessions.onclick = (event) => {
    event.preventDefault();
    openSessionSheet();
  };
  els.openSessions.addEventListener('pointerup', (event) => {
    event.preventDefault();
    openSessionSheet();
  }, { passive: false });
  els.closeSessionSheet.addEventListener('click', closeSessionSheet);
  els.sessionSheet.addEventListener('click', (event) => {
    if (event.target === els.sessionSheet) closeSessionSheet();
  });
  els.toggleSidebar.addEventListener('click', () => setControlsCollapsed(!els.sidebar.classList.contains('collapsed')));
  els.viewPage.addEventListener('click', () => setView('page'));
  els.viewTerminal.addEventListener('click', () => setView('terminal'));
  els.terminal.addEventListener('pointerdown', () => {
    if (state.view === 'terminal' && state.activeSessionId) armRawTerminalInput();
  });
  els.ctrlC.addEventListener('click', () => sendTerminalInput('\x03'));
  els.ctrlD.addEventListener('click', () => sendTerminalInput('\x04'));
  els.mobileKeys.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-key]');
    if (!button || !state.socket || !state.activeSessionId) return;
    event.preventDefault();
    const sequences = {
      up: '\x1b[A',
      down: '\x1b[B',
      right: '\x1b[C',
      left: '\x1b[D',
      enter: '\r',
      esc: '\x1b',
      tab: '\t'
    };
    const sequence = sequences[button.dataset.key];
    if (sequence) sendTerminalInput(sequence);
  });
  els.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = els.composerInput.value;
    if (!text) return;
    if (state.watchOnly) {
      els.composerInput.value = '';
      const thread = state.watchThread || state.threads.find((item) => item.id === state.watchThreadId);
      if (!thread) {
        appendSystemMessage('No watched thread is selected.');
        return;
      }
      startControlForThread(thread, text)
        .catch((error) => appendSystemMessage(`Resume failed: ${error.message}`));
      return;
    }
    if (!state.socket || !state.activeSessionId) return;
    appendUserMessage(text);
    state.liveMessageBody = null;
    sendTerminalInput(`${text}\n`);
    els.composerInput.value = '';
    els.composerInput.focus();
  });
  els.composerInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      els.composer.requestSubmit();
    }
  });
  els.terminate.addEventListener('click', () => {
    if (state.activeSessionId) signalSession(state.activeSessionId, 'SIGTERM').catch((error) => alert(error.message));
  });

  els.loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const username = els.usernameInput.value.trim();
    const password = els.passwordInput.value;
    const otp = els.otpInput.value.trim();
    const token = els.tokenInput.value.trim();

    if (username || password || otp) {
      api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password, otp })
      })
        .then(() => {
          state.token = '';
          localStorage.removeItem('codex-control-token');
          return connect();
        })
        .catch((error) => {
          els.loginError.textContent = error.message || 'Login failed';
        });
      return;
    }

    state.token = token;
    localStorage.setItem('codex-control-token', state.token);
    connect();
  });

  window.addEventListener('resize', fitTerminal);
  window.addEventListener('orientationchange', () => setTimeout(fitTerminal, 200));
  setInterval(() => {
    if (state.connected) refresh({ threads: false }).catch(() => {});
  }, 3000);

  setView(state.view);
  setControlsCollapsed(defaultControlsCollapsed());

  connect();
})();
