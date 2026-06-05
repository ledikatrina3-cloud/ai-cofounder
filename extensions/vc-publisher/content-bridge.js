// content-bridge.js - ISOLATED world, мост между chrome.runtime и страницей.
//
// Зачем нужен: content-main.js работает в world: "MAIN" и НЕ имеет доступа к
// chrome.runtime API (MV3 ограничение). Поэтому делаем 2 content-script'а:
// - content-bridge (ISOLATED, default) - имеет chrome.* API
// - content-main (MAIN) - имеет доступ к page closure (Editor.js instance)
//
// Связь через window.postMessage с подписью { source: 'vc-publisher' }.

(() => {
  const SRC = 'vc-publisher';
  let mainReady = false;
  const pendingMessages = new Map(); // requestId -> { resolve, reject, timer }

  // 1. Listen window.postMessage из content-main.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SRC || !data.from) return;
    if (data.from !== 'main') return; // принимаем только от main

    if (data.type === 'READY') {
      mainReady = true;
      console.log('[vc-publisher:bridge] main ready, editorFound:', data.editorFound);
      return;
    }
    if (data.type === 'DIAG') {
      // Прокидываем диагностику в localhost:7777 из ISOLATED world (без page CSP).
      fetch('http://localhost:7777/diag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data.payload || {}),
      }).catch((err) => console.log('[vc-publisher:bridge] diag POST failed:', err.message));
      return;
    }
    if (data.type === 'RESULT' && data.requestId) {
      const p = pendingMessages.get(data.requestId);
      if (p) {
        clearTimeout(p.timer);
        pendingMessages.delete(data.requestId);
        p.resolve(data.payload);
      }
      return;
    }
    if (data.type === 'ERROR' && data.requestId) {
      const p = pendingMessages.get(data.requestId);
      if (p) {
        clearTimeout(p.timer);
        pendingMessages.delete(data.requestId);
        p.reject(new Error(data.error));
      }
      return;
    }
  });

  // 2. Принимаем сообщения от background, проксируем в page (world MAIN).
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ ready: mainReady, location: location.href });
      return false;
    }
    if (msg.type === 'PUBLISH') {
      sendToMain('PUBLISH', msg.payload, 300_000)
        .then((result) => sendResponse({ success: true, ...result }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // async
    }
    return false;
  });

  function sendToMain(type, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        pendingMessages.delete(requestId);
        reject(new Error(`main-script timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      pendingMessages.set(requestId, { resolve, reject, timer });
      window.postMessage({ source: SRC, from: 'bridge', type, requestId, payload }, '*');
    });
  }

  console.log('[vc-publisher:bridge] loaded');
})();
