// Тесты для фазы 2.2a (триаж: одиночный Sonnet-вызов с tool_use).
//
// Стратегия мокинга: используем DI через `callImpl` — подменяем call.ts на
// функцию, которая возвращает CallResult без сетевого hop'а. Это устойчивее
// vi.mock и реалистичнее (мы тестируем shape парсинга tool_use, не интеграцию
// с Anthropic SDK — её покрывает budget.test.ts).
//
// Изоляция в shared dev.db: уникальный promptId-prefix через ulid() в каждом
// тесте, фильтруем audit.triage.invalid по этому маркеру (паттерн из 1.3/2.1b).

import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSchemaInvariants } from '../src/db/invariants-check.js';
import type { CallOptions, CallResult } from '../src/llm/call.js';
import {
  type SupportMessage,
  TriageInvalidResponseError,
  _resetPromptCache,
  extractProblems,
  formatSupportMessages,
} from '../src/triage/extract.js';

const RUN_ID = ulid().slice(0, 8);

const db = new PrismaClient();

beforeAll(async () => {
  await db.$connect();
  await assertSchemaInvariants(db);
  _resetPromptCache();
});

afterAll(async () => {
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// Хелперы.
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<SupportMessage> & { id: string }): SupportMessage {
  // 'username' in overrides — чтобы явно переданный null не схлопывался в дефолт
  // через ?? (null ?? 'fallback' = 'fallback', что губит тест на null-username).
  return {
    id: overrides.id,
    chatId: overrides.chatId ?? `2.2a-${RUN_ID}`,
    messageId: overrides.messageId ?? Math.floor(Math.random() * 100000),
    userId: 'userId' in overrides ? (overrides.userId ?? null) : '1001',
    username: 'username' in overrides ? (overrides.username ?? null) : `user-${RUN_ID}`,
    text: overrides.text ?? '',
    attachments: overrides.attachments ?? [],
    timestamp: overrides.timestamp ?? Date.now(),
  };
}

// Mock-callImpl: возвращает заранее заготовленный CallResult. Все cost-meter
// поля заполнены реалистично, чтобы ассерты по usd/usage не падали.
function makeMockCall(
  result: Partial<CallResult> & { toolUses: CallResult['toolUses'] },
): (opts: CallOptions) => Promise<CallResult> {
  return async (opts: CallOptions) => {
    return {
      text: result.text ?? '',
      toolUses: result.toolUses,
      stopReason: result.stopReason ?? 'tool_use',
      usd: result.usd ?? 0.005,
      usage: result.usage ?? {
        inputTokens: 1500,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheCreationTokens: 1200,
      },
      pricingAsOf: Date.now(),
      spendRecordId: result.spendRecordId ?? `spend-${RUN_ID}-${opts.promptId}-${ulid()}`,
      modelCanonical: result.modelCanonical ?? 'claude-sonnet-4-6',
    };
  };
}

// Записываем фейковый audit.spend Record, на который сошлётся тестовый
// CallResult.spendRecordId, чтобы FK-связь audit.triage.invalid.parentId на
// audit.spend была валидной (FK Restrict на Record.parent — см. 1.1).
async function recordFakeSpend(spendId: string): Promise<void> {
  const now = Date.now();
  const properties = JSON.stringify({
    promptId: 'triage:extract',
    model: 'claude-sonnet-4-6',
    modelRequested: 'claude-sonnet-4-6',
    inputTokens: 1500,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheCreationTokens: 1200,
    usd: 0.005,
    pricingAsOf: now,
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt) VALUES (?, 'audit.spend', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    spendId,
    properties,
    now,
    now,
  );
}

async function countTriageInvalid(promptIdMarker: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n FROM "Record" WHERE type = 'audit.triage.invalid' AND properties LIKE ?`,
    `%${promptIdMarker}%`,
  );
  return Number(rows[0]?.n ?? 0n);
}

// ---------------------------------------------------------------------------
// formatSupportMessages — чистая утилита, без LLM.
// ---------------------------------------------------------------------------

describe('formatSupportMessages', () => {
  it('пустой массив → плейсхолдер «сообщений нет»', () => {
    expect(formatSupportMessages([])).toContain('Сообщений нет');
  });

  it('сообщение с text → markdown-строка с id, username, timestamp, текстом', () => {
    const msg = makeMessage({
      id: '01HXYZ',
      username: 'alice',
      text: 'не могу оплатить',
      timestamp: 1714521600000, // 2024-05-01T00:00:00Z
    });
    const out = formatSupportMessages([msg]);
    expect(out).toContain('[id=01HXYZ]');
    expect(out).toContain('@alice');
    expect(out).toContain('не могу оплатить');
    expect(out).toContain('2024-05-01T00:00:00.000Z');
  });

  it('voice без text → attachment-маркер, тело «(текста нет)»', () => {
    const msg = makeMessage({
      id: 'voice-1',
      text: '',
      attachments: [{ type: 'voice', file_id: 'AwAC', transcribed: false }],
    });
    const out = formatSupportMessages([msg]);
    expect(out).toContain('(текста нет)');
    expect(out).toContain('attachments: voice (не разобрано)');
  });

  it('username=null → «без username»', () => {
    const msg = makeMessage({ id: 'anon-1', username: null, text: 'hi' });
    expect(formatSupportMessages([msg])).toContain('без username');
  });
});

// ---------------------------------------------------------------------------
// extractProblems — happy-path snapshot на shape.
// ---------------------------------------------------------------------------

describe('extractProblems — happy-path с моком LLM', () => {
  it('mock возвращает 3 problems → result.problems.length === 3, shape совпадает', async () => {
    const messages: SupportMessage[] = [];
    // 5 про оплату
    for (let i = 0; i < 5; i++) {
      messages.push(makeMessage({ id: `pay-${RUN_ID}-${i}`, text: `платёж завис ${i}` }));
    }
    // 4 про логин
    for (let i = 0; i < 4; i++) {
      messages.push(makeMessage({ id: `login-${RUN_ID}-${i}`, text: `не могу войти ${i}` }));
    }
    // 3 про скорость
    for (let i = 0; i < 3; i++) {
      messages.push(makeMessage({ id: `slow-${RUN_ID}-${i}`, text: `всё тормозит ${i}` }));
    }

    const spendId = `spend-${RUN_ID}-happy`;
    await recordFakeSpend(spendId);

    const mockCall = makeMockCall({
      spendRecordId: spendId,
      toolUses: [
        {
          id: 'toolu_01',
          name: 'extract_problems',
          input: {
            problems: [
              {
                summary: 'Клиенты не могут оплатить — платёж зависает.',
                symptoms: ['платёж завис', 'оплата не проходит'],
                supportMessageIds: messages.slice(0, 5).map((m) => m.id),
              },
              {
                summary: 'Клиенты не могут войти в систему.',
                symptoms: ['не могу войти'],
                supportMessageIds: messages.slice(5, 9).map((m) => m.id),
              },
              {
                summary: 'Клиенты жалуются на скорость работы.',
                symptoms: ['всё тормозит'],
                supportMessageIds: messages.slice(9, 12).map((m) => m.id),
              },
            ],
          },
        },
      ],
    });

    const result = await extractProblems(messages, { db, callImpl: mockCall });

    expect(result.problems).toHaveLength(3);
    expect(result.problems[0]!.summary).toContain('оплат');
    expect(result.problems[0]!.supportMessageIds).toHaveLength(5);
    expect(result.problems[1]!.supportMessageIds).toHaveLength(4);
    expect(result.problems[2]!.supportMessageIds).toHaveLength(3);

    // Метаданные
    expect(result.spendRecordId).toBe(spendId);
    expect(result.usd).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Snapshot на полный shape (фиксирует контракт для 2.2b).
    expect({
      problemCount: result.problems.length,
      shapes: result.problems.map((p) => ({
        hasSummary: typeof p.summary === 'string' && p.summary.length > 0,
        symptomsIsArray: Array.isArray(p.symptoms),
        idsCount: p.supportMessageIds.length,
      })),
    }).toMatchSnapshot();
  });

  it('mock возвращает problems: [] → result.problems пустой, не падает', async () => {
    const spendId = `spend-${RUN_ID}-empty`;
    await recordFakeSpend(spendId);

    const mockCall = makeMockCall({
      spendRecordId: spendId,
      toolUses: [
        {
          id: 'toolu_empty',
          name: 'extract_problems',
          input: { problems: [] },
        },
      ],
    });

    const result = await extractProblems([], { db, callImpl: mockCall });
    expect(result.problems).toEqual([]);
    expect(result.spendRecordId).toBe(spendId);
  });
});

// ---------------------------------------------------------------------------
// extractProblems — невалидные ответы LLM.
// ---------------------------------------------------------------------------

describe('extractProblems — невалидный ответ Sonnet', () => {
  it('mock не вернул ни одного tool_use → throw + audit.triage.invalid (no-tool-use)', async () => {
    const spendId = `spend-${RUN_ID}-no-tool`;
    await recordFakeSpend(spendId);

    const mockCall = makeMockCall({
      spendRecordId: spendId,
      toolUses: [],
      stopReason: 'end_turn',
      text: 'я не понял задачу',
    });

    const beforeCount = await countTriageInvalid(spendId);

    await expect(extractProblems([], { db, callImpl: mockCall })).rejects.toBeInstanceOf(
      TriageInvalidResponseError,
    );

    const afterCount = await countTriageInvalid(spendId);
    expect(afterCount - beforeCount).toBe(1);

    // Проверяем shape audit.triage.invalid — критично для отладки в продакшене.
    const audit = await db.$queryRawUnsafe<{ properties: string; parentId: string | null }[]>(
      `SELECT properties, parentId FROM "Record" WHERE type = 'audit.triage.invalid' AND properties LIKE ? ORDER BY createdAt DESC LIMIT 1`,
      `%${spendId}%`,
    );
    expect(audit[0]).toBeDefined();
    expect(audit[0]!.parentId).toBe(spendId);
    const props = JSON.parse(audit[0]!.properties) as Record<string, unknown>;
    expect(props.reason).toBe('no-tool-use');
    expect(props.promptId).toBe('triage:extract');
    expect(props.spendRecordId).toBe(spendId);
    expect(props.stopReason).toBe('end_turn');
  });

  it('mock вернул tool_use с input не соответствующим схеме → throw + schema-mismatch', async () => {
    const spendId = `spend-${RUN_ID}-bad-shape`;
    await recordFakeSpend(spendId);

    const mockCall = makeMockCall({
      spendRecordId: spendId,
      toolUses: [
        {
          id: 'toolu_bad',
          name: 'extract_problems',
          // problems это объект, а не массив — должен зафейлиться
          input: { problems: { not: 'an-array' } },
        },
      ],
    });

    await expect(extractProblems([], { db, callImpl: mockCall })).rejects.toMatchObject({
      name: 'TriageInvalidResponseError',
      reason: 'schema-mismatch',
    });
  });

  it('mock вернул tool_use с problem без обязательного поля supportMessageIds → schema-mismatch', async () => {
    const spendId = `spend-${RUN_ID}-missing-field`;
    await recordFakeSpend(spendId);

    const mockCall = makeMockCall({
      spendRecordId: spendId,
      toolUses: [
        {
          id: 'toolu_partial',
          name: 'extract_problems',
          input: {
            problems: [
              {
                summary: 'что-то болит',
                symptoms: ['боль'],
                // supportMessageIds отсутствует
              },
            ],
          },
        },
      ],
    });

    await expect(extractProblems([], { db, callImpl: mockCall })).rejects.toMatchObject({
      reason: 'schema-mismatch',
    });
  });

  it('mock вернул tool_use чужого имени → throw + wrong-tool', async () => {
    const spendId = `spend-${RUN_ID}-wrong-tool`;
    await recordFakeSpend(spendId);

    const mockCall = makeMockCall({
      spendRecordId: spendId,
      toolUses: [
        {
          id: 'toolu_wrong',
          name: 'something_else',
          input: { problems: [] },
        },
      ],
    });

    await expect(extractProblems([], { db, callImpl: mockCall })).rejects.toMatchObject({
      reason: 'wrong-tool',
    });
  });
});

// ---------------------------------------------------------------------------
// Опциональный реальный hit к Anthropic. Skip без ключа — 8/8 mock-кейсов
// зелёные на любой машине. С ключом — один реальный вызов на ~$0.02.
// ---------------------------------------------------------------------------

describe('extractProblems — реальный API (skip без ANTHROPIC_API_KEY)', () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const it_ = apiKey ? it : it.skip;

  it_(
    '12 сообщений (5 оплата / 4 логин / 3 скорость) → 3 problems от Sonnet 4.6',
    async () => {
      const messages: SupportMessage[] = [];
      const payTexts = [
        'не могу оплатить подписку — платёж зависает',
        'оплатил, а доступ не открылся',
        'списали дважды за одну подписку',
        'после оплаты карта заблокирована',
        'оплата висит больше часа',
      ];
      const loginTexts = [
        'не могу войти, пишет неверный пароль хотя я уверен',
        'после ввода логина крутится бесконечно',
        'забыл пароль, ссылка восстановления не приходит',
        'логин не принимается ни в браузере ни в приложении',
      ];
      const slowTexts = ['всё тормозит', 'страницы грузятся по минуте', 'приложение зависает'];

      for (const text of payTexts) {
        messages.push(makeMessage({ id: `real-pay-${RUN_ID}-${ulid()}`, text }));
      }
      for (const text of loginTexts) {
        messages.push(makeMessage({ id: `real-login-${RUN_ID}-${ulid()}`, text }));
      }
      for (const text of slowTexts) {
        messages.push(makeMessage({ id: `real-slow-${RUN_ID}-${ulid()}`, text }));
      }

      const result = await extractProblems(messages, { db });

      // Не пристёгиваемся жёстко к 3 — Sonnet может разделить на 2 или 4.
      // Главное: количество в адекватном диапазоне и shape валиден.
      expect(result.problems.length).toBeGreaterThanOrEqual(2);
      expect(result.problems.length).toBeLessThanOrEqual(5);
      for (const p of result.problems) {
        expect(typeof p.summary).toBe('string');
        expect(p.summary.length).toBeGreaterThan(0);
        expect(Array.isArray(p.symptoms)).toBe(true);
        expect(p.supportMessageIds.length).toBeGreaterThanOrEqual(1);
      }
      expect(result.usd).toBeGreaterThan(0);
      expect(result.spendRecordId).toBeTruthy();
    },
    60_000,
  );
});
