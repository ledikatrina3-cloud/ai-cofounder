// Electron main process. Поднимает Hono-сервер на 3737 и BrowserWindow 1280×800.
//
// Renderer подписывается на /stream (SSE) — поэтому Electron preload минимальный:
// никакого IPC сейчас не нужно, сервер и Renderer общаются по HTTP.
//
// Запускается через `pnpm bridge:dev`. Электрон сам вызывается из node_modules.
//
// ESM + Electron: статические named imports из 'electron' падают в Electron 28+ / Node 22+
// (CJS named exports не детектируются статически). Динамический import() работает, потому
// что Electron патчит его runtime-резолвер. Поэтому используем await import('electron').

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridgeServer } from '../server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main(): Promise<void> {
  const { app, BrowserWindow } = await import('electron');

  await app.whenReady();

  const handle = await startBridgeServer();
  console.log(
    `[bridge.electron] server up on :${handle.port}, session=${handle.sessionId}, jsonl=${handle.jsonlPath}`,
  );

  const repoRoot = path.join(__dirname, '..', '..', '..');
  const preloadPath = path.join(repoRoot, 'bridge', 'electron', 'preload.cjs');

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

  win.once('ready-to-show', () => {
    win.show();
  });

  if (process.env.BRIDGE_DEV === 'true') {
    await win.loadURL('http://localhost:5173');
  } else {
    const htmlPath = path.join(repoRoot, 'bridge', 'app', 'dist', 'index.html');
    await win.loadFile(htmlPath);
  }

  if (process.env.BRIDGE_DEVTOOLS !== 'off') {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  app.on('window-all-closed', () => {
    void handle.close().finally(() => {
      app.quit();
    });
  });
}

main().catch(console.error);
