// Тесты для фазы 2.4b (семафор + параллельный fan-out решателя + Bridge events).
// Шаблон ровно повторяет tests/investigate-fanout.test.ts (фаза 2.3b):
//
//   * Mock solveDiagnosis через DI (`solveDiagnosisImpl`). Реальный SDK не зовётся.
//   * vi.mock на src/observe/bridge.js — проверяем эмит solve.batch.start/end +
//     verify, что solveDiagnosis получил наш parentSession (через
//     solveDepsOverride / dep-spy).
//   * Prisma — shared dev.db, изоляция через уникальный `parentSession` в SELECT.
//   * Параллельность через atomic-счётчик inFlight внутри mock'а.

import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSchemaInvariants } from '../src/db/invariants-check.js';
import { BudgetExceededError } from '../src/llm/call.js';
import type { SolveConfig } from '../src/solve/config.js';
import { solveMany } from '../src/solve/fanout.js';
import {
  SolveBudgetExceededError,
  type SolveResult,
  SolveTimeoutError,
  type solveDiagnosis as defaultSolveDiagnosis,
} from '../src/solve/run.js';

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

function makeConfig(overrides: Partial<SolveConfig> = {}): SolveConfig {
  return {
    targetProjectPath: '/dev/null',
    model: 'claude-sonnet-4-6',
    subagentType: 'Plan',
    timeoutMs: 5_000,
    maxTokens: 100_000,
    maxTurns: 20,
    promptId: 'solve:propose:test',
    bashWhitelist: ['cat'],
    concurrency: 3,
    maxProblemsPerCycle: 10,
    parentSessionPrefix: 'solve-test',
    asOf: 0,
    sourcePath: 'tests/solve-fanout.test.ts',
    ...overrides,
  };
}

function makeMockResult(overrides: Partial<SolveResult> = {}): SolveResult {
  return {
    asIs: 'как сейчас — тестовый абзац для решения.',
    problem: 'почему это проблема — тестовый абзац.',
    asWillBe: 'как будет после правки — тестовый абзац.',
    files: [{ path: 'src/test.ts', action: 'edit' }],
    estimateMinutes: 30,
    subagentId: ulid(),
    totalUsd: 0.02,
    totalTokens: 6_000,
    durationMs: 200,
    timedOut: false,
    spendRecordId: null,
    ...overrides,
  };
}

// Генератор уникальных diagnosisId для одного теста.
function makeDiagnosisIds(n: number): string[] {
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

describe('solveMany — параллельность через семафор', () => {
  it('concurrency=2, 4 diagnoses с задержкой 100мс → max in-flight = 2', async () => {
    const ids = makeDiagnosisIds(4);
    let inFlight = 0;
    let maxInFlight = 0;

    const fakeSolve: typeof defaultSolveDiagnosis = async (diagnosisId) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 100));
      inFlight--;
      return makeMockResult({ asIs: `обработана ${diagnosisId.slice(-6)} как сейчас` });
    };

    const startedAt = Date.now();
    const result = await solveMany(ids, {
      db: prisma,
      configOverride: makeConfig({ concurrency: 2 }),
      solveDiagnosisImpl: fakeSolve,
    });
    const durationMs = Date.now() - startedAt;

    expect(maxInFlight).toBe(2);
    expect(result.results).toHaveLength(4);
    expect(result.failures).toHaveLength(0);
    expect(result.deferred).toHaveLength(0);
    // 4 × 100мс ÷ 2 параллели ≈ 200мс. Допуск ±150мс.
    expect(durationMs).toBeGreaterThanOrEqual(180);
    expect(durationMs).toBeLessThan(500);
    // Все diagnosisId сохранены.
    const resultIds = new Set(result.results.map((r) => r.diagnosisId));
    expect(resultIds).toEqual(new Set(ids));
  });
});

// ---------------------------------------------------------------------------
// Тест 2 — BudgetExceeded на середине fan-out'а.
// ---------------------------------------------------------------------------

