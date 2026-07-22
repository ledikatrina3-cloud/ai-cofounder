// Department registry — единственная точка резолва `departments/<id>/`.
//
// Контракт:
//   * `listDepartments(opts?)` — сканирует `departments/*/DEPARTMENT.md` через
//     fast-glob, парсит каждый файл. Дубликаты id (basename папки) →
//     DepartmentRegistryError.
//   * `getDepartment(id, opts?)` — один department по id или null.
//
// DI как в skills/routines: cwd / glob / read — опциональные перегрузки для
// тестов.

import { dirname, resolve } from 'node:path';
import fg from 'fast-glob';
import { parseDepartment } from './parser.js';
import type { Department } from './types.js';

export class DepartmentRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DepartmentRegistryError';
  }
}

export interface DepartmentRegistryOptions {
  cwd?: string;
  glob?: (pattern: string, cwd: string) => Promise<string[]>;
  read?: (path: string) => Promise<string>;
  /** Glob-паттерн, относительный к cwd. По умолчанию `departments/*‎/DEPARTMENT.md`. */
  departmentsGlob?: string;
}

const DEFAULT_GLOB = 'departments/*/DEPARTMENT.md';

async function defaultGlob(pattern: string, cwd: string): Promise<string[]> {
  return fg(pattern, { cwd, absolute: true, onlyFiles: true });
}

async function loadAll(options: DepartmentRegistryOptions): Promise<Department[]> {
  const cwd = options.cwd ?? process.cwd();
  const glob = options.glob ?? defaultGlob;
  const pattern = options.departmentsGlob ?? DEFAULT_GLOB;

  const files = await glob(pattern, cwd);

  const parseOptions: Parameters<typeof parseDepartment>[1] = {};
  if (options.read !== undefined) parseOptions.read = options.read;

  const departments: Department[] = [];
  for (const file of files) {
    const abs = resolve(file);
    const deptDir = dirname(abs);
    const dept = await parseDepartment(deptDir, parseOptions);
    departments.push(dept);
  }

  // Уникальность по id (basename папки).
  const seen = new Map<string, string>();
  for (const d of departments) {
    const prev = seen.get(d.id);
    if (prev !== undefined) {
      throw new DepartmentRegistryError(
        `дубль department id='${d.id}': '${prev}' и '${d.filePath}'. id должен быть уникален (= basename папки).`,
      );
    }
    seen.set(d.id, d.filePath);
  }

  return departments;
}

export async function listDepartments(
  options: DepartmentRegistryOptions = {},
): Promise<Department[]> {
  return loadAll(options);
}

export async function getDepartment(
  id: string,
  options: DepartmentRegistryOptions = {},
): Promise<Department | null> {
  const all = await loadAll(options);
  return all.find((d) => d.id === id) ?? null;
}
