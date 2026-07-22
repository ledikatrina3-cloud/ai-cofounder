// dept-update — обновляет уже инстанцированный department из шаблона:
// перезаписывает DEPARTMENT.md, pipeline.yml и весь shared/, **НЕ трогая**
// существующие routines (employees) и НЕ создавая новые.
//
// Используется когда фаундер уже сделал `pnpm dept:instantiate marketing-content`,
// шаблон обновили, и нужно подтянуть свежий pipeline / KPI / backlog без
// потери ручных правок в routines/marketing-content-*.md.
//
// Использование: `pnpm dept:update <template-id>`
//
// Идемпотентно. Если department не существует — отказ с понятным сообщением.
//
// НЕ обновляет: routines/<dept-id>-*.md (employees). Если template employees
// поменялся — фаундер вручную решит как мержить, чтобы не потерять кастом.

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export interface UpdateOptions {
  templateId: string;
  cwd?: string;
}

export class DeptUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeptUpdateError';
  }
}

/**
 * Обновляет инстанцированный department из шаблона. Возвращает список
 * перезаписанных файлов.
 */
export async function updateDepartment(opts: UpdateOptions): Promise<string[]> {
  const cwd = opts.cwd ?? REPO_ROOT;
  const templateDir = join(cwd, 'templates', 'departments', opts.templateId);
  const targetDir = join(cwd, 'departments', opts.templateId);

  if (!existsSync(templateDir)) {
    throw new DeptUpdateError(
      `template '${opts.templateId}' не найден в templates/departments/. Проверь: ${templateDir}`,
    );
  }
  if (!existsSync(targetDir)) {
    throw new DeptUpdateError(
      `department '${opts.templateId}' не инстанцирован. Сначала выполни pnpm dept:instantiate ${opts.templateId}.`,
    );
  }

  const updated: string[] = [];

  // 1. DEPARTMENT.md — перезаписываем безусловно.
  const deptMdSrc = join(templateDir, 'DEPARTMENT.md');
  const deptMdDst = join(targetDir, 'DEPARTMENT.md');
  if (existsSync(deptMdSrc)) {
    await copyFile(deptMdSrc, deptMdDst);
    updated.push(deptMdDst);
  }

  // 2. pipeline.yml — перезаписываем безусловно.
  const pipelineSrc = join(templateDir, 'pipeline.yml');
  const pipelineDst = join(targetDir, 'pipeline.yml');
  if (existsSync(pipelineSrc)) {
    await copyFile(pipelineSrc, pipelineDst);
    updated.push(pipelineDst);
  }

  // 3. shared/ — recursive copy.
  const sharedSrc = join(templateDir, 'shared');
  if (existsSync(sharedSrc)) {
    const sharedDst = join(targetDir, 'shared');
    await mkdir(sharedDst, { recursive: true });
    await copyDirRecursive(sharedSrc, sharedDst, updated);
  }

  // 4. employees/* — НЕ трогаем (см. комментарий в шапке).

  return updated;
}

async function copyDirRecursive(src: string, dst: string, updated: string[]): Promise<void> {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src);
  for (const entry of entries) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    const s = await stat(srcPath);
    if (s.isDirectory()) {
      await copyDirRecursive(srcPath, dstPath, updated);
    } else if (s.isFile()) {
      await copyFile(srcPath, dstPath);
      updated.push(dstPath);
    }
  }
}

async function main(): Promise<void> {
  const templateId = process.argv[2];
  if (templateId === undefined || templateId === '') {
    console.error('Usage: pnpm dept:update <template-id>');
    console.error('  e.g. pnpm dept:update marketing-content');
    process.exit(1);
  }
  try {
    const updated = await updateDepartment({ templateId });
    console.log(`✓ Department '${templateId}' обновлён.`);
    console.log(`  Перезаписано файлов: ${updated.length}`);
    for (const f of updated) {
      console.log(`  - ${f.replace(`${REPO_ROOT}/`, '')}`);
    }
    console.log('');
    console.log('Routines (employees) НЕ затронуты. Если template employees');
    console.log('поменялся — синхронизируй вручную:');
    console.log(`  diff templates/departments/${templateId}/employees/ routines/`);
  } catch (err) {
    if (err instanceof DeptUpdateError) {
      console.error(`✗ ${err.message}`);
      process.exit(2);
    }
    console.error(err);
    process.exit(1);
  }
}

const isMainEntry = fileURLToPath(import.meta.url) === process.argv[1];
if (isMainEntry) {
  main();
}
