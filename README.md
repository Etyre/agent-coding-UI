# Agent Coding UI

A Typora-style wrapper around terminal sessions for running Claude Code.
One big terminal pane, a sidebar listing every open terminal, and a
**New Terminal** button at the bottom that opens a login shell in
`~/Documents/agent-coding`. Built 2026-11-04 so that several Claude Code
sessions can run side by side, each labelled with the project it is in and
with a clear signal of which one is waiting for input, and so that none of
them die when the UI is reloaded, the app relaunches, or the Mac reboots.

## How it works

### Architecture: a separate terminal host

The shells don't run inside the Electron app. They run in a small separate
**terminal host** process (`src/pty-host.js`) that the app starts on first
launch and talks to over a unix socket. The app is just a view onto it, so:

- **Changing the UI** (`renderer/`, `preload.js`): press ⌘⇧R to reload the
  page. Every terminal reattaches with its scrollback, and full-screen
  programs like Claude Code are nudged to repaint.
- **Changing `main.js`**: press ⌘⌥R to relaunch the app. Same result.
- **Quitting** with ⌘Q leaves the terminals running; relaunch the app later
  and they are all still there, untouched.
- **Changing `pty-host.js`** is the one case that needs the host itself
  restarted. The app notices when the host on disk differs from the one
  running and asks whether to keep the old one running or restart it (also
  available under Develop → Restart Terminal Host). A restart recreates the
  terminals from the snapshot described below.

The host owns the PTYs (node-pty), keeps a ring buffer of scrollback per
terminal, tracks each shell's cwd (via `lsof`) and foreground program, and
speaks newline-delimited JSON over the socket. It exits by itself once the
last terminal closes and no app is connected.

#### When the host itself goes away

The host keeps a snapshot of every terminal on disk: its folder, name, sidebar
order, the last 512 KB of scrollback, and the Claude Code conversation running
in it (found through the per-process files Claude Code writes under
`~/.claude/sessions`). If the host is gone when the app starts, after a
reboot, a logout, a crash, or a host restart, the new host recreates each
terminal from that snapshot: a fresh shell in the same folder, the old
scrollback above a dim `[restored from …]` line, and, where Claude Code was
running, `claude --resume <session>` typed for you so the conversation
carries on where it left off. Other programs that were running are not
restarted; the banner says what was there.

⌘⌥Q (**Quit and Close All Terminals**) is the one way to say you are done: it
closes the terminals and discards the snapshot, so the next launch starts
with a single fresh terminal.

### Sidebar

Each entry is named after the project the shell is in: the git repo that
contains the current directory, or the folder itself if it isn't inside a
repo. The name follows along as you `cd`, until you rename the terminal by
hand (⌘R), which pins it. Below the name is the program currently running,
so a terminal running `claude` is labelled as such.

Every project also gets an emoji in front of its name, in the sidebar and
the title bar, so terminals are easy to tell apart at a glance. The first
time a project is seen, the app asks Claude Code (headless, with the cheapest
model and no tools) for an emoji that fits what the project is about, judging
from its README, manifest and top-level files. A placeholder emoji shows
until the answer arrives, a second or two later. The pick is remembered after
that and kept distinct from the other projects' emojis. The app keeps the
mapping in its own storage, so it is per machine; there is no UI to change it
yet. If the `claude` command is not installed the placeholder simply stays.

