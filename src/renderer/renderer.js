/* global Terminal, FitAddon, WebLinksAddon */
// Agent Coding renderer: the page inside the Electron window (xterm.js
// terminals, sidebar, title bar). It talks to the main process only through
// window.api (src/preload.js). UI settings and drafts are kept in localStorage,
// which Electron stores under ~/Library/Application Support/Agent Coding/.
(() => {
  const api = window.api;

  const THEMES = {
    light: {
      background: '#ffffff',
      foreground: '#2b2b2b',
      cursor: '#2b2b2b',
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(74, 124, 247, 0.25)',
      black: '#000000',
      red: '#c91b00',
      green: '#00a600',
      yellow: '#b48b00',
      blue: '#2a5bd7',
      magenta: '#a627a4',
      cyan: '#0e7490',
      white: '#bfbfbf',
      brightBlack: '#666666',
      brightRed: '#e5473b',
      brightGreen: '#2bb84a',
      brightYellow: '#c9a000',
      brightBlue: '#4a7cf7',
      brightMagenta: '#c84fcd',
      brightCyan: '#1aa7bd',
      brightWhite: '#e5e5e5',
    },
    dark: {
      background: '#1e1e1e',
      foreground: '#d4d4d4',
      cursor: '#d4d4d4',
      cursorAccent: '#1e1e1e',
      selectionBackground: 'rgba(108, 156, 255, 0.3)',
      black: '#000000',
      red: '#f14c4c',
      green: '#23d18b',
      yellow: '#f5f543',
      blue: '#3b8eea',
      magenta: '#d670d6',
      cyan: '#29b8db',
      white: '#e5e5e5',
      brightBlack: '#666666',
      brightRed: '#f14c4c',
      brightGreen: '#23d18b',
      brightYellow: '#f5f543',
      brightBlue: '#3b8eea',
      brightMagenta: '#d670d6',
      brightCyan: '#29b8db',
      brightWhite: '#ffffff',
    },
  };

  const SHELL_NAMES = new Set(['zsh', 'bash', 'fish', 'sh', '-zsh', '-bash', 'login']);

  // ---------- State ----------

  const terminals = []; // ordered list of session objects
  let activeId = null;
  let fontSize = Number(localStorage.getItem('fontSize')) || 13;
  let defaultCwd = null;
  // Sidebar order: 'manual' (drag to reorder) or 'attention' (needs-you first).
  let sortMode = localStorage.getItem('sortMode') === 'attention' ? 'attention' : 'manual';

  const $ = (sel) => document.querySelector(sel);
  const sidebar = $('#sidebar');
  const list = $('#terminal-list');
  const container = $('#terminals');
  const emptyState = $('#empty-state');
  const titleName = $('#title-name');
  const titleCwd = $('#title-cwd');

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const currentTheme = () => (darkQuery.matches ? THEMES.dark : THEMES.light);

  const home = () => defaultCwd ? defaultCwd.replace(/\/Documents\/agent-coding$/, '') : null;
  function prettyPath(p) {
    const h = home();
    if (h && p.startsWith(h)) return '~' + p.slice(h.length);
    return p;
  }

  function uniqueName(base, except = null) {
    const taken = new Set(terminals.filter((t) => t !== except).map((t) => t.name));
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  const byId = (id) => terminals.find((t) => t.id === id);

  // ---------- Attention (the notification dot) ----------
  //
  // A terminal asks for attention when something happens that the user has not
  // seen. "Seen" means the terminal is the active one, the window has focus, and
  // its viewport is scrolled to the end of the output. The dot stays until all
  // three hold, so clicking a terminal and then reading down to the bottom is
  // what clears it, not the click alone.
  //
  // Going quiet only earns a dot if the screen now shows something different
  // from what the user last saw (s.seenScreen, the screen's text as of the
  // last moment it was read). Output the user watched arrive, followed by
  // silence after they switched away, is not news. Nor are repaints that leave
  // the text as it was, such as the one programs with focus reporting make
  // when the terminal loses focus; output during a window after such a known
  // repaint trigger is ignored outright and counted as seen
  // (s.ignoreOutputUntil).
  //
  // Claude Code also redraws the chrome at the bottom of its screen on its
  // own schedule: the status row above the input box gains and loses notices
  // (update results, the effort level), the box shows a suggested follow-up a
  // few seconds after a reply, and the footer's key hints come and go. None
  // of that is the conversation moving, so the comparison leaves the chrome
  // out and looks only at the transcript above it.

  const atBottom = (s) => {
    const b = s.term.buffer.active;
    return b.viewportY >= b.baseY;
  };
  const isRead = (s) => s.id === activeId && document.hasFocus() && atBottom(s);

  // The text on screen, row by row. Claude Code repaints in place rather than
  // scrolling, so this (not the scrollback length) is what tells output that
  // changed something from output that merely redrew it.
  function screenText(s) {
    const b = s.term.buffer.active;
    const rows = [];
    for (let r = 0; r < s.term.rows; r++) {
      const line = b.getLine(b.baseY + r);
      rows.push(line ? line.translateToString(true).trimEnd() : '');
    }
    return rows;
  }

  // Claude Code's input box is drawn between two full-width rules near the
  // bottom of the screen, with a status row above it and a footer below.
  // Returns the index of the first of those chrome rows, or the row count
  // when the screen has no such box (a shell, another program, a dialog).
  const isRule = (row) => row.length >= 20 && (row.match(/─/g) || []).length >= row.length * 0.8;
  function chromeTop(rows) {
    const n = rows.length;
    let bottom = -1;
    for (let r = n - 1; r >= Math.max(0, n - 8); r--) {
      if (isRule(rows[r])) {
        bottom = r;
        break;
      }
    }
    if (bottom < 0) return n;
    for (let r = bottom - 1; r >= Math.max(0, bottom - 12); r--) {
      if (isRule(rows[r])) return Math.max(0, r - 1);
    }
    return n;
  }

  // Did the transcript change since the user last read this terminal? The
  // chrome is taken from whichever screen has less of it, so a dialog that
  // replaces the input box (which also draws rules) still counts as news.
  function screenChanged(s) {
    if (s.seenScreen === null) return true;
    const now = screenText(s);
    const top = Math.max(chromeTop(s.seenScreen), chromeTop(now));
    for (let r = 0; r < top; r++) {
      if ((now[r] || '') !== (s.seenScreen[r] || '')) return true;
    }
    return false;
  }

  function markAttention(s) {
    if (!isRead(s)) s.attention = true;
  }

  function clearIfRead(s) {
    if (!s || !isRead(s)) return;
    s.seenScreen = screenText(s);
    if (!s.attention) return;
    s.attention = false;
    renderItem(s);
  }

  // Some output was drawn: if the user is looking, that is what they have now
  // seen; if it is a repaint we chose to ignore, count it as seen as well.
  function noteDrawn(s) {
    if (isRead(s)) clearIfRead(s);
    else if (Date.now() < s.ignoreOutputUntil) s.seenScreen = screenText(s);
  }

  window.addEventListener('focus', () => clearIfRead(byId(activeId)));
  // Losing window focus makes the active terminal's program repaint (see
  // activate); that repaint is not something new to read.
  window.addEventListener('blur', () => {
    const s = byId(activeId);
    if (s) s.ignoreOutputUntil = Date.now() + 600;
  });

  // ---------- Project emojis ----------
  //
  // Every project gets an emoji so terminals are easy to tell apart at a
  // glance. The emoji is chosen to fit the project: the first time a project
  // is seen, the main process asks Claude for one that matches the
  // directory's README, manifest and files. Until that answer arrives (and
  // for good if it never does) a placeholder from a fixed list is shown,
  // picked by hashing the name so it is at least stable within a session.
  // Only Claude's picks are remembered, so a project stuck with a placeholder
  // is asked about again on the next launch. No two projects share an emoji
  // while there are emojis left.

  const PLACEHOLDER_EMOJIS = [
    '🍎', '🍊', '🍋', '🍉', '🍇', '🍓', '🥝', '🥑', '🌽', '🥕', '🍄', '🌵',
    '🌲', '🌻', '🌸', '🍀', '🐙', '🐸', '🦊', '🐼', '🦋', '🐝', '🐢', '🦀',
    '🐳', '🦉', '🐧', '🦄', '🚀', '🛸', '🎈', '🎯', '🎲', '🎸', '🎨', '🧩',
    '🔮', '💎', '🔑', '🧭', '⚓', '🪁', '🏀', '⚽', '🎪', '🧲', '🔔', '🪐',
    '🌈', '⭐', '🔥', '🌊', '🧊', '🍩', '🧁', '🥨', '🍕', '🎁', '📦', '🧸',
  ];
  let emojiMap = {}; // project -> emoji chosen by Claude, persisted
  try {
    emojiMap = JSON.parse(localStorage.getItem('projectEmojiPicks') || '{}') || {};
  } catch (_) {}
  const placeholderEmojis = new Map(); // project -> placeholder, this session only
  const emojiAsked = new Set(); // projects Claude has been asked about this session
  let emojiQueue = Promise.resolve(); // one request at a time, so "taken" lists stay accurate

  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return h >>> 0;
  }

  const takenEmojis = () => new Set([...Object.values(emojiMap), ...placeholderEmojis.values()]);

  function placeholderFor(project) {
    if (placeholderEmojis.has(project)) return placeholderEmojis.get(project);
    const taken = takenEmojis();
    let i = hashString(project) % PLACEHOLDER_EMOJIS.length;
    for (let n = 0; n < PLACEHOLDER_EMOJIS.length && taken.has(PLACEHOLDER_EMOJIS[i]); n++) i = (i + 1) % PLACEHOLDER_EMOJIS.length;
    placeholderEmojis.set(project, PLACEHOLDER_EMOJIS[i]);
    return PLACEHOLDER_EMOJIS[i];
  }

  function requestEmoji(project, cwd) {
    if (!cwd || emojiAsked.has(project)) return;
    emojiAsked.add(project);
    emojiQueue = emojiQueue
      .then(async () => {
        if (emojiMap[project]) return;
        const taken = takenEmojis();
        taken.delete(placeholderEmojis.get(project));
        const emoji = await api.suggestEmoji({ cwd, project, taken: [...taken] });
        if (!emoji || taken.has(emoji)) return; // keep the placeholder; try again next launch
        emojiMap[project] = emoji;
        placeholderEmojis.delete(project);
        try {
          localStorage.setItem('projectEmojiPicks', JSON.stringify(emojiMap));
        } catch (_) {}
        for (const s of terminals) {
          if (projectKey(s) === project) renderItem(s);
        }
        updateTitle();
      })
      .catch(() => {});
  }

  const projectKey = (s) => s.project || s.name;

  function emojiFor(s) {
    const project = projectKey(s);
    if (!project) return '';
    if (emojiMap[project]) return emojiMap[project];
    requestEmoji(project, s.cwd);
    return placeholderFor(project);
  }

  const displayName = (s) => `${emojiFor(s)} ${s.name}`.trim();

  // ---------- Ordering ----------

  // Rank for "attention first": terminals that want you, then working ones,
  // then idle shells. Ties keep the manual order.
  function attentionRank(s) {
    if (s.exited) return 4;
    if (s.attention) return 0;
    if (s.state === 'waiting') return 1;
    if (s.state === 'running') return 2;
    return 3;
  }

  // The order the sidebar shows (and that ⌘1…9 / next / previous follow).
  function displayOrder() {
    if (sortMode !== 'attention') return terminals.slice();
    return terminals
      .map((t, i) => [t, i])
      .sort((a, b) => attentionRank(a[0]) - attentionRank(b[0]) || a[1] - b[1])
      .map(([t]) => t);
  }

  // Re-append the <li>s in display order (cheap; the DOM only moves what changed).
  function layoutList() {
    const ordered = displayOrder();
    ordered.forEach((t, i) => {
      if (!t.li) return;
      if (list.children[i] !== t.li) list.insertBefore(t.li, list.children[i] || null);
      t.li.draggable = sortMode === 'manual';
    });
  }

  function saveManualOrder() {
    terminals.forEach((t, i) => api.setPtyMeta(t.id, { order: i }));
  }

  function moveTerminal(s, beforeTarget) {
    const from = terminals.indexOf(s);
    if (from === -1) return;
    terminals.splice(from, 1);
    const to = beforeTarget ? terminals.indexOf(beforeTarget) : terminals.length;
    terminals.splice(to, 0, s);
    saveManualOrder();
    layoutList();
  }

  function setSortMode(mode) {
    sortMode = mode;
    localStorage.setItem('sortMode', mode);
    const btn = $('#sort-toggle');
    btn.textContent = mode === 'attention' ? 'attention first' : 'manual';
    btn.classList.toggle('attention-first', mode === 'attention');
    btn.title =
      mode === 'attention'
        ? 'Sort: terminals that need attention on top. Click for manual order (drag to reorder).'
        : 'Sort: manual order (drag to reorder). Click to put terminals that need attention on top.';
    layoutList();
  }

  // ---------- Terminal creation ----------

  async function createTerminal(cwd) {
    const probe = makeTerm();
    const info = await api.createPty({ cwd, cols: probe.term.cols, rows: probe.term.rows });
    const session = openSession(info, probe);
    activate(session.id);
    return session;
  }

  // Build an xterm instance in a fresh (temporarily visible) container so the
  // fit addon can measure it.
  function makeTerm() {
    const el = document.createElement('div');
    el.className = 'term-container';
    container.appendChild(el);

    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
      fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      macOptionIsMeta: true,
      allowProposedApi: true,
      theme: currentTheme(),
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => api.openExternal(uri)));

    // Temporarily show so fit can measure, then hide if not active.
    el.classList.add('visible');
    term.open(el);
    fit.fit();
    return { term, fit, el };
  }

  // Wire up the UI for a terminal that exists in the host: either one we just
  // created, or one we are reattaching to after a reload / relaunch.
  function openSession(info, { term, fit, el }, scrollback = '') {
    const { id, cwd: realCwd, shell, project, meta = {} } = info;
    const renamed = !!meta.renamed;

    const session = {
      id,
      name: renamed && meta.name ? uniqueName(meta.name) : uniqueName(project || realCwd.split('/').filter(Boolean).pop() || realCwd),
      renamed, // true once the user picks a name by hand; auto-naming then stops
      project: project || null, // repo / folder name, which also picks the emoji
      cwd: realCwd,
      process: info.process || shell,
      term,
      fit,
      el,
      li: null,
      exited: false,
      // Activity state shown in the sidebar:
      //   idle    – a shell sitting at its prompt
      //   running – a program is producing output
      //   waiting – a program went quiet (or rang the bell): it wants input
      state: 'idle',
      attention: false, // state changed while this terminal was in the background
      seenScreen: null, // screen text as of the last time the user read this terminal
      settleTimer: null,
      ignoreOutputUntil: 0,
    };
    terminals.push(session);

    term.onData((data) => api.writePty(id, data));
    term.onBinary((data) => api.writePty(id, data));
    term.onResize(({ cols, rows }) => api.resizePty(id, cols, rows));
    // Claude Code rings the bell when it finishes and wants you back.
    term.onBell(() => {
      setState(session, 'waiting');
      markAttention(session);
      renderItem(session);
    });
    // Scrolling to the end of the output counts as having read it.
    term.onScroll(() => clearIfRead(session));
    term.onTitleChange((title) => {
      // Shells / programs that set the window title (e.g. "claude") show it as subtitle.
      if (title && title.trim()) {
        session.title = title.trim();
        renderItem(session);
      }
    });

    term.attachCustomKeyEventHandler((e) => {
      // Keep ⌘-shortcuts out of the terminal; the app menu handles them.
      if (e.metaKey && !e.ctrlKey && !e.altKey) return false;
      // Shift+Enter inserts a newline instead of submitting. xterm.js would
      // send a plain carriage return, indistinguishable from Enter, so send a
      // line feed instead (what Ctrl+J sends): Claude Code's input box treats
      // it as a newline, and a shell at its prompt treats it like Enter.
      if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.type === 'keydown') api.writePty(id, '\n');
        return false;
      }
      return true;
    });

    session.li = buildItem(session);
    list.appendChild(session.li);
    layoutList();
    if (!scrollback) api.setPtyMeta(id, { order: terminals.length - 1 });

    if (scrollback) {
      // Replay what the host buffered, then poke the foreground program so a
      // full-screen app (like Claude Code) repaints itself for the new size.
      term.write(scrollback, () => {
        try {
          fit.fit();
        } catch (_) {}
        api.resizePty(id, term.cols, term.rows, true);
        term.scrollToBottom();
        // What was restored counts as seen, and so does the repaint the poke
        // above is about to cause.
        session.seenScreen = screenText(session);
        session.ignoreOutputUntil = Date.now() + 1500;
      });
    }
    return session;
  }

  // Reconnect to the terminals the host kept alive across a reload / relaunch.
  async function attachExisting() {
    const existing = await api.listPtys();
    if (!existing || !existing.length) return false;
    const orderOf = (x) => (x.meta && Number.isFinite(x.meta.order) ? x.meta.order : Number.MAX_SAFE_INTEGER);
    existing.sort((a, b) => orderOf(a) - orderOf(b) || a.id - b.id);
    for (const info of existing) {
      const parts = makeTerm();
      openSession(info, parts, info.scrollback || '');
    }
    const remembered = Number(sessionStorage.getItem('activeId'));
    const target = byId(remembered) || terminals[0];
    activate(target.id);
    return true;
  }

  // ---------- Sidebar items ----------

  let dragging = null; // session being dragged for reordering
  const clearDropMarkers = () => list.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));

  function buildItem(s) {
    const li = document.createElement('li');
    li.dataset.id = s.id;

    const dot = document.createElement('span');
    dot.className = 'status';
    dot.title = '';

    const label = document.createElement('div');
    label.className = 'label';
    const name = document.createElement('div');
    name.className = 'name';
    const emoji = document.createElement('span');
    emoji.className = 'emoji';
    const nameText = document.createElement('span');
    nameText.className = 'name-text';
    name.append(emoji, nameText);
    const sub = document.createElement('div');
    sub.className = 'sub';
    label.append(name, sub);

    const close = document.createElement('button');
    close.className = 'close';
    close.title = 'Close terminal (⌘W)';
    close.textContent = '×';

    li.append(dot, label, close);

    li.addEventListener('click', (e) => {
      if (e.target === close) return;
      activate(s.id);
    });
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(s);
    });
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTerminal(s.id);
    });

    // Manual reordering by dragging items.
    li.draggable = sortMode === 'manual';
    li.addEventListener('dragstart', (e) => {
      if (sortMode !== 'manual') return e.preventDefault();
      dragging = s;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/x-terminal-id', String(s.id));
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      dragging = null;
      li.classList.remove('dragging');
      clearDropMarkers();
    });
    li.addEventListener('dragover', (e) => {
      if (!dragging || dragging === s) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = li.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      clearDropMarkers();
      li.classList.add(before ? 'drop-before' : 'drop-after');
    });
    li.addEventListener('drop', (e) => {
      if (!dragging || dragging === s) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      const moved = dragging;
      const target = before ? s : terminals[terminals.indexOf(s) + 1] || null;
      clearDropMarkers();
      moveTerminal(moved, target);
    });

    s.nameEl = nameText;
    s.emojiEl = emoji;
    s.subEl = sub;
    s.statusEl = dot;
    renderItem(s, li);
    return li;
  }

  function renderItem(s, li = s.li) {
    if (!li) return;
    s.emojiEl.textContent = emojiFor(s);
    s.nameEl.textContent = s.name;
    const proc = s.process || '';
    let sub;
    if (s.exited) sub = 'exited';
    else if (proc && !SHELL_NAMES.has(proc)) {
      sub = s.title && s.title !== proc ? `${proc} · ${s.title}` : proc;
      if (s.state === 'waiting') sub += ' · waiting for you';
      else if (s.state === 'running') sub += ' · working';
    } else sub = prettyPath(s.cwd);
    s.subEl.textContent = sub;
    li.classList.toggle('active', s.id === activeId);
    li.classList.toggle('attention', !!s.attention);
    li.classList.toggle('exited', s.exited);
    for (const st of ['idle', 'running', 'waiting']) li.classList.toggle(`state-${st}`, s.state === st);
    if (sortMode === 'attention') layoutList();
    s.statusEl.title = s.exited ? 'Exited' : s.state === 'running' ? 'Working' : s.attention ? 'Waiting for you: unread output' : '';
  }

  // A rename in progress is a draft: it is saved to localStorage on every
  // keystroke, keyed by terminal, and comes back if the UI reloads mid-edit.
  // It is cleared only when the rename is committed or deliberately escaped.
  const renameDraftKey = (s) => `renameDraft:${s.id}`;
  const readRenameDraft = (s) => {
    try {
      return localStorage.getItem(renameDraftKey(s));
    } catch (_) {
      return null;
    }
  };
  const writeRenameDraft = (s, v) => {
    try {
      if (v === null) localStorage.removeItem(renameDraftKey(s));
      else localStorage.setItem(renameDraftKey(s), v);
    } catch (_) {}
  };

  function startRename(s) {
    if (!s.nameEl || s.nameEl.querySelector('input')) return;
    const input = document.createElement('input');
    input.className = 'name-input';
    const draft = readRenameDraft(s);
    input.value = draft !== null ? draft : s.name;
    s.nameEl.textContent = '';
    s.nameEl.appendChild(input);
    input.focus();
    input.select();
    input.addEventListener('input', () => writeRenameDraft(s, input.value));

    const finish = (commit) => {
      if (!input.isConnected) return;
      const v = input.value.trim();
      if (commit && v && v !== s.name) {
        s.name = v;
        s.renamed = true;
        api.setPtyMeta(s.id, { name: v, renamed: true });
      }
      writeRenameDraft(s, null);
      input.remove();
      renderItem(s);
      updateTitle();
      focusActive();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
  }

  // ---------- Activation / layout ----------

  function activate(id) {
    const s = byId(id);
    if (!s) return;
    const previous = byId(activeId);
    if (previous && previous !== s) {
      // Programs with focus reporting on (Claude Code does this) repaint a few
      // bytes when the terminal loses focus. That is not real activity.
      previous.ignoreOutputUntil = Date.now() + 600;
    }
    activeId = id;
    try {
      sessionStorage.setItem('activeId', String(id));
    } catch (_) {}
    for (const t of terminals) {
      t.el.classList.toggle('visible', t.id === id);
    }
    for (const t of terminals) renderItem(t);
    updateTitle();
    requestAnimationFrame(() => {
      fitActive();
      s.term.focus();
      clearIfRead(s); // already at the end: nothing left to read
    });
  }

  function fitActive() {
    const s = byId(activeId);
    if (!s) return;
    try {
      s.fit.fit();
    } catch (_) {}
  }

  function focusActive() {
    const s = byId(activeId);
    if (s) s.term.focus();
  }

  function updateTitle() {
    const s = byId(activeId);
    emptyState.classList.toggle('visible', terminals.length === 0);
    if (!s) {
      titleName.textContent = '';
      titleCwd.textContent = '';
      document.title = 'Agent Coding';
      return;
    }
    titleName.textContent = displayName(s);
    titleCwd.textContent = prettyPath(s.cwd);
    document.title = `${displayName(s)} — Agent Coding`;
  }

  new ResizeObserver(() => fitActive()).observe(container);

  // ---------- Closing ----------

  async function closeTerminal(id) {
    const s = byId(id);
    if (!s) return;
    const running = s.process && !SHELL_NAMES.has(s.process) && !s.exited;
    if (running) {
      const ok = await api.confirm(
        `Close "${s.name}"?`,
        `"${s.process}" is still running in this terminal and will be terminated.`
      );
      if (!ok) {
        focusActive();
        return;
      }
    }
    removeSession(s, true);
  }

  function removeSession(s, kill) {
    const idx = terminals.indexOf(s);
    if (idx === -1) return;
    if (kill) api.killPty(s.id);
    clearTimeout(s.settleTimer);
    terminals.splice(idx, 1);
    s.term.dispose();
    s.el.remove();
    s.li.remove();
    if (activeId === s.id) {
      const next = terminals[Math.min(idx, terminals.length - 1)];
      activeId = null;
      if (next) activate(next.id);
      else updateTitle();
    }
  }

  // ---------- PTY events ----------

  const QUIET_MS = 1500; // no output for this long = the program is waiting

  const isProgram = (s) => s.process && !SHELL_NAMES.has(s.process) && !s.exited;

  function setState(s, state) {
    if (s.state === state) return;
    s.state = state;
    renderItem(s);
  }

  function noteOutput(s) {
    if (Date.now() < s.ignoreOutputUntil) return;
    if (!isProgram(s)) {
      setState(s, 'idle');
      return;
    }
    setState(s, 'running');
    clearTimeout(s.settleTimer);
    s.settleTimer = setTimeout(() => {
      if (!isProgram(s)) return setState(s, 'idle');
      if (screenChanged(s)) markAttention(s);
      setState(s, 'waiting');
      renderItem(s);
    }, QUIET_MS);
  }

  api.onPtyData((id, data) => {
    const s = byId(id);
    if (!s) return;
    s.term.write(data, () => noteDrawn(s));
    noteOutput(s);
  });

  api.onPtyExit((id, code) => {
    const s = byId(id);
    if (!s) return;
    s.exited = true;
    clearTimeout(s.settleTimer);
    s.state = 'idle';
    s.term.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`);
    renderItem(s);
    // Close cleanly-exited shells automatically, like Terminal.app does.
    if (code === 0) setTimeout(() => removeSession(s, false), 300);
  });

  // The shell changed directory: follow it in the sidebar unless the user
  // renamed this terminal themselves.
  api.onPtyCwd((id, cwd, project) => {
    const s = byId(id);
    if (!s) return;
    s.cwd = cwd;
    if (project) s.project = project;
    if (!s.renamed && project) s.name = uniqueName(project, s);
    renderItem(s);
    if (id === activeId) updateTitle();
  });

  api.onPtyProcess((id, name) => {
    const s = byId(id);
    if (!s) return;
    const wasProgram = isProgram(s);
    s.process = name;
    if (SHELL_NAMES.has(name)) {
      s.title = null;
      clearTimeout(s.settleTimer);
      // A program just finished while you were not looking: worth a look.
      if (wasProgram) markAttention(s);
      s.state = 'idle';
    } else if (!wasProgram) {
      noteOutput(s); // a program just started
    }
    renderItem(s);
  });

  // ---------- Theme / font ----------

  function applyTheme() {
    const theme = currentTheme();
    for (const t of terminals) t.term.options.theme = theme;
  }
  darkQuery.addEventListener('change', applyTheme);
  api.onThemeChanged(() => setTimeout(applyTheme, 50));

  function setFontSize(delta) {
    fontSize = delta === 0 ? 13 : Math.min(28, Math.max(9, fontSize + delta));
    localStorage.setItem('fontSize', String(fontSize));
    for (const t of terminals) t.term.options.fontSize = fontSize;
    fitActive();
  }

  // ---------- Sidebar: toggle & resize ----------

  function setSidebarCollapsed(collapsed) {
    sidebar.style.setProperty('--sidebar-width', sidebar.offsetWidth + 'px');
    sidebar.classList.toggle('collapsed', collapsed);
    localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
    setTimeout(fitActive, 200);
  }
  $('#toggle-sidebar').addEventListener('click', () => {
    setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
    focusActive();
  });
  if (localStorage.getItem('sidebarCollapsed') === '1') {
    sidebar.style.transition = 'none';
    setSidebarCollapsed(true);
    requestAnimationFrame(() => (sidebar.style.transition = ''));
  }
  const savedWidth = Number(localStorage.getItem('sidebarWidth'));
  if (savedWidth) sidebar.style.width = savedWidth + 'px';

  (() => {
    const resizer = $('#sidebar-resizer');
    let startX = 0;
    let startW = 0;
    const onMove = (e) => {
      const w = Math.min(480, Math.max(160, startW + (e.clientX - startX)));
      sidebar.style.width = w + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      localStorage.setItem('sidebarWidth', String(sidebar.offsetWidth));
      focusActive();
    };
    resizer.addEventListener('mousedown', (e) => {
      startX = e.clientX;
      startW = sidebar.offsetWidth;
      document.body.style.cursor = 'col-resize';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  })();

  // ---------- Buttons & menu ----------

  async function newTerminalInFolder() {
    const folder = await api.pickFolder();
    if (folder) createTerminal(folder);
    else focusActive();
  }

  const newBtn = $('#new-terminal');
  newBtn.addEventListener('click', () => createTerminal(defaultCwd));
  newBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    newTerminalInFolder();
  });

  const step = (dir) => {
    if (terminals.length < 2) return;
    const order = displayOrder();
    const idx = order.findIndex((t) => t.id === activeId);
    const next = order[(idx + dir + order.length) % order.length];
    activate(next.id);
  };

  api.onMenu('new-terminal', () => createTerminal(defaultCwd));
  api.onMenu('new-terminal-in-folder', newTerminalInFolder);
  api.onMenu('close-terminal', () => activeId != null && closeTerminal(activeId));
  api.onMenu('rename-terminal', () => {
    const s = byId(activeId);
    if (s) startRename(s);
  });
  api.onMenu('reveal-folder', () => {
    const s = byId(activeId);
    if (s) api.revealPath(s.cwd);
  });
  api.onMenu('toggle-sidebar', () => setSidebarCollapsed(!sidebar.classList.contains('collapsed')));
  api.onMenu('next-terminal', () => step(1));
  api.onMenu('prev-terminal', () => step(-1));
  api.onMenu('select-index', (n) => {
    const order = displayOrder();
    const t = n === 9 ? order[order.length - 1] : order[n - 1];
    if (t) activate(t.id);
  });
  api.onMenu('toggle-sort', () => setSortMode(sortMode === 'attention' ? 'manual' : 'attention'));
  api.onMenu('font-size', (d) => setFontSize(d));
  api.onMenu('clear-terminal', () => {
    const s = byId(activeId);
    if (s) s.term.clear();
  });
  api.onMenu('copy', async () => {
    const s = byId(activeId);
    if (!s) return;
    const sel = s.term.getSelection();
    if (sel) {
      await navigator.clipboard.writeText(sel);
      s.term.clearSelection();
    } else {
      api.writePty(s.id, '\x03'); // no selection: behave like Ctrl+C
    }
  });
  api.onMenu('paste', () => {
    const s = byId(activeId);
    if (s) pasteClipboard(s);
  });
  api.onMenu('select-all', () => {
    const s = byId(activeId);
    if (s) s.term.selectAll();
  });

  // ---------- Images: paste & drag-and-drop ----------

  // Escape a path the way Terminal.app / iTerm do when you drop a file, which
  // is the form Claude Code expects when it looks for image paths in a prompt.
  const shellEscape = (p) => p.replace(/[^A-Za-z0-9_\-./~]/g, (c) => '\\' + c);

  function pastePaths(s, paths) {
    if (!paths.length) return;
    s.term.paste(paths.map(shellEscape).join(' ') + ' ');
    s.term.focus();
  }

  // Programs that read the clipboard themselves when they receive Ctrl+V.
  // Claude Code does this and turns a screenshot into a real image attachment.
  const readsClipboardOnCtrlV = (s) => /claude|node/i.test(s.process || '');

  async function pasteClipboard(s) {
    const { text, hasImage } = await api.readClipboard();
    if (text) {
      s.term.paste(text);
      return;
    }
    if (!hasImage) return;
    if (readsClipboardOnCtrlV(s)) {
      // Let Claude Code grab the image from the clipboard itself.
      api.writePty(s.id, '\x16');
      return;
    }
    // Plain shell: save the image and paste its path.
    const file = await api.saveClipboardImage();
    if (file) pastePaths(s, [file]);
  }

  async function filesToPaths(fileList) {
    const paths = [];
    for (const file of fileList) {
      const p = api.pathForFile(file);
      if (p) {
        paths.push(p);
        continue;
      }
      // No path on disk (e.g. an image dragged out of a browser): save it first.
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const saved = await api.saveTempFile(file.name || 'image.png', bytes);
        if (saved) paths.push(saved);
      } catch (_) {}
    }
    return paths;
  }

  (() => {
    const main = $('#main');
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

    main.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      main.classList.add('drop-target');
    });
    main.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    main.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) main.classList.remove('drop-target');
    });
    main.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      main.classList.remove('drop-target');
      const s = byId(activeId);
      if (!s) return;
      const paths = await filesToPaths(Array.from(e.dataTransfer.files));
      pastePaths(s, paths);
    });
  })();

  $('#sort-toggle').addEventListener('click', () => {
    setSortMode(sortMode === 'attention' ? 'manual' : 'attention');
    focusActive();
  });
  setSortMode(sortMode);

  // Clicking anywhere in the main pane refocuses the terminal.
  $('#main').addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    setTimeout(focusActive, 0);
  });

  // ---------- Boot ----------

  api.onHostDisconnected(() => {
    for (const t of terminals) t.term.write('\r\n\x1b[2m[terminal host disconnected]\x1b[0m\r\n');
  });
  api.onHostReconnected(() => location.reload());

  (async () => {
    defaultCwd = await api.defaultCwd();
    const attached = await attachExisting();
    if (!attached) await createTerminal(defaultCwd);
  })();
})();
