// Tool: journal.search — поиск в append-only журнале AI-Cofounder.
//
// Routine вызывает journalSearch() чтобы найти свои предыдущие runs, audit-записи
// и любые Record'ы по типу/проекту/диапазону дат. Чтение идёт через Prisma
// ($queryRawUnsafe) — тот же клиент, что у основного кода.
//
// Постфильтрация по projectId/routineId — в JS после SQL-выборки, потому что
// эти поля живут внутри JSON properties (SQLite JSON-функции есть, но
// $queryRawUnsafe + LIKE на JSON — хрупко; JS-фильтр проще и прозрачнее).

import { getPrisma } from '../../db/client.js';
import type { PrismaClient } from '../../db/client.js';

// ---------------------------------------------------------------------------
// Публичные типы.
// ---------------------------------------------------------------------------

export interface JournalSearchOptions {
  /** Фильтр по Record.type (точное совпадение). */
  type?: string;
  /** Нижняя граница диапазона, timestamp ms. Default: 24 часа назад. */
  since?: number;
  /** Верхняя граница диапазона, timestamp ms. Default: Date.now(). */
  until?: number;
  /** Постфильтр: только Records, у которых properties.projectId === projectId. */
  projectId?: string;
  /** Постфильтр: только Records, у которых properties.routineId === routineId. */
  routineId?: string;
  /** Максимальное число возвращаемых записей. Default: 50. */
  limit?: number;
}

export interface JournalRecord {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  parentId: string | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Ошибки.
// ---------------------------------------------------------------------------

export class JournalSearchError extends Error {
  constructor(message: string) {
    super(`journal.search: ${message}`);
    this.name = 'JournalSearchError';
  }
}

// ---------------------------------------------------------------------------
// Главная функция.
// ---------------------------------------------------------------------------

export async function journalSearch(
  opts: JournalSearchOptions,
  db?: PrismaClient,
): Promise<JournalRecord[]> {
  const prisma = db ?? getPrisma();

  const now = Date.now();
  const since = opts.since ?? now - 24 * 60 * 60 * 1000;
  const until = opts.until ?? now;
  const limit = opts.limit ?? 50;

  // Собираем SQL и параметры динамически.
  // $queryRawUnsafe принимает (sql, ...params) — параметры подставляются через ?.
  let sql = `
    SELECT id, type, properties, parentId, createdAt
    FROM "Record"
    WHERE createdAt >= ? AND createdAt <= ?
  `;
  const params: unknown[] = [since, until];

  if (opts.type !== undefined) {
    sql += ' AND type = ?';
    params.push(opts.type);
  }

  sql += ' ORDER BY createdAt DESC LIMIT ?';
  params.push(limit);

  let rows: unknown[];
  try {
    rows = await prisma.$queryRawUnsafe(sql, ...params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new JournalSearchError(`запрос к БД завершился ошибкой: ${msg}`);
  }

  // Prisma возвращает Record[] — поля соответствуют SELECT-списку.
  // properties хранится как TEXT (JSON); нужно распарсить.
  const records = (rows as Array<Record<string, unknown>>).map((row): JournalRecord => {
    let properties: Record<string, unknown> = {};
    const rawProps = row.properties;
    if (typeof rawProps === 'string' && rawProps.length > 0) {
      try {
        const parsed = JSON.parse(rawProps);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          properties = parsed as Record<string, unknown>;
        }
      } catch {
        // Невалидный JSON в properties — возвращаем пустой объект (безопасно).
      }
    } else if (typeof rawProps === 'object' && rawProps !== null) {
      // Некоторые адаптеры могут вернуть уже распарсенный объект.
      properties = rawProps as Record<string, unknown>;
    }

    const parentId = row.parentId;
    return {
      id: String(row.id ?? ''),
      type: String(row.type ?? ''),
      properties,
      parentId: typeof parentId === 'string' ? parentId : null,
      createdAt: Number(row.createdAt ?? 0),
    };
  });

  // Постфильтрация по projectId / routineId (поля внутри JSON properties).
  let result = records;

  if (opts.projectId !== undefined) {
    const pid = opts.projectId;
    result = result.filter((r) => r.properties.projectId === pid);
  }

  if (opts.routineId !== undefined) {
    const rid = opts.routineId;
    result = result.filter((r) => r.properties.routineId === rid);
  }

  return result;
}
