// Terminal host.
//
// Owns every PTY so the UI can be reloaded or the whole app relaunched without
// killing the shells (and whatever Claude session is running inside them).
// It is started by the Electron main process using Electron's own binary in
// Node mode, so the node-pty build made for Electron loads fine. It listens on
// a unix socket and speaks newline-delimited JSON.
//
//   client -> host: hello | create | write | resize | kill | meta | list | shutdown
//   host -> client: reply (to a reqId) | data | exit | process | cwd
//
// Output from each terminal is kept in a ring buffer so a reconnecting UI can
// replay the recent scrollback.
//
// The host also writes a snapshot of every terminal (cwd, name, order,
// scrollback, and the Claude Code session running in it) to disk. When the
// host itself goes away (reboot, logout, crash, or a restart after its code
// changed) the next host recreates the terminals from that snapshot and
// resumes each Claude session with `claude --resume`. Only an explicit
// "quit and close all terminals" discards the snapshot.
//
// Runtime files, all under ~/Library/Application Support/Agent Coding/:
//   pty-host.sock (the socket, passed in as argv[2]), pty-host.log (this
//   process's log, timestamped), pty-host-state/ (the snapshot).

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const pty = require('node-pty');

// The shells we spawn must not inherit this, or Electron-based CLIs launched
// from them (e.g. `code`) would misbehave.
delete process.env.ELECTRON_RUN_AS_NODE;

const SOCKET_PATH = process.argv[2];
if (!SOCKET_PATH) {
  console.error('usage: pty-host.js <socket path>');
  process.exit(2);
}
const LOG_PATH = SOCKET_PATH.replace(/\.sock$/, '') + '.log';
const STATE_DIR = SOCKET_PATH.replace(/\.sock$/, '') + '-state';
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const SCROLLBACK_LIMIT = 2 * 1024 * 1024; // characters kept per terminal
const SAVED_SCROLLBACK_LIMIT = 512 * 1024; // characters written to disk per terminal
const SCROLLBACK_SAVE_INTERVAL = 5000;
const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = crypto.createHash('sha1').update(fs.readFileSync(__filename)).digest('hex').slice(0, 12);
const STARTED_AT = Date.now();

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch (_) {}
}

// ---------- helpers (cwd / project name) ----------

function readProcessCwd(pid) {
  return new Promise((resolve) => {
    execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = stdout.split('\n').find((l) => l.startsWith('n/'));
      resolve(line ? line.slice(1) : null);
    });
  });
}

function findRepoRoot(cwd) {
  const home = os.homedir();
  let dir = cwd;
  while (dir && dir !== '/' && dir !== home) {
    try {
      fs.statSync(path.join(dir, '.git'));
      return dir;
    } catch (_) {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function projectNameFor(cwd) {
  const root = findRepoRoot(cwd);
  return path.basename(root || cwd) || cwd;
}

// node-pty reports the foreground program by its executable's file name. The
// `claude` command is a symlink to ~/.local/share/claude/versions/<version>, so
// it shows up as e.g. "2.1.318"; call it claude again.
const CLAUDE_VERSIONS_DIR = path.join(os.homedir(), '.local', 'share', 'claude', 'versions');
function foregroundName(name) {
  if (name && /^\d+\.\d+/.test(name) && fs.existsSync(path.join(CLAUDE_VERSIONS_DIR, name))) return 'claude';
  return name;
}

function isDirectory(p) {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

// Write a file atomically so a crash mid-write never leaves a torn snapshot.
function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// Last `limit` characters of `text`, cut at a line break so the result does not
// start in the middle of an escape sequence.
function tailAtLine(text, limit) {
  if (text.length <= limit) return text;
  const cut = text.slice(text.length - limit);
  const nl = cut.indexOf('\n');
  return nl === -1 || nl + 1 >= cut.length ? cut : cut.slice(nl + 1);
}

// ---------- Claude Code session detection ----------
//
// Claude Code writes ~/.claude/sessions/<pid>.json for every running
// interactive session, with the conversation's sessionId and cwd. To know which
// conversation runs in which terminal we look for a descendant of the
// terminal's shell that has such a file.

function readProcessTable() {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,ppid=,comm='], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      const procs = new Map(); // pid -> { ppid, comm }
      for (const line of stdout.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3] });
      }
      resolve(procs);
    });
  });
}

