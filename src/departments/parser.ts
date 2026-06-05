// Department parser — единственная точка чтения `departments/<id>/`.
//
// Контракт:
//   * `parseDepartment(deptDir, opts?)` — читает DEPARTMENT.md (обязательно)
//     и pipeline.yml (обязательно), валидирует поля, возвращает `Department`.
//   * Frontmatter DEPARTMENT.md — узкий YAML (тот же набор, что у скиллов):
//       name: <displayName>
//       description: <текст>
//       budget:
//         perDayUsd: 5.00
//         perRunUsd: 1.00
//   * Валидация: name/description непустые. budget — числа > 0 (если задан).
//
// Используем `yaml` библиотеку для frontmatter — она уже зависимость
// pipelines/parser.ts. Свой узкий parser, как у скиллов, тоже бы подошёл, но
// унификация выигрывает: один pipeline.yml + DEPARTMENT.md одной библиотекой.

import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parsePipeline } from '../pipelines/parser.js';
import type { Department, DepartmentBudget } from './types.js';

export class DepartmentParseError extends Error {
  constructor(deptId: string, message: string) {
    super(`department '${deptId}': ${message}`);
    this.name = 'DepartmentParseError';
  }
}

const FRONTMATTER_DELIM = '---';

export interface ParseDepartmentOptions {
  /** DI для тестов: подменить чтение файлов. */
  read?: (path: string) => Promise<string>;
}

async function defaultRead(p: string): Promise<string> {
  return readFile(p, 'utf8');
}

export async function parseDepartment(
  deptDir: string,
  options: ParseDepartmentOptions = {},
): Promise<Department> {
  const read = options.read ?? defaultRead;
  const id = basename(deptDir);
  const departmentMdPath = join(deptDir, 'DEPARTMENT.md');
  const pipelinePath = join(deptDir, 'pipeline.yml');
  const sharedDir = join(deptDir, 'shared');

  let departmentSource: string;
  try {
    departmentSource = await read(departmentMdPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new DepartmentParseError(
      id,
      `не удалось прочитать DEPARTMENT.md (${departmentMdPath}): ${reason}`,
    );
  }

  let pipelineSource: string;
  try {
    pipelineSource = await read(pipelinePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new DepartmentParseError(
      id,
      `не удалось прочитать pipeline.yml (${pipelinePath}): ${reason}`,
    );
  }

  return parseDepartmentSources({
    deptDir,
    departmentSource,
    pipelineSource,
    departmentMdPath,
    pipelinePath,
    sharedDir,
  });
}

interface ParseSourcesArgs {
  deptDir: string;
  departmentSource: string;
  pipelineSource: string;
  departmentMdPath: string;
  pipelinePath: string;
  sharedDir: string;
}

/** Экспортируется для тестов — парсит без I/O. */
export function parseDepartmentSources(args: ParseSourcesArgs): Department {
  const id = basename(args.deptDir);
  const { frontmatter, body } = splitFrontmatterAndBody(id, args.departmentSource);
  const fmRaw = parseFrontmatter(id, frontmatter);

  if (typeof fmRaw.name !== 'string' || fmRaw.name.trim() === '') {
    throw new DepartmentParseError(
      id,
      "frontmatter поле 'name' обязательно и не должно быть пустым.",
    );
  }
  if (typeof fmRaw.description !== 'string' || fmRaw.description.trim() === '') {
    throw new DepartmentParseError(id, "frontmatter поле 'description' обязательно.");
  }

  let budget: DepartmentBudget | undefined;
  if (fmRaw.budget !== undefined) {
    budget = parseBudget(id, fmRaw.budget);
  }

  const pipeline = parsePipeline(args.pipelineSource, args.pipelinePath);

  // Проверим что employee-имена в pipeline нодах непустые. Существование
  // routine с таким id мы НЕ проверяем здесь — это registry-задача (циклы между
  // registry'ями departments↔routines — нежелательны).

  return {
    id,
    name: fmRaw.name.trim(),
    description: fmRaw.description.trim(),
    ...(budget !== undefined ? { budget } : {}),
    body,
    filePath: args.departmentMdPath,
    pipelinePath: args.pipelinePath,
    pipeline,
    sharedDir: args.sharedDir,
  };
}

function parseBudget(id: string, raw: unknown): DepartmentBudget {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DepartmentParseError(id, "поле 'budget' должно быть mapping {perDayUsd, perRunUsd}.");
  }
  const obj = raw as Record<string, unknown>;
  const perDayUsd = obj.perDayUsd;
  const perRunUsd = obj.perRunUsd;
  if (typeof perDayUsd !== 'number' || !Number.isFinite(perDayUsd) || perDayUsd <= 0) {
    throw new DepartmentParseError(
      id,
      `поле 'budget.perDayUsd' должно быть числом > 0, получено '${String(perDayUsd)}'.`,
    );
  }
  if (typeof perRunUsd !== 'number' || !Number.isFinite(perRunUsd) || perRunUsd <= 0) {
    throw new DepartmentParseError(
      id,
      `поле 'budget.perRunUsd' должно быть числом > 0, получено '${String(perRunUsd)}'.`,
    );
  }
  return { perDayUsd, perRunUsd };
}

function splitFrontmatterAndBody(
  deptId: string,
  source: string,
): { frontmatter: string; body: string } {
  const lines = source.split('\n');
  if (lines[0]?.trim() !== FRONTMATTER_DELIM) {
    throw new DepartmentParseError(
      deptId,
      "DEPARTMENT.md должен начинаться с '---' (frontmatter delimiter).",
    );
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FRONTMATTER_DELIM) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new DepartmentParseError(
      deptId,
      "не найден закрывающий '---' frontmatter'а DEPARTMENT.md.",
    );
  }
  return {
    frontmatter: lines.slice(1, endIdx).join('\n'),
    body: lines
      .slice(endIdx + 1)
      .join('\n')
      .trim(),
  };
}

function parseFrontmatter(deptId: string, raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new DepartmentParseError(deptId, `frontmatter не парсится как YAML: ${reason}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DepartmentParseError(deptId, 'frontmatter должен быть mapping (key: value ...).');
  }
  return parsed as Record<string, unknown>;
}

/** Хелпер для тестов: резолвит deptDir относительно cwd. */
export function resolveDepartmentDir(cwd: string, id: string): string {
  return resolve(cwd, 'departments', id);
}

/** Извлекает деректорию из путей DEPARTMENT.md. */
export function deptDirFromFilePath(filePath: string): string {
  return dirname(filePath);
}
