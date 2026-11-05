const { contextBridge, ipcRenderer, webUtils } = require('electron');

function on(channel, handler) {
  const wrapped = (_event, ...args) => handler(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('api', {
  // pty
  listPtys: () => ipcRenderer.invoke('pty:list'),
  createPty: (opts) => ipcRenderer.invoke('pty:create', opts),
  writePty: (id, data) => ipcRenderer.send('pty:write', id, data),
  resizePty: (id, cols, rows, force) => ipcRenderer.send('pty:resize', id, cols, rows, force),
  killPty: (id) => ipcRenderer.send('pty:kill', id),
  setPtyMeta: (id, meta) => ipcRenderer.send('pty:meta', id, meta),
  onHostDisconnected: (handler) => on('host:disconnected', handler),
  onHostReconnected: (handler) => on('host:reconnected', handler),
  onPtyData: (handler) => on('pty:data', handler),
  onPtyExit: (handler) => on('pty:exit', handler),
  onPtyProcess: (handler) => on('pty:process', handler),
  onPtyCwd: (handler) => on('pty:cwd', handler),

  // dialogs / app
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  confirm: (message, detail) => ipcRenderer.invoke('dialog:confirm', { message, detail }),
  defaultCwd: () => ipcRenderer.invoke('app:defaultCwd'),
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),
  revealPath: (p) => ipcRenderer.send('shell:revealPath', p),

  // clipboard & dropped files (for sending screenshots to Claude)
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  saveClipboardImage: () => ipcRenderer.invoke('clipboard:saveImage'),
  saveTempFile: (name, bytes) => ipcRenderer.invoke('file:saveTemp', name, bytes),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch (_) {
      return null;
    }
  },

  // menu events
  onMenu: (name, handler) => on(`menu:${name}`, handler),
  onThemeChanged: (handler) => on('theme:changed', handler),
});
