// Renders build/icon.svg to build/icon.png (1024x1024) using Electron offscreen.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
app.setPath('userData', path.join(require('os').tmpdir(), 'acui-icon-render'));
app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  const html = `<!doctype html><html><body style="margin:0;background:transparent;width:1024px;height:1024px;overflow:hidden">${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(path.join(__dirname, 'icon.png'), img.toPNG());
  console.log('wrote icon.png', img.getSize());
  app.exit(0);
});