// Is the process actually Claude Code? Guards against a stale
// ~/.claude/sessions file whose pid has since been reused by something else.
function looksLikeClaude(procs, pid) {
  const p = procs.get(pid);
  if (!p) return false;
  const base = path.basename(p.comm.trim());
  return /claude/i.test(base) || (/^\d+\.\d+/.test(base) && fs.existsSync(path.join(CLAUDE_VERSIONS_DIR, base)));
}

function readClaudeSessions() {
  const byPid = new Map(); // pid -> { sessionId, cwd }
  let names;
  try {
    names = fs.readdirSync(CLAUDE_SESSIONS_DIR);
  } catch (_) {
    return byPid;
  }
  for (const name of names) {
    const m = name.match(/^(\d+)\.json$/);
    if (!m) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, name), 'utf8'));
      if (info && UUID_RE.test(info.sessionId || '') && info.kind !== 'background') {
        byPid.set(Number(m[1]), { sessionId: info.sessionId, cwd: info.cwd || null, pid: Number(m[1]) });
      }
    } catch (_) {}
  }
  return byPid;
}

// How many generations below `ancestor` the process `pid` is, or -1 if it is
// not a descendant at all.
function descendantDepth(procs, pid, ancestor) {
  let cur = pid;
  for (let depth = 0; depth < 12 && cur && cur !== 1; depth++) {
    if (cur === ancestor) return depth;
    const p = procs.get(cur);
    cur = p ? p.ppid : null;
  }
  return -1;
}

let claudeScanBusy = false;
async function scanClaudeSessions() {
  if (claudeScanBusy || sessions.size === 0) return;
  claudeScanBusy = true;
  try {
    const claudes = readClaudeSessions();
    const procs = claudes.size ? await readProcessTable() : null;
    for (const s of sessions.values()) {
      // The claude nearest to the shell is the one the user is talking to;
      // anything deeper is a subprocess it spawned.
      let found = null;
      let foundDepth = Infinity;
      if (procs) {
        for (const c of claudes.values()) {
          if (!looksLikeClaude(procs, c.pid)) continue;
          const depth = descendantDepth(procs, c.pid, s.pty.pid);
          if (depth > 0 && depth < foundDepth) {
            found = { sessionId: c.sessionId, cwd: c.cwd };
            foundDepth = depth;
          }
        }
      }
      const before = s.claude ? s.claude.sessionId : null;
      const after = found ? found.sessionId : null;
      if (before !== after) {
        s.claude = found;
        log(`terminal ${s.id}: claude session ${after || 'ended'}`);
        scheduleStateSave();
      }
    }
  } finally {
    claudeScanBusy = false;
  }
}

// ---------- persistence ----------

let stateSaveTimer = null;

function scrollbackFile(id) {
  return path.join(STATE_DIR, `scrollback-${id}.txt`);
}

function stateSnapshot() {
  return {
    savedAt: Date.now(),
    sessions: [...sessions.values()].map((s) => ({
      id: s.id,
      cwd: s.cwd,
      shell: s.shell,
      process: s.process,
      meta: s.meta,
      cols: s.pty.cols,
      rows: s.pty.rows,
      createdAt: s.createdAt,
      claude: s.claude || null,
    })),
  };
}

function saveState() {
  clearTimeout(stateSaveTimer);
  stateSaveTimer = null;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    writeFileAtomic(STATE_FILE, JSON.stringify(stateSnapshot()));
  } catch (err) {
    log('failed to save state:', err.message);
  }
}

function scheduleStateSave() {
  if (stateSaveTimer) return;
  stateSaveTimer = setTimeout(saveState, 500);
}

function saveScrollback(s) {
  if (!s.scrollbackDirty) return;
  s.scrollbackDirty = false;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    writeFileAtomic(scrollbackFile(s.id), tailAtLine(s.chunks.join(''), SAVED_SCROLLBACK_LIMIT));
  } catch (err) {
    log(`failed to save scrollback for ${s.id}:`, err.message);
  }
}

function saveAllScrollback() {
  for (const s of sessions.values()) saveScrollback(s);
}

function removeSavedScrollback(id) {
  try {
    fs.unlinkSync(scrollbackFile(id));
  } catch (_) {}
}

