# Agent Coding UI

A Typora-style wrapper around terminal sessions for running Claude Code.
One big terminal pane, a sidebar listing every open terminal, and a
**New Terminal** button at the bottom that opens a login shell in
`~/Documents/agent-coding`.

## Run

```
npm install
npm start
```

`npm install` rebuilds `node-pty` against Electron automatically. If you ever
see a native module error, run `npm run rebuild`.

## Install as an app

```
npm run install_app
```

builds `Agent Coding.app` (with the icon from `build/icon.svg`) into
`dist/` and copies it to `/Applications`. Re-run it after changing the code
to update the installed copy; `npm start` still runs straight from the source
tree for development. The icon is re-rendered with
`npx electron build/render-icon.js` followed by the `iconutil` step in
`build/make-icns.sh`.

## Shortcuts

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
| Clear terminal | ⌘K |
| Font size | ⌘= / ⌘- / ⌘0 |
| Reload the UI (terminals keep running) | ⌘⇧R |
| Relaunch the app (terminals keep running) | ⌘⌥R |
| Quit, leaving terminals running in the background | ⌘Q |
| Quit and close every terminal | ⌘⌥Q |

## Sidebar

Each entry is named after the project the shell is in: the git repo that
contains the current directory, or the folder itself if it isn't inside a
repo. The name follows along as you `cd`, until you rename the terminal by
hand (⌘R), which pins it. Below the name is the program currently running,
so a terminal running `claude` is labelled as such.

The icon in front of the name shows what the terminal is doing:

- **nothing** – a shell sitting at its prompt
- **spinning ring** – a program is working (producing output)
- **blue dot** – the program has gone quiet or rang the bell: it is waiting for
  you. The dot pulses and the name is bold while that terminal is in the
  background; clicking it clears the highlight.
- **hollow ring** – a program finished and dropped back to the shell while the
  terminal was in the background.

**Ordering.** The small label in the sidebar header toggles between two
orders (also ⌘⇧A):

- **manual** – drag items to reorder them; the order is remembered.
- **attention first** – terminals waiting for you float to the top, then ones
  that are working, then idle shells. Ties keep the manual order.

⌘1…⌘9 and next/previous follow whichever order is shown.

Drag the sidebar edge to resize it. Width, collapsed state, sort mode and
font size are remembered between launches.

## Sending images to Claude

- **Paste**: take a screenshot to the clipboard (⌘⌃⇧4) and press ⌘V in the
  terminal. When Claude Code is running it receives the image directly as an
  attachment; in a plain shell the image is saved to a temp PNG and its path
  is pasted instead.
- **Drag and drop**: drop image files (or any files) onto the terminal pane to
  insert their paths. Images dragged from a browser are saved to a temp file
  first.

## Terminals survive reloads and restarts

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

### When the host itself goes away

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

The host exits by itself once the last terminal closes and no app is
connected. Its log is at
`~/Library/Application Support/Agent Coding/pty-host.log`
(Develop → Show Host Log); the snapshot lives next to it in
`pty-host-state/`.

## Layout

- `src/pty-host.js` – long-lived terminal host: owns the PTYs (node-pty), buffers scrollback, tracks each shell's cwd.
- `src/main.js` – Electron main process: window, app menu, client for the terminal host.
- `src/preload.js` – the small IPC bridge exposed to the page as `window.api`.
- `src/renderer/` – the UI (xterm.js terminals, sidebar, title bar).
