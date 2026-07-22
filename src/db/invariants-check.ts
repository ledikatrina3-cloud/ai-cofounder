import type { PrismaClient } from '@prisma/client';
import type { VecDatabase } from './client.js';

export const REQUIRED_TRIGGERS = [
  'audit_fully_immutable',
  'record_close_once',
  'record_immutable_fields',
  'record_no_delete',
] as const;

export const REQUIRED_CHECKS_RECORD = [
  'record_created_at_typeof_check',
  'record_closed_at_typeof_check',
  'record_due_at_typeof_check',
  'record_chronology_check',
  'record_event_trigger_idempotency_check',
  'record_due_at_typed_check',
  'record_priority_range_check',
  'record_audit_visibility_check',
] as const;

export const REQUIRED_CHECKS_RECORDLINK = [
  'recordlink_xor_check',
  'recordlink_created_at_typeof_check',
] as const;

// Колонки, которым физически разрешено меняться после INSERT.
// Все остальные колонки Record должны быть в record_immutable_fields.
// Если sсхема Record прирастёт новой колонкой через `prisma migrate dev`, smoke-валидатор
// поднимет тревогу: триггер не покроет новую колонку, append-only будет дырявым.
export const RECORD_MUTABLE_COLUMNS = ['status', 'closedAt', 'closedReason'] as const;

export class InvariantsMissingError extends Error {
  constructor(public readonly missing: string[]) {
    super(
      `Schema invariants missing (${missing.length}): ${missing.join(', ')}. БД нельзя считать append-only — запусти pnpm db:reset.`,
    );
    this.name = 'InvariantsMissingError';
  }
}

type SqliteMasterRow = { name: string; sql: string | null };
type TableInfoRow = { name: string };

export async function assertSchemaInvariants(db: PrismaClient): Promise<void> {
  const triggers = await db.$queryRawUnsafe<SqliteMasterRow[]>(
    `SELECT name, sql FROM sqlite_master WHERE type = 'trigger'`,
  );
  const triggerByName = new Map(triggers.map((row) => [row.name, row.sql ?? '']));
  const missingTriggers = REQUIRED_TRIGGERS.filter((name) => !triggerByName.has(name));

  const tables = await db.$queryRawUnsafe<SqliteMasterRow[]>(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('Record', 'RecordLink')`,
  );
  const tableSql = new Map(tables.map((row) => [row.name, row.sql ?? '']));
  const recordDdl = tableSql.get('Record') ?? '';
  const linkDdl = tableSql.get('RecordLink') ?? '';

  const missingChecks: string[] = [];
  for (const name of REQUIRED_CHECKS_RECORD) {
    if (!recordDdl.includes(name)) missingChecks.push(`Record.${name}`);
  }
  for (const name of REQUIRED_CHECKS_RECORDLINK) {
    if (!linkDdl.includes(name)) missingChecks.push(`RecordLink.${name}`);
  }

  // Триггер record_immutable_fields должен покрывать все колонки Record,
  // которые НЕ перечислены в RECORD_MUTABLE_COLUMNS. Источник правды — реальные
  // колонки в БД (PRAGMA table_info), а не снимок схемы из migration.sql, чтобы
  // ALTER TABLE через prisma migrate dev не оставлял дыр в append-only.
  const uncoveredColumns: string[] = [];
  if (triggerByName.has('record_immutable_fields')) {
    const recordColumns = await db.$queryRawUnsafe<TableInfoRow[]>(
      `SELECT name FROM pragma_table_info('Record')`,
    );
    const triggerSql = triggerByName.get('record_immutable_fields') ?? '';
    const mutableSet = new Set<string>(RECORD_MUTABLE_COLUMNS);
    for (const { name } of recordColumns) {
      if (mutableSet.has(name)) continue;
      // SQLite хранит CREATE TRIGGER ... UPDATE OF "id", "type", ... — ищем имя
      // в кавычках, чтобы случайные совпадения подстрок (например, в RAISE-сообщении)
      // не давали ложноотрицательных срабатываний.
      if (!triggerSql.includes(`"${name}"`)) {
        uncoveredColumns.push(name);
      }
    }
  }

  const missing = [
    ...missingTriggers.map((name) => `trigger:${name}`),
    ...missingChecks.map((name) => `check:${name}`),
    ...uncoveredColumns.map((name) => `immutable-coverage:Record.${name}`),
  ];

  if (missing.length > 0) {
    throw new InvariantsMissingError(missing);
  }
}

// ---------------------------------------------------------------------------
// sqlite-vec invariants (фаза 2.2b).
//
// vec-таблицы лежат вне Prisma-схемы, потому проверка отдельная — у неё свой
// клиент (better-sqlite3 с загруженным sqlite-vec). Проверяем:
//   1. Расширение sqlite-vec доступно (`vec_version()` отвечает).
//   2. Виртуальная таблица существует под именем из config/embeddings.md.
// Если что-то не так — fail-fast при старте процесса; это единственный способ
// поймать «забыл `pnpm db:reset` после `prisma migrate reset`» до первого
// семантического мерджа в проде.
// ---------------------------------------------------------------------------

export class VecInvariantsError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'VecInvariantsError';
  }
}

export interface VecInvariantsExpectation {
  vecTable: string;
}

export function assertVecInvariants(db: VecDatabase, expected: VecInvariantsExpectation): void {
  let version: string;
  try {
    const row = db.prepare('SELECT vec_version() as v').get() as { v: string } | undefined;
    if (row === undefined || typeof row.v !== 'string' || row.v.length === 0) {
      throw new VecInvariantsError(
        'sqlite-vec: vec_version() вернула пустой ответ — расширение не загружено.',
      );
    }
    version = row.v;
  } catch (err) {
    if (err instanceof VecInvariantsError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new VecInvariantsError(
      `sqlite-vec: vec_version() недоступна (${msg}). Расширение не загружено в коннект.`,
    );
  }

  // SQLite virtual table сохраняется в sqlite_master как обычная запись типа 'table'.
  const tableRow = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(expected.vecTable) as { name: string } | undefined;
  if (tableRow === undefined) {
    throw new VecInvariantsError(
      `sqlite-vec: таблица '${expected.vecTable}' не существует. Запусти scripts/init-vec.ts (или pnpm db:reset).`,
    );
  }

  return void version;
}
