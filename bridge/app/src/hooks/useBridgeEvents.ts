import { useSyncExternalStore } from 'react';
import type { BridgeEvent } from '../../../events.js';

const MAX = 500;

// Singleton state — один EventSource на всё приложение.
const subscribers = new Set<() => void>();
let events: BridgeEvent[] = [];
let es: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function notify(): void {
  for (const cb of subscribers) cb();
}

function connect(): void {
  if (es !== null) {
    es.close();
    es = null;
  }
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const source = new EventSource('http://127.0.0.1:3737/stream');

  const onSseEvent = (e: MessageEvent<string>): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(e.data);
    } catch {
      return;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).type !== 'string' ||
      typeof (parsed as Record<string, unknown>).ts !== 'number'
    ) {
      return;
    }
    const event = parsed as BridgeEvent;
    const next = events.length >= MAX ? [...events.slice(1), event] : [...events, event];
    events = next;
    notify();
  };

  // bridge/server.ts отправляет SSE с явным `event:<type>` (см. server.ts:692).
  // Браузерный EventSource при наличии `event:` НЕ вызывает onmessage — только
  // именованный addEventListener. Регистрируем хендлеры на все известные типы
  // из bridge/events.ts. Список держим в синхроне с BridgeEvent union: новые
  // типы добавляются вручную тут.
  const SSE_EVENT_TYPES = [
    'event.trigger',
    'audit.repeat',
    'subagent.start',
    'subagent.end',
    'tool.start',
    'tool.end',
    'tool.error',
    'assistant.message',
    'assistant.thinking',
    'audit.spend',
    'audit.budget.deny',
    'audit.security.allow',
    'audit.security.deny',
    'bot.start',
    'support.fetch.start',
    'support.fetch.end',
    'triage.start',
    'triage.end',
    'merge.start',
    'merge.end',
    'investigate.start',
    'investigate.end',
    'solve.start',
    'solve.end',
    'report.send',
    'runIteration.start',
    'runIteration.end',
    'runIteration.step',
    'routine.start',
    'routine.end',
  ];
  for (const t of SSE_EVENT_TYPES) {
    source.addEventListener(t, onSseEvent as EventListener);
  }
  // Fallback на дефолтный onmessage (если когда-то backend начнёт слать без event:).
  source.onmessage = onSseEvent;

  source.onerror = () => {
    source.close();
    es = null;
    // Переподключение через 2 секунды, если есть подписчики.
    if (subscribers.size > 0) {
      reconnectTimer = setTimeout(connect, 2000);
    }
  };

  es = source;
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  // Первый подписчик — открываем соединение.
  if (subscribers.size === 1 && es === null) {
    connect();
  }
  return () => {
    subscribers.delete(cb);
    // Последний подписчик ушёл — закрываем соединение.
    if (subscribers.size === 0) {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (es !== null) {
        es.close();
        es = null;
      }
    }
  };
}

function getSnapshot(): BridgeEvent[] {
  return events;
}

export function useBridgeEvents(): BridgeEvent[] {
  return useSyncExternalStore(subscribe, getSnapshot);
}
