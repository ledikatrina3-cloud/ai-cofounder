// Тесты для фазы 2.3b (семафор + параллельный fan-out + Bridge events).
//
// Стратегия:
//   * Mock investigateProblem через DI (`investigateProblemImpl`). Реальный
//     SDK не зовётся ни в одном тесте — это touchpoint с деньгами и
//     требует API-ключа.
//   * vi.mock на `src/observe/bridge.js` чтобы проверить вызовы emit:
//     parentSession, типы событий, число subagent.start/end.
//   * Prisma — shared dev.db (как остальные тесты), изоляция через
//     уникальный `parentSession` в SELECT.
//   * Параллельность измеряется через atomic-счётчик `inFlight` внутри mock'а:
//     mock инкрементит при входе, ждёт `setTimeout`, декрементит на выходе.
//     `maxInFlight` запоминаем — должен быть ≤ concurrency.

import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSchemaInvariants } from '../src/db/invariants-check.js';
import type { InvestigateConfig } from '../src/investigate/config.js';
import { investigateMany } from '../src/investigate/fanout.js';
import {
  InvestigateBudgetExceededError,
  InvestigateInvalidResponseError,
  type InvestigationResult,
  type investigateProblem as defaultInvestigateProblem,
} from '../src/investigate/run.js';
import { BudgetExceededError } from '../src/llm/call.js';

vi.mock('../src/observe/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/observe/bridge.js')>();
  return {
    ...actual,
    emit: vi.fn().mockResolvedValue(undefined),
  };
});

import { emit } from '../src/observe/bridge.js';

const prisma = new PrismaClient();

beforeAll(async () => {
  await prisma.$connect();
  await assertSchemaInvariants(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  vi.mocked(emit).mockClear();
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<InvestigateConfig> = {}): InvestigateConfig {
  return {
    targetProjectPath: '/dev/null',
    model: 'claude-sonnet-4-6',
    subagentType: 'Explore',
    timeoutMs: 5_000,
    maxTokens: 100_000,
    maxTurns: 20,
    promptId: 'investigate:run:test',
    bashWhitelist: ['cat'],
    concurrency: 3,
    maxProblemsPerCycle: 10,
    parentSessionPrefix: 'investigate-test',
    asOf: 0,
    sourcePath: 'tests/investigate-fanout.test.ts',
    ...overrides,
  };
}

function makeMockResult(overrides: Partial<InvestigationResult> = {}): InvestigationResult {
  return {
    verdict: 'code',
    rationale: 'тестовое объяснение',
    codeRefs: [],
    gitHints: [],
    subagentId: ulid(),
    totalUsd: 0.01,
    totalTokens: 5_000,
    durationMs: 100,
    timedOut: false,
    spendRecordId: null,
    ...overrides,
  };
}

// Генератор уникальных problemId для одного теста.
function makeProblemIds(n: number): string[] {
  return Array.from({ length: n }, () => ulid());
}

// SELECT для проверки физических Record'ов в БД.
async function selectRecordsByParentSession(
  type: string,
  parentSession: string,
): Promise<Array<{ id: string; properties: Record<string, unknown> }>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; properties: string }>>(
    `SELECT id, properties FROM "Record" WHERE type = ? AND properties LIKE ?`,
    type,
    `%${parentSession}%`,
  );
  return rows.map((r) => ({
    id: r.id,
    properties: JSON.parse(r.properties) as Record<string, unknown>,
  }));
}

// ---------------------------------------------------------------------------
// Тест 1 — параллельность.
// ---------------------------------------------------------------------------

describe('investigateMany — параллельность через семафор', () => {
  it('concurrency=2, 4 problems с задержкой 100мс → max in-flight = 2', async () => {
    const ids = makeProblemIds(4);
    let inFlight = 0;
    let maxInFlight = 0;

    const fakeInvestigate: typeof defaultInvestigateProblem = async (problemId) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 100));
      inFlight--;
      return makeMockResult({
        rationale: `обработана ${problemId.slice(-6)}`,
      });
    };

    const startedAt = Date.now();
    const result = await investigateMany(ids, {
      db: prisma,
      configOverride: makeConfig({ concurrency: 2 }),
      investigateProblemImpl: fakeInvestigate,
    });
    const durationMs = Date.now() - startedAt;

    expect(maxInFlight).toBe(2);
    expect(result.results).toHaveLength(4);
    expect(result.failures).toHaveLength(0);
    expect(result.deferred).toHaveLength(0);
    // 4 проблемы × 100мс ÷ 2 параллели ≈ 200мс. Допуск ±150мс на overhead.
    expect(durationMs).toBeGreaterThanOrEqual(180);
    expect(durationMs).toBeLessThan(500);
    // Все problemId сохранены в результатах.
    const resultIds = new Set(result.results.map((r) => r.problemId));
    expect(resultIds).toEqual(new Set(ids));
  });
});