describe('solveMany — BudgetExceeded → drain + deferred', () => {
  it('concurrency=1, 4 diagnoses, на 3-й — BudgetExceeded → 2 succeeded + 0 failed + 2 deferred', async () => {
    const ids = makeDiagnosisIds(4);

    let callCount = 0;
    const fakeSolve: typeof defaultSolveDiagnosis = async () => {
      callCount++;
      if (callCount === 3) {
        throw new BudgetExceededError('per-cycle', 300_000, 300_000, ulid());
      }
      return makeMockResult();
    };

    const result = await solveMany(ids, {
      db: prisma,
      configOverride: makeConfig({ concurrency: 1 }),
      solveDiagnosisImpl: fakeSolve,
    });

    expect(result.results).toHaveLength(2);
    expect(result.failures).toHaveLength(0);
    expect(result.deferred).toHaveLength(2);

    expect(result.results.map((r) => r.diagnosisId)).toEqual([ids[0], ids[1]]);

    const deferredIds = result.deferred.map((d) => d.diagnosisId).sort();
    expect(deferredIds).toEqual([ids[2], ids[3]].sort());
    for (const d of result.deferred) {
      expect(d.reason).toBe('per-cycle-budget');
    }

    // Физическая проверка: 2 audit.budget.deferred Record'а с subjectKind='diagnosis'.
    const dbRecords = await selectRecordsByParentSession(
      'audit.budget.deferred',
      result.parentSession,
    );
    expect(dbRecords).toHaveLength(2);
    const dbDiagnosisIds = dbRecords.map((r) => r.properties.diagnosisId).sort();
    expect(dbDiagnosisIds).toEqual([ids[2], ids[3]].sort());
    for (const r of dbRecords) {
      expect(r.properties.reason).toBe('per-cycle-budget');
      expect(r.properties.subjectKind).toBe('diagnosis');
      expect(r.properties.parentSession).toBe(result.parentSession);
      expect(typeof r.properties.attemptedAt).toBe('number');
    }
  });

  it('SolveBudgetExceededError тоже идёт в deferred (>maxTokens на одной solve-сессии)', async () => {
    const ids = makeDiagnosisIds(3);

    let callCount = 0;
    const fakeSolve: typeof defaultSolveDiagnosis = async () => {
      callCount++;
      if (callCount === 2) {
        throw new SolveBudgetExceededError(150_000, 100_000);
      }
      return makeMockResult();
    };

    const result = await solveMany(ids, {
      db: prisma,
      configOverride: makeConfig({ concurrency: 1 }),
      solveDiagnosisImpl: fakeSolve,
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

describe('solveMany — non-budget failures', () => {
  it('SolveTimeoutError на 2-й → 3 succeeded + 1 failed + 0 deferred', async () => {
    const ids = makeDiagnosisIds(4);

    let callCount = 0;
    const fakeSolve: typeof defaultSolveDiagnosis = async () => {
      callCount++;
      if (callCount === 2) {
        throw new SolveTimeoutError(5_000);
      }
      return makeMockResult();
    };

    const result = await solveMany(ids, {
      db: prisma,
      configOverride: makeConfig({ concurrency: 1 }),
      solveDiagnosisImpl: fakeSolve,
    });

    expect(result.results).toHaveLength(3);
    expect(result.failures).toHaveLength(1);
    expect(result.deferred).toHaveLength(0);

    const failure = result.failures[0];
    expect(failure?.diagnosisId).toBe(ids[1]);
    expect(failure?.errorClass).toBe('SolveTimeoutError');
    expect(failure?.message).toMatch(/тайм-аут|5000/);
  });
});

// ---------------------------------------------------------------------------
// Тест 4 — soft-cap.
// ---------------------------------------------------------------------------

describe('solveMany — soft-cap', () => {
  it('15 diagnoses, maxProblemsPerCycle=10 → 10 запущено + 5 в deferred(soft-cap-skip)', async () => {
    const ids = makeDiagnosisIds(15);

    const fakeSolve: typeof defaultSolveDiagnosis = async () => makeMockResult();

    const result = await solveMany(ids, {
      db: prisma,
      configOverride: makeConfig({ concurrency: 3, maxProblemsPerCycle: 10 }),
      solveDiagnosisImpl: fakeSolve,
    });

    expect(result.results).toHaveLength(10);
    expect(result.failures).toHaveLength(0);
    expect(result.deferred).toHaveLength(5);

    const deferredIds = result.deferred.map((d) => d.diagnosisId);
    expect(deferredIds).toEqual(ids.slice(10));
    for (const d of result.deferred) {
      expect(d.reason).toBe('soft-cap-skip');
    }

    // 5 audit.solve.softcap.skip Records.
    const dbRecords = await selectRecordsByParentSession(
      'audit.solve.softcap.skip',
      result.parentSession,
    );
    expect(dbRecords).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Тест 5 — parentSession уникален и эмиты solve.batch.* + N×solve.* пробрасываются.
// ---------------------------------------------------------------------------

describe('solveMany — parentSession и Bridge events', () => {
  it('один parentSession на batch, эмитятся solve.batch.start/end; solveDiagnosis получает parentSession', async () => {
    const ids = makeDiagnosisIds(3);

    const seenParentSessions: Array<string | undefined> = [];
    const fakeSolve: typeof defaultSolveDiagnosis = async (_diagnosisId, runDeps) => {
      seenParentSessions.push(runDeps?.parentSession);
      return makeMockResult();
    };

    const result = await solveMany(ids, {
      db: prisma,
      configOverride: makeConfig({ concurrency: 2 }),
      solveDiagnosisImpl: fakeSolve,
    });

    // parentSession уникален и начинается с prefix'а.
    expect(result.parentSession).toMatch(/^solve-test-[0-9A-HJKMNP-TV-Z]{26}$/);

    // Каждый solveDiagnosis получил наш parentSession.
    expect(seenParentSessions).toHaveLength(3);
    for (const ps of seenParentSessions) {
      expect(ps).toBe(result.parentSession);
    }

    const calls = vi.mocked(emit).mock.calls;
    const events = calls.map((c) => c[0]);

    const batchStarts = events.filter((e) => e.type === 'solve.batch.start');
    const batchEnds = events.filter((e) => e.type === 'solve.batch.end');
    expect(batchStarts).toHaveLength(1);
    expect(batchEnds).toHaveLength(1);

    const bs = batchStarts[0] as {
      diagnosesIn: number;
      concurrency: number;
      parentSession: string;
    };
    expect(bs.diagnosesIn).toBe(3);
    expect(bs.concurrency).toBe(2);
    expect(bs.parentSession).toBe(result.parentSession);

    const be = batchEnds[0] as {
      succeeded: number;
      failed: number;
      deferred: number;
      totalUsd: number;
      totalTokens: number;
      parentSession: string;
    };
    expect(be.succeeded).toBe(3);
    expect(be.failed).toBe(0);
    expect(be.deferred).toBe(0);
    expect(be.totalUsd).toBeCloseTo(0.06, 5);
    expect(be.totalTokens).toBe(18_000);
    expect(be.parentSession).toBe(result.parentSession);

    // audit.solve.batch Record в БД.
    const auditRow = await prisma.$queryRawUnsafe<Array<{ id: string; properties: string }>>(
      `SELECT id, properties FROM "Record" WHERE id = ?`,
      result.auditRecordId,
    );
    expect(auditRow).toHaveLength(1);
    const auditProps = JSON.parse(auditRow[0]?.properties ?? '{}');
    expect(auditProps.parentSession).toBe(result.parentSession);
    expect(auditProps.succeeded).toBe(3);
    expect(auditProps.diagnosesIn).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Тест 6 — пустой инпут.
// ---------------------------------------------------------------------------

describe('solveMany — пустой инпут', () => {
  it('пустой массив diagnosisIds → ноль workers, эмитятся только batch.start/end', async () => {
    const fakeSolve: typeof defaultSolveDiagnosis = async () => {
      throw new Error('не должно вызываться');
    };

    const result = await solveMany([], {
      db: prisma,
      configOverride: makeConfig(),
      solveDiagnosisImpl: fakeSolve,
    });

    expect(result.results).toHaveLength(0);
    expect(result.failures).toHaveLength(0);
    expect(result.deferred).toHaveLength(0);
    expect(result.totalUsd).toBe(0);
    expect(result.totalTokens).toBe(0);

    const calls = vi.mocked(emit).mock.calls;
    const types = calls.map((c) => c[0].type);
    expect(types).toEqual(['solve.batch.start', 'solve.batch.end']);
  });
});
