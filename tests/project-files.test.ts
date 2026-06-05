// Тесты для фазы 2.1 — project.read / project.grep / project.glob.
//
// Стратегия:
//   * Fixture-директория через fs.mkdtempSync в beforeEach, удаляется в afterEach.
//   * Не трогаем БД — эти tools не зависят от Prisma.
//   * projectGrep — интеграционный тест с реальным rg (если найден). Если rg
//     не найден → тест проверяет что projectGrep кидает ProjectToolError.
//   * Все тест-кейсы изолированы через tmpdir.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type GrepResult,
  ProjectToolError,
  ProjectToolNotFoundError,
  ProjectToolPermissionError,
  projectGlob,
  projectGrep,
  projectRead,
} from '../src/tools/project-files/index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'project-files-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// projectRead

describe('projectRead', () => {
  it('читает существующий файл и возвращает содержимое', async () => {
    const content = 'hello, world!\nline 2\n';
    writeFileSync(join(tmpDir, 'readme.txt'), content, 'utf-8');

    const result = await projectRead(tmpDir, 'readme.txt');
    expect(result).toBe(content);
  });

  it('несуществующий файл → ProjectToolNotFoundError', async () => {
    await expect(projectRead(tmpDir, 'nonexistent.ts')).rejects.toThrow(ProjectToolNotFoundError);
  });

  it('path traversal (../etc/passwd) → ProjectToolPermissionError', async () => {
    await expect(projectRead(tmpDir, '../etc/passwd')).rejects.toThrow(ProjectToolPermissionError);
  });

  it('абсолютный путь вне проекта (/etc/passwd) → ProjectToolPermissionError', async () => {
    await expect(projectRead(tmpDir, '/etc/passwd')).rejects.toThrow(ProjectToolPermissionError);
  });

  it('файл > 1MB → ProjectToolError с сообщением о размере', async () => {
    // Создаём файл 1.1 MB
    const bigBuf = Buffer.alloc(1024 * 1024 + 100, 'A');
    writeFileSync(join(tmpDir, 'big.bin'), bigBuf);

    const error = await projectRead(tmpDir, 'big.bin').catch((e) => e);
    expect(error).toBeInstanceOf(ProjectToolError);
    expect(error.message).toMatch(/слишком большой/);
  });

  it('вложенный файл в поддиректории — читается нормально', async () => {
    mkdirSync(join(tmpDir, 'src'));
    writeFileSync(join(tmpDir, 'src', 'index.ts'), 'export {};', 'utf-8');

    const result = await projectRead(tmpDir, 'src/index.ts');
    expect(result).toBe('export {};');
  });
});

// ---------------------------------------------------------------------------
// projectGlob

