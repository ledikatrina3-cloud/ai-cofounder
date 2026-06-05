// Тесты для bridge/routines-api.ts — helpers для /routines* эндпоинтов.
//
// Стратегия:
//   * In-memory better-sqlite3 БД с минимальной CREATE TABLE Record — не
//     поднимаем prisma-template, чтобы тесты были быстрыми (≈10ms) и не
//     зависели от миграций.
//   * Все helper'ы (computeNextRunAt, buildRoutineSummary, listRecentRuns,
//     buildTranscript) — чистые функции, принимают Database — тесты только
//     наполняют таблицу и проверяют выход.
//
// Что покрываем:
//   * computeNextRunAt — manual, валидный cron, invalid cron.
//   * deriveRoutineState/buildRoutineSummary — idle/running/failed,
//     lastRunAt/Status, last7DaysRunCount, nextRunAt для cron-routine'ы.
//   * listRecentRuns — pair trigger+end, totalUsd через time-window spend.
//   * buildTranscript — 404 для несуществующего, корректный chronological
//     порядок, level-2 deep parentId.

import Database from 'better-sqlite3';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type RoutineRecord,
  buildRoutineSummary,
  buildTranscript,
  computeNextRunAt,
  listRecentRuns,
} from '../bridge/routines-api.js';

// ---------------------------------------------------------------------------
// Helpers — поднимаем минимальную in-memory БД и наполняем Records.
// ---------------------------------------------------------------------------

interface InsertRecordArgs {
  id?: string;
  type: string;
  properties?: Record<string, unknown>;
  parentId?: string | null;
  createdAt?: number;
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  // Минимальная схема Record — только колонки, которые используют helper'ы.
  // Не повторяем CHECK constraints и триггеры immutability — тесты не
  // мутируют Records, только INSERT.
  db.exec(`
    CREATE TABLE "Record" (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      properties TEXT NOT NULL,
      parentId TEXT,
      actorKind TEXT NOT NULL DEFAULT 'agent',
      actorRef TEXT,
      subjectPagePath TEXT,
      createdAt INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'closed',
      closedAt INTEGER,
      closedReason TEXT,
      dueAt INTEGER,
      priority INTEGER,
      visibility TEXT NOT NULL DEFAULT 'autonomous',
      idempotencyKey TEXT UNIQUE
    );
    CREATE INDEX idx_record_type_createdat ON "Record"(type, createdAt DESC);
  `);
  return db;
}

function insertRecord(db: Database.Database, args: InsertRecordArgs): string {
  const id = args.id ?? ulid();
  const stmt = db.prepare(
    `INSERT INTO "Record" (id, type, properties, parentId, createdAt) VALUES (?, ?, ?, ?, ?)`,
  );
  stmt.run(
    id,
    args.type,
    JSON.stringify(args.properties ?? {}),
    args.parentId ?? null,
    args.createdAt ?? Date.now(),
  );
  return id;
}

