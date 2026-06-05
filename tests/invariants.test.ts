// Тесты схемных инвариантов (фаза 1.1, обновлено в 3.5 — изоляция БД).
//
// Стратегия (после 3.5):
//   * Isolated-db (template.db + cp) на каждый тест через afterEach/beforeEach.
//     До 3.5 — shared dev.db. Это порождало race condition: smoke-validator тест
//     DROP TRIGGER / ALTER TABLE мог снести защиту на живой dev.db пока другой
//     тест туда пишет → intermittent invariant check failure.
//   * smoke validator тесты используют тот же isolated.filePath — они делают
//     probe PrismaClient({ datasourceUrl: file:<path> }) явно, а не через
//     новый PrismaClient().

import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertSchemaInvariants } from '../src/db/invariants-check.js';
import {
  type IsolatedDb,
  type TemplateHandle,
  createIsolatedDb,
  setupTemplateDb,
} from './fixtures/isolated-db.js';

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

// Вспомогательный геттер — берёт свежий isolated.prisma для текущего теста.
function db() {
  return isolated.prisma;
}

let linkIdCounter = Date.now();
function nextLinkId(): number {
  linkIdCounter += 1;
  return linkIdCounter;
}

async function insertEventMessage(): Promise<string> {
  const id = ulid();
  await db().$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility) VALUES (?, 'event.message', '{}', 'system', 'autonomous')`,
    id,
  );
  return id;
}

describe('schema invariants — append-only Record', () => {
  // Каждая immutable-колонка должна реально отвергать UPDATE триггером.
  // Параметризованный тест защищает от опечатки в DDL триггера: например,
  // если кто-то напишет "priorty" вместо "priority", smoke-валидатор это
  // не поймает (он матчит на имя в whitelist'е), а этот тест — поймает.
  const immutableUpdateCases: Array<{ column: string; value: string | number }> = [
    { column: 'properties', value: `'{"x":1}'` },
    { column: 'parentId', value: `'01HNEW00000000000000000000'` },
    { column: 'actorKind', value: `'agent'` },
    { column: 'actorRef', value: `'CompanyWiki/test.md'` },
    { column: 'subjectPagePath', value: `'CompanyWiki/test.md'` },
    { column: 'dueAt', value: 1745044273089 },
    { column: 'priority', value: 2 },
    { column: 'visibility', value: `'ask_first'` },
    { column: 'idempotencyKey', value: `'manual:probe'` },
    // type / id / createdAt не проверяем здесь — они не имеют смысла как UPDATE
    // (изменение type меняет схему properties, id — primary key, createdAt
    //  пишется один раз). Их защита покрыта самим триггером, валидатором coverage.
  ];

  for (const { column, value } of immutableUpdateCases) {
    it(`UPDATE Record.${column} отвергается триггером record_immutable_fields`, async () => {
      const id = await insertEventMessage();
      // SAFETY: column и value берутся ТОЛЬКО из in-file константы immutableUpdateCases
      // выше. SQL-плейсхолдер `?` в SQLite допустим только для значений, не для имён
      // колонок, поэтому имя интерполируется. Не копируй этот паттерн в код, который
      // принимает column от пользователя/LLM/external — будет SQL injection.
      await expect(
        db().$executeRawUnsafe(`UPDATE "Record" SET "${column}" = ${value} WHERE id = ?`, id),
      ).rejects.toThrow(/immutable/i);
    });
  }

  it('DELETE Record отвергается триггером record_no_delete', async () => {
    const id = await insertEventMessage();
    await expect(db().$executeRawUnsafe(`DELETE FROM "Record" WHERE id = ?`, id)).rejects.toThrow(
      /append-only|forbidden/i,
    );
  });

  it('повторный UPDATE closedAt отвергается триггером record_close_once', async () => {
    const id = await insertEventMessage();
    await db().$executeRawUnsafe(`UPDATE "Record" SET "closedAt" = ? WHERE id = ?`, Date.now(), id);
    await expect(
      db().$executeRawUnsafe(
        `UPDATE "Record" SET "closedAt" = ? WHERE id = ?`,
        Date.now() + 1000,
        id,
      ),
    ).rejects.toThrow(/already set|cannot be reopened/i);
  });

  it('audit.* запись полностью immutable (UPDATE на closedReason отвергается)', async () => {
    const id = ulid();
    // createdAt явно задаём чтобы closedAt >= createdAt (избегаем record_chronology_check
    // при конкурентных тестах, где DEFAULT CURRENT_TIMESTAMP может отличаться).
    const nowMs = Date.now();
    await db().$executeRawUnsafe(
      `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt) VALUES (?, 'audit.action', '{}', 'system', 'autonomous', 'closed', ?, ?)`,
      id,
      nowMs,
      nowMs,
    );
    await expect(
      db().$executeRawUnsafe(`UPDATE "Record" SET "closedReason" = 'после-факта' WHERE id = ?`, id),
    ).rejects.toThrow(/audit\.\* records are fully immutable/i);
  });
});

describe('schema invariants — CHECK constraints', () => {
  it('INSERT event.trigger без idempotencyKey отвергается CHECK', async () => {
    await expect(
      db().$executeRawUnsafe(
        `INSERT INTO "Record" (id, type, properties, actorKind, visibility) VALUES (?, 'event.trigger', '{}', 'system', 'autonomous')`,
        ulid(),
      ),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('INSERT RecordLink с двумя NULL в (toRecordId, toPagePath) отвергается CHECK', async () => {
    const fromId = await insertEventMessage();
    await expect(
      db().$executeRawUnsafe(
        `INSERT INTO "RecordLink" (id, fromRecordId, toRecordId, toPagePath, linkType) VALUES (?, ?, NULL, NULL, 'касается')`,
        nextLinkId(),
        fromId,
      ),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('INSERT RecordLink с двумя NOT NULL в (toRecordId, toPagePath) отвергается CHECK', async () => {
    const fromId = await insertEventMessage();
    const toId = await insertEventMessage();
    const pagePath = `CompanyWiki/тест/${ulid()}.md`;
    await db().$executeRawUnsafe(
      `INSERT INTO "Page" (path, type, title, updatedAt, gitSha) VALUES (?, 'company', 'Тест', ?, 'sha-test')`,
      pagePath,
      Date.now(),
    );
    await expect(
      db().$executeRawUnsafe(
        `INSERT INTO "RecordLink" (id, fromRecordId, toRecordId, toPagePath, linkType) VALUES (?, ?, ?, ?, 'касается')`,
        nextLinkId(),
        fromId,
        toId,
        pagePath,
      ),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('UPDATE closedAt значением раньше createdAt отвергается CHECK record_chronology', async () => {
    const id = await insertEventMessage();
    const created = await db().$queryRawUnsafe<{ createdAt: number }[]>(
      `SELECT createdAt FROM "Record" WHERE id = ?`,
      id,
    );
    const createdMs = Number(created[0]?.createdAt ?? 0);
    await expect(
      db().$executeRawUnsafe(
        `UPDATE "Record" SET "closedAt" = ? WHERE id = ?`,
        createdMs - 1000,
        id,
      ),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('UPDATE closedAt текстовым ISO-значением отвергается CHECK typeof', async () => {
    const id = await insertEventMessage();
    await expect(
      db().$executeRawUnsafe(
        `UPDATE "Record" SET "closedAt" = ? WHERE id = ?`,
        '2026-04-30T17:05:21.000Z',
        id,
      ),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });
});

describe('smoke validator', () => {
  it('обнаруживает удалённый триггер и кидает InvariantsMissingError', async () => {
    // Используем тот же isolated filePath — probe работает с той же БД.
    const probe = new PrismaClient({ datasourceUrl: `file:${isolated.filePath}` });
    try {
      await probe.$connect();
      await probe.$executeRawUnsafe('DROP TRIGGER "record_no_delete"');
      await expect(assertSchemaInvariants(probe)).rejects.toThrow(/record_no_delete/);
    } finally {
      // Восстанавливаем триггер в isolated-копии (dev.db не трогаем).
      await probe.$executeRawUnsafe(
        `CREATE TRIGGER "record_no_delete" BEFORE DELETE ON "Record" BEGIN SELECT RAISE(ABORT, 'Record append-only: hard DELETE forbidden, use audit.cancel instead'); END`,
      );
      await probe.$disconnect();
    }
  });

  it('ловит дыру в append-only при ALTER TABLE: новая колонка Record не покрыта триггером', async () => {
    // Используем тот же isolated filePath — probe работает с той же БД.
    const probe = new PrismaClient({ datasourceUrl: `file:${isolated.filePath}` });
    try {
      await probe.$connect();
      // Имитируем будущий `prisma migrate dev` — добавляем колонку, забыв обновить
      // триггер record_immutable_fields. Smoke-валидатор должен это поймать.
      await probe.$executeRawUnsafe(`ALTER TABLE "Record" ADD COLUMN "future_metric_key" TEXT`);
      await expect(assertSchemaInvariants(probe)).rejects.toThrow(
        /immutable-coverage:Record\.future_metric_key/,
      );
    } finally {
      await probe.$executeRawUnsafe(`ALTER TABLE "Record" DROP COLUMN "future_metric_key"`);
      await probe.$disconnect();
    }
  });
});
