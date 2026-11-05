const { app, BrowserWindow, ipcMain, Menu, dialog, shell, nativeTheme, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const DEFAULT_CWD = path.join(os.homedir(), 'Documents', 'agent-coding');
const PTY_HOST_PATH = path.join(__dirname, 'pty-host.js');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function send(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

// ---------- Terminal host client ----------
//
// The PTYs live in a separate long-lived process (src/pty-host.js) so that
// reloading the UI or relaunching this app never kills a running shell. This
// class starts that process if needed and talks to it over a unix socket.

class PtyHost extends EventEmitter {
  constructor(socketPath) {
    super();
    this.socketPath = socketPath;
    this.socket = null;
    this.pending = new Map();
    this.nextReq = 1;
    this.buffer = '';
    this.info = null;
  }

  async connect() {
    try {
      await this._connectOnce();
    } catch (err) {
      // No host running (or a stale socket file): start one and wait for it.
      try {
        fs.unlinkSync(this.socketPath);
      } catch (_) {}
      this._spawnHost();
      const deadline = Date.now() + 8000;
      let lastErr = err;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          await this._connectOnce();
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (lastErr) throw lastErr;
    }
    this.info = await this.request({ t: 'hello' });
    return this.info;
  }

  _spawnHost() {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    const child = spawn(process.execPath, [PTY_HOST_PATH, this.socketPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
  }

  _connectOnce() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      const onError = (err) => {
        sock.destroy();
        reject(err);
      };
      sock.once('error', onError);
      sock.once('connect', () => {
        sock.removeListener('error', onError);
        this.socket = sock;
        sock.on('data', (buf) => this._onData(buf));
        const lost = () => {
          if (this.socket !== sock) return;
          this.socket = null;
          for (const p of this.pending.values()) p.reject(new Error('terminal host disconnected'));
          this.pending.clear();
          this.emit('disconnected');
        };
        sock.on('close', lost);
        sock.on('error', lost);
        resolve();
      });
    });
  }

  _onData(buf) {
    this.buffer += buf.toString('utf8');
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (msg.t === 'reply') {
        const p = this.pending.get(msg.reqId);
        if (p) {
          this.pending.delete(msg.reqId);
          p.resolve(msg.result);
        }
      } else {
        this.emit('event', msg);
      }
    }
  }

  send(msg) {
    if (this.socket) this.socket.write(JSON.stringify(msg) + '\n');
  }

  request(msg) {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('terminal host not connected'));
      const reqId = this.nextReq++;
      this.pending.set(reqId, { resolve, reject });
      this.send({ ...msg, reqId });
    });
  }

  // Hash of the pty-host.js on disk, to compare with what the running host loaded.
  static currentVersion() {
    return crypto.createHash('sha1').update(fs.readFileSync(PTY_HOST_PATH)).digest('hex').slice(0, 12);
  }
}

let host = null;

function resolveCwd(requested) {
  const candidates = [requested, DEFAULT_CWD, os.homedir()].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch (_) {}
  }
  return os.homedir();
}

async function connectHost() {
  host = new PtyHost(path.join(app.getPath('userData'), 'pty-host.sock'));
  host.on('event', (msg) => {
    switch (msg.t) {
      case 'data':
        return send('pty:data', msg.id, msg.data);
      case 'exit':
        return send('pty:exit', msg.id, msg.exitCode);
      case 'process':
        return send('pty:process', msg.id, msg.name);
      case 'cwd':
        return send('pty:cwd', msg.id, msg.cwd, msg.project);
    }
  });
  host.on('disconnected', () => {
    send('host:disconnected');
    // Try to come back (e.g. the host was restarted); the UI reattaches on reload.
    setTimeout(() => connectHost().then(() => send('host:reconnected')).catch(() => {}), 1000);
  });
  const info = await host.connect();
  if (info.sessions > 0 && info.version !== PtyHost.currentVersion()) {
    offerHostRestart();
  }
  return info;
}

async function offerHostRestart() {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['Keep Running', 'Restart Host'],
    defaultId: 0,
    cancelId: 0,
    message: 'The terminal host code has changed.',
    detail:
      'Your terminals are still running on the old version. Keep them running, or restart the host to pick up the change. Restarting recreates every terminal and resumes its Claude Code session, but any other program running in a terminal is stopped.',
  });
  if (response === 1) restartHost();
}

// Restart the host, keeping its snapshot so the new one recreates the terminals.
async function restartHost() {
  if (!host) return;
  host.removeAllListeners('disconnected');
  host.send({ t: 'shutdown', keepState: true });
  await new Promise((r) => setTimeout(r, 300));
  await connectHost();
  if (mainWindow) mainWindow.webContents.reload();
}

// ---------- IPC: terminals ----------

ipcMain.handle('pty:list', async () => (host ? host.request({ t: 'list' }) : []));

