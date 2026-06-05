// Тесты для department-level budget (Фаза 5, п. 8).

import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Department } from '../src/departments/types.js';
import {
  checkDepartmentDailyBudget,
  checkDepartmentRunBudget,
  sumRoutineSpend,
  sumSpendByParent,
} from '../src/llm/department-budget.js';
import { recordSpend } from '../src/llm/spend.js';
import type { Routine } from '../src/routines/parser.js';
import {
  type IsolatedDb,
  type TemplateHandle,
  createIsolatedDb,
  setupTemplateDb,
} from './fixtures/isolated-db.js';

let template: TemplateHandle;

beforeAll(() => {
  template = setupTemplateDb();
});
afterAll(() => template.dispose());

let db: IsolatedDb;
beforeEach(async () => {
  db = await createIsolatedDb(template);
});
afterEach(async () => {
  await db.dispose();
});

function makeRoutine(id: string, departmentId?: string): Routine {
  return {
    id,
    projectId: 'p',
    enabled: true,
    trigger: 'manual',
    tools: [],
    model: 'claude-sonnet-4-6',
    maxTokens: 1000,
    timeoutMs: 60_000,
    outputType: 'journal-only',
    description: '',
    prompt: 'p',
    filePath: '/abs/r.md',
    ...(departmentId !== undefined ? { departmentId } : {}),
  };
}

function makeDept(perDayUsd = 5.0, perRunUsd = 1.0): Department {
  return {
    id: 'marketing-content',
    name: 'M',
    description: 'm',
    body: '',
    filePath: '/abs/D.md',
    pipelinePath: '/abs/p.yml',
    sharedDir: '/abs/s',
    pipeline: { nodes: [{ kind: 'employee', id: 'a', employee: 'x', inputs: [], output: 'o.md' }] },
    budget: { perDayUsd, perRunUsd },
  };
}

describe('sumRoutineSpend', () => {
  it('считает sum по routineIds', async () => {
    await recordSpend(
      {
        promptId: 'p',
        model: 'claude-sonnet-4-6',
        modelRequested: 'claude-sonnet-4-6',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        usd: 0.5,
        pricingAsOf: Date.now(),
        routineId: 'r-1',
      },
      db.prisma,
    );
    await recordSpend(
      {
        promptId: 'p',
        model: 'claude-sonnet-4-6',
        modelRequested: 'claude-sonnet-4-6',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        usd: 0.3,
        pricingAsOf: Date.now(),
        routineId: 'r-2',
      },
      db.prisma,
    );
    const sum = await sumRoutineSpend(db.prisma, ['r-1', 'r-2'], 0);
    expect(sum).toBeCloseTo(0.8, 5);
  });

  it('пустой список routineIds → 0', async () => {
    const sum = await sumRoutineSpend(db.prisma, [], 0);
    expect(sum).toBe(0);
  });
});

describe('checkDepartmentDailyBudget', () => {
  it('routine без departmentId → ok без вычислений', async () => {
    const result = await checkDepartmentDailyBudget(makeRoutine('r-1'), async () => [], {
      db: db.prisma,
    });
    expect(result.ok).toBe(true);
  });

  it('routine с departmentId, нет budget → ok', async () => {
    const dept: Department = { ...makeDept(), budget: undefined };
    const result = await checkDepartmentDailyBudget(
      makeRoutine('r-1', 'marketing-content'),
      async () => [],
      { db: db.prisma, getDepartmentFn: async () => dept },
    );
    expect(result.ok).toBe(true);
  });

  it('current < cap → ok', async () => {
    await recordSpend(
      {
        promptId: 'p',
        model: 'm',
        modelRequested: 'm',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        usd: 1.0,
        pricingAsOf: Date.now(),
        routineId: 'r-1',
      },
      db.prisma,
    );
    const dept = makeDept(5.0);
    const result = await checkDepartmentDailyBudget(
      makeRoutine('r-1', 'marketing-content'),
      async () => [makeRoutine('r-1', 'marketing-content')],
      { db: db.prisma, getDepartmentFn: async () => dept },
    );
    expect(result.ok).toBe(true);
  });

  it('current >= cap → deny + audit.budget.deny', async () => {
    // 6 USD за день при cap 5.
    await recordSpend(
      {
        promptId: 'p',
        model: 'm',
        modelRequested: 'm',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        usd: 6.0,
        pricingAsOf: Date.now(),
        routineId: 'r-1',
      },
      db.prisma,
    );
    const dept = makeDept(5.0);
    const result = await checkDepartmentDailyBudget(
      makeRoutine('r-1', 'marketing-content'),
      async () => [makeRoutine('r-1', 'marketing-content')],
      { db: db.prisma, getDepartmentFn: async () => dept },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('department-cap');
    expect(result.cap).toBe(5);
    expect(result.current).toBeCloseTo(6, 5);

    // проверим audit.budget.deny создан
    const rows = await db.prisma.$queryRawUnsafe<{ properties: string }[]>(
      `SELECT properties FROM "Record" WHERE type='audit.budget.deny'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const props = JSON.parse(rows[0]?.properties ?? '{}') as Record<string, unknown>;
    expect(props.reason).toBe('department-cap');
  });
});

describe('checkDepartmentRunBudget + sumSpendByParent', () => {
  it('считает spend по parentId', async () => {
    const cycleParent = ulid();
    // Создаём audit.spend с parentId=cycleParent — для этого ему нужен реальный
    // event.routine.trigger record (parentId FK / soft). Тест проверяет SUM,
    // мы напишем audit.spend напрямую с этим parentId.
    const now = Date.now();
    // Сначала вставим event.routine.trigger как «корневую» запись.
    await db.prisma.$executeRawUnsafe(
      `INSERT INTO "Record" (id, type, properties, actorKind, visibility, idempotencyKey, status, createdAt)
       VALUES (?, 'event.routine.trigger', '{}', 'system', 'autonomous', ?, 'active', ?)`,
      cycleParent,
      `test-${cycleParent}`,
      now,
    );
    await recordSpend(
      {
        promptId: 'p',
        model: 'm',
        modelRequested: 'm',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        usd: 0.7,
        pricingAsOf: now,
        cycleParentId: cycleParent,
        routineId: 'r-1',
      },
      db.prisma,
    );

    const sum = await sumSpendByParent(db.prisma, cycleParent);
    expect(sum).toBeCloseTo(0.7, 5);

    const dept = makeDept(5.0, 0.5);
    const result = await checkDepartmentRunBudget(
      makeRoutine('r-1', 'marketing-content'),
      cycleParent,
      { db: db.prisma, getDepartmentFn: async () => dept },
    );
    // 0.7 >= 0.5 → deny
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('department-cap');
  });
});
