// Mock-данные для Wave 1B. В Wave 2 заменим на live-данные из /routines.
//
// Цвета подобраны под палитру bridge (см. bridge/server.ts).
// 5 worker'ов = чуть больше, чем 4 routine'а в плане, чтобы проверить layout 3x2.

import type { WorkerData } from './types.js';

export const MOCK_WORKERS: WorkerData[] = [
  {
    id: 'example-project-support-triage',
    role: 'Поддержка',
    color: '#d97757',
    status: 'idle',
  },
  {
    id: 'example-project-db-morning-triage',
    role: 'DB-аналитик',
    color: '#7c9eb2',
    status: 'running',
  },
  {
    id: 'example-project-metrics-weekly',
    role: 'Метрики',
    color: '#c4a747',
    status: 'idle',
  },
  {
    id: 'example-project-critical-alerts',
    role: 'Алертер',
    color: '#b25555',
    status: 'failed',
  },
  {
    id: 'example-project-example-noop',
    role: 'Stub',
    color: '#7c4a2e',
    status: 'idle',
  },
];
