import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertSchemaInvariants } from '../src/db/invariants-check.js';
import { loadEnv } from '../src/env.js';
import { type AnthropicMessagesClient, BudgetExceededError, call } from '../src/llm/call.js';
import { getMoneyReportData } from '../src/llm/money-report.js';
import { resetTransportForTests } from '../src/llm/transport.js';

// Форсим apikey-режим: транспорт читает LLM_TRANSPORT при первом getTransport(),
// а тесты ниже ожидают per-token биллинг (usd>0). Если в .env.local нет реального
// ANTHROPIC_API_KEY (CI/dev без подключения), подставляем тестовый stub — все
// мок-тесты идут через clientOverride, ключ нужен только чтобы транспорт не
// бросил TransportConfigError. Реальный API-тест ниже пропускается, если ключ
// был застаблен (см. REAL_API_KEY_AVAILABLE).
process.env.LLM_TRANSPORT = 'apikey';
loadEnv();
const REAL_API_KEY_AVAILABLE = Boolean(process.env.ANTHROPIC_API_KEY);
if (!REAL_API_KEY_AVAILABLE) {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-stub';
}
resetTransportForTests();

const db = new PrismaClient();

beforeAll(async () => {
  await db.$connect();
  await assertSchemaInvariants(db);
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  // Чистим только spend/deny — не трогаем остальную БД, чтобы инварианты теста (audit.* immutable)
  // обходились корректно. SQL DELETE на audit.* отвергается триггером record_no_delete — но в тесте
  // нам нужно сбросить состояние. Решение: вместо DELETE используем raw "DROP TRIGGER → DELETE → CREATE"
  // паттерн? Нет, это сломает инвариант. Правильнее — фильтровать по уникальному маркеру в test-promptId.
  // Но computeCurrentSpend не фильтрует по promptId, она читает глобально по типу. Значит нужен sandbox.
  //
  // Sandbox-стратегия: каждый тестовый прогон использует свою БД через ANTHROPIC_TEST_DB_URL? Слишком тяжело.
  // Простое: используем уникальный ULID-prefix для тестовых записей и сравниваем относительные дельты,
  // а не абсолютные значения. См. конкретные тесты ниже.
});

