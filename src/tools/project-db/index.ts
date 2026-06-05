// Tool: project.db.query — read-only SQL доступ к БД проекта.
//
// Контракт фазы 2.3:
//   * Только SELECT. INSERT/UPDATE/DELETE/DROP и т.п. → DbQueryPermissionError.
//   * Whitelist таблиц из карты проекта (allowedTables[]). Пустой [] = доверяем.
//   * Query timeout на уровне БД (SET statement_timeout / max_execution_time).
//   * Row limit — LIMIT добавляется в SQL если его ещё нет.
//   * DSN читается из macOS Keychain через keytar (keychainService из карты).
//   * Phased rollout: сначала SQLite (тесты), Postgres/MySQL — после M4'.2.

import Database from 'better-sqlite3';
import { getPassword } from 'keytar';
import type { Client as PgClient } from 'pg';
import type { DbConnConfig } from '../../projects/map.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class DbQueryError extends Error {
  constructor(
    public readonly toolName: string,
    message: string,
  ) {
    super(`project.db.query: ${message}`);
    this.name = 'DbQueryError';
  }
}

export class DbQueryPermissionError extends DbQueryError {
  constructor(reason: string) {
    super('project.db.query', reason);
    this.name = 'DbQueryPermissionError';
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DbQueryOptions {
  connection: DbConnConfig; // из ProjectMap
  sql: string;
  params?: unknown[]; // параметры для prepared statement
  /** DI для тестов: пропускает Keychain, возвращает DSN напрямую */
  getDsnOverride?: (conn: DbConnConfig) => Promise<string>;
}

export interface DbQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// SQL validation
// ---------------------------------------------------------------------------

/**
 * Удаляет SQL-комментарии перед валидацией.
 * Без этого `FROM/*comment*\/secret_table` обходит regex-whitelist.
 */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments: /* ... */
    .replace(/--[^\n]*/g, ' '); // line comments: -- ...
}

// Множество запрещённых «первых слов» SQL-запроса.
const FORBIDDEN_VERBS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'CREATE',
  'ALTER',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'EXEC',
  'EXECUTE',
  'REPLACE',
  'MERGE',
  'CALL',
  'DO',
  'SET',
  'LOCK',
  'UNLOCK',
]);