function discardState() {
  try {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
  } catch (_) {}
}

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return Array.isArray(state.sessions) ? state : null;
  } catch (_) {
    return null;
  }
}

// Recreate the terminals a previous host left behind.
function restoreState() {
  const state = loadState();
  if (!state || !state.sessions.length) return 0;
  const when = new Date(state.savedAt || Date.now());
  const stamp = when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const saved = state.sessions.filter((x) => Number.isFinite(x.id)).sort((a, b) => a.id - b.id);
  let restored = 0;
  for (const x of saved) {
    const claude = x.claude && UUID_RE.test(x.claude.sessionId || '') ? x.claude : null;
    const cwd = [claude && claude.cwd, x.cwd, os.homedir()].find(isDirectory) || os.homedir();
    let scrollback = '';
    try {
      scrollback = fs.readFileSync(scrollbackFile(x.id), 'utf8');
    } catch (_) {}
    removeSavedScrollback(x.id);

    const what = claude ? 'resuming Claude Code session' : x.process && x.process !== x.shell ? `"${x.process}" is not running anymore` : 'shell restarted';
    const banner =
      // Leave any modes a killed full-screen program left on (mouse, focus
      // reporting, bracketed paste, hidden cursor) and draw a separator.
      '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?25h\x1b[0m' +
      `\r\n\x1b[2m[restored from ${stamp} — ${what}]\x1b[0m\r\n`;

    try {
      createSession({
        id: x.id,
        cwd,
        cols: x.cols,
        rows: x.rows,
        meta: x.meta && typeof x.meta === 'object' ? x.meta : {},
        createdAt: x.createdAt,
        seedScrollback: scrollback + banner,
        resumeClaude: claude ? claude.sessionId : null,
      });
      restored++;
    } catch (err) {
      log(`failed to restore terminal ${x.id}:`, err.message);
    }
  }
  log(`restored ${restored} terminal(s) from snapshot saved ${when.toISOString()}`);
  saveState();
  return restored;
}

// Claude Code keeps transcripts in ~/.claude/projects/<cwd with every
// non-alphanumeric character replaced by "-">/<sessionId>.jsonl. A session that
// never got a message has no transcript and cannot be resumed.
function claudeTranscriptExists(cwd, sessionId) {
  const dir = path.join(os.homedir(), '.claude', 'projects', String(cwd || '').replace(/[^A-Za-z0-9]/g, '-'));
  return fs.existsSync(path.join(dir, `${sessionId}.jsonl`));
}

// Type `claude --resume <id>` (or plain `claude` when there is nothing to
// resume) into a freshly restored shell once it has drawn its prompt: first
// output, then a short quiet period.
function resumeClaudeIn(s, sessionId) {
  if (!UUID_RE.test(sessionId)) return;
  const command = claudeTranscriptExists(s.cwd, sessionId) ? `claude --resume ${sessionId}` : 'claude';
  let fired = false;
  let quiet = null;
  const fire = () => {
    if (fired || !sessions.has(s.id)) return;
    fired = true;
    clearTimeout(quiet);
    clearTimeout(fallback);
    s.onShellOutput = null;
    try {
      s.pty.write(`${command}\r`);
    } catch (_) {}
  };
  s.onShellOutput = () => {
    clearTimeout(quiet);
    quiet = setTimeout(fire, 400);
  };
  const fallback = setTimeout(fire, 4000);
}

// ---------- sessions ----------

const sessions = new Map();
const clients = new Set();
let nextId = 1;
let idleTimer = null;

function broadcast(msg) {
  const line = JSON.stringify(msg) + '\n';
  for (const c of clients) {
    try {
      c.write(line);
    } catch (_) {}
  }
}

function appendScrollback(s, data) {
  s.chunks.push(data);
  s.scrollbackLength += data.length;
  s.scrollbackDirty = true;
  if (s.scrollbackLength <= SCROLLBACK_LIMIT) return;
  // Drop whole chunks until we are comfortably under the limit...
  while (s.chunks.length > 1 && s.scrollbackLength > SCROLLBACK_LIMIT * 0.75) {
    s.scrollbackLength -= s.chunks.shift().length;
  }
  // ...then cut the oldest chunk at a line break so we don't start mid-escape-sequence.
  const first = s.chunks[0];
  const nl = first.indexOf('\n');
  if (nl !== -1 && nl + 1 < first.length) {
    s.chunks[0] = first.slice(nl + 1);
    s.scrollbackLength -= nl + 1;
  }
}

