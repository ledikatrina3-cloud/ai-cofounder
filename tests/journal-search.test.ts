// Тесты для tool journal.search (фаза 2.5).
//
// Стратегия:
//   * Изолированная БД через template.db + cp (паттерн isolated-db.ts).
//     Каждый тест начинает с чистого листа — нет кросс-флейка.
//   * Записи создаём через prisma.$executeRawUnsafe (обходим append-only
//     CHECK — нам важна только выборка, не бизнес-инварианты).
//   * journalSearch принимает db?: PrismaClient — передаём изолированный.

import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JournalSearchError, journalSearch } from '../src/tools/journal-search/index.js';
import {
  type IsolatedDb,
  type TemplateHandle,
  createIsolatedDb,
  setupTemplateDb,
} from './fixtures/isolated-db.js';

// ---------------------------------------------------------------------------
// Test rig.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Вставляет запись в Record напрямую через raw SQL (обход append-only CHECK). */
async function insertRecord(
  db: IsolatedDb['prisma'],
  opts: {
    id?: string;
    type: string;
    properties?: Record<string, unknown>;
    parentId?: string | null;
    createdAt?: number;
  },
): Promise<string> {
  const id = opts.id ?? ulid();
  const createdAt = opts.createdAt ?? Date.now();
  const properties = JSON.stringify(opts.properties ?? {});
  const parentId = opts.parentId ?? null;

  // audit.* требует visibility = 'autonomous' (CHECK constraint).
  // Остальные типы — используем 'autonomous' для простоты (подходит всем).
  const visibility = 'autonomous';

  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, parentId, actorKind, visibility, status, createdAt)
     VALUES (?, ?, ?, ?, 'system', ?, 'open', ?)`,
    id,
    opts.type,
    properties,
    parentId,
    visibility,
    createdAt,
  );
  return id;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('journalSearch', () => {
  it('пустой журнал → пустой массив', async () => {
    const result = await journalSearch({}, isolated.prisma);
    expect(result).toEqual([]);
  });

  it('один Record → возвращается в результате', async () => {
    const id = await insertRecord(isolated.prisma, {
      type: 'audit.routine.start',
      properties: { routineId: 'test-routine' },
    });

    const result = await journalSearch({}, isolated.prisma);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(id);
    expect(result[0]?.type).toBe('audit.routine.start');
    expect(result[0]?.properties.routineId).toBe('test-routine');
  });

  it('фильтр по type: только audit.routine.end', async () => {
    await insertRecord(isolated.prisma, { type: 'audit.routine.start' });
    await insertRecord(isolated.prisma, { type: 'audit.routine.end' });
    await insertRecord(isolated.prisma, { type: 'audit.routine.end' });

    const result = await journalSearch({ type: 'audit.routine.end' }, isolated.prisma);
    expect(result).toHaveLength(2);
    for (const r of result) {
      expect(r.type).toBe('audit.routine.end');
    }
  });

  it('фильтр по since/until: Record вне диапазона → не возвращается', async () => {
    const now = Date.now();
    const inRange = now - 3_600_000; // 1 час назад — в пределах 24 ч
    const outOfRange = now - 2 * 24 * 60 * 60 * 1000; // 2 дня назад — вне диапазона

    const idIn = await insertRecord(isolated.prisma, {
      type: 'audit.spend',
      createdAt: inRange,
    });
    await insertRecord(isolated.prisma, {
      type: 'audit.spend',
      createdAt: outOfRange,
    });

    const result = await journalSearch(
      {
        since: now - 24 * 60 * 60 * 1000,
        until: now,
      },
      isolated.prisma,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(idIn);
  });

  it('фильтр по routineId: только properties.routineId=support-triage', async () => {
    const idMatch = await insertRecord(isolated.prisma, {
      type: 'audit.routine.end',
      properties: { routineId: 'support-triage' },
    });
    await insertRecord(isolated.prisma, {
      type: 'audit.routine.end',
      properties: { routineId: 'other-routine' },
    });

    const result = await journalSearch({ routineId: 'support-triage' }, isolated.prisma);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(idMatch);
    expect(result[0]?.properties.routineId).toBe('support-triage');
  });

  it('фильтр по projectId: только properties.projectId=example-project', async () => {
    const idMatch = await insertRecord(isolated.prisma, {
      type: 'audit.routine.start',
      properties: { projectId: 'example-project' },
    });
    await insertRecord(isolated.prisma, {
      type: 'audit.routine.start',
      properties: { projectId: 'other-project' },
    });

    const result = await journalSearch({ projectId: 'example-project' }, isolated.prisma);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(idMatch);
  });

  it('limit: 10 Records, limit=3 → возвращает 3 самых свежих', async () => {
    const now = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await insertRecord(isolated.prisma, {
        type: 'audit.routine.end',
        createdAt: now - (10 - i) * 1000, // каждый следующий на 1 сек новее
      });
      ids.push(id);
    }
    // Последние 3 — самые свежие (индексы 7, 8, 9).
    const freshestIds = ids.slice(-3).reverse(); // ORDER BY createdAt DESC

    const result = await journalSearch({ limit: 3 }, isolated.prisma);

    expect(result).toHaveLength(3);
    expect(result.map((r) => r.id)).toEqual(freshestIds);
  });

  it('parentId корректно возвращается как строка или null', async () => {
    const parentId = await insertRecord(isolated.prisma, {
      type: 'event.routine.trigger',
    });
    const childId = await insertRecord(isolated.prisma, {
      type: 'audit.routine.start',
      parentId,
    });

    const result = await journalSearch({ type: 'audit.routine.start' }, isolated.prisma);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(childId);
    expect(result[0]?.parentId).toBe(parentId);
  });
});