That emoji request is the app's only LLM call, and it follows the shared
rules in `../CLAUDE.md`: the system prompt starts with
`../shared/llm-system-prompt-preamble.md` verbatim (passed with
`--system-prompt`, which replaces Claude Code's default), and every reply is
piped to `python3 ../shared/llm_contact.py check`. If the model reached for
Eli with an `@ELI:` line, the message lands in the LLM inbox and the task
stops: the placeholder stays and nothing is retried. `claude -p` takes no
custom tools, so the `contact_eli` tool cannot be offered; the marker is the
channel. All of this lives in `src/emoji.js`.

The icon in front of the name shows what the terminal is doing:

- **nothing** – a shell sitting at its prompt
- **spinning ring** – a program is working (producing output)
- **pulsing blue dot** – the program has gone quiet or rang the bell, and
  there is output you have not seen: it is waiting for you. The dot and the
  bold name stay until you have read the output: the terminal is selected,
  the window has focus, and you have scrolled to the end. Clicking a terminal
  that is already at the end clears it at once; one you have scrolled up in
  keeps the dot until you reach the bottom. Once read, the terminal shows no
  icon again until the program changes what is on screen. Output you watched
  arrive is not news, and neither is a repaint that leaves the text as it
  was (the redraw on losing focus) or that only touches Claude Code's own
  chrome: the notices in the status row above the input box, the suggested
  follow-up that appears in the box after a reply, and the key hints in the
  footer all come and go on their own. Only the transcript above the input
  box counts, so a program going quiet after those earns no dot.
- **hollow ring** – a program finished and dropped back to the shell while you
  were not looking.

**Ordering.** The small label in the sidebar header toggles between two
orders (also ⌘⇧A):

- **manual** – drag items to reorder them; the order is remembered.
- **attention first** – terminals waiting for you float to the top, then ones
  that are working, then idle shells. Ties keep the manual order.

⌘1…⌘9 and next/previous follow whichever order is shown.

Drag the sidebar edge to resize it. Width, collapsed state, sort mode and
font size are remembered between launches.

**Renaming.** ⌘R (or double-clicking the name) turns the name into a text
field. What you type is saved as a draft on every keystroke, keyed by
terminal, so a ⌘⇧R reload mid-edit brings the half-typed name back. The draft
is cleared when you press Enter or click away (both commit) or press Escape
(discard).

### Sending images to Claude

- **Paste**: take a screenshot to the clipboard (⌘⌃⇧4) and press ⌘V in the
  terminal. When Claude Code is running it receives the image directly as an
  attachment; in a plain shell the image is saved to a temp PNG and its path
  is pasted instead.
- **Drag and drop**: drop image files (or any files) onto the terminal pane to
  insert their paths. Images dragged from a browser are saved to a temp file
  first.

### Shortcuts

| Action | Keys |
| --- | --- |
| New terminal (default folder) | ⌘N |
| New terminal in a chosen folder | ⌘⇧N, or right-click **New Terminal** |
| Close terminal (asks first if a program is running) | ⌘W |
| Rename terminal | ⌘R, or double-click its name |
| Toggle sidebar | ⌘⇧L, or the icon in the title bar |
| Toggle sidebar order (manual / attention first) | ⌘⇧A, or the label in the sidebar header |
| Next / previous terminal | ⌘⇧] / ⌘⇧[ |
| Jump to terminal 1–8, last | ⌘1 … ⌘8, ⌘9 |
| Copy selection (or send ^C if nothing selected) | ⌘C |
| Paste (text, or a screenshot from the clipboard) | ⌘V |
| Newline in the Claude Code input box without submitting | ⇧↩ |
| Clear terminal | ⌘K |
| Font size | ⌘= / ⌘- / ⌘0 |
| Reload the UI (terminals keep running) | ⌘⇧R |
| Relaunch the app (terminals keep running) | ⌘⌥R |
| Quit, leaving terminals running in the background | ⌘Q |
| Quit and close every terminal | ⌘⌥Q |

## Files

| File | Purpose |
| --- | --- |
| `src/main.js` | Electron main process: window, app menu, client for the terminal host, clipboard/drop helpers. |
| `src/pty-host.js` | Long-lived terminal host: owns the PTYs (node-pty), buffers scrollback, tracks each shell's cwd and program, snapshots and restores terminals. |
| `src/emoji.js` | The project-emoji picker: the app's one LLM call (`claude -p`, haiku), with the shared preamble and inbox check. Runnable on its own as the test path. |
| `src/preload.js` | The small IPC bridge exposed to the page as `window.api`. |
| `src/renderer/index.html` | The page: sidebar, title bar, terminal pane. |
| `src/renderer/renderer.js` | The UI: xterm.js terminals, sidebar state and ordering, attention tracking, emoji display, rename drafts. |
| `src/renderer/styles.css` | Styling, light and dark. |
| `build/icon.svg` | Source of the app icon. |
| `build/render-icon.js` | Renders `icon.svg` to `icon.png` with Electron (`npx electron build/render-icon.js`). |
| `build/make-icns.sh` | Turns `icon.png` into `icon.iconset/` and `icon.icns` with `iconutil`. |
| `build/icon.png`, `build/icon.icns`, `build/icon.iconset/` | Rendered icon artifacts, committed so a build needs no rendering step. |
| `package.json` | Scripts (`start`, `rebuild`, `test-emoji`, `package`, `install_app`) and dependencies: Electron, node-pty, xterm.js and its fit/web-links addons, electron-packager and electron-rebuild. |
| `dist/` (ignored) | Output of `npm run package`. |

Dependencies, and why: Electron because the point is a native-feeling window
with a menu bar and shortcuts; node-pty because a real PTY is the only way to
run full-screen programs like Claude Code; xterm.js because writing a
terminal emulator is not the project.

## Runtime locations

- Installed app: `/Applications/Agent Coding.app` (a copy of the source tree
  plus Electron; made by `npm run install_app`).
- App data: `~/Library/Application Support/Agent Coding/`
  - `pty-host.sock` – the host's unix socket
  - `pty-host.log` – the host's log, one timestamped line per event
    (Develop → Show Host Log)
  - `pty-host-state/` – the terminal snapshot (`sessions.json` plus one
    `scrollback-<id>.txt` per terminal)
  - `Local Storage/` – Electron's localStorage, where the renderer keeps font
    size, sidebar width and collapsed state, sort mode, the project → emoji
    map (`projectEmojiPicks`) and rename drafts (`renameDraft:<id>`)
- Main-process log (emoji picker, LLM inbox checks): `~/Library/Logs/agent-coding-ui.log`
- Pasted and dropped images: `$TMPDIR/agent-coding-ui-images/`
- Shared LLM pieces it reads at runtime: `~/Documents/agent-coding/shared/`
  (`llm-system-prompt-preamble.md`, `llm_contact.py`, `.venv/bin/python3`)
- Claude Code's own session files, read to find resumable sessions:
  `~/.claude/sessions/<pid>.json`

## Common tasks

Run from the source tree (development):

```
npm install
npm start
```

`npm install` rebuilds `node-pty` against Electron automatically. If you ever
see a native module error, run `npm run rebuild`.

Install as an app:

```
npm run install_app
```

builds `Agent Coding.app` (with the icon from `build/icon.svg`) into
`dist/` and copies it to `/Applications`. Re-run it after changing the code
to update the installed copy; `npm start` still runs straight from the source
tree for development. Then relaunch the app (⌘⌥R if it is running; the
terminals survive). Do not run this while a session you care about is in the
middle of something unless you are happy to relaunch.

Re-render the icon:

```
npx electron build/render-icon.js
sh build/make-icns.sh
```

Test the LLM path end to end (preamble, `claude -p`, inbox check) without the
app; prints the emoji picked for a folder, or says why not and points at the
log:

```
npm run test-emoji -- ~/Documents/agent-coding/some-project
node src/emoji.js ~/Documents/agent-coding/some-project 🍎 🍋   # extra args = emojis to avoid
```

Tail the logs:

```
tail -f ~/Library/Logs/agent-coding-ui.log
tail -f ~/Library/Application\ Support/Agent\ Coding/pty-host.log
```

Stop: ⌘Q leaves terminals running in the host; ⌘⌥Q closes them all and
drops the snapshot. To restart the host after editing `pty-host.js`: Develop →
Restart Terminal Host (or accept the prompt on next launch).

## Settings that matter

- The `claude` command must be installed (`~/.local/bin/claude`,
  `/opt/homebrew/bin`, `/usr/local/bin` or on `PATH`) and logged in; the
  emoji picker runs it headless. Without it the placeholder emoji stays and
  nothing else is affected.
- The inbox check needs a Python 3.10+ `python3`: the shared venv
  (`~/Documents/agent-coding/shared/.venv`) or Homebrew. See Gotchas.
- `/Applications/Agent Coding.app` is ad-hoc signed (`codesign --sign -`), so
  there is nothing to configure in System Settings; if Gatekeeper complains
  after a rebuild, `install_app` already strips quarantine with `xattr -cr`.

## Gotchas learned

- The installed app is a *copy* of the source tree. Editing `src/` changes
  nothing in `/Applications` until `npm run install_app`; ⌘⇧R / ⌘⌥R only
  reload what is in the installed copy (or in the source tree, if you ran
  `npm start`).
- `/usr/bin/python3` on macOS is 3.9 and `shared/llm_contact.py` uses 3.10
  syntax (`dict | None`), so it crashes with a `TypeError`. `emoji.js` looks
  for the shared venv and Homebrew first and only falls back to `/usr/bin`.
  If the checker fails, the reply is still scanned for `@ELI:` locally so a
  message is never silently dropped.
- The host is started with `ELECTRON_RUN_AS_NODE=1` so node-pty's Electron
  build loads. The shells it spawns must *not* inherit that variable, or
  Electron-based CLIs launched from them (e.g. `code`) misbehave; the host
  deletes it from its environment first.
- If the app is launched from inside a Claude Code session (for example a
  "restart the app" command), it inherits `CLAUDECODE` / `CLAUDE_*`
  variables. Any `claude` started in a terminal would then run as a child of
  that session. Terminals, and the emoji picker's `claude -p`, always get a
  clean environment with those stripped.
- node-pty reports the foreground program by its executable's file name. The
  `claude` command is a symlink to `~/.local/share/claude/versions/<version>`,
  so it shows up as e.g. `2.1.318`; the host maps that back to `claude`.
- `~/.claude/sessions/<pid>.json` files can go stale and the pid be reused by
  something else; the host checks the process is really Claude Code before
  trusting one. A session that never got a message has no transcript and
  cannot be resumed.
- Shift+Enter: xterm.js would send a plain carriage return, indistinguishable
  from Enter, so the app sends a line feed instead (what Ctrl+J sends).
  Claude Code's input box treats it as a newline; a shell treats it like Enter.
- Claude Code repaints its chrome (status row, suggested follow-up, footer
  hints) on its own schedule and repaints everything when the terminal loses
  focus. Treating any output as "unread" made the attention dot fire
  constantly; the fix compares the transcript text above the input box with
  what was last read, and ignores output for a short window after a known
  repaint trigger.
- Programs with focus reporting redraw on blur; after reattaching a terminal
  the app pokes it with a resize so it repaints, and counts that repaint as
  already seen.
- The emoji picker runs `claude -p` from the temp dir, not the project, so it
  never shows up as a session of the project itself; and with
  `--no-session-persistence` so it leaves no transcript.
- Haiku sometimes ignores the "must not be any of these" list and returns an
  emoji already in use; the picker rejects it and the placeholder stays until
  the next launch asks again.
- `npm run package` passes `--ignore` patterns to electron-packager so `dist/`,
  the iconset and the icon renderer stay out of the bundle; anything new under
  `src/` is packaged automatically.
