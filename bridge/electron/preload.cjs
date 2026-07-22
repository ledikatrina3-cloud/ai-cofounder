// Минимальный preload для Electron contextIsolation. Файл намеренно CommonJS
// (.cjs), потому что Electron preload до сих пор не поддерживает ESM-импорты
// корректно при sandbox/contextIsolation. Renderer общается с Bridge-сервером
// по HTTP/SSE, поэтому IPC-моста сейчас не нужно — preload только декларирует
// contextBridge как future-proof'инг под фазу 3.6a (r3f-визуализация).

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  version: '1.5a',
});
