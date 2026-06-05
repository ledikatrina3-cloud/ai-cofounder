// background.js - Service Worker для vc.ru Publisher.
//
// Жизненный цикл: MV3 service worker засыпает после 30 секунд бездействия.
// Поэтому используем chrome.alarms (выживает sleep) для регулярного polling
// HTTP bridge на localhost:7777.
//
// Flow:
// 1. chrome.alarms tick каждые 30 сек -> GET localhost:7777/queue/next
// 2. Если has_work=true -> tabs.create vc.ru/?modal=editor, ждём content-bridge ready
// 3. Передаём payload в content-bridge через chrome.tabs.sendMessage
// 4. Content-bridge перенаправляет в content-main (через window.postMessage)
// 5. Получаем результат -> POST localhost:7777/result
//
// Manual trigger: popup.js может вызвать `triggerPublish()` напрямую через
// chrome.runtime.sendMessage({ type: 'MANUAL_PUBLISH' }).

const BRIDGE_URL = 'http://localhost:7777';
const POLL_ALARM = 'vc-publisher-poll';
const TAB_READY_TIMEOUT_MS = 60_000;
const PUBLISH_TIMEOUT_MS = 300_000;

// pollEnabled: дефолт TRUE - чтобы после load extension'а сразу пошла
// автономия без клика по тумблеру. Тумблер в popup остаётся для отладки
// (если пользователь хочет временно остановить polling).
let pollEnabled = true;

async function initPolling() {
  const stored = await chrome.storage.local.get('pollEnabled');
  // Если ключа нет (первый запуск) или явно true - включаем.
  pollEnabled = stored.pollEnabled !== false;
  if (pollEnabled) {
    chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
    // И сразу первый tick - не ждём 30 сек.
    tryPullAndPublish().catch((err) => console.error('[vc-publisher] initial poll failed:', err));
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[vc-publisher] installed - polling auto-enabled');
  initPolling();
});

chrome.runtime.onStartup.addListener(() => {
  initPolling();
});

// На случай если service worker проснулся не от install/startup.
initPolling();

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== POLL_ALARM) return;
  if (!pollEnabled) return;
  await tryPullAndPublish();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    sendResponse({ pollEnabled, bridgeUrl: BRIDGE_URL });
    return false;
  }
  if (msg.type === 'SET_POLL_ENABLED') {
    pollEnabled = msg.enabled === true;
    chrome.storage.local.set({ pollEnabled });
    if (pollEnabled) {
      chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
    } else {
      chrome.alarms.clear(POLL_ALARM);
    }
    sendResponse({ ok: true, pollEnabled });
    return false;
  }
  if (msg.type === 'MANUAL_PUBLISH') {
    tryPullAndPublish()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async
  }
  if (msg.type === 'TEST_BRIDGE') {
    fetch(`${BRIDGE_URL}/health`)
      .then((r) => r.json())
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async
  }
  return false;
});

async function tryPullAndPublish() {
  console.log('[vc-publisher] polling bridge...');
  const resp = await fetch(`${BRIDGE_URL}/queue/next`).catch((err) => {
    console.log('[vc-publisher] bridge unreachable:', err.message);
    return null;
  });
  if (resp === null || !resp.ok) return { skipped: true, reason: 'bridge unreachable' };

  const payload = await resp.json();
  if (!payload.has_work) return { skipped: true, reason: 'no work' };

  console.log('[vc-publisher] got task:', payload.taskId);
  const result = await publishViaTab(payload);

  // Send result back.
  await fetch(`${BRIDGE_URL}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: payload.taskId, result }),
  }).catch((err) => console.error('[vc-publisher] result POST failed:', err));

  return result;
}

async function publishViaTab(payload) {
  // 1. Открыть vc.ru/?modal=editor - composer как modal над лентой.
  // Если modal не появится, content-main кликнет "Написать" как fallback.
  const tab = await chrome.tabs.create({
    url: 'https://vc.ru/?modal=editor',
    active: true,
  });
  const tabId = tab.id;
  if (tabId === undefined) throw new Error('failed to create tab');

  try {
    // 2. Ждать content-bridge ready (ping/pong).
    await waitForReady(tabId);
    console.log('[vc-publisher] tab ready, sending payload');

    // 3. Послать PUBLISH через bridge.
    const result = await sendWithTimeout(tabId, { type: 'PUBLISH', payload }, PUBLISH_TIMEOUT_MS);
    return result;
  } finally {
    // Tab оставляем открытой 30 секунд для визуальной проверки.
    setTimeout(() => {
      chrome.tabs.remove(tabId).catch(() => {});
    }, 30_000);
  }
}

async function waitForReady(tabId) {
  const deadline = Date.now() + TAB_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const reply = await chrome.tabs.sendMessage(tabId, { type: 'PING' }).catch(() => null);
    if (reply && reply.ready) return reply;
    await sleep(500);
  }
  throw new Error('content-bridge not ready within timeout');
}

async function sendWithTimeout(tabId, msg, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tab message timeout after ${timeoutMs}ms`)), timeoutMs);
    chrome.tabs
      .sendMessage(tabId, msg)
      .then((r) => {
        clearTimeout(timer);
        resolve(r);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
