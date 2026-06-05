import { useEffect, useMemo, useState } from 'react';
import type { BridgeEvent } from '../../../events.js';

export type AgentStatus = 'idle' | 'thinking' | 'executing';

// Типы событий, которые меняют статус агента.
const STATUS_MAP: Partial<Record<BridgeEvent['type'], AgentStatus>> = {
  'routine.start': 'executing',
  'tool.start': 'executing',
  'subagent.start': 'thinking',
  'solve.start': 'thinking',
  'investigate.batch.start': 'thinking',
  'routine.end': 'idle',
  'subagent.end': 'idle',
  'runIteration.end': 'idle',
  'solve.end': 'idle',
};

const IDLE_TIMEOUT_MS = 10_000;

export function useAgentStatus(events: BridgeEvent[]): AgentStatus {
  // Вычисляем статус из последнего релевантного события.
  const statusFromEvents = useMemo<AgentStatus>(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev === undefined) continue;
      const mapped = STATUS_MAP[ev.type];
      if (mapped !== undefined) return mapped;
    }
    return 'idle';
  }, [events]);

  const [status, setStatus] = useState<AgentStatus>(statusFromEvents);

  // Синхронизируем статус с вычисленным значением.
  useEffect(() => {
    setStatus(statusFromEvents);
  }, [statusFromEvents]);

  // Если статус не idle — ставим таймер на сброс через 10 сек без новых событий.
  useEffect(() => {
    if (statusFromEvents === 'idle') return;

    const timer = setTimeout(() => {
      setStatus('idle');
    }, IDLE_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [statusFromEvents]);

  return status;
}
