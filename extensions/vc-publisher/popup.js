// popup.js - UI для manual testing.

const statusEl = document.getElementById('status');
const pollToggle = document.getElementById('pollToggle');
const manualBtn = document.getElementById('manualPublish');
const testBtn = document.getElementById('testBridge');
const editorBtn = document.getElementById('openEditor');

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = 'status ' + cls;
}

// Init: load current state.
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
  if (state) {
    pollToggle.checked = state.pollEnabled === true;
    setStatus(`bridge: ${state.bridgeUrl}`);
  }
});

pollToggle.addEventListener('change', () => {
  chrome.runtime.sendMessage(
    { type: 'SET_POLL_ENABLED', enabled: pollToggle.checked },
    (r) => {
      if (r?.ok) setStatus(`poll: ${pollToggle.checked ? 'включен' : 'выключен'}`, 'ok');
      else setStatus('ошибка переключения', 'err');
    },
  );
});

manualBtn.addEventListener('click', () => {
  setStatus('публикую...', '');
  manualBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'MANUAL_PUBLISH' }, (r) => {
    manualBtn.disabled = false;
    if (r?.ok) {
      const result = r.result;
      if (result?.skipped) setStatus(`пропущено: ${result.reason}`, 'err');
      else if (result?.success && result?.url) setStatus(`✓ ${result.url}`, 'ok');
      else setStatus(`результат: ${JSON.stringify(result)}`, '');
    } else {
      setStatus(`ошибка: ${r?.error}`, 'err');
    }
  });
});

testBtn.addEventListener('click', () => {
  setStatus('проверяю bridge...', '');
  chrome.runtime.sendMessage({ type: 'TEST_BRIDGE' }, (r) => {
    if (r?.ok) setStatus(`✓ bridge: ${JSON.stringify(r.data)}`, 'ok');
    else setStatus(`✗ ${r?.error || 'unreachable'}`, 'err');
  });
});

editorBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://vc.ru/?modal=editor', active: true });
  window.close();
});