// ---------------------------------------------------------------------------
// Тест 2 — BudgetExceeded на середине fan-out'а.
// ---------------------------------------------------------------------------

describe('investigateMany — BudgetExceeded → drain + deferred', () => {
  it('concurrency=1, 4 problems, на 3-й — BudgetExceeded → 2 succeeded + 0 failed + 2 deferred', async () => {
    const ids = makeProblemIds(4);

    let callCount = 0;
    const fakeInvestigate: typeof defaultInvestigateProblem = async (problemId) => {
      callCount++;
      if (callCount === 3) {
        throw new BudgetExceededError('per-cycle', 300_000, 300_000, ulid());
      }
      return makeMockResult({ rationale: `ok ${problemId.slice(-6)}` });
    };

    const result = await investigateMany(ids, {
      db: prisma,
      configOverride: makeConfig({ concurrency: 1 }),
      investigateProblemImpl: fakeInvestigate,
    });

    expect(result.results).toHaveLength(2);
    expect(result.failures).toHaveLength(0);
    expect(result.deferred).toHaveLength(2);

    // Первые две — это P1 и P2 (по порядку).
    expect(result.results.map((r) => r.problemId)).toEqual([ids[0], ids[1]]);

    // Остальные — P3 и P4 — в deferred.
    const deferredIds = result.deferred.map((d) => d.problemId).sort();
    expect(deferredIds).toEqual([ids[2], ids[3]].sort());
    for (const d of result.deferred) {
      expect(d.reason).toBe('per-cycle-budget');
    }

    // Физическая проверка: audit.budget.deferred Records в БД.
    const dbRecords = await selectRecordsByParentSession(
      'audit.budget.deferred',
      result.parentSession,
    );
    expect(dbRecords).toHaveLength(2);
    const dbProblemIds = dbRecords.map((r) => r.properties.problemId).sort();
    expect(dbProblemIds).toEqual([ids[2], ids[3]].sort());
    for (const r of dbRecords) {
      expect(r.properties.reason).toBe('per-cycle-budget');
      expect(r.properties.parentSession).toBe(result.parentSession);
      expect(typeof r.properties.attemptedAt).toBe('number');
    }
  });

  it('InvestigateBudgetExceededError тоже идёт в deferred (>100K на одной проблеме)', async () => {
    const ids = makeProblemIds(3);

    let callCount = 0;
    const fakeInvestigate: typeof defaultInvestigateProblem = async (problemId) => {
      callCount++;
      if (callCount === 2) {
        throw new InvestigateBudgetExceededError(150_000, 100_000);
      }
      return makeMockResult({ rationale: `ok ${problemId.slice(-6)}` });
    };

    const result = await investigateMany(ids, {
      db: prisma,
      configOverride: makeConfig({ concurrency: 1 }),
      investigateProblemImpl: fakeInvestigate,
    });

    expect(result.results).toHaveLength(1);
    expect(result.failures).toHaveLength(0);
    expect(result.deferred).toHaveLength(2);
    for (const d of result.deferred) {
      expect(d.reason).toBe('per-cycle-budget');
    }
  });
});

// ---------------------------------------------------------------------------
// Тест 3 — обычный failure (не budget) не валит весь fan-out.
// ---------------------------------------------------------------------------

describe('investigateMany — non-budget failures', () => {
  it('InvestigateInvalidResponseError на 2-й → 3 succeeded + 1 failed + 0 deferred', async () => {
    const ids = makeProblemIds(4);

    let callCount = 0;
    const fakeInvestigate: typeof defaultInvestigateProblem = async (problemId) => {
      callCount++;
      if (callCount === 2) {
        throw new InvestigateInvalidResponseError('sub-agent вернул чушь', 'schema-mismatch');
      }
      return makeMockResult({ rationale: `ok ${problemId.slice(-6)}` });
    };

    const result = await investigateMany(ids, {
      db: prisma,
      configOverride: makeConfig({ concurrency: 1 }),
      investigateProblemImpl: fakeInvestigate,
    });

    expect(result.results).toHaveLength(3);
    expect(result.failures).toHaveLength(1);
    expect(result.deferred).toHaveLength(0);

    const failure = result.failures[0];
    expect(failure?.problemId).toBe(ids[1]);
    expect(failure?.errorClass).toBe('InvestigateInvalidResponseError');
    expect(failure?.message).toMatch(/чушь/);
  });
});

// ---------------------------------------------------------------------------
// Тест 4 — soft-cap.
// ---------------------------------------------------------------------------

