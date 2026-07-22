// Wave 2: polling-hook поверх GET /routines.
//
// Используется в OfficeScene (через Wave 3-orchestrator) для рендера человечков
// в офисе. Каждые 5 сек делаем fetch, маппим RoutineSummary → WorkerData (то
// что нужно 3D-сцене), и одновременно возвращаем сырые `summaries` — нужны
// Drawer'у и тулбару (метаданные, last7DaysRunCount, nextRunAt и т.п.).
//
// Поведение при ошибках: оставляем последние успешные `workers` (не моргаем
// пустотой), только пишем `error`. Это критично, потому что иначе при кратком
// 500 сцена «исчезала» бы.

import { useEffect, useState } from 'react';
import type { WorkerData, WorkerStatus } from '../components/Office/types.js';

// Зеркало RoutineSummary из bridge/routines-api.ts. Дублируем, чтобы фронт не
// зависел от node-only модуля (bridge/routines-api.ts тянет better-sqlite3 и
// cron-parser). Точно те же поля.
export type RoutineStatus = 'idle' | 'running' | 'failed';
export type RoutineRunStatus = 'ok' | 'failed' | 'noop';

export interface RoutineSummary {
  id: string;
  projectId: string;
  departmentId?: string;
  enabled: boolean;
  trigger: string;
  model: string;
  description: string;
  role?: string;
  avatar?: string;
  color?: string;
  logo?: string;
  status: RoutineStatus;
  lastRunAt?: number;
  lastRunStatus?: RoutineRunStatus;
  nextRunAt?: number;
  last7DaysRunCount: number;
}

export interface UseRoutinesOptions {
  /** Если задано — оставить только routines с этим departmentId. */
  departmentId?: string;
  /** Меняется извне (после create/edit/delete) — форсит немедленный re-fetch. */
  refreshKey?: number;
}

export interface UseRoutinesResult {
  workers: WorkerData[];
  summaries: RoutineSummary[];
  loading: boolean;
  error: string | null;
}

const POLL_MS = 5000;
const BRIDGE_URL = 'http://127.0.0.1:3737';
const PALETTE = ['#d97757', '#7c9eb2', '#c4a747', '#9ca77c', '#7cb29a', '#a77c9c', '#b25555'];

/** Стабильный hash-цвет из id, тот же алгоритм, что в Worker.tsx — но локальный. */
function colorFromId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length] ?? '#d97757';
}

function toWorkerData(s: RoutineSummary): WorkerData {
  // status: backend возвращает 'idle'|'running'|'failed' — те же литералы, что
  // первые три значения WorkerStatus. 'finished' рождается только из live-events
  // (useWorkerEvents), не из polling'а.
  const status: WorkerStatus = s.status;
  const data: WorkerData = {
    id: s.id,
    role: s.role ?? s.id,
    color: s.color ?? colorFromId(s.id),
    status,
  };
  if (s.avatar !== undefined) data.avatar = s.avatar;
  if (s.logo !== undefined) data.logo = s.logo;
  if (s.nextRunAt !== undefined) data.nextRunAt = s.nextRunAt;
  return data;
}

export function useRoutines(options: UseRoutinesOptions = {}): UseRoutinesResult {
  const { departmentId, refreshKey } = options;
  const [workers, setWorkers] = useState<WorkerData[]>([]);
  const [summaries, setSummaries] = useState<RoutineSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey — trigger-only, внутри эффекта не читается, но его смена обязана форсить немедленный re-fetch
  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const res = await fetch(`${BRIDGE_URL}/routines`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {
          ok: boolean;
          items?: RoutineSummary[];
          error?: string;
        };
        if (cancelled) return;
        if (body.ok && Array.isArray(body.items)) {
          const filtered =
            departmentId !== undefined
              ? body.items.filter((s) => s.departmentId === departmentId)
              : body.items;
          setSummaries(filtered);
          setWorkers(filtered.map(toWorkerData));
          setError(null);
        } else {
          setError(body.error ?? 'unknown error');
        }
      } catch (err) {
        if (cancelled) return;
        // Сетевой сбой / bridge не поднят: оставляем последние workers, фиксируем error.
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    const interval = setInterval(() => {
      void load();
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [departmentId, refreshKey]);

  return { workers, summaries, loading, error };
}
