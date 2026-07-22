import { useMemo } from 'react';
import type { BridgeEvent, RoutineEndStatus } from '../../../events.js';

export interface RoutineRun {
  routineId: string;
  runDate: string;
  status?: RoutineEndStatus;
  durationMs?: number;
}

const MAX_RUNS = 10;

export function useRoutineRuns(events: BridgeEvent[]): RoutineRun[] {
  return useMemo<RoutineRun[]>(() => {
    // Собираем карту прогонов по ключу `routineId:runDate`.
    const runs = new Map<string, RoutineRun>();
    // Порядок появления ключей (для сортировки по времени).
    const order: string[] = [];

    for (const ev of events) {
      if (ev.type === 'routine.start') {
        const key = `${ev.routineId}:${ev.runDate}`;
        if (!runs.has(key)) {
          order.push(key);
          runs.set(key, { routineId: ev.routineId, runDate: ev.runDate });
        }
      } else if (ev.type === 'routine.end') {
        const key = `${ev.routineId}:${ev.runDate}`;
        const existing = runs.get(key);
        if (existing !== undefined) {
          runs.set(key, { ...existing, status: ev.status, durationMs: ev.durationMs });
        } else {
          // routine.end без предшествующего routine.start — добавляем как есть.
          order.push(key);
          runs.set(key, {
            routineId: ev.routineId,
            runDate: ev.runDate,
            status: ev.status,
            durationMs: ev.durationMs,
          });
        }
      }
    }

    // Берём последние MAX_RUNS прогонов в порядке появления.
    return order.slice(-MAX_RUNS).map((key) => runs.get(key) as RoutineRun);
  }, [events]);
}
