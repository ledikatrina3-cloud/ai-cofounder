// Electron main process bootstrap — CommonJS entry point.
//
// .cjs extension forces Node.js to treat this file as CommonJS regardless of
// the root package.json "type": "module". This is the only reliable way to
// load the 'electron' built-in module in the main process, because:
//   - ESM static named imports fail: "does not provide an export named BrowserWindow"
//   - ESM dynamic import('electron') returns namespace where API is under .default
//   - CJS require('electron') works unconditionally in Electron's main process
//
// The compiled ESM server module is loaded via dynamic import() after require().

'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');

async function createWindow() {
  const serverPath = path.join(REPO_ROOT, 'dist', 'bridge', 'server.js');
  const { startBridgeServer } = await import(serverPath);

  const handle = await startBridgeServer();
  console.log(
    `[bridge.electron] server up on :${handle.port}, session=${handle.sessionId}, jsonl=${handle.jsonlPath}`,
  );

  const preloadPath = path.join(REPO_ROOT, 'bridge', 'electron', 'preload.cjs');

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'AI-Cofounder Bridge',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  if (process.env.BRIDGE_DEV === 'true') {
    await win.loadURL('http://localhost:5173');
  } else {
    const htmlPath = path.join(REPO_ROOT, 'bridge', 'app', 'dist', 'index.html');
    await win.loadFile(htmlPath);
  }

  if (process.env.BRIDGE_DEVTOOLS !== 'off') {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  app.on('window-all-closed', () => {
    handle.close().finally(() => app.quit());
  });
}

app.whenReady().then(() => createWindow().catch(console.error));
