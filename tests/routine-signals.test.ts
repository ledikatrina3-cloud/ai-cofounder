import type { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleRoutineCompletedSignal,
  parseRoutineSignalSubscriptions,
} from '../src/core/routine-signals.js';
import type { RunRoutineTrigger } from '../src/core/triggers.js';
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

let template: TemplateHandle;
let isolated: IsolatedDb;

beforeAll(() => {
  template = setupTemplateDb();
});

afterAll(() => {
  template.dispose();
});

beforeEach(async () => {
  isolated = await createIsolatedDb(template);
});

afterEach(async () => {
  await isolated.dispose();
});

async function insertSourceTrigger(db: PrismaClient, id: string): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, idempotencyKey, status, createdAt)
     VALUES (?, 'event.routine.trigger', ?, 'system', 'autonomous', ?, 'active', ?)`,
    id,
    JSON.stringify({ routineId: 'article-brief-researcher', projectId: 'self' }),
    `routine:article-brief-researcher:manual:${id}`,
    1,
  );
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

describe('parseRoutineSignalSubscriptions', () => {
  it('парсит подписки routine.completed из YAML', () => {
    const subscriptions = parseRoutineSignalSubscriptions(
      'subscriptions:\n  - on: routine.completed\n    source: article-brief-researcher\n    run: article-writer\n',
      'routines/signals.yml',
    );

    expect(subscriptions).toEqual([
      {
        enabled: true,
        event: 'routine.completed',
        sourceRoutineId: 'article-brief-researcher',
        targetRoutineId: 'article-writer',
      },
    ]);
  });
});

describe('handleRoutineCompletedSignal', () => {
  it('создаёт durable signal и запускает target routine один раз', async () => {
    const sourceEventTriggerId = ulid();
    await insertSourceTrigger(isolated.prisma, sourceEventTriggerId);
    const runRoutine = vi.fn(
      async (_routineId: string, _runDate: string, _trigger: RunRoutineTrigger) => {},
    );

    await handleRoutineCompletedSignal({
      db: isolated.prisma,
      sourceRoutineId: 'article-brief-researcher',
      runDate: '2026-08-01',
      sourceEventTriggerId,
      loadSubscriptions: async () => [
        {
          enabled: true,
          event: 'routine.completed',
          sourceRoutineId: 'article-brief-researcher',
          targetRoutineId: 'article-writer',
        },
      ],
      runRoutine,
      now: () => 10,
    });

    expect(runRoutine).toHaveBeenCalledOnce();
    expect(runRoutine).toHaveBeenCalledWith('article-writer', '2026-08-01', {
      source: 'signal',
      idempotencyKey: `routine:article-writer:signal:${sourceEventTriggerId}:article-brief-researcher`,
      signal: {
        rootEventTriggerId: sourceEventTriggerId,
        visitedRoutineIds: ['article-brief-researcher', 'article-writer'],
      },
    });

    const signals = await selectRecords<{
      event: string;
      sourceRoutineId: string;
      targetRoutineId: string;
      runDate: string;
      idempotencyKey: string;
    }>(isolated.prisma, 'event.routine.signal');
    expect(signals).toHaveLength(1);
    expect(signals[0]?.parentId).toBe(sourceEventTriggerId);
    expect(signals[0]?.properties).toMatchObject({
      event: 'routine.completed',
      sourceRoutineId: 'article-brief-researcher',
      targetRoutineId: 'article-writer',
      runDate: '2026-08-01',
      rootEventTriggerId: sourceEventTriggerId,
      idempotencyKey: `routine-signal:${sourceEventTriggerId}:article-brief-researcher:article-writer`,
    });
  });

  it('повторный вызов с тем же source trigger не запускает target второй раз', async () => {
    const sourceEventTriggerId = ulid();
    await insertSourceTrigger(isolated.prisma, sourceEventTriggerId);
    const runRoutine = vi.fn(async () => {});
    const args = {
      db: isolated.prisma,
      sourceRoutineId: 'article-brief-researcher',
      runDate: '2026-08-01',
      sourceEventTriggerId,
      loadSubscriptions: async () => [
        {
          enabled: true,
          event: 'routine.completed' as const,
          sourceRoutineId: 'article-brief-researcher',
          targetRoutineId: 'article-writer',
        },
      ],
      runRoutine,
      now: () => 10,
    };

    await handleRoutineCompletedSignal(args);
    await handleRoutineCompletedSignal(args);

    expect(runRoutine).toHaveBeenCalledTimes(1);
    const signals = await selectRecords<Record<string, unknown>>(
      isolated.prisma,
      'event.routine.signal',
    );
    expect(signals).toHaveLength(1);
  });

  it('не запускает target, который уже есть в signal chain', async () => {
    const sourceEventTriggerId = ulid();
    await insertSourceTrigger(isolated.prisma, sourceEventTriggerId);
    const runRoutine = vi.fn(async () => {});

    await handleRoutineCompletedSignal({
      db: isolated.prisma,
      sourceRoutineId: 'article-writer',
      runDate: '2026-08-01',
      sourceEventTriggerId,
      rootEventTriggerId: 'root-trigger',
      visitedRoutineIds: ['article-brief-researcher', 'article-writer'],
      loadSubscriptions: async () => [
        {
          enabled: true,
          event: 'routine.completed',
          sourceRoutineId: 'article-writer',
          targetRoutineId: 'article-brief-researcher',
        },
      ],
      runRoutine,
      now: () => 10,
    });

    expect(runRoutine).not.toHaveBeenCalled();
    const signals = await selectRecords<Record<string, unknown>>(
      isolated.prisma,
      'event.routine.signal',
    );
    expect(signals).toHaveLength(0);
  });
});
