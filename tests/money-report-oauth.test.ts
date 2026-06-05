// Тесты oauth-режима для getMoneyReport / getMoneyReportData.
// План: plans/ (фаза 4.2).
//
// Изолируем oauth-режим в отдельном файле — vitest сбрасывает module cache между
// файлами, а getTransport() мемоизирует mode из env. В money-report-routine.test.ts
// форсируется apikey, тут — oauth.
//
// База данных: НЕ нужна. Подменяем PrismaClient на in-memory мок, который
// возвращает фиктивные audit.spend/deny rows. Это юнит-тест рендера, а не
// интеграция с SQLite (это покрыто money-report-routine.test.ts).

process.env.LLM_TRANSPORT = 'oauth';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetTransportForTests } from '../src/llm/transport.js';

import { getMoneyReport, getMoneyReportData } from '../src/llm/money-report.js';

// ---------------------------------------------------------------------------
// Mock PrismaClient — возвращает пустые spend/deny строки, чтобы фокус был
// на ветке рендера (квота, заголовки), а не на агрегации.
// ---------------------------------------------------------------------------

function mockDb(spend: Array<{ properties: string; createdAt?: number }> = []): {
  $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown[]>;
} {
  return {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('audit.spend')) {
        return spend;
      }
      return [];
    },
  };
}

// Мок fetch'а к gateway. Возвращает либо данные, либо бросает (gateway down).
function mockFetch(
  payload: Record<string, unknown> | null,
  opts: { status?: number } = {},
): typeof fetch {
  return (async () => {
    if (payload === null) {
      throw new Error('connect ECONNREFUSED');
    }
    return new Response(JSON.stringify(payload), {
      status: opts.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------

describe('money-report — oauth режим', () => {
  beforeEach(() => {
    resetTransportForTests();
    process.env.LLM_TRANSPORT = 'oauth';
  });

  afterEach(() => {
    resetTransportForTests();
  });

  it('quota=null когда gateway недоступен', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: тестовый мок Prisma.
    const db = mockDb() as any;
    const data = await getMoneyReportData(db, new Date(), {
      fetchImpl: mockFetch(null),
    });
    expect(data.transport).toBe('oauth');
    expect(data.quota).toBeNull();
  });

  it('рендер «недоступен» когда gateway down', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: тестовый мок Prisma.
    const db = mockDb() as any;
    const report = await getMoneyReport(db, new Date(), {
      fetchImpl: mockFetch(null),
    });
    expect(report).toContain('подписка');
    expect(report).toContain('gateway недоступен');
    expect(report).toContain('Сегодня:');
    expect(report).toContain('Месяц:');
  });

  it('рендер квоты когда gateway вернул данные', async () => {
    const now = new Date('2026-05-17T12:00:00Z');
    const fiveHourReset = Math.floor(now.getTime() / 1000) + 3600 * 2; // через 2ч
    const sevenDayReset = Math.floor(now.getTime() / 1000) + 86400 * 3; // через 3д

    // biome-ignore lint/suspicious/noExplicitAny: тестовый мок Prisma.
    const db = mockDb() as any;
    const report = await getMoneyReport(db, now, {
      fetchImpl: mockFetch({
        five_hour: { utilization: 0.31, reset_unix: fiveHourReset },
        seven_day: { utilization: 0.05, reset_unix: sevenDayReset },
        representative_claim: 'five_hour',
        status: 'allowed',
        observed_at_unix: Math.floor(now.getTime() / 1000),
        fallback: false,
      }),
    });

    expect(report).toContain('5h-окно: 31%');
    expect(report).toContain('7d-окно: 5%');
    expect(report).toContain('через 2ч');
    expect(report).toContain('через 3д');
    expect(report).not.toContain('Статус подписки'); // status=allowed → не показываем
    expect(report).not.toContain('fallback'); // fallback=false
  });

  it('показывает статус подписки если не allowed', async () => {
    const now = new Date('2026-05-17T12:00:00Z');
    // biome-ignore lint/suspicious/noExplicitAny: тестовый мок Prisma.
    const db = mockDb() as any;
    const report = await getMoneyReport(db, now, {
      fetchImpl: mockFetch({
        five_hour: { utilization: 0.95, reset_unix: Math.floor(now.getTime() / 1000) + 60 },
        seven_day: null,
        representative_claim: 'five_hour',
        status: 'allowed_warning',
        observed_at_unix: Math.floor(now.getTime() / 1000),
        fallback: false,
      }),
    });
    expect(report).toContain('Статус подписки: allowed_warning');
  });

  it('показывает fallback-маркер если квота оценочная', async () => {
    const now = new Date('2026-05-17T12:00:00Z');
    // biome-ignore lint/suspicious/noExplicitAny: тестовый мок Prisma.
    const db = mockDb() as any;
    const report = await getMoneyReport(db, now, {
      fetchImpl: mockFetch({
        five_hour: { utilization: 0.1, reset_unix: Math.floor(now.getTime() / 1000) + 3600 },
        seven_day: null,
        representative_claim: '',
        status: 'allowed',
        observed_at_unix: Math.floor(now.getTime() / 1000),
        fallback: true,
      }),
    });
    expect(report).toContain('fallback-оценка');
  });

  it('рендер «ещё нет данных» когда gateway вернул пустой payload', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: тестовый мок Prisma.
    const db = mockDb() as any;
    const report = await getMoneyReport(db, new Date(), {
      fetchImpl: mockFetch({
        five_hour: null,
        seven_day: null,
        representative_claim: '',
        status: '',
        observed_at_unix: 0,
        fallback: false,
      }),
    });
    expect(report).toContain('ещё нет данных');
  });

  it('агрегирует токены и звонки из spend', async () => {
    const now = Date.now();
    const spendRows = [
      {
        properties: JSON.stringify({
          promptId: 'test:a',
          inputTokens: 1500,
          outputTokens: 200,
          usd: 0,
          routineId: 'r1',
        }),
        createdAt: now,
      },
      {
        properties: JSON.stringify({
          promptId: 'test:b',
          inputTokens: 800,
          outputTokens: 50,
          usd: 0,
          routineId: 'r1',
        }),
        createdAt: now,
      },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: тестовый мок Prisma.
    const db = mockDb(spendRows) as any;
    const data = await getMoneyReportData(db, new Date(), {
      fetchImpl: mockFetch(null),
    });
    expect(data.daily.calls).toBe(2);
    expect(data.daily.inputTokens).toBe(2300);
    expect(data.daily.outputTokens).toBe(250);
    expect(data.daily.usd).toBe(0);
  });

  it('byRoutine в oauth-режиме рендерится без $-сумм', async () => {
    const now = Date.now();
    const spendRows = [
      {
        properties: JSON.stringify({
          promptId: 'test:r1',
          inputTokens: 100,
          outputTokens: 10,
          usd: 0,
          routineId: 'support-triage',
        }),
        createdAt: now,
      },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: тестовый мок Prisma.
    const db = mockDb(spendRows) as any;
    const report = await getMoneyReport(db, new Date(), {
      fetchImpl: mockFetch(null),
    });
    if (report.includes('По routines')) {
      expect(report).toContain('support-triage:');
      expect(report).toContain('вызов(а)');
      // В oauth-режиме НЕ должно быть $-формата
      const routineLines = report
        .split('\n')
        .filter((line) => line.startsWith('  ') && line.includes('support-triage'));
      for (const line of routineLines) {
        expect(line).not.toContain('$');
      }
    }
  });
});