ipcMain.handle('pty:create', async (_event, opts = {}) => {
  const cwd = resolveCwd(opts.cwd);
  return host.request({ t: 'create', cwd, cols: opts.cols || 80, rows: opts.rows || 24 });
});

ipcMain.on('pty:write', (_event, id, data) => host && host.send({ t: 'write', id, data }));
ipcMain.on('pty:resize', (_event, id, cols, rows, force) => host && host.send({ t: 'resize', id, cols, rows, force: !!force }));
ipcMain.on('pty:kill', (_event, id) => host && host.send({ t: 'kill', id }));
ipcMain.on('pty:meta', (_event, id, meta) => host && host.send({ t: 'meta', id, meta }));

// ---------- IPC: dialogs / app ----------

ipcMain.handle('dialog:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open terminal in folder',
    defaultPath: DEFAULT_CWD,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:confirm', async (_event, { message, detail }) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Close', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message,
    detail,
  });
  return result.response === 0;
});

ipcMain.handle('app:defaultCwd', () => DEFAULT_CWD);

ipcMain.on('shell:openExternal', (_event, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

ipcMain.on('shell:revealPath', (_event, p) => {
  if (p) shell.showItemInFolder(p);
});

// ---------- Project emojis ----------
//
// The UI labels every project with an emoji. Rather than picking one at
// random, ask Claude Code (headless, cheapest model, no tools) for an emoji
// that fits what the project is about, judging from its README, manifest and
// top-level files. The UI shows a placeholder until the answer arrives and
// keeps the placeholder if the `claude` CLI is missing or fails.

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

function readHead(file, maxChars) {
  try {
    return fs.readFileSync(file, 'utf8').slice(0, maxChars).trim();
  } catch (_) {
    return '';
  }
}

// A short plain-text sketch of a directory: its name, what its manifest and
// README say, and what files it holds.
function describeDirectory(root) {
  const parts = [`Directory name: ${path.basename(root)}`];
  let entries = [];
  try {
    entries = fs.readdirSync(root).filter((e) => !e.startsWith('.')).sort();
  } catch (_) {}
  if (entries.length) parts.push(`Top-level files: ${entries.slice(0, 40).join(', ')}${entries.length > 40 ? ', …' : ''}`);
  const manifests = ['package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'setup.py', 'Gemfile', 'composer.json'];
  for (const m of manifests) {
    const head = readHead(path.join(root, m), 600);
    if (head) {
      parts.push(`${m}:\n${head}`);
      break;
    }
  }
  const readme = entries.find((e) => /^readme(\.|$)/i.test(e));
  if (readme) {
    const head = readHead(path.join(root, readme), 1500);
    if (head) parts.push(`${readme}:\n${head}`);
  }
  return parts.join('\n\n');
}

function findClaudeBinary() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'claude')),
  ];
  return candidates.find((c) => {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return true;
    } catch (_) {
      return false;
    }
  });
}

// True for a single emoji (one grapheme cluster that is pictographic).
function isSingleEmoji(str) {
  if (!str || !/\p{Extended_Pictographic}/u.test(str)) return false;
  const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(str)];
  return graphemes.length === 1;
}

function askClaude(prompt) {
  const bin = findClaudeBinary();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    const args = ['-p', '--model', 'haiku', '--tools', '', '--no-session-persistence', '--output-format', 'text', prompt];
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let out = '';
    let child;
    try {
      // Run from the temp dir so it never shows up as a session of the project itself.
      child = spawn(bin, args, { cwd: os.tmpdir(), env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (_) {
      return resolve(null);
    }
    const timer = setTimeout(() => child.kill(), 45000);
    child.stdout.on('data', (b) => (out += b.toString('utf8')));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : null);
    });
  });
}

