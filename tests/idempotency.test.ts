import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runIteration } from '../src/core/loop.js';
import {
  type EventTrigger,
  triggerCronMorning,
  triggerDevTick,
  triggerManual,
} from '../src/core/triggers.js';
import { assertSchemaInvariants } from '../src/db/invariants-check.js';
import type { TelegramMessage } from '../src/report/morning.js';

// Pipeline-моки на shared dev.db: idempotency-тесты исторически (1.4) запускали
// «пустой» runIteration без сшивки. Теперь тело runIteration — полный pipeline,
// потому подкладываем нулевые fetch/send, чтобы тесты проверяли только идемпотентный
// upsert и audit.repeat. Реальные fetch/send требуют Keychain + Telegram, которые
// в тестовой среде недоступны.
const noopFetch = async () => ({
  messagesFound: 0,
  messagesInserted: 0,
  messagesDeduplicated: 0,
  since: null,
  until: new Date(),
  chatIds: [],
  auditRecordId: ulid(),
});
const noopSend = async (messages: TelegramMessage[]) => ({
  sentMessageIds: messages.map((_, i) => 90_000 + i),
  messages,
  founderChatId: 'idemp-test-chat',
});

// Все границы pipeline'а возвращают «ничего нового». Это даёт чистый
// outcome='empty' (если pending=0 в shared dev.db) ИЛИ 'ok' (если pending>0,
// но investigate mock всё равно ничего не делает). В любом случае — без
// реального SDK / Telegram / Keychain.
const noopInvestigate = async () => ({
  results: [],
  failures: [],
  deferred: [],
  parentSession: 'idemp-investigate',
  totalUsd: 0,
  totalTokens: 0,
  durationMs: 0,
  auditRecordId: ulid(),
});
const noopPersistInvestigate = async () => ({
  diagnosesCreated: [],
  failuresAuditedAs: [],
  deferredAlreadyAudited: 0,
});
const noopRunSolve = async () => ({
  fanout: {
    results: [],
    failures: [],
    deferred: [],
    parentSession: 'idemp-solve',
    totalUsd: 0,
    totalTokens: 0,
    durationMs: 0,
    auditRecordId: ulid(),
  },
  persist: { proposalsCreated: [], failuresAuditedAs: [], deferredAlreadyAudited: 0 },
});

function deps(prisma: PrismaClient) {
  return {
    db: prisma,
    fetchSupportMessages: noopFetch,
    sendReport: noopSend,
    investigateMany: noopInvestigate,
    persistFanoutResult: noopPersistInvestigate,
    runSolveBatch: noopRunSolve,
  };
}

// Тесты делят БД с invariants/budget/etc — фильтруем по уникальному префиксу
// idempotencyKey, чтобы гарантировать изоляцию (см. retrospectives/:
// «Vitest single fork, БД shared»).
//
// Префикс = idemp-test-<run-id>: первые 8 символов ULID. Все триггеры в этом
// файле будут начинаться на него; остальные тесты нашего префикса не используют.
const RUN_ID = ulid().slice(0, 8);
const TEST_PREFIX = `idemp-test-${RUN_ID}`;

function tagged(suffix: string): EventTrigger {
  return {
    source: 'manual',
    idempotencyKey: `${TEST_PREFIX}:${suffix}`,
    properties: { kind: 'idempotency-test', suffix },
  };
}

const db = new PrismaClient();

beforeAll(async () => {
  await db.$connect();
  await assertSchemaInvariants(db);
});

afterAll(async () => {
  await db.$disconnect();
});

async function countTriggers(prefix: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n FROM "Record" WHERE type = 'event.trigger' AND idempotencyKey LIKE ?`,
    `${prefix}%`,
  );
  return Number(rows[0]?.n ?? 0n);
}

async function countRepeatsForKeys(prefix: string): Promise<number> {
  // audit.repeat ссылается на event.trigger через parentId. Считаем все audit.repeat,
  // чей parent — event.trigger из нашего префикса.
  const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n
       FROM "Record" r
       JOIN "Record" t ON t.id = r.parentId
      WHERE r.type = 'audit.repeat'
        AND t.type = 'event.trigger'
        AND t.idempotencyKey LIKE ?`,
    `${prefix}%`,
  );
  return Number(rows[0]?.n ?? 0n);
}