/** Парсит SQL, бросает DbQueryPermissionError при нарушении политики. */
export function validateSql(sql: string, allowedTables: string[]): void {
  const trimmed = sql.trim();
  // Снимаем комментарии перед проверкой: FROM/*comment*/table обходил regex.
  const stripped = stripSqlComments(trimmed).trim();

  // 1. Проверяем первое слово.
  const firstWordMatch = /^(\w+)/i.exec(stripped);
  const firstWord = firstWordMatch ? (firstWordMatch[1] ?? '').toUpperCase() : '';

  if (firstWord !== 'SELECT') {
    if (FORBIDDEN_VERBS.has(firstWord)) {
      throw new DbQueryPermissionError(
        `SQL-запрос запрещён: команда '${firstWord}' не разрешена. Разрешён только SELECT.`,
      );
    }
    throw new DbQueryPermissionError(
      `SQL-запрос должен начинаться с SELECT. Получено: '${firstWord || '(пусто)'}'. Разрешён только SELECT.`,
    );
  }

  // 2. Проверяем whitelist таблиц (только если allowedTables не пуст).
  if (allowedTables.length === 0) return;

  const allowedLower = new Set(allowedTables.map((t) => t.toLowerCase()));

  // Ищем все таблицы после FROM/JOIN/INTO/UPDATE/TABLE.
  // Расширенный паттерн: ловит comma-separated таблицы: FROM users, secret_table.
  const tableRe =
    /(FROM|JOIN|INTO|UPDATE|TABLE)\s+((?:["'`]?\w+["'`]?\s*(?:,\s*["'`]?\w+["'`]?)*)?)/gi;
  const matches = [...stripped.matchAll(tableRe)];
  for (const match of matches) {
    // Разбиваем по запятой чтобы проверить каждую таблицу: FROM users, secret_table.
    const tableList = (match[2] ?? '').split(',');
    for (const entry of tableList) {
      // Берём первое слово (убираем кавычки/псевдонимы: "users" AS u → users).
      const tableName = entry.replace(/["'`]/g, '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      if (tableName && !allowedLower.has(tableName)) {
        throw new DbQueryPermissionError(
          `Таблица '${tableName}' не разрешена. Разрешены: [${allowedTables.join(', ')}].`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Keychain helper
// ---------------------------------------------------------------------------

export interface KeychainGetter {
  getPassword: (service: string, account: string) => Promise<string | null>;
}

async function getDsn(
  connection: DbConnConfig,
  keychain: KeychainGetter = { getPassword },
): Promise<string> {
  const dsn = await keychain.getPassword(connection.keychainService, 'dsn');
  if (dsn === null || dsn === '') {
    throw new DbQueryError(
      'project.db.query',
      `credentials для '${connection.id}' не найдены в Keychain (service='${connection.keychainService}')`,
    );
  }
  return dsn;
}

// ---------------------------------------------------------------------------
// LIMIT helper
// ---------------------------------------------------------------------------

/**
 * Принудительно ограничивает LIMIT.
 * enforceLimitMax пропускала LIMIT 1000000 без изменений — агент мог получить миллион строк.
 * Теперь: если LIMIT уже есть — капируем его до rowLimit; если нет — добавляем.
 */
function enforceLimitMax(sql: string, rowLimit: number): string {
  if (!/\bLIMIT\b/i.test(sql)) {
    return `${sql.trimEnd()} LIMIT ${rowLimit}`;
  }
  // Заменяем все числовые LIMIT (включая в subquery) на min(existing, rowLimit).
  return sql
    .replace(/\bLIMIT\s+ALL\b/gi, `LIMIT ${rowLimit}`) // PostgreSQL LIMIT ALL = без ограничения
    .replace(/(\bLIMIT\s+)(\d+)/gi, (_, prefix, numStr) => {
      const num = Number.parseInt(numStr, 10);
      return `${prefix}${Math.min(num, rowLimit)}`;
    });
}

// ---------------------------------------------------------------------------
// Driver adapters
// ---------------------------------------------------------------------------

/** PostgreSQL через pg.Client */
export async function runPostgresQuery(
  connectionString: string,
  sql: string,
  params: unknown[],
  timeoutMs: number,
  rowLimit: number,
): Promise<DbQueryResult> {
  // Динамический импорт чтобы не падать при отсутствии среды Postgres в тестах.
  const { Client } = (await import('pg')) as { Client: typeof PgClient };
  const client = new Client({ connectionString });
  await client.connect();
  const t0 = Date.now();
  try {
    // Таймаут на уровне сессии.
    await client.query(`SET statement_timeout = ${timeoutMs}`);
    const finalSql = enforceLimitMax(sql, rowLimit);
    const result = await client.query(finalSql, params as unknown[]);
    const durationMs = Date.now() - t0;
    return {
      rows: result.rows as Record<string, unknown>[],
      rowCount: result.rowCount ?? result.rows.length,
      durationMs,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** MySQL через mysql2/promise */
export async function runMysqlQuery(
  connectionString: string,
  sql: string,
  params: unknown[],
  timeoutMs: number,
  rowLimit: number,
): Promise<DbQueryResult> {
  const mysql = await import('mysql2/promise');
  const conn = await mysql.createConnection(connectionString);
  const t0 = Date.now();
  try {
    await conn.execute(`SET SESSION max_execution_time=${timeoutMs}`);
    const finalSql = enforceLimitMax(sql, rowLimit);
    const [rows] = await conn.execute(finalSql, params as never[]);
    const durationMs = Date.now() - t0;
    const rowArray = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    return { rows: rowArray, rowCount: rowArray.length, durationMs };
  } finally {
    await conn.end().catch(() => undefined);
  }
}

/** SQLite через better-sqlite3 (синхронный). Принимает путь к файлу БД. */
export function runSqliteQuery(
  dbPath: string,
  sql: string,
  params: unknown[],
  rowLimit: number,
): DbQueryResult {
  const db = new Database(dbPath, { readonly: true, fileMustExist: false });
  const t0 = Date.now();
  try {
    const finalSql = enforceLimitMax(sql, rowLimit);
    const stmt = db.prepare(finalSql);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    const durationMs = Date.now() - t0;
    return { rows, rowCount: rows.length, durationMs };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function projectDbQuery(opts: DbQueryOptions): Promise<DbQueryResult> {
  const { connection, sql, params = [] } = opts;

  // 1. Валидация SQL перед любым сетевым вызовом.
  validateSql(sql, connection.allowedTables);

  // 2. Получаем DSN (через override для тестов или реальный Keychain).
  const getDsnFn = opts.getDsnOverride ?? getDsn;
  const dsn = await getDsnFn(connection);

  const { driver, queryTimeoutMs, rowLimit } = connection;

  // 3. Запускаем запрос через нужный driver.
  switch (driver) {
    case 'postgres':
      return runPostgresQuery(dsn, sql, params, queryTimeoutMs, rowLimit);
    case 'mysql':
      return runMysqlQuery(dsn, sql, params, queryTimeoutMs, rowLimit);
    case 'sqlite':
      return runSqliteQuery(dsn, sql, params, rowLimit);
    default: {
      // Исчерпывающая проверка — TypeScript не должен сюда попасть.
      const exhaustive: never = driver;
      throw new DbQueryError('project.db.query', `Неизвестный driver: ${String(exhaustive)}`);
    }
  }
}
