// Anti-leak страж (OSS v1.0): движок не должен содержать ЛИЧНЫХ констант
// мейнтейнера (настоящее имя, бренд, домены, telegram-токен). Проверяемый
// инвариант обезлички: форк публикует только обезличенный код.
//
// Гоняется в общем `pnpm test` → попадает в CI автоматически (ci.yml gate).
// Падение = в трекаемый upstream-код просочилась личная константа: чини до
// релиза/пуша. См. CONTRIBUTING.md (раздел про де-идентификацию).
//
// Охват = engine[] из engine-manifest.json (всё, что upstream реально
// поставляет: код, доки, скиллы, .github/.claude, README/CLAUDE.md, LICENSE,
// engine-config'и). Пользовательский слой (engine-manifest.user[]: agents/
// org/ ai-clone/ config/projects.md …) gitignore'нут и НЕ сканируется — там
// личные данные форка легитимны. Так страж ловит регрессию в любой
// поставляемой прозе (README — самый читаемый файл OSS), а не только в коде.
//
// Почему свой walker на node:fs, а не glob-зависимость: ноль новых deps
// (новый пакет ломал бы `pnpm install --frozen-lockfile` в CI).
//
// ВАЖНО: этот файл сам содержит запретные токены (список ниже). Он лежит в
// tests/ (директория входит в engine[]), НО исключается как *.test.ts через
// isTestFile — поэтому себя не палит.

import { type Dirent, existsSync, readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

// Личные строковые токены НЕ хардкодятся здесь: публичный репо не должен светить
// собственное реальное имя/бренд мейнтейнера прямо в анти-leak блок-листе (иначе сам
// страж становится утечкой). Они лежат в gitignore'нутом локальном файле
// `anti-leak.tokens.local.json` ({"tokens":[...]}) в корне — его подхватывает pre-commit
// хук и локальный `pnpm test` мейнтейнера, так что личные данные всё ещё ловятся ДО пуша.
// Форк кладёт свой файл со своими токенами. На чистом публичном клоне список пуст, и
// проверку несут generic key-паттерны ниже (они шипятся и гоняются в CI на каждом клоне).
function loadForbiddenStrings(): string[] {
  const local = resolve(ROOT, 'anti-leak.tokens.local.json');
  if (!existsSync(local)) return [];
  try {
    const parsed = JSON.parse(readFileSync(local, 'utf8')) as { tokens?: unknown };
    return Array.isArray(parsed.tokens) ? parsed.tokens.map((t) => String(t)) : [];
  } catch {
    return [];
  }
}
const FORBIDDEN_STRINGS = loadForbiddenStrings();

// Telegram bot-token: 8-12 цифр, двоеточие, 30+ символов секрета.
const TELEGRAM_TOKEN_RE = /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/;

// Generic credential SHAPES — шипятся и гоняются на КАЖДОМ клоне (включая публичный CI),
// поэтому утёкший ключ ловится даже когда личный строковый блок-лист пуст (local-only).
// Длины подобраны так, чтобы плейсхолдеры в доках ('sk-ant-...', 'AIza-your-key') не ловились.
const KEY_PATTERNS: RegExp[] = [
  TELEGRAM_TOKEN_RE,
  /sk-ant-[A-Za-z0-9_-]{24,}/, // Anthropic API key
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, // GitHub token
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/, // GitHub fine-grained PAT
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /xox[baprs]-[A-Za-z0-9-]{20,}/, // Slack token
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, // private key block
];

// Расширения с текстом, которые сканируем при обходе директорий движка.
const SCAN_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.md',
  '.mdx',
  '.txt',
  '.json',
  '.yml',
  '.yaml',
  '.sql',
  '.prisma',
]);
// Подмножество, где ДОПОЛНИТЕЛЬНО ищем telegram-токен (только исходный код:
// в прозе/фикстурах токен-формат может встречаться как иллюстрация).
const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const CODE_DIRS = ['src', 'bridge', 'scripts', 'prisma'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

function isTestFile(path: string): boolean {
  return path.endsWith('.test.ts') || path.endsWith('.test.tsx');
}

// Рекурсивно собирает файлы из dir. predicate решает, брать ли файл по пути.
async function walk(dir: string, predicate: (path: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // директории может не быть — это ок
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await walk(full, predicate)));
    } else if (entry.isFile() && predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

// Все файлы, реально поставляемые upstream (engine[] из манифеста). Файл-запись
// сканируем напрямую; директорию — обходим по SCAN_EXTS. Охват следует за
// манифестом и не заходит в gitignored user-слой (engine-manifest.user[]).
async function enginePaths(): Promise<string[]> {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'engine-manifest.json'), 'utf8')) as {
    engine: string[];
  };
  const files: string[] = [];
  for (const rel of manifest.engine) {
    const abs = resolve(ROOT, rel);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      files.push(...(await walk(abs, (p) => SCAN_EXTS.has(extname(p)) && !isTestFile(p))));
    } else if (!isTestFile(abs)) {
      files.push(abs);
    }
  }
  return files;
}

function assertNoForbiddenStrings(files: string[]): void {
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const token of FORBIDDEN_STRINGS) {
      expect(content.includes(token), `Личная константа "${token}" в движке: ${file}`).toBe(false);
    }
  }
}

describe('anti-leak: движок не содержит личных констант мейнтейнера', () => {
  it('исходный код (src/bridge/scripts/prisma) чист от констант и telegram-токенов', async () => {
    const files: string[] = [];
    for (const dir of CODE_DIRS) {
      files.push(
        ...(await walk(resolve(ROOT, dir), (p) => CODE_EXTS.has(extname(p)) && !isTestFile(p))),
      );
    }
    expect(files.length).toBeGreaterThan(0); // walker реально что-то нашёл
    assertNoForbiddenStrings(files);
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const re of KEY_PATTERNS) {
        expect(re.test(content), `Похоже на секрет/ключ (${re}) в ${file}`).toBe(false);
      }
    }
  });

  it('все поставляемые upstream файлы (engine-manifest.engine[]) чисты от констант', async () => {
    const files = await enginePaths();
    expect(files.length).toBeGreaterThan(0);
    assertNoForbiddenStrings(files);
  });
});