describe('runIteration — идемпотентность по idempotencyKey', () => {
  it('тот же ключ дважды → одна event.trigger + одна audit.repeat', async () => {
    const trigger = tagged('same-key');
    const prefix = trigger.idempotencyKey;

    const first = await runIteration(trigger, deps(db));
    // 1.4 контракт: первый вызов с новым ключом — ne 'repeat'. Pipeline-исход
    // ('empty' если pending=0, 'ok' если pending>0 от старых тестов в shared
    // dev.db) — для idempotency не важен, проверка repeatRecordId и
    // accepted=upsert успешен — суть инварианта.
    expect(first.outcome).not.toBe('repeat');
    expect(first.outcome).not.toBe('failed');
    expect(first.repeatRecordId).toBeUndefined();

    const second = await runIteration(trigger, deps(db));
    expect(second.outcome).toBe('repeat');
    expect(second.triggerRecordId).toBe(first.triggerRecordId);
    expect(second.repeatRecordId).toBeDefined();

    expect(await countTriggers(prefix)).toBe(1);
    expect(await countRepeatsForKeys(prefix)).toBe(1);
  });

  it('manual с разным ULID — две event.trigger (audit.repeat не пишется)', async () => {
    // Используем триггеры из реального адаптера, чтобы проверить, что
    // ULID-генерация даёт разные ключи. Префикс уникальный для теста — фильтруем по нему.
    const a = triggerManual();
    const b = triggerManual();

    // Подменим префикс на тестовый, чтобы не загрязнять БД и легко считать.
    const tA = { ...a, idempotencyKey: `${TEST_PREFIX}:diff-ulid:${a.idempotencyKey}` };
    const tB = { ...b, idempotencyKey: `${TEST_PREFIX}:diff-ulid:${b.idempotencyKey}` };

    expect(tA.idempotencyKey).not.toBe(tB.idempotencyKey);

    const rA = await runIteration(tA, deps(db));
    const rB = await runIteration(tB, deps(db));
    expect(rA.outcome).not.toBe('repeat');
    expect(rA.outcome).not.toBe('failed');
    expect(rB.outcome).not.toBe('repeat');
    expect(rB.outcome).not.toBe('failed');
    expect(rA.triggerRecordId).not.toBe(rB.triggerRecordId);

    const sectionPrefix = `${TEST_PREFIX}:diff-ulid:`;
    expect(await countTriggers(sectionPrefix)).toBe(2);
    expect(await countRepeatsForKeys(sectionPrefix)).toBe(0);
  });

  it('cron + manual в одну дату — две event.trigger (разные префиксы ключей)', async () => {
    // Префиксы реальные: morning-detective:YYYY-MM-DD vs manual-tick:YYYY-MM-DD.
    // Чтобы в случае реального запуска dev:tick / launchd в той же дате не было ложного
    // accepted/repeat — приклеиваем тестовый суффикс, который реальный адаптер не генерирует.
    const cron = triggerCronMorning();
    const tick = triggerDevTick();
    const tCron = {
      ...cron,
      idempotencyKey: `${TEST_PREFIX}:date-mixed:${cron.idempotencyKey}`,
    };
    const tTick = {
      ...tick,
      idempotencyKey: `${TEST_PREFIX}:date-mixed:${tick.idempotencyKey}`,
    };

    // Префиксы реально разные:
    expect(tCron.idempotencyKey).not.toBe(tTick.idempotencyKey);
    expect(tCron.idempotencyKey).toContain('morning-detective:');
    expect(tTick.idempotencyKey).toContain('manual-tick:');

    const rCron = await runIteration(tCron, deps(db));
    const rTick = await runIteration(tTick, deps(db));
    expect(rCron.outcome).not.toBe('repeat');
    expect(rCron.outcome).not.toBe('failed');
    expect(rTick.outcome).not.toBe('repeat');
    expect(rTick.outcome).not.toBe('failed');

    const sectionPrefix = `${TEST_PREFIX}:date-mixed:`;
    expect(await countTriggers(sectionPrefix)).toBe(2);
    expect(await countRepeatsForKeys(sectionPrefix)).toBe(0);
  });
});
