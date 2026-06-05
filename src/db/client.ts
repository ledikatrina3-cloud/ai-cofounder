// Prisma — единственный writer основной схемы (Record/RecordLink/Embedding/Page).
// Better-sqlite3 — отдельный коннект к тому же файлу, ТОЛЬКО ради sqlite-vec
// virtual table `vec_intent_problem` (фаза 2.2b).
//
// Почему два клиента, а не один:
//   * Prisma sqlite-driver не позволяет `SELECT load_extension(...)` (требует
//     `sqlite3_enable_load_extension(db, 1)` в C-API, что Prisma не делает).
//   * Форк Prisma или переход на `@prisma/adapter-libsql` — жетон без причины.
//   * Концепционно vec-таблицы ортогональны Record-схеме: у них нет инвариантов
//     append-only, на них не висят триггеры, они не упоминаются в schema.prisma.
//   * Concurrent reads/writes к одному SQLite-файлу безопасны под WAL (Prisma
//     ставит journal_mode=WAL по умолчанию). Конфликтов между Prisma и vec
//     не будет — они трогают непересекающиеся таблицы.

import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

let cachedPrisma: PrismaClient | null = null;
let cachedVec: Database.Database | null = null;

export function getPrisma(): PrismaClient {
  if (cachedPrisma === null) {
    cachedPrisma = new PrismaClient();
  }
  return cachedPrisma;
}

export async function disposePrisma(): Promise<void> {
  if (cachedPrisma !== null) {
    await cachedPrisma.$disconnect();
    cachedPrisma = null;
  }
}

// ---------------------------------------------------------------------------
// Better-sqlite3 + sqlite-vec.
// ---------------------------------------------------------------------------

// Парсит DATABASE_URL формата `file:./dev.db` или `file:/abs/path`.
// Относительный путь резолвится от prisma/ директории — это поведение Prisma
// при чтении DATABASE_URL из .env (который лежит в корне проекта).
export function resolveSqliteFilePath(
  url: string = process.env.DATABASE_URL ?? '',
  rootDir: string = process.cwd(),
): string {
  if (!url.startsWith('file:')) {
    throw new Error(
      `DATABASE_URL должен начинаться с file: (получено '${url}'). Только sqlite-driver поддерживается.`,
    );
  }
  const raw = url.slice('file:'.length);
  if (raw.startsWith('/')) return raw;
  // Относительные пути резолвятся от директории prisma/ (там лежит schema.prisma).
  return resolve(rootDir, 'prisma', raw);
}

export interface VecClientOptions {
  // Полезно для тестов: подменить путь к БД (in-memory или временный файл).
  filePath?: string;
  // Не загружать sqlite-vec — для тестов, которые проверяют поведение «extension
  // не загружен». В проде всегда true.
  loadExtension?: boolean;
}

export function getVecClient(options: VecClientOptions = {}): Database.Database {
  if (cachedVec === null || options.filePath !== undefined) {
    const filePath = options.filePath ?? resolveSqliteFilePath();
    const db = new Database(filePath);
    // Прибиваем те же pragma'ы, что у Prisma — иначе на одном файле два клиента
    // могут конфликтовать по journal_mode. Prisma ставит WAL по умолчанию;
    // повторная установка идемпотентна.
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    if (options.loadExtension !== false) {
      sqliteVec.load(db);
    }
    if (options.filePath !== undefined) {
      // Тестовый клиент не кэшируется (иначе second test получит чужой path).
      return db;
    }
    cachedVec = db;
  }
  return cachedVec;
}

export function disposeVecClient(): void {
  if (cachedVec !== null) {
    cachedVec.close();
    cachedVec = null;
  }
}

export type { PrismaClient };
export type VecDatabase = Database.Database;
