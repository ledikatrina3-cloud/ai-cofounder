// Org parser — единственная точка чтения `org/*.md`.
//
// Контракт фазы 3:
//   * parseOrg(orgDir) — читает 4 файла + проверяет существование examples/.
//     identity/brand-voice/audience — обязательны (OrgParseError если нет).
//     product-knowledge.md — опционален.
//   * body = весь markdown без frontmatter. У org-файлов frontmatter не
//     предполагается, но если кто-то добавит `---`-блок сверху — пропускаем
//     его (чтобы не получить мусор в system prompt'е).
//
// Никаких yaml-полей: org-файлы — это чистый markdown для system prompt'а.
// Если в будущем понадобятся метаданные (например, `lastReviewed`), добавим
// их через отдельный nested-YAML-парсер по образцу skills/parser.ts.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { OrgKnowledge } from './types.js';

export class OrgParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrgParseError';
  }
}

export interface ParseOrgOptions {
  /**
   * DI: чтение файла. Получает абсолютный путь, должен вернуть содержимое
   * или бросить (ENOENT и т.п.). По умолчанию — fs/promises.readFile.
   */
  read?: (path: string) => Promise<string>;
  /**
   * DI: проверка существования файла/директории. По умолчанию —
   * fs/promises.stat (ENOENT → false).
   */
  exists?: (path: string) => Promise<boolean>;
}

async function defaultRead(p: string): Promise<string> {
  return readFile(p, 'utf8');
}

async function defaultExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

/**
 * Если файл начинается с `---\n...\n---\n` (frontmatter-блок), вырезаем его.
 * Иначе возвращаем содержимое как есть (trimmed).
 *
 * Это «мягкая» совместимость: org-файлы обычно без frontmatter, но если
 * фаундер скопирует шаблон с frontmatter'ом — мы не падаем.
 */
function stripOptionalFrontmatter(source: string): string {
  const lines = source.split('\n');
  if (lines[0]?.trim() !== '---') {
    return source.trim();
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      return lines
        .slice(i + 1)
        .join('\n')
        .trim();
    }
  }
  // Открывающий `---` без закрывающего — отдаём как есть, без вырезания.
  return source.trim();
}

/**
 * Читает обязательный файл. Бросает OrgParseError, если файла нет.
 * Любая другая ошибка чтения — пробрасывается как есть.
 */
async function readRequired(
  path: string,
  fileLabel: string,
  read: (p: string) => Promise<string>,
): Promise<string> {
  let source: string;
  try {
    source = await read(path);
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new OrgParseError(
        `${fileLabel} не найден (${path}). Этот файл обязателен — см. план 2026-05-21-skills-architecture-v3, раздел «Org knowledge».`,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new OrgParseError(`не удалось прочитать ${fileLabel} (${path}): ${message}`);
  }
  const body = stripOptionalFrontmatter(source);
  if (body === '') {
    throw new OrgParseError(
      `${fileLabel} (${path}) пустой. Заполни его — иначе скиллы writing/research получат пустой prompt.`,
    );
  }
  return body;
}

/**
 * Читает опциональный файл. Возвращает null если файла нет.
 * Любая другая ошибка чтения — пробрасывается.
 */
async function readOptional(
  path: string,
  read: (p: string) => Promise<string>,
  exists?: (p: string) => Promise<boolean>,
): Promise<string | null> {
  if (exists !== undefined) {
    if (!(await exists(path))) return null;
    const source = await read(path);
    return stripOptionalFrontmatter(source);
  }
  try {
    const source = await read(path);
    return stripOptionalFrontmatter(source);
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export async function parseOrg(
  orgDir: string,
  options: ParseOrgOptions = {},
): Promise<OrgKnowledge> {
  const read = options.read ?? defaultRead;
  const exists = options.exists ?? defaultExists;

  const identityPath = join(orgDir, 'identity.md');
  const brandVoicePath = join(orgDir, 'brand-voice.md');
  const audiencePath = join(orgDir, 'audience.md');
  const productKnowledgePath = join(orgDir, 'product-knowledge.md');
  const examplesPath = join(orgDir, 'examples');

  // Параллельно: 3 обязательных файла, 1 опциональный, 1 проверка директории.
  // Если обязательный отсутствует — Promise.all бросит первую ошибку.
  const [identity, brandVoice, audience, productKnowledge, hasExamples] = await Promise.all([
    readRequired(identityPath, 'org/identity.md', read),
    readRequired(brandVoicePath, 'org/brand-voice.md', read),
    readRequired(audiencePath, 'org/audience.md', read),
    readOptional(productKnowledgePath, read, exists),
    exists(examplesPath),
  ]);

  return {
    identity,
    brandVoice,
    audience,
    productKnowledge,
    examplesDir: hasExamples ? examplesPath : null,
    filePath: orgDir,
  };
}
