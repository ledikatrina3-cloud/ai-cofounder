// Парсер черновика для публикации.
//
// Формат — markdown с YAML-like frontmatter (тот же стиль, что в
// `routines/<id>.md` см. `src/routines/parser.ts`):
//
//     ---
//     title: Мой заголовок
//     status: ready
//     account: main
//     tags: [ai, automation]
//     cover: /tmp/foo/cover.png        # опционально, абс или относ путь
//     category: ai                     # опционально, для vc.ru обязательно
//     htmlPath: ./foo.html             # опционально, паттерн «paste HTML»
//     ---
//
//     Тело поста (markdown). Используется если htmlPath не задан.
//
// Платформа резолвится из имени директории, в которой лежит файл
// (`content/drafts/vc/foo.md` → platform=vc), не из frontmatter. Это сразу
// разводит файлы по платформам и исключает класс ошибок «положил черновик
// vc в папку reddit».
//
// Свой узкий парсер, не gray-matter — соответствует подходу из
// `src/routines/parser.ts`: формат фиксирован и узок (scalar + flow-array
// `[a, b, c]`), внешняя зависимость не нужна.

import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { type Draft, DraftError, type DraftStatus } from './types.js';

const FRONTMATTER_DELIMITER = '---';
const VALID_STATUS = new Set<DraftStatus>(['ready', 'draft', 'published']);
const KEY_VALUE_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/;

interface FrontmatterAndBody {
  scalars: Map<string, string>;
  arrays: Map<string, string[]>;
  body: string;
}

/**
 * Достаёт frontmatter и body. Frontmatter — между двумя `---` в начале файла.
 * Если первой строкой не `---` — frontmatter пустой, всё содержимое — body
 * (тогда required-валидация ниже упадёт с понятной ошибкой).
 */
export function splitFrontmatter(filePath: string, raw: string): FrontmatterAndBody {
  const lines = raw.split('\n');
  const scalars = new Map<string, string>();
  const arrays = new Map<string, string[]>();

  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    return { scalars, arrays, body: raw };
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FRONTMATTER_DELIMITER) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new DraftError(filePath, 'frontmatter не закрыт (нет второго `---`)');
  }

  let i = 1;
  while (i < endIdx) {
    const line = lines[i];
    if (line === undefined) {
      i++;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      i++;
      continue;
    }

    // Игнорируем YAML-list-items (`  - item`) и YAML-map-items (`  slug: x`)
    // на верхнем уровне — они обработаются как продолжение предыдущего ключа.
    if (line.startsWith('  ') || line.startsWith('\t')) {
      i++;
      continue;
    }

    const m = KEY_VALUE_RE.exec(trimmed);
    if (m === null) {
      throw new DraftError(filePath, `непонятная строка frontmatter (строка ${i + 1}): '${line}'`);
    }
    const key = m[1];
    const valueRaw = (m[2] ?? '').trim();
    if (key === undefined) {
      i++;
      continue;
    }

    if (valueRaw.startsWith('[') && valueRaw.endsWith(']')) {
      // flow-array: [a, b, "c d"]
      const inner = valueRaw.slice(1, -1).trim();
      if (inner.length === 0) {
        arrays.set(key, []);
      } else {
        const items = inner.split(',').map((s) => {
          const v = s.trim();
          if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
          return v;
        });
        arrays.set(key, items);
      }
      i++;
    } else if (valueRaw === '') {
      // Block-style: либо list (- item), либо map (slug: x). Парсим как array
      // строк (значения для map-item — пропускаем, оставляем только scalar items).
      const items: string[] = [];
      let j = i + 1;
      while (j < endIdx) {
        const sub = lines[j];
        if (sub === undefined) break;
        const subTrim = sub.trim();
        if (subTrim.length === 0) {
          j++;
          continue;
        }
        // Любая не-indented строка = конец блока.
        if (!sub.startsWith('  ') && !sub.startsWith('\t')) break;
        if (subTrim.startsWith('- ')) {
          let val = subTrim.slice(2).trim();
          if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
          items.push(val);
        }
        // YAML-map-items (`slug: x`) внутри `- ` уже не верхний уровень — игнорим.
        j++;
      }
      arrays.set(key, items);
      i = j;
    } else {
      // scalar (string) — кавычки опциональны.
      let v = valueRaw;
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      scalars.set(key, v);
      i++;
    }
  }

  // Тело — всё что после второго `---`. Снимаем лидирующие пустые строки.
  const bodyLines = lines.slice(endIdx + 1);
  while (bodyLines.length > 0 && bodyLines[0]?.trim() === '') {
    bodyLines.shift();
  }

  return { scalars, arrays, body: bodyLines.join('\n') };
}

