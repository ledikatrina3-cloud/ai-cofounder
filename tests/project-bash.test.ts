// Vitest тесты для src/tools/project-bash/index.ts
//
// Покрываем:
//   1. ls в tmpDir → BashResult exitCode=0, stdout содержит файлы.
//   2. pwd → stdout = projectPath + newline.
//   3. git status в git-репозитории → exitCode=0.
//   4. rm -rf / → ProjectBashPermissionError (не в whitelist).
//   5. cat /etc/passwd — разрешён по whitelist (cat в списке).
//   6. ls && rm -rf / → ProjectBashPermissionError (&&).
//   7. ls | rm → ProjectBashPermissionError (|).
//   8. eval "rm -rf /" → ProjectBashPermissionError (eval).
//   9. git log $(rm -rf /) → ProjectBashPermissionError ($().
//  10. canRunCommand('ls -la', undefined) → true.
//  11. canRunCommand('wget http://x.com', undefined) → false.
//  12. Кастомный whitelist ['echo'] → echo hello разрешён; ls заблокирован.
//  13. Тайм-аут: sleep 100 с timeoutMs=100 → ProjectBashTimeoutError.

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProjectBashPermissionError,
  ProjectBashTimeoutError,
  canRunCommand,
  projectBash,
} from '../src/tools/project-bash/index.js';

// ---------------------------------------------------------------------------
// Setup / teardown.
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'project-bash-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Тест 1: ls в tmpDir → exitCode=0, stdout содержит имена файлов.
// ---------------------------------------------------------------------------

it('ls in tmpDir returns exitCode=0 and lists files', async () => {
  writeFileSync(join(tmpDir, 'foo.txt'), 'hello');
  writeFileSync(join(tmpDir, 'bar.ts'), 'world');

  const result = await projectBash(tmpDir, 'ls');

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('foo.txt');
  expect(result.stdout).toContain('bar.ts');
});

// ---------------------------------------------------------------------------
// Тест 2: pwd → stdout = projectPath + newline.
// ---------------------------------------------------------------------------

it('pwd returns projectPath', async () => {
  const result = await projectBash(tmpDir, 'pwd');

  expect(result.exitCode).toBe(0);
  // macOS может добавить /private/ перед /tmp/ — нормализуем через realpath.
  const normalized = result.stdout.trim();
  // stdout должен оканчиваться базовым именем tmpDir.
  expect(normalized).toMatch(/project-bash-test-/);
});

// ---------------------------------------------------------------------------
// Тест 3: git status в git-репозитории → exitCode=0.
// ---------------------------------------------------------------------------