describe('investigateMany — soft-cap', () => {
  it('15 problems, maxProblemsPerCycle=10 → 10 запущено + 5 в deferred(soft-cap-skip)', async () => {
    const ids = makeProblemIds(15);

    const fakeInvestigate: typeof defaultInvestigateProblem = async () => {
      return makeMockResult();
    };

    const result = await investigateMany(ids, {
      db: prisma,
      configOverride: makeConfig({ concurrency: 3, maxProblemsPerCycle: 10 }),
      investigateProblemImpl: fakeInvestigate,
    });

    expect(result.results).toHaveLength(10);
    expect(result.failures).toHaveLength(0);
    expect(result.deferred).toHaveLength(5);

    // Хвост — последние 5 problemIds.
    const deferredIds = result.deferred.map((d) => d.problemId);
    expect(deferredIds).toEqual(ids.slice(10));
    for (const d of result.deferred) {
      expect(d.reason).toBe('soft-cap-skip');
    }

    // Физическая проверка: 5 audit.investigate.softcap.skip Records.
    const dbRecords = await selectRecordsByParentSession(
      'audit.investigate.softcap.skip',
      result.parentSession,
    );
    expect(dbRecords).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Тест 5 — parentSession уникален для batch и одинаков для всех subagent.*.
// ---------------------------------------------------------------------------

describe('investigateMany — parentSession и Bridge events', () => {
  it('один parentSession на batch, эмитятся batch.start/end + N×subagent.start/end', async () => {
    const ids = makeProblemIds(3);

    const fakeInvestigate: typeof defaultInvestigateProblem = async () => {
      return makeMockResult();
    };

    const result = await investigateMany(ids, {
      db: prisma,
      configOverride: makeConfig({ concurrency: 2 }),
      investigateProblemImpl: fakeInvestigate,
    });

    // parentSession уникален и начинается с prefix'а.
    expect(result.parentSession).toMatch(/^investigate-test-[0-9A-HJKMNP-TV-Z]{26}$/);

    const calls = vi.mocked(emit).mock.calls;
    const events = calls.map((c) => c[0]);

    const batchStarts = events.filter((e) => e.type === 'investigate.batch.start');
    const batchEnds = events.filter((e) => e.type === 'investigate.batch.end');
    const subagentStarts = events.filter((e) => e.type === 'subagent.start');
    const subagentEnds = events.filter((e) => e.type === 'subagent.end');

    expect(batchStarts).toHaveLength(1);
    expect(batchEnds).toHaveLength(1);
    expect(subagentStarts).toHaveLength(3);
    expect(subagentEnds).toHaveLength(3);

    // Все subagent.start с одинаковым parentSession + правильным problemId.
    const sStarts = subagentStarts as Array<{
      type: 'subagent.start';
      parentSession?: string;
      problemId?: string;
      subagentId: string;
      subagentType: string;
    }>;
    for (const s of sStarts) {
      expect(s.parentSession).toBe(result.parentSession);
      expect(s.subagentType).toBe('investigator');
      expect(typeof s.problemId).toBe('string');
      expect(ids).toContain(s.problemId);
    }

    // batch.start.problemsIn = 3, concurrency = 2.
    const bs = batchStarts[0] as { problemsIn: number; concurrency: number };
    expect(bs.problemsIn).toBe(3);
    expect(bs.concurrency).toBe(2);

    // batch.end counters совпадают с FanoutResult.
    const be = batchEnds[0] as {
      succeeded: number;
      failed: number;
      deferred: number;
      totalUsd: number;
      totalTokens: number;
    };
    expect(be.succeeded).toBe(3);
    expect(be.failed).toBe(0);
    expect(be.deferred).toBe(0);
    expect(be.totalUsd).toBeCloseTo(0.03, 5);
    expect(be.totalTokens).toBe(15_000);

    // audit.investigate.batch Record в БД.
    const auditRow = await prisma.$queryRawUnsafe<Array<{ id: string; properties: string }>>(
      `SELECT id, properties FROM "Record" WHERE id = ?`,
      result.auditRecordId,
    );
    expect(auditRow).toHaveLength(1);
    const auditProps = JSON.parse(auditRow[0]?.properties ?? '{}');
    expect(auditProps.parentSession).toBe(result.parentSession);
    expect(auditProps.succeeded).toBe(3);
    expect(auditProps.problemsIn).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Тест 6 — пустой инпут.
// ---------------------------------------------------------------------------

describe('investigateMany — пустой инпут', () => {
  it('пустой массив problemIds → ноль workers, ноль emits subagent.*, batch.start/end эмитятся', async () => {
    const fakeInvestigate: typeof defaultInvestigateProblem = async () => {
      throw new Error('не должно вызываться');
    };

    const result = await investigateMany([], {
      db: prisma,
      configOverride: makeConfig(),
      investigateProblemImpl: fakeInvestigate,
    });

    expect(result.results).toHaveLength(0);
    expect(result.failures).toHaveLength(0);
    expect(result.deferred).toHaveLength(0);
    expect(result.totalUsd).toBe(0);
    expect(result.totalTokens).toBe(0);

    const calls = vi.mocked(emit).mock.calls;
    const types = calls.map((c) => c[0].type);
    expect(types).toEqual(['investigate.batch.start', 'investigate.batch.end']);
  });
});
