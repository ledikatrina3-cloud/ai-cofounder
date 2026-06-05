// E2E-тесты идемпотентности dispatcher'а (фаза 3.4 нового плана `routines.md`).
//
// Цель: проверить, что dispatcher НЕ вызывает executeRoutine дважды для одного
// и того же (routineId, runDate, trigger.idempotencyKey), и что аудит-записи
// пишутся ровно один раз при повторе (audit.repeat, без дубля audit.routine.start).
//
// Стратегия:
//   * Изолированная БД через template.db + cp (паттерн `tests/fixtures/isolated-db.ts`).
//   * vi.mock на src/observe/bridge.js — emit'ы проверяем, без сетевых вызовов.
//   * executeRoutineImpl — vi.fn(), считаем количество вызовов.
//   * Если dispatcher интегрирует report.send (фаза 3.3) через deps — мокируем.
//     Пока 3.3 не добавила его в RunRoutineDeps — мокируем только executeRoutine.
//   * getRoutine / getProject — DI через RunRoutineDeps, fixture-driven.

import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunRoutineDeps, runRoutine } from '../src/core/dispatcher.js';
import { triggerCronRoutine, triggerManualRoutine } from '../src/core/triggers.js';
import type { ProjectMeta } from '../src/projects/registry.js';
import type { Routine } from '../src/routines/parser.js';
import type { RoutineResult } from '../src/routines/runtime.js';
import {
  type IsolatedDb,
  type TemplateHandle,
  createIsolatedDb,
  setupTemplateDb,
} from './fixtures/isolated-db.js';

vi.mock('../src/observe/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/observe/bridge.js')>();
  return {
    ...actual,
    emit: vi.fn().mockResolvedValue(undefined),
  };
});

import { emit } from '../src/observe/bridge.js';

// ---------------------------------------------------------------------------
// Test rig.
// ---------------------------------------------------------------------------

let template: TemplateHandle;
let isolated: IsolatedDb;

beforeAll(() => {
  template = setupTemplateDb();
});

afterAll(() => {
  template.dispose();
});

beforeEach(async () => {
  vi.mocked(emit).mockClear();
  isolated = await createIsolatedDb(template);
});

