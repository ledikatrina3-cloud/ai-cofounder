// Тесты агрегации audit.spend по routineId в getMoneyReportData / getMoneyReport.
// Фаза 1.5 нового плана `routines.md`.
//
// Стратегия:
//   * Юнит-тесты агрегации — через экспортированную aggregateByRoutine() напрямую
//     (синхронно, без БД). Это изолированно и воспроизводимо.
//   * Интеграционные smoke-тесты — через dev.db PrismaClient (как budget.test.ts).
//     Проверяем, что getMoneyReport() правильно форматирует секцию «По routines».
//   * isolated-db не используем: better-sqlite3 требует пересборки под текущую Node.
//
// Транспорт: этот файл специально проверяет apikey-режим (USD-форматирование).
// OAuth-форматирование — в tests/money-report-oauth.test.ts.

// LLM_TRANSPORT=apikey принудительно, ДО первого импорта transport-зависимых
// модулей: getTransport() мемоизирует значение env. Тесты с oauth — в отдельном
// файле; vitest изолирует module cache между файлами.
process.env.LLM_TRANSPORT = 'apikey';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-test-stub-for-apikey-format';

import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';
import { aggregateByRoutine, getMoneyReport } from '../src/llm/money-report.js';

loadEnv();

// ---------------------------------------------------------------------------
// Юнит-тесты aggregateByRoutine (без БД, синхронно).
// ---------------------------------------------------------------------------

// Вспомогательная функция: создаёт строку properties для audit.spend.
function mkRow(opts: { usd: number; routineId?: string }): { properties: string } {
  const props: Record<string, unknown> = {
    promptId: 'test',
    model: 'claude-sonnet-4-6',
    modelRequested: 'claude-sonnet-4-6',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    usd: opts.usd,
    pricingAsOf: Date.now(),
  };
  if (typeof opts.routineId === 'string') {
    props.routineId = opts.routineId;
  }
  return { properties: JSON.stringify(props) };
}

describe('aggregateByRoutine — юнит-тесты (без БД)', () => {
  // Тест 1. Без routineId → пустой массив.
  it('spend без routineId → byRoutine = []', () => {
    const rows = [mkRow({ usd: 0.05 }), mkRow({ usd: 0.1 })];
    expect(aggregateByRoutine(rows)).toEqual([]);
  });

  // Тест 2. Один spend с routineId.
  it('один spend с routineId → один элемент с calls=1', () => {
    const rows = [mkRow({ usd: 0.12, routineId: 'support-triage' })];
    const result = aggregateByRoutine(rows);
    expect(result).toHaveLength(1);
    expect(result[0]?.routineId).toBe('support-triage');
    expect(result[0]?.usd).toBeCloseTo(0.12, 10);
    expect(result[0]?.calls).toBe(1);
  });

  // Тест 3. Два spend с одним routineId → calls=2, usd суммируется.
  it('два spend с тем же routineId → calls=2, usd суммируется', () => {
    const rows = [
      mkRow({ usd: 0.07, routineId: 'support-triage' }),
      mkRow({ usd: 0.05, routineId: 'support-triage' }),
    ];
    const result = aggregateByRoutine(rows);
    expect(result).toHaveLength(1);
    expect(result[0]?.routineId).toBe('support-triage');
    expect(result[0]?.usd).toBeCloseTo(0.12, 10);
    expect(result[0]?.calls).toBe(2);
  });

  // Тест 4. Два spend с разными routineId → оба, отсортированы по usd desc.
  it('два spend с разными routineId → оба, отсортированы по usd desc', () => {
    const rows = [
      mkRow({ usd: 0.08, routineId: 'db-morning-triage' }),
      mkRow({ usd: 0.12, routineId: 'support-triage' }),
    ];
    const result = aggregateByRoutine(rows);
    expect(result).toHaveLength(2);
    expect(result[0]?.routineId).toBe('support-triage');
    expect(result[0]?.usd).toBeCloseTo(0.12, 10);
    expect(result[1]?.routineId).toBe('db-morning-triage');
    expect(result[1]?.usd).toBeCloseTo(0.08, 10);
  });

  // Тест 5. Более 5 разных routineId → только top-5.
  it('6 разных routineId → только top-5 по usd (минимальный исключается)', () => {
    const rows = [
      mkRow({ usd: 0.01, routineId: 'routine-a' }), // наименьший
      mkRow({ usd: 0.02, routineId: 'routine-b' }),
      mkRow({ usd: 0.03, routineId: 'routine-c' }),
      mkRow({ usd: 0.04, routineId: 'routine-d' }),
      mkRow({ usd: 0.05, routineId: 'routine-e' }),
      mkRow({ usd: 0.06, routineId: 'routine-f' }), // наибольший
    ];
    const result = aggregateByRoutine(rows);
    expect(result).toHaveLength(5);
    expect(result[0]?.routineId).toBe('routine-f');
    expect(result[4]?.routineId).toBe('routine-b');
    expect(result.map((r) => r.routineId)).not.toContain('routine-a');
  });

  // Тест 6. Смешанный ввод: часть с routineId, часть без.
  it('смесь spend с routineId и без → только именованные попадают в byRoutine', () => {
    const rows = [
      mkRow({ usd: 0.1 }), // без routineId — legacy
      mkRow({ usd: 0.05, routineId: 'support-triage' }),
      mkRow({ usd: 0.03 }), // без routineId — legacy
    ];
    const result = aggregateByRoutine(rows);
    expect(result).toHaveLength(1);
    expect(result[0]?.routineId).toBe('support-triage');
  });

  // Тест 7. Битый JSON — не роняет функцию.
  it('битый JSON в properties → строка пропускается, остальные обрабатываются', () => {
    const rows = [
      { properties: 'NOT JSON {{{' },
      mkRow({ usd: 0.12, routineId: 'support-triage' }),
    ];
    const result = aggregateByRoutine(rows);
    expect(result).toHaveLength(1);
    expect(result[0]?.routineId).toBe('support-triage');
  });
});