/**
 * Резолвит platform из родительской директории файла.
 * `/abs/.../content/drafts/vc/foo.md` → `vc`.
 */
function platformFromPath(filePath: string): string {
  const parent = basename(dirname(filePath));
  if (parent.length === 0) {
    throw new DraftError(filePath, 'не могу определить platform — файл не в подпапке');
  }
  // Alias для downstream-формата: `content/vc-drafts/foo.md` → platform=vc.
  if (parent === 'vc-drafts') return 'vc';
  return parent;
}

export interface LoadDraftOptions {
  /** DI для тестов. */
  read?: (path: string) => Promise<string>;
}

export async function loadDraft(filePath: string, opts: LoadDraftOptions = {}): Promise<Draft> {
  const abs = resolve(filePath);
  const read = opts.read ?? ((p: string) => readFile(p, 'utf8'));
  const raw = await read(abs).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DraftError(abs, `не удалось прочитать файл: ${msg}`);
  });

  const { scalars, arrays, body } = splitFrontmatter(abs, raw);

  // title или h1 (альтернативный downstream-формат).
  const title = scalars.get('title') ?? scalars.get('h1');
  if (title === undefined || title.length === 0) {
    throw new DraftError(abs, 'отсутствует обязательное поле title (или h1) в frontmatter');
  }

  const statusRaw = scalars.get('status') ?? 'draft';
  if (!VALID_STATUS.has(statusRaw as DraftStatus)) {
    throw new DraftError(
      abs,
      `status='${statusRaw}' не из допустимого набора: ${Array.from(VALID_STATUS).join(', ')}`,
    );
  }
  const status = statusRaw as DraftStatus;

  const account = scalars.get('account') ?? 'main';
  const tags = arrays.get('tags') ?? [];
  const platform = platformFromPath(abs);

  // Optional cover: абс или относительно draft.md. Validate существование сразу,
  // чтобы publisher не падал в середине flow.
  let cover: string | null = null;
  // cover или coverPath (альтернативный downstream-формат).
  const coverRaw = scalars.get('cover') ?? scalars.get('coverPath');
  if (coverRaw !== undefined && coverRaw.length > 0) {
    cover = isAbsolute(coverRaw) ? coverRaw : resolve(dirname(abs), coverRaw);
    const coverExists = await read(cover)
      .then(() => true)
      .catch(() => false);
    if (!coverExists) {
      throw new DraftError(abs, `cover='${coverRaw}' указан, но файл не найден: ${cover}`);
    }
  }

  // Optional category — slug категории платформы. Не валидируем (зависит от
  // платформы), просто прокидываем дальше.
  const categoryRaw = scalars.get('category');
  const category: string | null =
    categoryRaw !== undefined && categoryRaw.length > 0 ? categoryRaw : null;

  // Optional htmlPath — paste-HTML альтернатива body. Загружаем сразу.
  let htmlBody: string | null = null;
  const htmlPathRaw = scalars.get('htmlPath');
  if (htmlPathRaw !== undefined && htmlPathRaw.length > 0) {
    const htmlPath = isAbsolute(htmlPathRaw) ? htmlPathRaw : resolve(dirname(abs), htmlPathRaw);
    htmlBody = await read(htmlPath).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DraftError(abs, `htmlPath='${htmlPathRaw}' указан, но не читается: ${msg}`);
    });
    if (htmlBody.trim().length === 0) {
      throw new DraftError(abs, `htmlPath='${htmlPathRaw}' пустой`);
    }
  }

  if (body.trim().length === 0 && htmlBody === null) {
    throw new DraftError(abs, 'тело черновика пустое (ни markdown body, ни htmlPath)');
  }

  return { platform, account, status, title, body, htmlBody, tags, cover, category, filePath: abs };
}