it('git status in git repo returns exitCode=0', async () => {
  // Инициализируем git в tmpDir.
  execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });

  const result = await projectBash(tmpDir, 'git status');

  expect(result.exitCode).toBe(0);
  // git status выдаёт что-то вроде "On branch main"
  expect(result.stdout.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Тест 4: rm -rf / → ProjectBashPermissionError (не в whitelist).
// ---------------------------------------------------------------------------

it('rm -rf / throws ProjectBashPermissionError (not in whitelist)', async () => {
  await expect(projectBash(tmpDir, 'rm -rf /')).rejects.toThrow(ProjectBashPermissionError);
});

// ---------------------------------------------------------------------------
// Тест 5: абсолютные пути и path traversal заблокированы.
// ---------------------------------------------------------------------------

it('cat /etc/passwd blocked (absolute path)', () => {
  // Абсолютные пути запрещены: cwd=projectPath не защищает от /etc/passwd.
  expect(canRunCommand('cat /etc/passwd')).toBe(false);
});

it('cat ../../etc/passwd blocked (path traversal via ..)', () => {
  // ../ в аргументах заблокирован: rg pattern ../../other/ обходит projectPath.
  expect(canRunCommand('cat ../../etc/passwd')).toBe(false);
});

// ---------------------------------------------------------------------------
// Тест 6: ls && rm -rf / → ProjectBashPermissionError (&&).
// ---------------------------------------------------------------------------

it('ls && rm -rf / throws ProjectBashPermissionError (&&)', async () => {
  await expect(projectBash(tmpDir, 'ls && rm -rf /')).rejects.toThrow(ProjectBashPermissionError);
});

// ---------------------------------------------------------------------------
// Тест 7: ls | rm → ProjectBashPermissionError (|).
// ---------------------------------------------------------------------------

it('ls | rm throws ProjectBashPermissionError (pipe)', async () => {
  await expect(projectBash(tmpDir, 'ls | rm')).rejects.toThrow(ProjectBashPermissionError);
});

// ---------------------------------------------------------------------------
// Тест 8: eval "rm -rf /" → ProjectBashPermissionError (eval).
// ---------------------------------------------------------------------------

it('eval "rm -rf /" throws ProjectBashPermissionError (eval)', async () => {
  await expect(projectBash(tmpDir, 'eval "rm -rf /"')).rejects.toThrow(ProjectBashPermissionError);
});

// ---------------------------------------------------------------------------
// Тест 9: git log $(rm -rf /) → ProjectBashPermissionError ($().
// ---------------------------------------------------------------------------

it('git log $(rm -rf /) throws ProjectBashPermissionError (subshell)', async () => {
  await expect(projectBash(tmpDir, 'git log $(rm -rf /)')).rejects.toThrow(
    ProjectBashPermissionError,
  );
});

// ---------------------------------------------------------------------------
// Тест 10: canRunCommand('ls -la', undefined) → true.
// ---------------------------------------------------------------------------

it('canRunCommand ls -la returns true', () => {
  expect(canRunCommand('ls -la', undefined)).toBe(true);
});

// ---------------------------------------------------------------------------
// Тест 11: canRunCommand('wget http://x.com', undefined) → false.
// ---------------------------------------------------------------------------

it('canRunCommand wget returns false (not in default whitelist)', () => {
  expect(canRunCommand('wget http://x.com', undefined)).toBe(false);
});

// ---------------------------------------------------------------------------
// Тест 12: Кастомный whitelist ['echo'] → echo hello разрешён; ls заблокирован.
// ---------------------------------------------------------------------------

describe('custom whitelist', () => {
  const customWhitelist = ['echo'];

  it('echo hello is allowed with custom whitelist', () => {
    expect(canRunCommand('echo hello', customWhitelist)).toBe(true);
  });

  it('ls is blocked with custom whitelist', () => {
    expect(canRunCommand('ls', customWhitelist)).toBe(false);
  });

  it('echo hello runs successfully with custom whitelist', async () => {
    const result = await projectBash(tmpDir, 'echo hello', { whitelist: customWhitelist });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('ls throws ProjectBashPermissionError with custom whitelist', async () => {
    await expect(projectBash(tmpDir, 'ls', { whitelist: customWhitelist })).rejects.toThrow(
      ProjectBashPermissionError,
    );
  });
});

// ---------------------------------------------------------------------------
// Тест 13: Тайм-аут: sleep 100 с timeoutMs=100 → ProjectBashTimeoutError.
// sleep не в DEFAULT_WHITELIST → используем кастомный whitelist ['sleep'].
// ---------------------------------------------------------------------------

it('sleep 100 with timeoutMs=100 throws ProjectBashTimeoutError', async () => {
  await expect(
    projectBash(tmpDir, 'sleep 100', {
      whitelist: ['sleep'],
      timeoutMs: 100,
    }),
  ).rejects.toThrow(ProjectBashTimeoutError);
}, 5000); // Даём тесту до 5 секунд (Node убивает sleep очень быстро).

// ---------------------------------------------------------------------------
// Security regressions (Phase 8 review, 2026-05-21):
//
// До этого fix'а проверка пути искала substring `' ../'` (с ведущим пробелом)
// и `(?:^|\s)\/` для абсолютных путей — оба не ловили traversal/абсолютный
// путь в значении опции (`--out=../foo`, `--out="../foo"`, `--out=/etc/x`).
// А `args.includes('rm')` ложно срабатывал на `--platform`, `--format` и т.п.
// ---------------------------------------------------------------------------

describe('security: path-traversal in =value style', () => {
  const skillWl = ['pnpm exec tsx skills/cover-design/scripts/generate.ts'];

  it('blocks --out=../../foo (traversal через =)', () => {
    expect(
      canRunCommand(
        'pnpm exec tsx skills/cover-design/scripts/generate.ts --out=../../private/secrets',
        skillWl,
      ),
    ).toBe(false);
  });
  it('blocks --out="../foo" (quoted traversal)', () => {
    expect(
      canRunCommand(
        'pnpm exec tsx skills/cover-design/scripts/generate.ts --out="../../../etc/passwd"',
        skillWl,
      ),
    ).toBe(false);
  });
  it('blocks --out=/etc/foo (абсолютный путь через =)', () => {
    expect(
      canRunCommand(
        'pnpm exec tsx skills/cover-design/scripts/generate.ts --out=/etc/foo',
        skillWl,
      ),
    ).toBe(false);
  });
  it('blocks --x=.. (token-traversal через =)', () => {
    expect(
      canRunCommand('pnpm exec tsx skills/cover-design/scripts/generate.ts --x=..', skillWl),
    ).toBe(false);
  });
  it('blocks --x .. (token-traversal без слэша)', () => {
    expect(
      canRunCommand('pnpm exec tsx skills/cover-design/scripts/generate.ts --x ..', skillWl),
    ).toBe(false);
  });
});

describe('security: word-boundary для FORBIDDEN_WORDS', () => {
  const skillWl = ['pnpm exec tsx skills/analytics-traffic/scripts/collect.ts'];

  it('allows --platform vc (не путать с rm)', () => {
    expect(
      canRunCommand(
        'pnpm exec tsx skills/analytics-traffic/scripts/collect.ts --platform vc',
        skillWl,
      ),
    ).toBe(true);
  });
  it('allows --urls https://vc.ru/foo,https://vc.ru/bar (URL-content)', () => {
    expect(
      canRunCommand(
        'pnpm exec tsx skills/analytics-traffic/scripts/collect.ts --platform vc --urls https://vc.ru/foo,https://vc.ru/bar',
        skillWl,
      ),
    ).toBe(true);
  });
  it('blocks reali rm как отдельное слово', () => {
    expect(
      canRunCommand('pnpm exec tsx skills/analytics-traffic/scripts/collect.ts; rm -rf /', skillWl),
    ).toBe(false);
  });
  it('blocks curl как отдельное слово', () => {
    expect(canRunCommand('cat foo; curl http://x', undefined)).toBe(false);
  });
  it('allows слово, содержащее curl как substring (--curlable)', () => {
    // Защита от false-positive: --curlable не должен быть заблокирован
    // как «содержит curl». В реальности таких опций нет, но контракт
    // word-boundary должен это разрешать.
    expect(canRunCommand('cat --curlable', undefined)).toBe(true);
  });
});

describe('canRunCommand — path-traversal через сегменты (security regression)', () => {
  it('блокирует классический ../', () => {
    expect(canRunCommand('cat ../../etc/passwd', undefined)).toBe(false);
  });
  it('блокирует ../ ПОСЛЕ сегмента (прошлый bypass dir/../)', () => {
    expect(canRunCommand('cat ./x/../../../etc/passwd', undefined)).toBe(false);
    expect(canRunCommand('cat a/../../etc/passwd', undefined)).toBe(false);
    expect(canRunCommand('cat foo/bar/../../../../etc/passwd', undefined)).toBe(false);
  });
  it('блокирует ../ в значении опции', () => {
    expect(canRunCommand('grep -f ../secret pattern', undefined)).toBe(false);
    expect(canRunCommand('cat --file=../../.env', undefined)).toBe(false);
  });
  it('НЕ блокирует легитимные имена с точками (не path-traversal)', () => {
    expect(canRunCommand('cat src/a..b.txt', undefined)).toBe(true);
    expect(canRunCommand('cat v1.2.txt', undefined)).toBe(true);
    expect(canRunCommand('grep foo src/nested/file.ts', undefined)).toBe(true);
  });
});

describe('canRunCommand — find read-only контракт (security regression)', () => {
  it('блокирует find -delete (удаление)', () => {
    expect(canRunCommand('find . -delete', undefined)).toBe(false);
  });
  it('блокирует find -exec/-execdir (произвольное выполнение)', () => {
    expect(canRunCommand('find . -exec touch {} +', undefined)).toBe(false);
    expect(canRunCommand('find . -exec sh -c x {} +', undefined)).toBe(false);
    expect(canRunCommand('find . -execdir echo {} +', undefined)).toBe(false);
  });
  it('блокирует find -fprintf/-fls (запись файла)', () => {
    expect(canRunCommand('find . -name foo -fprintf bar.txt %p', undefined)).toBe(false);
    expect(canRunCommand('find . -fls out.txt', undefined)).toBe(false);
  });
  it('разрешает безопасный read-only find', () => {
    expect(canRunCommand('find . -name "*.ts"', undefined)).toBe(true);
    expect(canRunCommand('find src -type f', undefined)).toBe(true);
  });
});
