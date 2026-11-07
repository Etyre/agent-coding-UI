// Project emoji picker: the one place this app talks to a language model.
//
// The UI labels every project with an emoji. Rather than picking one at
// random, ask Claude Code (headless, cheapest model, no tools) for an emoji
// that fits what the project is about, judging from its README, manifest and
// top-level files. The UI shows a placeholder until the answer arrives and
// keeps the placeholder if the `claude` CLI is missing or fails.
//
// Like every LLM call in ~/Documents/agent-coding, the system prompt starts
// with shared/llm-system-prompt-preamble.md word for word, and every reply is
// run through `python3 shared/llm_contact.py check`: if the model used the
// `@ELI:` marker to reach Eli, the message is recorded in his LLM inbox and
// this task stops (no retry; the placeholder stays). The `contact_eli` tool
// cannot be offered here because `claude -p` takes no custom tools, which is
// why the marker is the channel.
//
// Plain Node (no Electron), so it doubles as the test path:
//   node src/emoji.js [folder]      prints the emoji picked for that folder
// Log: ~/Library/Logs/agent-coding-ui.log (shared with main.js).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const APP_NAME = 'agent-coding-ui';
const MODEL = 'haiku';
const SHARED_DIR = path.join(os.homedir(), 'Documents', 'agent-coding', 'shared');
const PREAMBLE_PATH = path.join(SHARED_DIR, 'llm-system-prompt-preamble.md');
const LLM_CONTACT_PATH = path.join(SHARED_DIR, 'llm_contact.py');
const LOG_PATH = path.join(os.homedir(), 'Library', 'Logs', `${APP_NAME}.log`);

// The app's own instructions; the shared preamble goes in front of them.
const INSTRUCTIONS =
  'You pick a single emoji to serve as the icon for a software project, so it is recognisable in a ' +
  'list of projects. Choose something that evokes what the project is about (its subject, domain or ' +
  'purpose), not a generic symbol like a folder or a computer. Reply with exactly one emoji and nothing else.';

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line);
  } catch (_) {}
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

function findExecutable(name, extraDirs) {
  const dirs = [...extraDirs, ...(process.env.PATH || '').split(path.delimiter).filter(Boolean)];
  return dirs.map((d) => path.join(d, name)).find((c) => {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return true;
    } catch (_) {
      return false;
    }
  });
}