function sessionInfo(s) {
  return {
    id: s.id,
    cwd: s.cwd,
    project: projectNameFor(s.cwd),
    process: s.process,
    shell: s.shell,
    cols: s.pty.cols,
    rows: s.pty.rows,
    meta: s.meta,
    createdAt: s.createdAt,
  };
}

// If this app was launched from inside a Claude Code session (say, by a Claude
// "restart the app" command), it inherits that session's CLAUDECODE / CLAUDE_*
// variables. Any `claude` started in our terminals would then run as a child of
// that session and write no transcript of its own (and could not be resumed).
// Terminals must always get a clean environment.
function withoutClaudeSessionEnv(source) {
  const env = {};
  for (const [k, v] of Object.entries(source)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_')) continue;
    env[k] = v;
  }
  return env;
}

function createSession({ cwd, cols, rows, id: wantedId, meta, createdAt, seedScrollback, resumeClaude }) {
  // Restored terminals keep their old id so the UI's saved order still applies.
  const id = Number.isFinite(wantedId) && !sessions.has(wantedId) ? wantedId : nextId;
  nextId = Math.max(nextId, id + 1);
  const shellPath = process.env.SHELL || '/bin/zsh';
  const env = { ...withoutClaudeSessionEnv(process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8' };

  const proc = pty.spawn(shellPath, ['-l'], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd,
    env,
  });

  const s = {
    id,
    pty: proc,
    cwd,
    shell: path.basename(shellPath),
    process: '',
    meta: meta || {},
    chunks: [],
    scrollbackLength: 0,
    scrollbackDirty: false,
    cwdBusy: false,
    createdAt: createdAt || Date.now(),
    claude: null, // { sessionId, cwd } of the Claude Code conversation running here
    onShellOutput: null,
  };
  if (seedScrollback) appendScrollback(s, seedScrollback);
  sessions.set(id, s);
  clearTimeout(idleTimer);
  scheduleStateSave();

  proc.onData((data) => {
    appendScrollback(s, data);
    broadcast({ t: 'data', id, data });
    if (s.onShellOutput) s.onShellOutput();
  });
  proc.onExit(({ exitCode }) => {
    destroySession(s);
    broadcast({ t: 'exit', id, exitCode });
    maybeExitWhenIdle();
  });

  // Foreground process name, so the UI can show e.g. "claude".
  s.poll = setInterval(() => {
    try {
      const name = foregroundName(proc.process);
      if (name !== s.process) {
        s.process = name;
        broadcast({ t: 'process', id, name });
        scheduleStateSave();
        scanClaudeSessions();
      }
    } catch (_) {}
  }, 1000);

  // Shell working directory, so the UI can name the terminal after the project.
  s.cwdPoll = setInterval(async () => {
    if (s.cwdBusy || !sessions.has(id)) return;
    s.cwdBusy = true;
    try {
      const current = await readProcessCwd(proc.pid);
      if (current && current !== s.cwd && sessions.has(id)) {
        s.cwd = current;
        broadcast({ t: 'cwd', id, cwd: current, project: projectNameFor(current) });
        scheduleStateSave();
      }
    } finally {
      s.cwdBusy = false;
    }
  }, 2000);

  if (resumeClaude) resumeClaudeIn(s, resumeClaude);

  log(`created terminal ${id} pid=${proc.pid} cwd=${cwd}${resumeClaude ? ` resume=${resumeClaude}` : ''}`);
  return s;
}

function destroySession(s) {
  if (!sessions.has(s.id)) return;
  clearInterval(s.poll);
  clearInterval(s.cwdPoll);
  sessions.delete(s.id);
  removeSavedScrollback(s.id);
  scheduleStateSave();
}

function killSession(s) {
  destroySession(s);
  try {
    s.pty.kill();
  } catch (_) {}
  log(`killed terminal ${s.id}`);
}

// Change the PTY size. If the size is unchanged, bump it for a moment so the
// foreground program still gets a SIGWINCH and repaints (used after reattach).
function resizeSession(s, cols, rows, force) {
  if (!(cols > 0 && rows > 0)) return;
  try {
    if (s.pty.cols === cols && s.pty.rows === rows) {
      if (!force) return;
      s.pty.resize(cols, rows + 1);
      setTimeout(() => {
        try {
          if (sessions.has(s.id)) s.pty.resize(cols, rows);
        } catch (_) {}
      }, 60);
    } else {
      s.pty.resize(cols, rows);
    }
  } catch (_) {}
}

// Quit once nothing is left to host and nobody is connected.
function maybeExitWhenIdle() {
  clearTimeout(idleTimer);
  if (sessions.size === 0 && clients.size === 0) {
    idleTimer = setTimeout(() => {
      if (sessions.size === 0 && clients.size === 0) shutdown(0);
    }, 5000);
  }
}

// Stop the host. With keepState (the default: SIGTERM at logout/shutdown, a
// host restart after a code change) the snapshot stays so the next host can
// bring every terminal back; without it the terminals are gone for good.
function shutdown(code, { keepState = true } = {}) {
  log(`shutting down (${keepState ? 'keeping' : 'discarding'} snapshot)`);
  clearInterval(scrollbackTimer);
  clearInterval(claudeTimer);
  if (keepState) {
    saveAllScrollback();
    saveState();
  }
  for (const s of [...sessions.values()]) {
    clearInterval(s.poll);
    clearInterval(s.cwdPoll);
    try {
      s.pty.kill();
    } catch (_) {}
  }
  sessions.clear();
  if (!keepState) discardState();
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch (_) {}
  process.exit(code);
}

// ---------- socket server ----------

function handleMessage(client, msg) {
  const reply = (result) => client.write(JSON.stringify({ t: 'reply', reqId: msg.reqId, result }) + '\n');
  const s = msg.id != null ? sessions.get(msg.id) : null;

  switch (msg.t) {
    case 'hello':
      return reply({ version: VERSION, startedAt: STARTED_AT, pid: process.pid, sessions: sessions.size, restored: restoredCount });
    case 'list':
      return reply([...sessions.values()].map((x) => ({ ...sessionInfo(x), scrollback: x.chunks.join('') })));
    case 'create': {
      const created = createSession(msg);
      return reply(sessionInfo(created));
    }
    case 'write':
      if (s) s.pty.write(msg.data);
      return;
    case 'resize':
      if (s) resizeSession(s, msg.cols, msg.rows, msg.force);
      return;
    case 'kill':
      if (s) killSession(s);
      maybeExitWhenIdle();
      return;
    case 'meta':
      if (s) {
        s.meta = { ...s.meta, ...msg.meta };
        scheduleStateSave();
      }
      return;
    case 'shutdown':
      return shutdown(0, { keepState: !!msg.keepState });
    default:
      log('unknown message', msg.t);
  }
}

try {
  fs.unlinkSync(SOCKET_PATH);
} catch (_) {}

// Bring back whatever the previous host was running, then keep the snapshot
// fresh for the next one.
const restoredCount = restoreState();
const scrollbackTimer = setInterval(saveAllScrollback, SCROLLBACK_SAVE_INTERVAL);
const claudeTimer = setInterval(scanClaudeSessions, 3000);

const server = net.createServer((client) => {
  clients.add(client);
  clearTimeout(idleTimer);
  log(`client connected (${clients.size})`);
  let pending = '';
  client.on('data', (buf) => {
    pending += buf.toString('utf8');
    let nl;
    while ((nl = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (!line) continue;
      try {
        handleMessage(client, JSON.parse(line));
      } catch (err) {
        log('bad message:', err.message);
      }
    }
  });
  const gone = () => {
    if (!clients.has(client)) return;
    clients.delete(client);
    log(`client disconnected (${clients.size}); ${sessions.size} terminal(s) kept alive`);
    maybeExitWhenIdle();
  };
  client.on('close', gone);
  client.on('error', gone);
});

server.listen(SOCKET_PATH, () => {
  try {
    fs.chmodSync(SOCKET_PATH, 0o600);
  } catch (_) {}
  log(`listening on ${SOCKET_PATH} version=${VERSION} pid=${process.pid}`);
  maybeExitWhenIdle();
});

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('uncaughtException', (err) => log('uncaught:', err.stack || err.message));
