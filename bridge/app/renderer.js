// Renderer для Bridge UI. Источник правды — Bridge event-bus, доставленный
// через SSE (/stream). DOM перерисовывается на каждом событии — эквивалент
// useSyncExternalStore-шаблона без React-рантайма.
//
// SECURITY (R1, security-review 1.5b):
//   * НИКАКОГО innerHTML — только createElement + textContent. Любой type/
//     idempotencyKey/etc. event — это НЕ-доверенный input, мог прийти от
//     стороннего локального процесса (мостик.md L271 «граница доверия»).
//   * CSP в index.html запрещает 'unsafe-inline' для script-src — этот файл
//     грузится через <script src="...">, не inline.
//   * Никакого eval'а / new Function() / location-mutation на основании event'а.

(() => {
  const list = document.getElementById('events');
  const empty = document.getElementById('empty');
  const status = document.getElementById('status');
  const port = document.getElementById('port');

  const url = new URL(window.location.href);
  const bridgePort = url.port || '3737';
  if (port) port.textContent = bridgePort;

  function summaryFor(event) {
    if (event.type === 'event.trigger') {
      return `trigger source=${event.triggerSource || '?'} key=${event.idempotencyKey || '?'}`;
    }
    if (event.type === 'audit.repeat') {
      return `repeat key=${event.idempotencyKey || '?'} → ${event.existingTriggerId || '?'}`;
    }
    if (typeof event.type === 'string' && event.type.startsWith('subagent.')) {
      return `${event.subagentType || ''} ${event.subagentId || ''}`.trim();
    }
    if (typeof event.type === 'string' && event.type.startsWith('tool.')) {
      return `${event.name || event.toolId || ''}`.trim();
    }
    try {
      return JSON.stringify(event).slice(0, 200);
    } catch {
      return '(unserialisable event)';
    }
  }

  function appendEvent(event) {
    if (empty?.parentNode) empty.remove();

    const li = document.createElement('li');

    const tsSpan = document.createElement('span');
    tsSpan.className = 'ts';
    const tsValue = typeof event.ts === 'number' ? event.ts : Date.now();
    tsSpan.textContent = new Date(tsValue).toISOString().slice(11, 23);

    const typeSpan = document.createElement('span');
    typeSpan.className = 'type';
    typeSpan.textContent = typeof event.type === 'string' ? event.type : '?';

    const summarySpan = document.createElement('span');
    summarySpan.className = 'summary';
    summarySpan.textContent = summaryFor(event);

    li.append(tsSpan, typeSpan, summarySpan);
    list.prepend(li);
  }

  const es = new EventSource('/stream');
  es.onopen = () => {
    if (status) status.textContent = 'online';
  };
  es.onerror = () => {
    if (status) status.textContent = 'reconnecting...';
  };
  es.onmessage = (msg) => {
    let event;
    try {
      event = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (typeof event !== 'object' || event === null) return;
    appendEvent(event);
  };
})();
