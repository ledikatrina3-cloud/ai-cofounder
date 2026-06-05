// dept-instantiate — копирует pre-packaged шаблон отдела из
// templates/departments/<id>/ в departments/<id>/ + employees/*.md в
// routines/<dept-id>-<employee-name>.md.
//
// Использование: `pnpm dept:instantiate <template-id>`
//
// Идемпотентно с safety-check: если directory `departments/<id>/` уже
// существует — отказываемся (фаундер должен сам решить delete + retry).
//
// Что копируется:
//   * DEPARTMENT.md (как есть)
//   * pipeline.yml (как есть)
//   * shared/* (recursive)
//   * employees/*.md → routines/<dept-id>-<basename>.md
//     - frontmatter id уже корректный (например, marketing-content-researcher)
//     - копируется без модификации (templates содержат правильные id)

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

interface InstantiateOptions {
  templateId: string;
  cwd?: string;
}

export class DeptInstantiateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeptInstantiateError';
  }
}

/**
 * Главная функция (используется тестами через DI cwd).
 *
 * Возвращает список созданных файлов.
 */
export async function instantiateDepartment(opts: InstantiateOptions): Promise<string[]> {
  const cwd = opts.cwd ?? REPO_ROOT;
  const templateDir = join(cwd, 'templates', 'departments', opts.templateId);
  const targetDir = join(cwd, 'departments', opts.templateId);
  const routinesDir = join(cwd, 'routines');

  if (!existsSync(templateDir)) {
    throw new DeptInstantiateError(
      `template '${opts.templateId}' не найден в templates/departments/. Проверь: ${templateDir}`,
    );
  }
  if (existsSync(targetDir)) {
    throw new DeptInstantiateError(
      `department '${opts.templateId}' уже существует в departments/${opts.templateId}/. Удали папку руками если хочешь пересоздать.`,
    );
  }

  await mkdir(targetDir, { recursive: true });
  await mkdir(routinesDir, { recursive: true });

  const created: string[] = [];

  // 1. DEPARTMENT.md
  const deptMdSrc = join(templateDir, 'DEPARTMENT.md');
  const deptMdDst = join(targetDir, 'DEPARTMENT.md');
  if (!existsSync(deptMdSrc)) {
    throw new DeptInstantiateError(`в шаблоне нет DEPARTMENT.md: ${deptMdSrc}`);
  }
  await copyFile(deptMdSrc, deptMdDst);
  created.push(deptMdDst);

  // 2. pipeline.yml
  const pipelineSrc = join(templateDir, 'pipeline.yml');
  const pipelineDst = join(targetDir, 'pipeline.yml');
  if (!existsSync(pipelineSrc)) {
    throw new DeptInstantiateError(`в шаблоне нет pipeline.yml: ${pipelineSrc}`);
  }
  await copyFile(pipelineSrc, pipelineDst);
  created.push(pipelineDst);

  // 3. shared/ (recursive)
  const sharedSrc = join(templateDir, 'shared');
  if (existsSync(sharedSrc)) {
    const sharedDst = join(targetDir, 'shared');
    await copyDirRecursive(sharedSrc, sharedDst, created);
  }

  // 4. employees/*.md → routines/<basename>
  const employeesDir = join(templateDir, 'employees');
  if (existsSync(employeesDir)) {
    const files = await readdir(employeesDir);
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const src = join(employeesDir, f);
      // Имя файла-результата: уже в шаблоне employees/researcher.md имеет
      // frontmatter id='<dept-id>-researcher', что соответствует имени файла
      // routines/<dept-id>-<basename>.md.
      const dst = join(routinesDir, `${opts.templateId}-${f}`);
      if (existsSync(dst)) {
        throw new DeptInstantiateError(
          `routine файл уже существует: ${dst}. Удали руками и повтори.`,
        );
      }
      await copyFile(src, dst);
      created.push(dst);
    }
  }

  return created;
}

async function copyDirRecursive(src: string, dst: string, created: string[]): Promise<void> {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src);
  for (const entry of entries) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    const s = await stat(srcPath);
    if (s.isDirectory()) {
      await copyDirRecursive(srcPath, dstPath, created);
    } else if (s.isFile()) {
      await copyFile(srcPath, dstPath);
      created.push(dstPath);
    }
  }
}

async function main(): Promise<void> {
  const templateId = process.argv[2];
  if (templateId === undefined || templateId === '') {
    console.error('Usage: pnpm dept:instantiate <template-id>');
    console.error('  e.g. pnpm dept:instantiate marketing-content');
    process.exit(1);
  }
  try {
    const created = await instantiateDepartment({ templateId });
    console.log(`✓ Department '${templateId}' создан.`);
    console.log(`  Создано файлов: ${created.length}`);
    for (const f of created) {
      console.log(`  - ${f.replace(`${REPO_ROOT}/`, '')}`);
    }
    console.log('');
    console.log('Дальше:');
    console.log(`  1. Открой departments/${templateId}/DEPARTMENT.md — проверь budget.`);
    console.log(`  2. Открой departments/${templateId}/shared/topics-backlog.md — добавь темы.`);
    console.log(
      `  3. В routines/${templateId}-*.md замени enabled: false на true (после готовности скиллов).`,
    );
    console.log(`  4. Запусти pipeline вручную: pnpm dev:run --department ${templateId}`);
  } catch (err) {
    if (err instanceof DeptInstantiateError) {
      console.error(`✗ ${err.message}`);
      process.exit(2);
    }
    console.error(err);
    process.exit(1);
  }
}

// Когда запускается напрямую через tsx — выполняем main.
// Когда импортируется тестом — main не выполняется (мы вообще не зовём его в этом случае).
const isMainEntry = fileURLToPath(import.meta.url) === process.argv[1];
if (isMainEntry) {
  main();
}