describe('projectGlob', () => {
  it('паттерн **/*.ts — возвращает список .ts файлов', async () => {
    mkdirSync(join(tmpDir, 'src'));
    writeFileSync(join(tmpDir, 'src', 'a.ts'), '', 'utf-8');
    writeFileSync(join(tmpDir, 'src', 'b.ts'), '', 'utf-8');
    writeFileSync(join(tmpDir, 'src', 'c.js'), '', 'utf-8');
    writeFileSync(join(tmpDir, 'readme.md'), '', 'utf-8');

    const results = await projectGlob(tmpDir, '**/*.ts');
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.endsWith('.ts'))).toBe(true);
  });

  it('паттерн выдаёт > maxResults → обрезается до maxResults', async () => {
    // Создаём 10 файлов
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(tmpDir, `file${i}.txt`), '', 'utf-8');
    }

    const results = await projectGlob(tmpDir, '*.txt', { maxResults: 3 });
    expect(results).toHaveLength(3);
  });

  it('пустой проект → пустой массив', async () => {
    const results = await projectGlob(tmpDir, '**/*.ts');
    expect(results).toEqual([]);
  });

  it('паттерн с glob ** находит файлы в поддиректориях', async () => {
    mkdirSync(join(tmpDir, 'deep', 'nested'), { recursive: true });
    writeFileSync(join(tmpDir, 'deep', 'nested', 'target.ts'), '', 'utf-8');

    const results = await projectGlob(tmpDir, '**/*.ts');
    expect(results.some((r) => r.includes('target.ts'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// projectGrep

describe('projectGrep', () => {
  it('поиск строки в файле → GrepResult[] с правильными file/line/text', async () => {
    writeFileSync(
      join(tmpDir, 'code.ts'),
      'const a = 1;\nconst b = 2;\nexport { a, b };\n',
      'utf-8',
    );

    let results: GrepResult[];
    try {
      results = await projectGrep(tmpDir, 'const');
    } catch (err) {
      if (
        err instanceof ProjectToolError &&
        (err as ProjectToolError).message.includes('rg не установлен')
      ) {
        // rg недоступен в этой среде — пропускаем тест
        return;
      }
      throw err;
    }

    expect(results.length).toBeGreaterThanOrEqual(2);
    const firstResult = results[0]!;
    expect(firstResult).toHaveProperty('file');
    expect(firstResult).toHaveProperty('line');
    expect(firstResult).toHaveProperty('text');
    expect(firstResult.text).toMatch(/const/);
    // file должен быть относительным
    expect(firstResult.file).not.toMatch(/^\//);
  });

  it('паттерн не найден → пустой массив', async () => {
    writeFileSync(join(tmpDir, 'code.ts'), 'const a = 1;\n', 'utf-8');

    let results: GrepResult[];
    try {
      results = await projectGrep(tmpDir, 'XYZNOTFOUND12345');
    } catch (err) {
      if (
        err instanceof ProjectToolError &&
        (err as ProjectToolError).message.includes('rg не установлен')
      ) {
        return; // rg недоступен — пропускаем
      }
      throw err;
    }

    expect(results).toEqual([]);
  });

  it('caseSensitive=false (default) — находит с любым регистром', async () => {
    writeFileSync(join(tmpDir, 'test.ts'), 'const Hello = "World";\n', 'utf-8');

    let results: GrepResult[];
    try {
      results = await projectGrep(tmpDir, 'hello', { caseSensitive: false });
    } catch (err) {
      if (
        err instanceof ProjectToolError &&
        (err as ProjectToolError).message.includes('rg не установлен')
      ) {
        return;
      }
      throw err;
    }

    expect(results.length).toBeGreaterThan(0);
  });

  it('fileGlob фильтрует по расширению файла', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'const match = 1;\n', 'utf-8');
    writeFileSync(join(tmpDir, 'b.js'), 'const match = 2;\n', 'utf-8');

    let results: GrepResult[];
    try {
      results = await projectGrep(tmpDir, 'match', { fileGlob: '*.ts' });
    } catch (err) {
      if (
        err instanceof ProjectToolError &&
        (err as ProjectToolError).message.includes('rg не установлен')
      ) {
        return;
      }
      throw err;
    }

    // Все результаты должны быть из .ts файлов
    expect(results.every((r) => r.file.endsWith('.ts'))).toBe(true);
  });

  it('path traversal в fileGlob — rg ограничен cwd, результаты вне проекта фильтруются', async () => {
    writeFileSync(join(tmpDir, 'code.ts'), 'const a = 1;\n', 'utf-8');

    // Даже с ../outside глоб — rg работает в CWD=projectPath
    // Результаты вне projectPath — фильтруются в нашем коде
    let results: GrepResult[];
    try {
      results = await projectGrep(tmpDir, 'const', { fileGlob: '../outside' });
    } catch (err) {
      if (err instanceof ProjectToolError) {
        // Любая ProjectToolError допустима (rg не найден или ничего не нашёл)
        return;
      }
      throw err;
    }

    // Если results есть — проверяем что все файлы из projectPath
    for (const r of results) {
      expect(r.file).not.toMatch(/^\.\./);
    }
  });
});

// ---------------------------------------------------------------------------
// Безопасность (дополнительные проверки)

describe('Безопасность: path traversal', () => {
  it('projectRead с ../../../etc/passwd → ProjectToolPermissionError, не утечка', async () => {
    const error = await projectRead(tmpDir, '../../../etc/passwd').catch((e) => e);
    expect(error).toBeInstanceOf(ProjectToolPermissionError);
  });

  it('projectRead с путём внутри проекта — разрешено', async () => {
    writeFileSync(join(tmpDir, 'allowed.txt'), 'ok', 'utf-8');
    const result = await projectRead(tmpDir, 'allowed.txt');
    expect(result).toBe('ok');
  });
});
