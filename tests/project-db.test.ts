// Тесты для src/tools/project-db/index.ts
//
// Используем только SQLite in-memory (через better-sqlite3 напрямую для фикстур).
// Реальный Postgres/MySQL не поднимаем — phased rollout после M4'.2.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbConnConfig } from '../src/projects/map.js';
import {
  DbQueryPermissionError,
  runSqliteQuery,
  validateSql,
} from '../src/tools/project-db/index.js';

// ---------------------------------------------------------------------------
// Фикстуры
// ---------------------------------------------------------------------------

let tmpDir: string;
let dbPath: string;

function makeSqliteConnection(dbPath: string, tables: string[]): DbConnConfig {
  return {
    id: 'test-sqlite',
    driver: 'sqlite',
    keychainService: 'test-keychain-service', // НЕ используется при DI
    description: 'test sqlite connection',
    allowedTables: tables,
    queryTimeoutMs: 5000,
    rowLimit: 100,
  };
}

// Создаём реальную SQLite БД с таблицей users (10 строк) и таблицей orders.
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'project-db-test-'));
  dbPath = join(tmpDir, 'test.db');

  // Открываем read-write для создания фикстурных данных.
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL
    );
  `);

  const insertUser = db.prepare('INSERT INTO users (id, name, email) VALUES (?, ?, ?)');
  for (let i = 1; i <= 10; i++) {
    insertUser.run(i, `User ${i}`, `user${i}@example.com`);
  }

  const insertOrder = db.prepare('INSERT INTO orders (id, user_id, amount) VALUES (?, ?, ?)');
  for (let i = 1; i <= 5; i++) {
    insertOrder.run(i, i, i * 100.0);
  }

  db.close();
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------

describe('runSqliteQuery', () => {
  it('1. SELECT * FROM users LIMIT 5 → возвращает строки', () => {
    const result = runSqliteQuery(dbPath, 'SELECT * FROM users LIMIT 5', [], 100);
    expect(result.rows).toHaveLength(5);
    expect(result.rowCount).toBe(5);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // Проверяем структуру первой строки
    const first = result.rows[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('email');
  });

  it('7. rowLimit=3 + SELECT * FROM users → возвращает 3 строки (из 10)', () => {
    // rowLimit добавляется как LIMIT если его нет в SQL
    const result = runSqliteQuery(dbPath, 'SELECT * FROM users', [], 3);
    expect(result.rows).toHaveLength(3);
    expect(result.rowCount).toBe(3);
  });

  it('rowLimit не перебивает явный LIMIT в SQL', () => {
    // Если LIMIT уже есть, rowLimit не добавляется
    const result = runSqliteQuery(dbPath, 'SELECT * FROM users LIMIT 2', [], 100);
    expect(result.rows).toHaveLength(2);
  });
});

describe('validateSql', () => {
  it('2. INSERT → DbQueryPermissionError', () => {
    expect(() => validateSql('INSERT INTO users (name) VALUES (?)', [])).toThrow(
      DbQueryPermissionError,
    );
  });

  it('3. DROP TABLE → DbQueryPermissionError', () => {
    expect(() => validateSql('DROP TABLE users', [])).toThrow(DbQueryPermissionError);
  });

  it('4. SELECT из не-whitelisted таблицы → DbQueryPermissionError', () => {
    expect(() => validateSql('SELECT * FROM users', ['orders'])).toThrow(DbQueryPermissionError);
  });

  it('5. SELECT с allowedTables=[] → разрешено (пустой whitelist)', () => {
    expect(() => validateSql('SELECT * FROM users', [])).not.toThrow();
  });

  it('6. SELECT * FROM users JOIN orders ON ... с allowedTables=[users] → PermissionError', () => {
    expect(() =>
      validateSql('SELECT * FROM users JOIN orders ON users.id = orders.user_id', ['users']),
    ).toThrow(DbQueryPermissionError);
  });

  it('8. select * from USERS (case-insensitive) с allowedTables=[users] → OK', () => {
    // SQL в нижнем регистре, whitelist в нижнем — должно работать
    expect(() => validateSql('select * from USERS', ['users'])).not.toThrow();
  });

  it('UPDATE → DbQueryPermissionError', () => {
    expect(() => validateSql('UPDATE users SET name = ?', [])).toThrow(DbQueryPermissionError);
  });

  it('DELETE → DbQueryPermissionError', () => {
    expect(() => validateSql('DELETE FROM users WHERE id = 1', [])).toThrow(DbQueryPermissionError);
  });

  it('TRUNCATE → DbQueryPermissionError', () => {
    expect(() => validateSql('TRUNCATE TABLE users', [])).toThrow(DbQueryPermissionError);
  });

  it('SELECT с несколькими разрешёнными таблицами → OK', () => {
    expect(() =>
      validateSql('SELECT * FROM users JOIN orders ON users.id = orders.user_id', [
        'users',
        'orders',
      ]),
    ).not.toThrow();
  });

  it('Пустой SQL → DbQueryPermissionError', () => {
    expect(() => validateSql('', [])).toThrow(DbQueryPermissionError);
  });

  it('SQL с пробелами в начале → всё равно SELECT', () => {
    expect(() => validateSql('   SELECT id FROM users', [])).not.toThrow();
  });
});