function makeRoutineRecord(overrides: Partial<RoutineRecord> = {}): RoutineRecord {
  return {
    id: 'example-noop',
    projectId: 'example-project',
    enabled: true,
    trigger: 'manual',
    model: 'claude-sonnet-4-6',
    description: 'Test routine',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeNextRunAt.
// ---------------------------------------------------------------------------

describe('computeNextRunAt', () => {
  it('возвращает undefined для manual', () => {
    expect(computeNextRunAt('manual')).toBeUndefined();
  });

  it('считает следующий запуск для cron-trigger', () => {
    // Используем минутный cron, чтобы не зависеть от таймзоны test-runner'а.
    // На каждой минуте — следующий запуск ровно через ≤60сек от now.
    const now = new Date('2026-05-17T05:30:00Z');
    const next = computeNextRunAt('* * * * *', now);
    expect(next).toBeDefined();
    expect(next).toBeGreaterThan(now.getTime());
    expect(next).toBeLessThanOrEqual(now.getTime() + 60_000);
  });

  it('возвращает undefined для невалидной cron-строки', () => {
    expect(computeNextRunAt('not-a-cron')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildRoutineSummary — status derivation + 7-day count.
// ---------------------------------------------------------------------------

describe('buildRoutineSummary', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  const ROUTINE_ID = 'example-noop';
  const NOW = new Date('2026-05-17T12:00:00Z').getTime();

  it('routine без запусков → idle, last7DaysRunCount=0, без lastRunAt', () => {
    const summary = buildRoutineSummary(db, makeRoutineRecord(), NOW);
    expect(summary.status).toBe('idle');
    expect(summary.last7DaysRunCount).toBe(0);
    expect(summary.lastRunAt).toBeUndefined();
    expect(summary.lastRunStatus).toBeUndefined();
    expect(summary.nextRunAt).toBeUndefined();
  });

  it('routine с одним успешным запуском → idle, lastRunStatus=ok', () => {
    const triggerId = insertRecord(db, {
      type: 'event.routine.trigger',
      properties: { routineId: ROUTINE_ID, runDate: '2026-05-17' },
      createdAt: NOW - 60_000,
    });
    insertRecord(db, {
      type: 'audit.routine.start',
      properties: { routineId: ROUTINE_ID },
      parentId: triggerId,
      createdAt: NOW - 50_000,
    });
    insertRecord(db, {
      type: 'audit.routine.end',
      properties: { routineId: ROUTINE_ID, status: 'ok', durationMs: 10_000 },
      parentId: triggerId,
      createdAt: NOW - 40_000,
    });

    const summary = buildRoutineSummary(db, makeRoutineRecord(), NOW);
    expect(summary.status).toBe('idle');
    expect(summary.lastRunStatus).toBe('ok');
    expect(summary.lastRunAt).toBe(NOW - 40_000);
    expect(summary.last7DaysRunCount).toBe(1);
  });

  it('routine с running start (без end за окно <1ч) → status=running', () => {
    const triggerId = insertRecord(db, {
      type: 'event.routine.trigger',
      properties: { routineId: ROUTINE_ID, runDate: '2026-05-17' },
      createdAt: NOW - 30_000,
    });
    insertRecord(db, {
      type: 'audit.routine.start',
      properties: { routineId: ROUTINE_ID },
      parentId: triggerId,
      createdAt: NOW - 20_000,
    });
    // НЕТ audit.routine.end

    const summary = buildRoutineSummary(db, makeRoutineRecord(), NOW);
    expect(summary.status).toBe('running');
    // Если ни одного end'а нет — lastRunStatus не определён.
    expect(summary.lastRunStatus).toBeUndefined();
  });

  it('routine со start без end старше 1ч → status НЕ running (защита от висящих)', () => {
    const triggerId = insertRecord(db, {
      type: 'event.routine.trigger',
      properties: { routineId: ROUTINE_ID },
      createdAt: NOW - 90 * 60 * 1000, // 1.5 часа назад
    });
    insertRecord(db, {
      type: 'audit.routine.start',
      properties: { routineId: ROUTINE_ID },
      parentId: triggerId,
      createdAt: NOW - 90 * 60 * 1000,
    });
    // end отсутствует — но start старше 1 часа.

    const summary = buildRoutineSummary(db, makeRoutineRecord(), NOW);
    expect(summary.status).toBe('idle');
  });

  it('последний запуск failed → status=failed', () => {
    const triggerId = insertRecord(db, {
      type: 'event.routine.trigger',
      properties: { routineId: ROUTINE_ID },
      createdAt: NOW - 60_000,
    });
    insertRecord(db, {
      type: 'audit.routine.start',
      properties: { routineId: ROUTINE_ID },
      parentId: triggerId,
      createdAt: NOW - 50_000,
    });
    insertRecord(db, {
      type: 'audit.routine.end',
      properties: { routineId: ROUTINE_ID, status: 'failed', durationMs: 100 },
      parentId: triggerId,
      createdAt: NOW - 40_000,
    });

    const summary = buildRoutineSummary(db, makeRoutineRecord(), NOW);
    expect(summary.status).toBe('failed');
    expect(summary.lastRunStatus).toBe('failed');
  });

  it('last7DaysRunCount считает только starts в окне 7 дней', () => {
    // 1 запуск 3 дня назад.
    const t1 = insertRecord(db, {
      type: 'event.routine.trigger',
      properties: { routineId: ROUTINE_ID },
      createdAt: NOW - 3 * 24 * 60 * 60 * 1000,
    });
    insertRecord(db, {
      type: 'audit.routine.start',
      properties: { routineId: ROUTINE_ID },
      parentId: t1,
      createdAt: NOW - 3 * 24 * 60 * 60 * 1000,
    });
    // 1 запуск 10 дней назад — должен НЕ попасть.
    const t2 = insertRecord(db, {
      type: 'event.routine.trigger',
      properties: { routineId: ROUTINE_ID },
      createdAt: NOW - 10 * 24 * 60 * 60 * 1000,
    });
    insertRecord(db, {
      type: 'audit.routine.start',
      properties: { routineId: ROUTINE_ID },
      parentId: t2,
      createdAt: NOW - 10 * 24 * 60 * 60 * 1000,
    });

    const summary = buildRoutineSummary(db, makeRoutineRecord(), NOW);
    expect(summary.last7DaysRunCount).toBe(1);
  });

  it('routine с cron-trigger получает nextRunAt', () => {
    // Минутный cron — независим от таймзоны test-runner'а.
    const at = new Date('2026-05-17T05:30:00Z').getTime();
    const summary = buildRoutineSummary(db, makeRoutineRecord({ trigger: '* * * * *' }), at);
    expect(summary.nextRunAt).toBeDefined();
    expect(summary.nextRunAt).toBeGreaterThan(at);
    expect(summary.nextRunAt).toBeLessThanOrEqual(at + 60_000);
  });

  it('пробрасывает frontmatter-поля role/avatar/color', () => {
    const summary = buildRoutineSummary(
      db,
      makeRoutineRecord({ role: 'Детектив', avatar: '🕵️', color: '#a8e063' }),
      NOW,
    );
    expect(summary.role).toBe('Детектив');
    expect(summary.avatar).toBe('🕵️');
    expect(summary.color).toBe('#a8e063');
  });

  it('игнорирует Records ДРУГОЙ routine при определении статуса', () => {
    // start для ДРУГОЙ routine (other-id), не для нашего — не должен влиять.
    const triggerId = insertRecord(db, {
      type: 'event.routine.trigger',
      properties: { routineId: 'other-id' },
      createdAt: NOW - 30_000,
    });
    insertRecord(db, {
      type: 'audit.routine.start',
      properties: { routineId: 'other-id' },
      parentId: triggerId,
      createdAt: NOW - 20_000,
    });

    const summary = buildRoutineSummary(db, makeRoutineRecord(), NOW);
    expect(summary.status).toBe('idle');
    expect(summary.last7DaysRunCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listRecentRuns.
// ---------------------------------------------------------------------------

describe('listRecentRuns', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  const ROUTINE_ID = 'example-noop';
  const NOW = new Date('2026-05-17T12:00:00Z').getTime();

  it('пустой результат, если ни одного trigger нет', () => {
    const runs = listRecentRuns(db, ROUTINE_ID);
    expect(runs).toEqual([]);
  });

  it('возвращает trigger+end пару, durationMs/status из end.properties', () => {
    const triggerId = insertRecord(db, {
      type: 'event.routine.trigger',
      properties: { routineId: ROUTINE_ID },
      createdAt: NOW - 60_000,
    });
    insertRecord(db, {
      type: 'audit.routine.end',
      properties: { routineId: ROUTINE_ID, status: 'ok', durationMs: 12_345 },
      parentId: triggerId,
      createdAt: NOW - 40_000,
    });

    const runs = listRecentRuns(db, ROUTINE_ID);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggerId).toBe(triggerId);
    expect(runs[0]?.startedAt).toBe(NOW - 60_000);
    expect(runs[0]?.endedAt).toBe(NOW - 40_000);
    expect(runs[0]?.status).toBe('ok');
    expect(runs[0]?.durationMs).toBe(12_345);
  });

  it('суммирует totalUsd по audit.spend в окне (startedAt..endedAt) по routineId', () => {
    const triggerId = insertRecord(db, {
      type: 'event.routine.trigger',
      properties: { routineId: ROUTINE_ID },
      createdAt: NOW - 60_000,
    });
    // Два spend'а в окне.
    insertRecord(db, {
      type: 'audit.spend',
      properties: { routineId: ROUTINE_ID, usd: 0.01 },
      createdAt: NOW - 55_000,
    });
    insertRecord(db, {
      type: 'audit.spend',
      properties: { routineId: ROUTINE_ID, usd: 0.05 },
      createdAt: NOW - 45_000,
    });
    insertRecord(db, {
      type: 'audit.routine.end',
      properties: { routineId: ROUTINE_ID, status: 'ok', durationMs: 100 },
      parentId: triggerId,
      createdAt: NOW - 40_000,
    });
    // Spend ВНЕ окна (после end'а) — не должен попасть.
    insertRecord(db, {
      type: 'audit.spend',
      properties: { routineId: ROUTINE_ID, usd: 100 },
      createdAt: NOW - 1000,
    });

    const runs = listRecentRuns(db, ROUTINE_ID);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.totalUsd).toBeCloseTo(0.06, 5);
    expect(runs[0]?.toolCallCount).toBe(2);
  });

  it('сортирует DESC по startedAt и ограничивает limit', () => {
    for (let i = 0; i < 5; i++) {
      insertRecord(db, {
        type: 'event.routine.trigger',
        properties: { routineId: ROUTINE_ID },
        createdAt: NOW - i * 60_000,
      });
    }
    const runs = listRecentRuns(db, ROUTINE_ID, 3);
    expect(runs).toHaveLength(3);
    // Первый — самый свежий.
    expect(runs[0]?.startedAt).toBeGreaterThan(runs[1]?.startedAt ?? 0);
    expect(runs[1]?.startedAt).toBeGreaterThan(runs[2]?.startedAt ?? 0);
  });

  it('ещё-бегущий запуск (без end) имеет toolCallCount но НЕ endedAt', () => {
    const triggerId = insertRecord(db, {
      type: 'event.routine.trigger',
      properties: { routineId: ROUTINE_ID },
      createdAt: NOW - 30_000,
    });
    insertRecord(db, {
      type: 'audit.spend',
      properties: { routineId: ROUTINE_ID, usd: 0.02 },
      createdAt: NOW - 25_000,
    });

    const runs = listRecentRuns(db, ROUTINE_ID);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggerId).toBe(triggerId);
    expect(runs[0]?.endedAt).toBeUndefined();
    expect(runs[0]?.status).toBeUndefined();
    expect(runs[0]?.toolCallCount).toBe(1);
    expect(runs[0]?.totalUsd).toBeCloseTo(0.02, 5);
  });
});

// ---------------------------------------------------------------------------
// buildTranscript.
// ---------------------------------------------------------------------------

describe('buildTranscript', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  const ROUTINE_ID = 'example-noop';
  const NOW = new Date('2026-05-17T12:00:00Z').getTime();

  it('возвращает null для несуществующего triggerId', () => {
    expect(buildTranscript(db, 'nonexistent')).toBeNull();
  });

  it('возвращает trigger как первое событие + children по chronological', () => {
    const triggerId = insertRecord(db, {
      type: 'event.routine.trigger',
      properties: { routineId: ROUTINE_ID, runDate: '2026-05-17' },
      createdAt: NOW - 100,
    });
    insertRecord(db, {
      type: 'audit.routine.start',
      properties: { routineId: ROUTINE_ID },
      parentId: triggerId,
      createdAt: NOW - 90,
    });
    insertRecord(db, {
      type: 'audit.routine.end',
      properties: { routineId: ROUTINE_ID, status: 'ok' },
      parentId: triggerId,
      createdAt: NOW - 10,
    });

    const events = buildTranscript(db, triggerId);
    expect(events).not.toBeNull();
    expect(events).toHaveLength(3);
    expect(events?.[0]?.type).toBe('event.routine.trigger');
    expect(events?.[1]?.type).toBe('audit.routine.start');
    expect(events?.[2]?.type).toBe('audit.routine.end');
    // properties — парсированный JSON.
    expect(events?.[0]?.properties).toMatchObject({ routineId: ROUTINE_ID });
  });

  it('идёт 2 уровня вглубь (grandchildren через parentId chain)', () => {
    const triggerId = insertRecord(db, {
      type: 'event.routine.trigger',
      properties: { routineId: ROUTINE_ID },
      createdAt: NOW - 100,
    });
    const startId = insertRecord(db, {
      type: 'audit.routine.start',
      properties: { routineId: ROUTINE_ID },
      parentId: triggerId,
      createdAt: NOW - 90,
    });
    // Внук: spend с parentId = audit.routine.start. Сегодня в коде spend
    // пишется с parentId=null, но buildTranscript уже готов к будущему,
    // когда spend начнёт линковать на start.
    insertRecord(db, {
      type: 'audit.spend',
      properties: { usd: 0.01 },
      parentId: startId,
      createdAt: NOW - 80,
    });

    const events = buildTranscript(db, triggerId);
    expect(events?.map((e) => e.type)).toEqual([
      'event.routine.trigger',
      'audit.routine.start',
      'audit.spend',
    ]);
  });

  it('возвращает 404-сигнал (null) если triggerId не event.routine.trigger', () => {
    // Записываем ULID, но НЕ как event.routine.trigger (другой тип).
    const id = insertRecord(db, {
      type: 'audit.routine.start',
      properties: { routineId: ROUTINE_ID },
      createdAt: NOW,
    });
    expect(buildTranscript(db, id)).toBeNull();
  });
});