describe('cost-meter — pre-call guard и audit.spend', () => {
  it('hard-cap по daily.usd блокирует второй вызов ДО API + audit.budget.deny записывается', async () => {
    // Влиаем мизерный лимит → любой prior spend > $0.001 заставит guard сработать.
    const tinyLimits = {
      perCycle: { inputTokens: 1_000_000_000 }, // не хотим, чтобы per-cycle стрельнул
      daily: { usd: 0.001 },
      monthly: { usd: 1_000_000 },
    };

    // Имитируем «первый вызов» — пишем audit.spend с usd=0.01 (выше лимита 0.001).
    const priorId = ulid();
    const priorProperties = JSON.stringify({
      promptId: 'test:budget-guard-prior',
      model: 'claude-sonnet-4-6',
      modelRequested: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      usd: 0.01,
      pricingAsOf: Date.now(),
    });
    const now = Date.now();
    await db.$executeRawUnsafe(
      `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt) VALUES (?, 'audit.spend', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
      priorId,
      priorProperties,
      now,
      now,
    );

    const denyCountBefore = await countAuditDeny(db);

    // Mock-клиент: если будет вызван, тест провалится (мы должны блокироваться ДО сетевого hop'а).
    const exploding: AnthropicMessagesClient = {
      messages: {
        create: async () => {
          throw new Error('NETWORK CALL MUST NOT HAPPEN — guard failed to block');
        },
      },
    };

    const promptId = `test:budget-guard-${ulid()}`;
    await expect(
      call(
        {
          promptId,
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'should be blocked' }],
          limitsOverride: tinyLimits,
          clientOverride: exploding,
        },
        db,
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    const denyCountAfter = await countAuditDeny(db);
    expect(denyCountAfter).toBe(denyCountBefore + 1);

    // Проверяем шейп deny-записи: must mention 'daily' и наш promptId.
    const lastDeny = await db.$queryRawUnsafe<{ properties: string }[]>(
      `SELECT properties FROM "Record" WHERE type = 'audit.budget.deny' ORDER BY createdAt DESC LIMIT 1`,
    );
    expect(lastDeny[0]).toBeDefined();
    const props = JSON.parse(lastDeny[0]?.properties ?? '{}') as Record<string, unknown>;
    expect(props.limit).toBe('daily');
    expect(props.cap).toBe(0.001);
    expect(props.promptId).toBe(promptId);
    expect(typeof props.current).toBe('number');
    expect(props.current).toBeGreaterThanOrEqual(0.01);
  });

  it('hard-cap по per-cycle.inputTokens блокирует ДО API', async () => {
    const tinyLimits = {
      perCycle: { inputTokens: 50 }, // ниже 100 input tokens из prior spend выше
      daily: { usd: 1_000_000 },
      monthly: { usd: 1_000_000 },
    };
    const exploding: AnthropicMessagesClient = {
      messages: {
        create: async () => {
          throw new Error('NETWORK CALL MUST NOT HAPPEN — per-cycle guard failed');
        },
      },
    };
    await expect(
      call(
        {
          promptId: `test:per-cycle-${ulid()}`,
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'should be blocked' }],
          limitsOverride: tinyLimits,
          clientOverride: exploding,
        },
        db,
      ),
    ).rejects.toThrow(/per-cycle/);
  });

  it('успешный вызов с mock-клиентом пишет audit.spend с непустыми токенами и USD>0', async () => {
    const promptId = `test:mock-success-${ulid()}`;
    const mockResponse: AnthropicMessagesClient = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: 'mock response' }],
          usage: {
            input_tokens: 12,
            output_tokens: 7,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 0,
          },
        }),
      },
    };

    const result = await call(
      {
        promptId,
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello' }],
        // Высокие лимиты, чтобы prior spend от предыдущего теста не блокировал.
        limitsOverride: {
          perCycle: { inputTokens: 10_000_000 },
          daily: { usd: 1_000_000 },
          monthly: { usd: 1_000_000 },
        },
        clientOverride: mockResponse,
      },
      db,
    );

    expect(result.text).toBe('mock response');
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(7);
    expect(result.usd).toBeGreaterThan(0);
    expect(result.pricingAsOf).toBeGreaterThan(0);
    expect(result.modelCanonical).toBe('claude-sonnet-4-6');

    const spendRow = await db.$queryRawUnsafe<{ properties: string }[]>(
      `SELECT properties FROM "Record" WHERE id = ?`,
      result.spendRecordId,
    );
    expect(spendRow[0]).toBeDefined();
    const props = JSON.parse(spendRow[0]?.properties ?? '{}') as Record<string, unknown>;
    expect(props.promptId).toBe(promptId);
    expect(props.model).toBe('claude-sonnet-4-6');
    expect(props.inputTokens).toBe(12);
    expect(props.outputTokens).toBe(7);
    expect(props.cacheReadTokens).toBe(3);
    expect(typeof props.usd).toBe('number');
    expect(props.usd as number).toBeGreaterThan(0);
    expect(typeof props.pricingAsOf).toBe('number');
  });

  it('alias-модель резолвится в каноническую через config/pricing.md', async () => {
    const promptId = `test:alias-${ulid()}`;
    const mockResponse: AnthropicMessagesClient = {
      messages: {
        create: async (params) => {
          // Проверяем, что в API ушло каноническое имя, не alias.
          expect(params.model).toBe('claude-opus-4-7');
          return {
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
    };
    const result = await call(
      {
        promptId,
        model: 'claude-opus-4-7[1m]', // alias
        messages: [{ role: 'user', content: 'x' }],
        limitsOverride: {
          perCycle: { inputTokens: 1_000_000_000 },
          daily: { usd: 1_000_000 },
          monthly: { usd: 1_000_000 },
        },
        clientOverride: mockResponse,
      },
      db,
    );
    expect(result.modelCanonical).toBe('claude-opus-4-7');
  });

  it('getMoneyReportData агрегирует daily/monthly корректно', async () => {
    const data = await getMoneyReportData(db);
    expect(data.daily.cap).toBeGreaterThan(0);
    expect(data.monthly.cap).toBeGreaterThan(0);
    expect(data.daily.calls).toBeGreaterThanOrEqual(1);
    expect(data.daily.usd).toBeGreaterThan(0);
  });
});

describe('cost-meter — реальный API (skip без ANTHROPIC_API_KEY)', () => {
  const it_ = REAL_API_KEY_AVAILABLE ? it : it.skip;

  it_(
    'echo hello к Sonnet 4.6 → audit.spend с USD>0 и непустыми токенами',
    async () => {
      const promptId = `test:real-echo-${ulid()}`;
      const result = await call(
        {
          promptId,
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'Скажи только одно слово: hello' }],
          maxTokens: 50,
          // Используем дефолтные лимиты из config/budget.md. На пустой БД (или после reset) prior spend = 0.
          // Если запускать в проде поверх накопленного spend — этот тест может удивить, но в CI/test:budget
          // мы запускаем после db:reset.
        },
        db,
      );
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
      expect(result.usd).toBeGreaterThan(0);

      const row = await db.$queryRawUnsafe<{ properties: string; closedAt: number }[]>(
        `SELECT properties, closedAt FROM "Record" WHERE id = ?`,
        result.spendRecordId,
      );
      expect(row[0]).toBeDefined();
      expect(row[0]?.closedAt).toBeTruthy();
    },
    30_000,
  );
});

describe('Biome rule: @anthropic-ai/sdk запрещён вне src/llm/**', () => {
  it('падает на тестовом импорте вне src/llm/', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'biome-rule-'));
    const violator = join(tmpDir, 'violator.ts');
    try {
      await writeFile(
        violator,
        "import Anthropic from '@anthropic-ai/sdk';\nexport const x = Anthropic;\n",
      );
      const result = spawnSync(
        'pnpm',
        ['exec', 'biome', 'check', '--config-path', process.cwd(), violator],
        {
          encoding: 'utf-8',
          cwd: process.cwd(),
        },
      );
      expect(result.status).not.toBe(0);
      const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      expect(combined).toMatch(/anthropic|@anthropic-ai\/sdk/i);
      expect(combined).toMatch(/restricted|allowed only/i);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('тот же импорт внутри src/llm/ через override проходит', async () => {
    // Простая проверка: src/llm/call.ts уже импортирует @anthropic-ai/sdk и НЕ ловит ошибку.
    // Если это сломалось — pnpm exec biome check . выше сообщил бы.
    const result = spawnSync(
      'pnpm',
      ['exec', 'biome', 'check', '--config-path', process.cwd(), 'src/llm/call.ts'],
      {
        encoding: 'utf-8',
        cwd: process.cwd(),
      },
    );
    expect(result.status).toBe(0);
  }, 20_000);
});

async function countAuditDeny(db: PrismaClient): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ c: bigint }[]>(
    `SELECT COUNT(*) AS c FROM "Record" WHERE type = 'audit.budget.deny'`,
  );
  return Number(rows[0]?.c ?? 0);
}