ipcMain.handle('emoji:suggest', async (_event, { cwd, project, taken = [] } = {}) => {
  const root = findRepoRoot(cwd) || cwd;
  if (!root || !fs.existsSync(root)) return null;
  const avoid = taken.filter(isSingleEmoji);
  const prompt =
    `Pick one emoji to serve as the icon for the software project "${project || path.basename(root)}", ` +
    `so it is recognisable in a list of projects. Choose something that evokes what the project is about ` +
    `(its subject, domain or purpose), not a generic symbol like a folder or a computer.` +
    (avoid.length ? ` It must not be any of these, which are already in use: ${avoid.join(' ')}.` : '') +
    `\n\nReply with exactly one emoji and nothing else.\n\n${describeDirectory(root)}`;
  const reply = await askClaude(prompt);
  if (!reply) return null;
  const emoji = reply.trim().replace(/^[`'"\s]+|[`'"\s.]+$/g, '');
  if (!isSingleEmoji(emoji) || avoid.includes(emoji)) return null;
  return emoji;
});

// ---------- Clipboard & dropped images ----------

const IMAGE_DIR = path.join(os.tmpdir(), 'agent-coding-ui-images');

function imageFileName(ext) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  return `Pasted image ${stamp}.${ext}`;
}

ipcMain.handle('clipboard:read', () => {
  const text = clipboard.readText();
  const formats = clipboard.availableFormats();
  const hasImage = formats.some((f) => f.startsWith('image/')) && !clipboard.readImage().isEmpty();
  return { text, hasImage };
});

// Save the clipboard image as a PNG in a temp folder and return its path.
ipcMain.handle('clipboard:saveImage', () => {
  const img = clipboard.readImage();
  if (img.isEmpty()) return null;
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  const file = path.join(IMAGE_DIR, imageFileName('png'));
  fs.writeFileSync(file, img.toPNG());
  return file;
});

// Save bytes dropped from e.g. a browser (no path on disk) and return the path.
ipcMain.handle('file:saveTemp', (_event, name, bytes) => {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  const ext = (path.extname(name || '') || '.png').slice(1).toLowerCase();
  const file = path.join(IMAGE_DIR, imageFileName(ext));
  fs.writeFileSync(file, Buffer.from(bytes));
  return file;
});

// ---------- Menu ----------

let quitWithTerminals = false;

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { label: 'Quit (Keep Terminals Running)', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
              {
                label: 'Quit and Close All Terminals',
                accelerator: 'CmdOrCtrl+Alt+Q',
                click: () => {
                  quitWithTerminals = true;
                  app.quit();
                },
              },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Terminal', accelerator: 'CmdOrCtrl+N', click: () => send('menu:new-terminal') },
        { label: 'New Terminal in Folder…', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('menu:new-terminal-in-folder') },
        { type: 'separator' },
        { label: 'Rename Terminal', accelerator: 'CmdOrCtrl+R', click: () => send('menu:rename-terminal') },
        { label: 'Reveal Folder in Finder', click: () => send('menu:reveal-folder') },
        { type: 'separator' },
        { label: 'Close Terminal', accelerator: 'CmdOrCtrl+W', click: () => send('menu:close-terminal') },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => send('menu:copy') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => send('menu:paste') },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => send('menu:select-all') },
        { type: 'separator' },
        { label: 'Clear Terminal', accelerator: 'CmdOrCtrl+K', click: () => send('menu:clear-terminal') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('menu:toggle-sidebar') },
        { label: 'Sort Sidebar: Attention First / Manual', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('menu:toggle-sort') },
        { type: 'separator' },
        { label: 'Next Terminal', accelerator: 'CmdOrCtrl+Shift+]', click: () => send('menu:next-terminal') },
        { label: 'Previous Terminal', accelerator: 'CmdOrCtrl+Shift+[', click: () => send('menu:prev-terminal') },
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
          label: n === 9 ? 'Last Terminal' : `Terminal ${n}`,
          accelerator: `CmdOrCtrl+${n}`,
          visible: false,
          click: () => send('menu:select-index', n),
        })),
        { type: 'separator' },
        { label: 'Increase Font Size', accelerator: 'CmdOrCtrl+=', click: () => send('menu:font-size', 1) },
        { label: 'Decrease Font Size', accelerator: 'CmdOrCtrl+-', click: () => send('menu:font-size', -1) },
        { label: 'Reset Font Size', accelerator: 'CmdOrCtrl+0', click: () => send('menu:font-size', 0) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Develop',
      submenu: [
        {
          label: 'Reload UI (Terminals Keep Running)',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => mainWindow && mainWindow.webContents.reload(),
        },
        {
          label: 'Relaunch App (Terminals Keep Running)',
          accelerator: 'CmdOrCtrl+Alt+R',
          click: () => {
            app.relaunch();
            app.quit();
          },
        },
        { type: 'separator' },
        {
          label: 'Restart Terminal Host…',
          click: async () => {
            const { response } = await dialog.showMessageBox(mainWindow, {
              type: 'warning',
              buttons: ['Restart Host', 'Cancel'],
              defaultId: 1,
              cancelId: 1,
              message: 'Restart the terminal host?',
              detail:
                'Every terminal is recreated with its scrollback, and Claude Code sessions are resumed. Any other program running in a terminal is stopped.',
            });
            if (response === 0) restartHost();
          },
        },
        { label: 'Show Host Log', click: () => shell.showItemInFolder(path.join(app.getPath('userData'), 'pty-host.log')) },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- Lifecycle ----------

app.whenReady().then(async () => {
  buildMenu();
  try {
    await connectHost();
  } catch (err) {
    dialog.showErrorBox('Terminal host failed to start', String(err && err.message ? err.message : err));
  }
  createWindow();

  nativeTheme.on('updated', () => send('theme:changed', nativeTheme.shouldUseDarkColors));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Terminals live in the host, so quitting the app leaves them running unless
// the user explicitly asked to close them too. That explicit quit also drops
// the host's snapshot, so the terminals do not come back on the next launch.
app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  if (quitWithTerminals && host) host.send({ t: 'shutdown', keepState: false });
});
