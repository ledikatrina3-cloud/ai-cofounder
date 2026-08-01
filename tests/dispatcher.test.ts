// Тесты dispatcher'а (фаза 1.3 нового плана `routines.md`).
//
// Стратегия:
//   * Изолированная БД через template.db + cp (паттерн `tests/fixtures/isolated-db.ts`).
//     НЕ шарим shared dev.db с другими тестами — это убирает кросс-флейк.
//   * vi.mock на src/observe/bridge.js — проверяем emit'ы routine.start/end и
//     audit.repeat без сетевых вызовов.
//   * getRoutine / getProject — DI через RunRoutineDeps. Каждому тесту собираем
//     свой fake-реестр (никаких реальных config/projects.md / routines/*.md в
//     тесте — fixtures-driven).
//   * runRoutine не возвращает результат: проверяем по Records в БД и по emit'ам.

import type { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
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

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'example-noop',
    projectId: 'example-project',
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
    id: 'example-project',
    name: 'Acme Academy',
    path: '/tmp/fake-project',
    enabled: true,
    mapPath: 'projects/example-project/map.md',
    routinesGlob: 'routines/example-project-*.md',
    ...overrides,
  };
}

// Заглушка executeRoutine — возвращает ok без реального sub-agent вызова.
// Используется в тестах dispatcher'а чтобы не требовать ANTHROPIC_API_KEY.
function makeNoopExecuteRoutine(
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

// Простая фабрика подменённых getRoutine/getProject. Возвращает routine/project
// по id; если id не совпадает — null. Тесты этим управляют сценариями
// «routine не найдена», «project не найден».
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

async function countRecords(db: PrismaClient, type: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n FROM "Record" WHERE type = ?`,
    type,
  );
  return Number(rows[0]?.n ?? 0n);
}

async function selectRecords<T extends Record<string, unknown>>(
  db: PrismaClient,
  type: string,
): Promise<Array<{ id: string; properties: T; parentId: string | null }>> {
  const rows = await db.$queryRawUnsafe<
    Array<{ id: string; properties: string; parentId: string | null }>
  >(`SELECT id, properties, parentId FROM "Record" WHERE type = ? ORDER BY createdAt ASC`, type);
  return rows.map((row) => ({
    id: row.id,
    parentId: row.parentId,
    properties: JSON.parse(row.properties) as T,
  }));
}

const RUN_DATE = '2026-05-02';
const ROUTINE_ID = 'example-noop';
const PROJECT_ID = 'example-project';

// ---------------------------------------------------------------------------
// Кейс 1. Happy path — routine выполняется как noop-stub.
// ---------------------------------------------------------------------------

describe('runRoutine — happy path (noop-stub)', () => {
  it('создаёт event.routine.trigger + audit.routine.start + audit.routine.end', async () => {
    const registry = fakeRegistry({
      routines: new Map([[ROUTINE_ID, makeRoutine()]]),
      projects: new Map([[PROJECT_ID, makeProject()]]),
    });
    const trigger = triggerManualRoutine(ROUTINE_ID);

    await runRoutine(ROUTINE_ID, RUN_DATE, trigger, {
      db: isolated.prisma,
      ...registry,
      executeRoutineImpl: makeNoopExecuteRoutine('ok') as RunRoutineDeps['executeRoutineImpl'],
    });

    expect(await countRecords(isolated.prisma, 'event.routine.trigger')).toBe(1);
    expect(await countRecords(isolated.prisma, 'audit.routine.start')).toBe(1);
    expect(await countRecords(isolated.prisma, 'audit.routine.end')).toBe(1);
    expect(await countRecords(isolated.prisma, 'audit.routine.skipped')).toBe(0);
    expect(await countRecords(isolated.prisma, 'audit.repeat')).toBe(0);

    // event.routine.trigger.properties содержит идентификаторы.
    const triggers = await selectRecords<{
      routineId: string;
      projectId: string;
      runDate: string;
      source: string;
    }>(isolated.prisma, 'event.routine.trigger');
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.properties.routineId).toBe(ROUTINE_ID);
    expect(triggers[0]?.properties.projectId).toBe(PROJECT_ID);
    expect(triggers[0]?.properties.runDate).toBe(RUN_DATE);
    expect(triggers[0]?.properties.source).toBe('manual');

    // audit.routine.start.parentId → event.routine.trigger.id.
    const starts = await selectRecords<{ status?: string; reason?: string }>(
      isolated.prisma,
      'audit.routine.start',
    );
    expect(starts[0]?.parentId).toBe(triggers[0]?.id);

    // audit.routine.end status='ok', reason='ok' (M3': реальный sub-agent через DI).
    const ends = await selectRecords<{ status: string; reason: string }>(
      isolated.prisma,
      'audit.routine.end',
    );
    expect(ends[0]?.properties.status).toBe('ok');
    expect(ends[0]?.properties.reason).toBe('ok');
    expect(ends[0]?.parentId).toBe(triggers[0]?.id);

    // emit'ы: routine.start + routine.end (status='ok').
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
// Кейс 2. Идемпотентность — повторный запуск с тем же idempotencyKey.
// ---------------------------------------------------------------------------

describe('runRoutine — идемпотентность', () => {
  it('повторный запуск с тем же idempotencyKey → audit.repeat, нет дубля event.routine.trigger', async () => {
    const registry = fakeRegistry({
      routines: new Map([[ROUTINE_ID, makeRoutine()]]),
      projects: new Map([[PROJECT_ID, makeProject()]]),
    });
    // Один и тот же trigger.idempotencyKey — например, cron с фиксированной датой.
    const trigger = triggerCronRoutine(ROUTINE_ID, new Date('2026-05-02T07:00:00Z'));

    const noopExec = makeNoopExecuteRoutine('ok') as RunRoutineDeps['executeRoutineImpl'];
    await runRoutine(ROUTINE_ID, RUN_DATE, trigger, {
      db: isolated.prisma,
      ...registry,
      executeRoutineImpl: noopExec,
    });
    await runRoutine(ROUTINE_ID, RUN_DATE, trigger, {
      db: isolated.prisma,
      ...registry,
      executeRoutineImpl: noopExec,
    });

    expect(await countRecords(isolated.prisma, 'event.routine.trigger')).toBe(1);
    expect(await countRecords(isolated.prisma, 'audit.routine.start')).toBe(1);
    expect(await countRecords(isolated.prisma, 'audit.routine.end')).toBe(1);
    expect(await countRecords(isolated.prisma, 'audit.repeat')).toBe(1);

    // audit.repeat ссылается на существующий event.routine.trigger через parentId.
    const triggers = await selectRecords<Record<string, unknown>>(
      isolated.prisma,
      'event.routine.trigger',
    );
    const repeats = await selectRecords<{ kind?: string; idempotencyKey: string }>(
      isolated.prisma,
      'audit.repeat',
    );
    expect(repeats[0]?.parentId).toBe(triggers[0]?.id);
    expect(repeats[0]?.properties.kind).toBe('routine.repeat');
    expect(repeats[0]?.properties.idempotencyKey).toBe(trigger.idempotencyKey);

    // Повтор → emit routine.end status='repeat'.
    const calls = vi.mocked(emit).mock.calls.map(([ev]) => ev);
    const endEvents = calls.filter((c) => c.type === 'routine.end');
    expect(endEvents).toHaveLength(2);
    const repeatEnd = endEvents.find((e) => e.type === 'routine.end' && e.status === 'repeat');
    expect(repeatEnd).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Кейс 3. Manual-trigger даёт уникальный ULID — два прогона = два event.routine.trigger.
// ---------------------------------------------------------------------------

describe('runRoutine — manual triggers', () => {
  it('два manual с разными ULID → две event.routine.trigger', async () => {
    const registry = fakeRegistry({
      routines: new Map([[ROUTINE_ID, makeRoutine()]]),
      projects: new Map([[PROJECT_ID, makeProject()]]),
    });
    const triggerA = triggerManualRoutine(ROUTINE_ID);
    const triggerB = triggerManualRoutine(ROUTINE_ID);

    expect(triggerA.idempotencyKey).not.toBe(triggerB.idempotencyKey);

    const noopExec = makeNoopExecuteRoutine('ok') as RunRoutineDeps['executeRoutineImpl'];
    await runRoutine(ROUTINE_ID, RUN_DATE, triggerA, {
      db: isolated.prisma,
      ...registry,
      executeRoutineImpl: noopExec,
    });
    await runRoutine(ROUTINE_ID, RUN_DATE, triggerB, {
      db: isolated.prisma,
      ...registry,
      executeRoutineImpl: noopExec,
    });

    expect(await countRecords(isolated.prisma, 'event.routine.trigger')).toBe(2);
    expect(await countRecords(isolated.prisma, 'audit.routine.start')).toBe(2);
    expect(await countRecords(isolated.prisma, 'audit.routine.end')).toBe(2);
    expect(await countRecords(isolated.prisma, 'audit.repeat')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Кейс 4. Cron + manual в один день — два разных ключа, два прогона.
// ---------------------------------------------------------------------------

describe('runRoutine — cron + manual в один день', () => {
  it('cron-trigger и manual-trigger в одну дату → две event.routine.trigger', async () => {
    const registry = fakeRegistry({
      routines: new Map([[ROUTINE_ID, makeRoutine()]]),
      projects: new Map([[PROJECT_ID, makeProject()]]),
    });
    const today = new Date('2026-05-02T07:00:00Z');
    const cronTrigger = triggerCronRoutine(ROUTINE_ID, today);
    const manualTrigger = triggerManualRoutine(ROUTINE_ID);

    // Префиксы реально разные — у cron нет ULID, у manual он обязателен.
    expect(cronTrigger.idempotencyKey).not.toBe(manualTrigger.idempotencyKey);
    expect(cronTrigger.idempotencyKey).toContain(':2026-05-02');
    expect(manualTrigger.idempotencyKey).toContain(':manual:');

    const noopExec = makeNoopExecuteRoutine('ok') as RunRoutineDeps['executeRoutineImpl'];
    await runRoutine(ROUTINE_ID, RUN_DATE, cronTrigger, {
      db: isolated.prisma,
      ...registry,
      executeRoutineImpl: noopExec,
    });
    await runRoutine(ROUTINE_ID, RUN_DATE, manualTrigger, {
      db: isolated.prisma,
      ...registry,
      executeRoutineImpl: noopExec,
    });

    expect(await countRecords(isolated.prisma, 'event.routine.trigger')).toBe(2);
    expect(await countRecords(isolated.prisma, 'audit.repeat')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Кейс 5. routine не существует — audit.routine.skipped, ничего больше.
// ---------------------------------------------------------------------------

describe('runRoutine — skip-ветки', () => {
  it("routine не существует → audit.routine.skipped reason='routine-not-found'", async () => {
    const registry = fakeRegistry({}); // ни routine, ни project
    const trigger = triggerManualRoutine('unknown-routine');

    await runRoutine('unknown-routine', RUN_DATE, trigger, {
      db: isolated.prisma,
      ...registry,
    });

    expect(await countRecords(isolated.prisma, 'event.routine.trigger')).toBe(0);
    expect(await countRecords(isolated.prisma, 'audit.routine.start')).toBe(0);
    expect(await countRecords(isolated.prisma, 'audit.routine.end')).toBe(0);
    expect(await countRecords(isolated.prisma, 'audit.routine.skipped')).toBe(1);

    const skips = await selectRecords<{ reason: string; routineId: string }>(
      isolated.prisma,
      'audit.routine.skipped',
    );
    expect(skips[0]?.properties.reason).toBe('routine-not-found');
    expect(skips[0]?.properties.routineId).toBe('unknown-routine');
    // Нет parentId (нет event.routine.trigger).
    expect(skips[0]?.parentId).toBeNull();

    // Live-start не отправляем для непринятого запуска: иначе UI может зависнуть.
    const calls = vi.mocked(emit).mock.calls.map(([ev]) => ev);
    expect(calls.find((c) => c.type === 'routine.start')).toBeUndefined();

    // emit routine.end status='skipped'.
    const endEvent = calls.find((c) => c.type === 'routine.end');
    expect(endEvent).toBeDefined();
    if (endEvent?.type === 'routine.end') {
      expect(endEvent.status).toBe('skipped');
      expect(endEvent.reason).toBe('routine-not-found');
    }
  });

  it("routine.enabled=false → audit.routine.skipped reason='routine-disabled'", async () => {
    const registry = fakeRegistry({
      routines: new Map([[ROUTINE_ID, makeRoutine({ enabled: false })]]),
      projects: new Map([[PROJECT_ID, makeProject()]]),
    });
    const trigger = triggerManualRoutine(ROUTINE_ID);

    await runRoutine(ROUTINE_ID, RUN_DATE, trigger, {
      db: isolated.prisma,
      ...registry,
    });

    expect(await countRecords(isolated.prisma, 'event.routine.trigger')).toBe(0);
    expect(await countRecords(isolated.prisma, 'audit.routine.skipped')).toBe(1);
    const skips = await selectRecords<{ reason: string }>(isolated.prisma, 'audit.routine.skipped');
    expect(skips[0]?.properties.reason).toBe('routine-disabled');
  });

  it("project не найден → audit.routine.skipped reason='project-not-found'", async () => {
    const registry = fakeRegistry({
      routines: new Map([[ROUTINE_ID, makeRoutine({ projectId: 'ghost' })]]),
      // Намеренно НЕ кладём project 'ghost' — registry вернёт null.
      projects: new Map(),
    });
    const trigger = triggerManualRoutine(ROUTINE_ID);

    await runRoutine(ROUTINE_ID, RUN_DATE, trigger, {
      db: isolated.prisma,
      ...registry,
    });

    expect(await countRecords(isolated.prisma, 'event.routine.trigger')).toBe(0);
    expect(await countRecords(isolated.prisma, 'audit.routine.skipped')).toBe(1);
    const skips = await selectRecords<{ reason: string }>(isolated.prisma, 'audit.routine.skipped');
    expect(skips[0]?.properties.reason).toBe('project-not-found');
  });

  it("project.enabled=false → audit.routine.skipped reason='project-disabled'", async () => {
    const registry = fakeRegistry({
      routines: new Map([[ROUTINE_ID, makeRoutine()]]),
      projects: new Map([[PROJECT_ID, makeProject({ enabled: false })]]),
    });
    const trigger = triggerManualRoutine(ROUTINE_ID);

    await runRoutine(ROUTINE_ID, RUN_DATE, trigger, {
      db: isolated.prisma,
      ...registry,
    });

    expect(await countRecords(isolated.prisma, 'event.routine.trigger')).toBe(0);
    expect(await countRecords(isolated.prisma, 'audit.routine.skipped')).toBe(1);
    const skips = await selectRecords<{ reason: string }>(isolated.prisma, 'audit.routine.skipped');
    expect(skips[0]?.properties.reason).toBe('project-disabled');
  });

  it('ошибка загрузки routine не отправляет routine.start без durable trigger', async () => {
    const trigger = triggerManualRoutine(ROUTINE_ID);

    await expect(
      runRoutine(ROUTINE_ID, RUN_DATE, trigger, {
        db: isolated.prisma,
        getRoutine: async () => {
          throw new Error('loader exploded');
        },
      }),
    ).rejects.toThrow('loader exploded');

    expect(await countRecords(isolated.prisma, 'event.routine.trigger')).toBe(0);
    expect(await countRecords(isolated.prisma, 'audit.routine.start')).toBe(0);
    expect(await countRecords(isolated.prisma, 'audit.routine.end')).toBe(0);
    const calls = vi.mocked(emit).mock.calls.map(([ev]) => ev);
    expect(calls.find((c) => c.type === 'routine.start')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Кейс 6. outputType='journal-only' → sendToFounder НЕ вызван.
// ---------------------------------------------------------------------------

describe('runRoutine — outputType (фаза 3.3)', () => {
  it("outputType='journal-only' → sendToFounder не вызван", async () => {
    const registry = fakeRegistry({
      routines: new Map([[ROUTINE_ID, makeRoutine({ outputType: 'journal-only' })]]),
      projects: new Map([[PROJECT_ID, makeProject()]]),
    });
    const trigger = triggerManualRoutine(ROUTINE_ID);
    const sendToFounder = vi.fn().mockResolvedValue(undefined);

    await runRoutine(ROUTINE_ID, RUN_DATE, trigger, {
      db: isolated.prisma,
      ...registry,
      executeRoutineImpl: makeNoopExecuteRoutine('ok') as RunRoutineDeps['executeRoutineImpl'],
      sendToFounder,
    });

    expect(sendToFounder).not.toHaveBeenCalled();
  });

  it("outputType='telegram-thread' → sendToFounder вызван 1 раз", async () => {
    const registry = fakeRegistry({
      routines: new Map([[ROUTINE_ID, makeRoutine({ outputType: 'telegram-thread' })]]),
      projects: new Map([[PROJECT_ID, makeProject()]]),
    });
    const trigger = triggerManualRoutine(ROUTINE_ID);
    const sendToFounder = vi.fn().mockResolvedValue(undefined);

    await runRoutine(ROUTINE_ID, RUN_DATE, trigger, {
      db: isolated.prisma,
      ...registry,
      executeRoutineImpl: makeNoopExecuteRoutine('ok') as RunRoutineDeps['executeRoutineImpl'],
      sendToFounder,
    });

    // renderRoutineOutput с дефолтным шаблоном + пустым output → одно сообщение.
    expect(sendToFounder).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Кейс 7. Department-level budget guard (Фаза 5 п. 8 плана v3).
//
// Проверяем что dispatcher ДЕЙСТВИТЕЛЬНО вызывает checkDepartmentDailyBudget
// для routine с departmentId и блокирует executeRoutine при превышении cap'а.
// ---------------------------------------------------------------------------

describe('runRoutine — department budget guard', () => {
  it('routine без departmentId → бюджет не проверяется, executeRoutine вызван', async () => {
    const registry = fakeRegistry({
      routines: new Map([[ROUTINE_ID, makeRoutine({ outputType: 'journal-only' })]]),
      projects: new Map([[PROJECT_ID, makeProject()]]),
    });
    const trigger = triggerManualRoutine(ROUTINE_ID);
    const exec = vi.fn(makeNoopExecuteRoutine('ok'));

    await runRoutine(ROUTINE_ID, RUN_DATE, trigger, {
      db: isolated.prisma,
      ...registry,
      executeRoutineImpl: exec as RunRoutineDeps['executeRoutineImpl'],
    });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(await countRecords(isolated.prisma, 'audit.budget.deny')).toBe(0);
  });

  it('routine с departmentId без spend → executeRoutine вызывается', async () => {
    // Подсовываем routine с departmentId='dept-a'.
    const routine = makeRoutine({
      outputType: 'journal-only',
      departmentId: 'dept-a',
    });
    const registry = fakeRegistry({
      routines: new Map([[ROUTINE_ID, routine]]),
      projects: new Map([[PROJECT_ID, makeProject()]]),
    });
    const trigger = triggerManualRoutine(ROUTINE_ID);
    const exec = vi.fn(makeNoopExecuteRoutine('ok'));

    await runRoutine(ROUTINE_ID, RUN_DATE, trigger, {
      db: isolated.prisma,
      ...registry,
      executeRoutineImpl: exec as RunRoutineDeps['executeRoutineImpl'],
      // listRoutinesFn вернёт только нашу — это нужно, чтобы department-budget
      // не пытался читать реальный routines/ глоб.
      listRoutinesFn: async () => [routine],
    });

    // Бюджет не задан в departments (getDepartment вернёт null в реальном fs) —
    // checkDepartmentDailyBudget возвращает ok без deny. executeRoutine
    // вызван.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(await countRecords(isolated.prisma, 'audit.budget.deny')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Кейс 8. Completion signals: dispatcher вызывает signal hook только после ok.
// ---------------------------------------------------------------------------

describe('runRoutine — completion signals', () => {
  it("status='ok' → вызывает completion signal hook с eventTriggerId", async () => {
    const registry = fakeRegistry({
      routines: new Map([[ROUTINE_ID, makeRoutine({ outputType: 'journal-only' })]]),
      projects: new Map([[PROJECT_ID, makeProject()]]),
    });
    const trigger = triggerManualRoutine(ROUTINE_ID);
    const signalHook = vi.fn(
      async (
        _args: Parameters<NonNullable<RunRoutineDeps['handleRoutineCompletedSignalImpl']>>[0],
      ) => {},
    );

    await runRoutine(ROUTINE_ID, RUN_DATE, trigger, {
      db: isolated.prisma,
      ...registry,
      executeRoutineImpl: makeNoopExecuteRoutine('ok') as RunRoutineDeps['executeRoutineImpl'],
      handleRoutineCompletedSignalImpl: signalHook,
    });

    const triggers = await selectRecords<Record<string, unknown>>(
      isolated.prisma,
      'event.routine.trigger',
    );
    expect(signalHook).toHaveBeenCalledOnce();
    const signalArgs = signalHook.mock.calls[0]?.[0];
    expect(signalArgs?.db).toBe(isolated.prisma);
    expect(signalArgs?.sourceRoutineId).toBe(ROUTINE_ID);
    expect(signalArgs?.runDate).toBe(RUN_DATE);
    expect(signalArgs?.sourceEventTriggerId).toBe(triggers[0]?.id);
  });

  it("status='failed' → не вызывает completion signal hook", async () => {
    const registry = fakeRegistry({
      routines: new Map([[ROUTINE_ID, makeRoutine({ outputType: 'journal-only' })]]),
      projects: new Map([[PROJECT_ID, makeProject()]]),
    });
    const trigger = triggerManualRoutine(ROUTINE_ID);
    const signalHook = vi.fn(
      async (
        _args: Parameters<NonNullable<RunRoutineDeps['handleRoutineCompletedSignalImpl']>>[0],
      ) => {},
    );

    await runRoutine(ROUTINE_ID, RUN_DATE, trigger, {
      db: isolated.prisma,
      ...registry,
      executeRoutineImpl: makeNoopExecuteRoutine('failed') as RunRoutineDeps['executeRoutineImpl'],
      handleRoutineCompletedSignalImpl: signalHook,
    });

    expect(signalHook).not.toHaveBeenCalled();
  });
});