const findClaudeBinary = () => findExecutable('claude', [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']);
// llm_contact.py needs Python 3.10+; the system /usr/bin/python3 is 3.9, so it
// is the last resort after the shared venv and Homebrew.
const findPython = () =>
  findExecutable('python3', [path.join(SHARED_DIR, '.venv', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']) || findExecutable('python3', ['/usr/bin']);

// True for a single emoji (one grapheme cluster that is pictographic).
function isSingleEmoji(str) {
  if (!str || !/\p{Extended_Pictographic}/u.test(str)) return false;
  const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(str)];
  return graphemes.length === 1;
}

// The full system prompt: shared preamble first, verbatim, then our own rules.
// Returns null (and logs) if the preamble is missing: no call is made without it.
function systemPrompt() {
  let preamble;
  try {
    preamble = fs.readFileSync(PREAMBLE_PATH, 'utf8').trim();
  } catch (err) {
    log(`emoji: cannot read preamble ${PREAMBLE_PATH}: ${err.message}`);
    return null;
  }
  return `${preamble}\n\n${INSTRUCTIONS}`;
}

// Environment for child processes: never run as a child of a Claude session
// this app may have inherited (see pty-host.js), and never in Electron's Node mode.
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'ELECTRON_RUN_AS_NODE' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_')) continue;
    env[k] = v;
  }
  return env;
}

function run(bin, args, { input, cwd } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(bin, args, { cwd, env: cleanEnv(), stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: null, out, err: e.message });
    }
    const timer = setTimeout(() => child.kill(), 45000);
    child.stdout.on('data', (b) => (out += b.toString('utf8')));
    child.stderr.on('data', (b) => (err += b.toString('utf8')));
    child.on('error', (e) => resolve({ code: null, out, err: e.message }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    if (input != null) child.stdin.end(input);
  });
}

async function askClaude(system, prompt) {
  const bin = findClaudeBinary();
  if (!bin) {
    log('emoji: claude CLI not found; keeping placeholder');
    return null;
  }
  const args = ['-p', '--model', MODEL, '--tools', '', '--system-prompt', system, '--no-session-persistence', '--output-format', 'text', prompt];
  // Run from the temp dir so it never shows up as a session of the project itself.
  const { code, out, err } = await run(bin, args, { cwd: os.tmpdir() });
  if (code !== 0) {
    log(`emoji: claude exited ${code}: ${(err || out).trim().slice(0, 300)}`);
    return null;
  }
  return out;
}

// Hand the exchange to the shared inbox. Exit 3 means the model contacted Eli
// (recorded and notified there); anything else means carry on.
async function contactedEli(system, prompt, reply) {
  const py = findPython();
  if (!py) {
    log('emoji: python3 not found; cannot run llm_contact check');
    return false;
  }
  const payload = JSON.stringify({
    app: APP_NAME,
    model: MODEL,
    system,
    messages: [{ role: 'user', content: prompt }],
    response: { role: 'assistant', content: [{ type: 'text', text: reply }] },
    tools: [],
  });
  const { code, out, err } = await run(py, ['-I', LLM_CONTACT_PATH, 'check'], { input: payload });
  if (code === 3) {
    log(`emoji: model contacted Eli; stopping. ${out.trim()}`);
    return true;
  }
  if (code !== 0) {
    // The checker itself failed, so fall back to looking for the marker here;
    // a message must never be lost, even if it cannot be recorded properly.
    log(`emoji: llm_contact check exited ${code}: ${(err || out).trim().slice(0, 300)}`);
    if (/^\s*@ELI:/m.test(reply)) {
      log(`emoji: reply contains @ELI: but could not be recorded; stopping. Reply: ${reply.trim().slice(0, 500)}`);
      return true;
    }
  }
  return false;
}

// One emoji for the project at `cwd`, or null to keep the placeholder.
async function suggestEmoji({ cwd, project, taken = [] } = {}) {
  const root = findRepoRoot(cwd) || cwd;
  if (!root || !fs.existsSync(root)) return null;
  const system = systemPrompt();
  if (!system) return null;
  const avoid = taken.filter(isSingleEmoji);
  const prompt =
    `Pick one emoji to serve as the icon for the software project "${project || path.basename(root)}".` +
    (avoid.length ? ` It must not be any of these, which are already in use: ${avoid.join(' ')}.` : '') +
    `\n\n${describeDirectory(root)}`;
  const reply = await askClaude(system, prompt);
  if (!reply) return null;
  if (await contactedEli(system, prompt, reply)) return null;
  const emoji = reply.trim().replace(/^[`'"\s]+|[`'"\s.]+$/g, '');
  if (!isSingleEmoji(emoji) || avoid.includes(emoji)) {
    log(`emoji: unusable reply for ${project || root}: ${JSON.stringify(reply.trim().slice(0, 80))}`);
    return null;
  }
  log(`emoji: ${project || root} -> ${emoji}`);
  return emoji;
}

module.exports = { suggestEmoji, findRepoRoot, isSingleEmoji };

// Test path: `node src/emoji.js [folder]`. Exercises the real call end to end
// (preamble, claude, inbox check) without the app.
if (require.main === module) {
  const cwd = path.resolve(process.argv[2] || process.cwd());
  suggestEmoji({ cwd, project: path.basename(cwd), taken: process.argv.slice(3) }).then((emoji) => {
    if (emoji) {
      console.log(emoji);
      process.exit(0);
    }
    console.error(`no emoji for ${cwd}; see ${LOG_PATH}`);
    process.exit(1);
  });
}