// ---------------------------------------------------------------------------
// Интеграционные smoke-тесты через dev.db.
// ---------------------------------------------------------------------------

const db = new PrismaClient();

beforeAll(async () => {
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('getMoneyReport — интеграционный smoke', () => {
  // Тест 8. getMoneyReport() форматирует секцию «По routines» при наличии spend.
  // Мы вставляем spend с маленьким usd ($0.001) и только проверяем, что:
  //   (a) getMoneyReport() выполняется без ошибок и возвращает строку с нужной структурой;
  //   (b) если byRoutine содержит нашу запись (зависит от top-5 конкуренции) —
  //       она отформатирована правильно.
  // Конкретный routineId в секции не проверяем — dev.db накапливает данные между
  // запусками и нельзя гарантировать попадание мелкого usd в top-5.
  it('getMoneyReport() возвращает строку с корректными секциями', async () => {
    const testRunId = ulid();
    const fullRoutineId = `test-${testRunId}-smoke-routine`;
    const now = Date.now();
    await db.$executeRawUnsafe(
      `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt) VALUES (?, 'audit.spend', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
      ulid(),
      JSON.stringify({
        promptId: `test:smoke-${testRunId}`,
        model: 'claude-sonnet-4-6',
        modelRequested: 'claude-sonnet-4-6',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        usd: 0.001,
        pricingAsOf: now,
        routineId: fullRoutineId,
      }),
      now,
      now,
    );

    const report = await getMoneyReport(db, new Date());

    // Структура отчёта корректная.
    expect(typeof report).toBe('string');
    expect(report).toContain('Бюджет');
    expect(report).toContain('Сегодня');
    expect(report).toContain('Месяц');

    // Если секция «По routines» есть — она правильно отформатирована.
    if (report.includes('По routines')) {
      expect(report).toMatch(/По routines \(сегодня\):/);
      // Каждая строка секции начинается с «  <routineId>: $X.XX».
      const routineLines = report
        .split('\n')
        .filter((line) => line.startsWith('  ') && line.includes(': $'));
      expect(routineLines.length).toBeGreaterThan(0);
    }
  });
});