afterEach(async () => {
  await isolated.dispose();
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const RUN_DATE = '2026-05-02';
const ROUTINE_ID = 'example-noop';
const PROJECT_ID = 'example-project';

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: ROUTINE_ID,
    projectId: PROJECT_ID,
    enabled: true,
    trigger: 'manual',
    tools: [],
    model: 'claude-sonnet-4-6',
    maxTokens: 100_000,
    timeoutMs: 300_000,
    outputType: 'journal-only',
    description: 'fixture routine',
    prompt: 'noop',
    filePath: '/tmp/fake-routine.md',
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectMeta> = {}): ProjectMeta {
  return {
    id: PROJECT_ID,
    name: 'Acme Academy',
    path: '/tmp/fake-project',
    enabled: true,
    mapPath: 'projects/example-project/map.md',
    routinesGlob: 'routines/example-project-*.md',
    ...overrides,
  };
}

function fakeRegistry(args: {
  routines?: Map<string, Routine>;
  projects?: Map<string, ProjectMeta>;
}): {
  getRoutine: (id: string) => Promise<Routine | null>;
  getProject: (id: string) => Promise<ProjectMeta | null>;
} {
  const routines = args.routines ?? new Map();
  const projects = args.projects ?? new Map();
  return {
    getRoutine: async (id: string) => routines.get(id) ?? null,
    getProject: async (id: string) => projects.get(id) ?? null,
  };
}

function makeNoopExecuteRoutineFn(
  statusOverride: RoutineResult['status'] = 'ok',
): (...args: unknown[]) => Promise<RoutineResult> {
  return async () => ({
    status: statusOverride,
    output: '',
    totalUsd: 0,
    totalTokens: 0,
    durationMs: 10,
    toolCallCount: 0,
    spendRecordId: null,
  });
}

async function countRecords(db: PrismaClient, type: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n FROM "Record" WHERE type = ?`,
    type,
  );
  return Number(rows[0]?.n ?? 0n);
}

// ---------------------------------------------------------------------------
// Кейс 1. Один запуск → executeRoutine вызван ровно 1 раз.
//          audit.routine.start = 1, audit.routine.end = 1, audit.repeat = 0.
// ---------------------------------------------------------------------------

describe('routine-idempotency-e2e — кейс 1: один запуск', () => {
  it('один запуск → executeRoutine вызван 1 раз, нет audit.repeat', async () => {
    const execFn = vi.fn(makeNoopExecuteRoutineFn('ok'));

    const registry = fakeRegistry({
      routines: new Map([[ROUTINE_ID, makeRoutine()]]),
      projects: new Map([[PROJECT_ID, makeProject()]]),
    });
    const trigger = triggerManualRoutine(ROUTINE_ID);

    await runRoutine(ROUTINE_ID, RUN_DATE, trigger, {
      db: isolated.prisma,
      ...registry,
      executeRoutineImpl: execFn as RunRoutineDeps['executeRoutineImpl'],
    });

    // executeRoutine вызван ровно 1 раз.
    expect(execFn).toHaveBeenCalledTimes(1);

    // DB-инварианты.
    expect(await countRecords(isolated.prisma, 'event.routine.trigger')).toBe(1);
    expect(await countRecords(isolated.prisma, 'audit.routine.start')).toBe(1);
    expect(await countRecords(isolated.prisma, 'audit.routine.end')).toBe(1);
    expect(await countRecords(isolated.prisma, 'audit.repeat')).toBe(0);
    expect(await countRecords(isolated.prisma, 'audit.routine.skipped')).toBe(0);

    // Bridge видит routine.start + routine.end status='ok'.
    const calls = vi.mocked(emit).mock.calls.map(([ev]) => ev);
    expect(calls.find((c) => c.type === 'routine.start')).toBeDefined();
    const endEvent = calls.find((c) => c.type === 'routine.end');
    expect(endEvent).toBeDefined();
    if (endEvent?.type === 'routine.end') {
      expect(endEvent.status).toBe('ok');
    }
  });
});

// ---------------------------------------------------------------------------
// Кейс 2. Два запуска с одинаковым cron-trigger (same idempotencyKey) →
//          executeRoutine вызван 1 раз, audit.repeat = 1.
// ---------------------------------------------------------------------------

describe('routine-idempotency-e2e — кейс 2: повтор с одним idempotencyKey', () => {
  it('два запуска с одним cron-trigger → executeRoutine 1 раз, audit.repeat = 1', async () => {
    const execFn = vi.fn(makeNoopExecuteRoutineFn('ok'));

    const registry = fakeRegistry({
      routines: new Map([[ROUTINE_ID, makeRoutine()]]),
      projects: new Map([[PROJECT_ID, makeProject()]]),
    });

    // Один и тот же cron-trigger с фиксированной датой → одинаковый idempotencyKey.
    const trigger = triggerCronRoutine(ROUTINE_ID, new Date('2026-05-02T07:00:00Z'));

    const deps: RunRoutineDeps = {
      db: isolated.prisma,
      ...registry,
      executeRoutineImpl: execFn as RunRoutineDeps['executeRoutineImpl'],
    };

    // Первый запуск — принят.
    await runRoutine(ROUTINE_ID, RUN_DATE, trigger, deps);
    // Второй запуск — дубль (одинаковый idempotencyKey).
    await runRoutine(ROUTINE_ID, RUN_DATE, trigger, deps);

    // executeRoutine вызван ТОЛЬКО ОДИН РАЗ: второй запуск поймал repeat раньше.
    expect(execFn).toHaveBeenCalledTimes(1);

    // audit.repeat = 1, event.routine.trigger = 1 (не задублировался).
    expect(await countRecords(isolated.prisma, 'event.routine.trigger')).toBe(1);
    expect(await countRecords(isolated.prisma, 'audit.routine.start')).toBe(1);
    expect(await countRecords(isolated.prisma, 'audit.routine.end')).toBe(1);
    expect(await countRecords(isolated.prisma, 'audit.repeat')).toBe(1);

    // emit routine.end status='repeat' присутствует (второй emit от dispatcher при repeat-ветке).
    const calls = vi.mocked(emit).mock.calls.map(([ev]) => ev);
    const endEvents = calls.filter((c) => c.type === 'routine.end');
    // Два routine.end: первый status='ok', второй status='repeat'.
    expect(endEvents).toHaveLength(2);
    const repeatEnd = endEvents.find((e) => e.type === 'routine.end' && e.status === 'repeat');
    expect(repeatEnd).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Кейс 3. Два запуска с разными manual-trigger (разные idempotencyKey) →
//          executeRoutine вызван 2 раза, audit.repeat = 0.
// ---------------------------------------------------------------------------

describe('routine-idempotency-e2e — кейс 3: два разных manual-trigger', () => {
  it('два manual-trigger с разными ULID → executeRoutine 2 раза, audit.repeat = 0', async () => {
    const execFn = vi.fn(makeNoopExecuteRoutineFn('ok'));

    const registry = fakeRegistry({
      routines: new Map([[ROUTINE_ID, makeRoutine()]]),
      projects: new Map([[PROJECT_ID, makeProject()]]),
    });

    // triggerManualRoutine генерирует уникальный ULID каждый раз.
    const triggerA = triggerManualRoutine(ROUTINE_ID);
    const triggerB = triggerManualRoutine(ROUTINE_ID);
    expect(triggerA.idempotencyKey).not.toBe(triggerB.idempotencyKey);

    const depsBase: RunRoutineDeps = {
      db: isolated.prisma,
      ...registry,
      executeRoutineImpl: execFn as RunRoutineDeps['executeRoutineImpl'],
    };

    await runRoutine(ROUTINE_ID, RUN_DATE, triggerA, depsBase);
    await runRoutine(ROUTINE_ID, RUN_DATE, triggerB, depsBase);

    // executeRoutine вызван ДВА РАЗА (разные ключи → оба accepted).
    expect(execFn).toHaveBeenCalledTimes(2);

    expect(await countRecords(isolated.prisma, 'event.routine.trigger')).toBe(2);
    expect(await countRecords(isolated.prisma, 'audit.routine.start')).toBe(2);
    expect(await countRecords(isolated.prisma, 'audit.routine.end')).toBe(2);
    expect(await countRecords(isolated.prisma, 'audit.repeat')).toBe(0);
    expect(await countRecords(isolated.prisma, 'audit.routine.skipped')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Кейс 4. Routine disabled → executeRoutine НЕ вызван, audit.routine.skipped = 1.
// ---------------------------------------------------------------------------

describe('routine-idempotency-e2e — кейс 4: routine disabled', () => {
  it('routine.enabled=false → executeRoutine не вызван, audit.routine.skipped = 1', async () => {
    const execFn = vi.fn(makeNoopExecuteRoutineFn('ok'));

    const registry = fakeRegistry({
      routines: new Map([[ROUTINE_ID, makeRoutine({ enabled: false })]]),
      projects: new Map([[PROJECT_ID, makeProject()]]),
    });
    const trigger = triggerManualRoutine(ROUTINE_ID);

    await runRoutine(ROUTINE_ID, RUN_DATE, trigger, {
      db: isolated.prisma,
      ...registry,
      executeRoutineImpl: execFn as RunRoutineDeps['executeRoutineImpl'],
    });

    // executeRoutine НЕ вызван.
    expect(execFn).toHaveBeenCalledTimes(0);

    // Нет event.routine.trigger, только skipped.
    expect(await countRecords(isolated.prisma, 'event.routine.trigger')).toBe(0);
    expect(await countRecords(isolated.prisma, 'audit.routine.start')).toBe(0);
    expect(await countRecords(isolated.prisma, 'audit.routine.end')).toBe(0);
    expect(await countRecords(isolated.prisma, 'audit.repeat')).toBe(0);
    expect(await countRecords(isolated.prisma, 'audit.routine.skipped')).toBe(1);

    // Bridge видит routine.end status='skipped'.
    const calls = vi.mocked(emit).mock.calls.map(([ev]) => ev);
    const endEvent = calls.find((c) => c.type === 'routine.end');
    expect(endEvent).toBeDefined();
    if (endEvent?.type === 'routine.end') {
      expect(endEvent.status).toBe('skipped');
      expect(endEvent.reason).toBe('routine-disabled');
    }
  });
});

// ---------------------------------------------------------------------------
// Кейс 5. Project not found → executeRoutine НЕ вызван, audit.routine.skipped = 1.
// ---------------------------------------------------------------------------

describe('routine-idempotency-e2e — кейс 5: project not found', () => {
  it('project не найден → executeRoutine не вызван, audit.routine.skipped = 1', async () => {
    const execFn = vi.fn(makeNoopExecuteRoutineFn('ok'));

    const registry = fakeRegistry({
      // routine ссылается на projectId='ghost', которого нет в projects.
      routines: new Map([[ROUTINE_ID, makeRoutine({ projectId: 'ghost' })]]),
      projects: new Map(), // ghost не существует → null.
    });
    const trigger = triggerManualRoutine(ROUTINE_ID);

    await runRoutine(ROUTINE_ID, RUN_DATE, trigger, {
      db: isolated.prisma,
      ...registry,
      executeRoutineImpl: execFn as RunRoutineDeps['executeRoutineImpl'],
    });

    // executeRoutine НЕ вызван.
    expect(execFn).toHaveBeenCalledTimes(0);

    expect(await countRecords(isolated.prisma, 'event.routine.trigger')).toBe(0);
    expect(await countRecords(isolated.prisma, 'audit.routine.start')).toBe(0);
    expect(await countRecords(isolated.prisma, 'audit.routine.end')).toBe(0);
    expect(await countRecords(isolated.prisma, 'audit.routine.skipped')).toBe(1);

    // Bridge видит routine.end status='skipped' reason='project-not-found'.
    const calls = vi.mocked(emit).mock.calls.map(([ev]) => ev);
    const endEvent = calls.find((c) => c.type === 'routine.end');
    expect(endEvent).toBeDefined();
    if (endEvent?.type === 'routine.end') {
      expect(endEvent.status).toBe('skipped');
      expect(endEvent.reason).toBe('project-not-found');
    }
  });
});
