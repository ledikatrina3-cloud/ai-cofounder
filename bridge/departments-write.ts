// bridge/departments-write.ts — создание/удаление отделов из UI (Ф4).
//
// Отдел = departments/<id>/{DEPARTMENT.md, pipeline.yml}. DEPARTMENT.md
// frontmatter — настоящий YAML (парсер использует `yaml`-либу), поэтому
// сериализуем через `yaml.stringify`.
//
// Тонкость: parsePipeline требует НЕПУСТОЙ `nodes`, а department-budget guard
// вызывает getDepartment (который парсит pipeline). Поэтому новый отдел пишем с
// одной placeholder-нодой — иначе getDepartment бросит и сломает budget-guard
// для routines этого отдела. Члены отдела в UI берутся из routines с
// departmentId (не из pipeline-нод), так что placeholder на список не влияет.

import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stringify as yamlStringify } from 'yaml';

const KEBAB_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DEPARTMENTS_DIR_NAME = 'departments';

export interface DepartmentBudgetInput {
  perDayUsd: number;
  perRunUsd: number;
}
export interface DepartmentCreateInput {
  id: string;
  name: string;
  description: string;
  budget?: DepartmentBudgetInput;
}

export class DepartmentWriteError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = 'DepartmentWriteError';
    this.status = status;
  }
}

export interface DepartmentWriteDeps {
  cwd?: string;
  departmentsRoot?: string;
  fileExists?: (path: string) => Promise<boolean>;
  writeFileFn?: (path: string, content: string) => Promise<void>;
  mkdirFn?: (path: string) => Promise<void>;
  rmFn?: (path: string) => Promise<void>;
}

export function serializeDepartmentMd(input: DepartmentCreateInput): string {
  const fm: Record<string, unknown> = { name: input.name, description: input.description };
  if (input.budget !== undefined) fm.budget = input.budget;
  const frontmatter = yamlStringify(fm).trimEnd();
  const body = `# Отдел: ${input.name}\n\n${input.description}\n`;
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

export function placeholderPipelineYml(id: string): string {
  return [
    `# Отдел '${id}'. Сотрудники добавляются как routine с departmentId='${id}'.`,
    '# Pipeline-ноды (оркестрация последовательных workflow) — опционально.',
    '# Заглушка ниже нужна для валидации (parsePipeline требует непустой nodes);',
    '# замени реальными нодами, когда выстроишь workflow.',
    'nodes:',
    '  - id: placeholder',
    `    employee: ${id}-placeholder`,
    '    output: content/drafts/${date}.md',
    '',
  ].join('\n');
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function validateBudget(b: DepartmentBudgetInput | undefined): void {
  if (b === undefined) return;
  if (typeof b.perDayUsd !== 'number' || !Number.isFinite(b.perDayUsd) || b.perDayUsd <= 0) {
    throw new DepartmentWriteError('budget.perDayUsd должен быть числом > 0.');
  }
  if (typeof b.perRunUsd !== 'number' || !Number.isFinite(b.perRunUsd) || b.perRunUsd <= 0) {
    throw new DepartmentWriteError('budget.perRunUsd должен быть числом > 0.');
  }
}

export async function createDepartment(
  input: DepartmentCreateInput,
  deps: DepartmentWriteDeps = {},
): Promise<{ ok: true; id: string; dir: string }> {
  const cwd = deps.cwd ?? process.cwd();
  const root = deps.departmentsRoot ?? resolve(cwd, DEPARTMENTS_DIR_NAME);
  const fileExists = deps.fileExists ?? defaultFileExists;
  const writeFileFn = deps.writeFileFn ?? ((p, c) => writeFile(p, c, 'utf8'));
  const mkdirFn = deps.mkdirFn ?? (async (p) => void (await mkdir(p, { recursive: true })));

  if (!KEBAB_RE.test(input.id)) {
    throw new DepartmentWriteError(`id '${input.id}' должен быть kebab-case.`);
  }
  if (input.name.trim() === '') throw new DepartmentWriteError('name обязателен.');
  if (input.description.trim() === '') throw new DepartmentWriteError('description обязателен.');
  validateBudget(input.budget);

  const dir = resolve(root, input.id);
  if (dir !== `${root}/${input.id}` && !dir.startsWith(`${root}/`)) {
    throw new DepartmentWriteError(`небезопасный id '${input.id}'.`);
  }
  if (await fileExists(dir)) {
    throw new DepartmentWriteError(`отдел '${input.id}' уже существует.`, 409);
  }

  await mkdirFn(dir);
  try {
    await writeFileFn(resolve(dir, 'DEPARTMENT.md'), serializeDepartmentMd(input));
    await writeFileFn(resolve(dir, 'pipeline.yml'), placeholderPipelineYml(input.id));
  } catch (err) {
    // Откат частичной папки (ревью finding #6): полупустой отдел без pipeline.yml
    // ломал бы getDepartment/listDepartments (parseDepartment бросает).
    const rmFn = deps.rmFn ?? ((p) => rm(p, { recursive: true, force: true }));
    await rmFn(dir).catch(() => {});
    throw err;
  }
  return { ok: true, id: input.id, dir };
}

export async function deleteDepartment(
  id: string,
  deps: DepartmentWriteDeps = {},
): Promise<{ ok: true; id: string }> {
  const cwd = deps.cwd ?? process.cwd();
  const root = deps.departmentsRoot ?? resolve(cwd, DEPARTMENTS_DIR_NAME);
  const fileExists = deps.fileExists ?? defaultFileExists;
  const rmFn = deps.rmFn ?? ((p) => rm(p, { recursive: true, force: true }));

  if (!KEBAB_RE.test(id)) throw new DepartmentWriteError(`id '${id}' невалиден.`);
  const dir = resolve(root, id);
  if (!dir.startsWith(`${root}/`)) throw new DepartmentWriteError(`небезопасный id '${id}'.`);
  if (!(await fileExists(dir))) throw new DepartmentWriteError(`отдел '${id}' не найден.`, 404);
  await rmFn(dir);
  return { ok: true, id };
}
