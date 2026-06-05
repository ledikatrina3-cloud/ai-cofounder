// Generic-парсер Page'ей: markdown с секциями вида `## <name>`. Введён в фазе
// 1.1 (project registry + map) — но сделан так, чтобы старый
// `parsePageChatIds` (founder-bot allowlist + support-source) лёг сверху без
// поломок API: тот парсер остаётся в `src/telegram/secrets.ts` как
// специализация (только `- <chat_id>` элементы), здесь — общий парсер,
// который отдаёт сырые строки внутри секции для дальнейшей интерпретации
// (key:value, bullet, json — на выбор вызывающего).
//
// Контракт:
//   * Заголовок секции: строка вида `^##\s+<name>\s*$`. Уровень фиксирован
//     `##` — глубже не лезем, заголовки `###` интерпретируются как обычные
//     строки тела секции.
//   * Тело секции — все строки от заголовка (не включая) до следующего `##`
//     или EOF. Возвращается «как есть» с сохранением порядка и пустых строк.
//   * Имена секций уникальны. При дубле выигрывает первая (для
//     append-only-friendly семантики: дописал второй раз — не перетёр).
//
// Используют:
//   * `src/projects/registry.ts` — реестр проектов в `config/projects.md`.
//   * `src/projects/map.ts` — карта проекта в `projects/<id>/map.md`.
//
// `src/telegram/secrets.ts:parsePageChatIds` остаётся независимой узкой
// функцией — её сигнатура (string[] → string[] из chat_id) проще нашего
// generic API и завязана на 44 теста. Не трогаем, чтобы не сломать.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface PageReader {
  read: (path: string) => Promise<string>;
}

const HEADING_RE = /^##\s+(.+?)\s*$/;

// Возвращает map: secName → массив строк тела (без заголовка). Порядок строк
// сохранён. Пустые строки сохраняются (могут быть значимы для маркеров).
export function parsePageSections(markdown: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  let buf: string[] = [];

  for (const line of markdown.split('\n')) {
    const heading = HEADING_RE.exec(line);
    if (heading !== null && heading[1] !== undefined) {
      // Закрываем предыдущую секцию (если была). При дубле — первая
      // выигрывает (`if !has`): пишем только если это первое появление.
      if (current !== null && !out.has(current)) {
        out.set(current, buf);
      }
      current = heading[1];
      buf = [];
      continue;
    }
    if (current !== null) buf.push(line);
  }
  if (current !== null && !out.has(current)) {
    out.set(current, buf);
  }
  return out;
}

// Достаёт ровно одну секцию. `null`, если секция отсутствует. Нужен для
// «эта секция обязательная — на отсутствии бросаем». Тело — те же строки,
// что в `parsePageSections`.
export function getSection(markdown: string, name: string): string[] | null {
  const sections = parsePageSections(markdown);
  return sections.get(name) ?? null;
}

// Парсит строки вида `- key: value` в Map. Игнорирует пустые строки,
// строки-комментарии (`# ...` без префикса `- `), строки без `: `. Это
// формат, в котором писатель карты человекочитаемо описывает свойства:
//
//   - name: Acme Academy
//   - path: ${PROJECTS_ROOT}/example-project
//   - enabled: true
//
// Дубли ключей — выигрывает первый (тот же принцип, что секции).
export function parseKeyValueLines(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^-\s+([^:\s]+):\s*(.*?)\s*$/;
  for (const line of lines) {
    const m = re.exec(line);
    if (m === null || m[1] === undefined || m[2] === undefined) continue;
    if (!out.has(m[1])) out.set(m[1], m[2]);
  }
  return out;
}

// Удобный аккорд для самого частого случая: «прочитай Page, достань
// одну секцию как key/value-карту».
export function parseSectionKeyValue(markdown: string, name: string): Map<string, string> | null {
  const lines = getSection(markdown, name);
  if (lines === null) return null;
  return parseKeyValueLines(lines);
}

// Парсит «список объектов» — каждый объект отделён пустой строкой,
// внутри объекта строки `- key: value`. Используется для коллекций типа
// `dbConnections[]`, `telegramChannels[]` в `projects/<id>/map.md`.
//
// Пример входа (после `getSection`):
//   - id: example-project-prod
//   - driver: postgres
//   - keychainService: ai-cofounder.example-project.db
//
//   - id: example-project-replica
//   - driver: postgres
//   - keychainService: ai-cofounder.example-project.db.replica
//
// Пустая секция (только пустые строки или вообще ноль строк) → []. Это
// валидная семантика «коннектов нет, но место под них объявлено».
export function parseSectionObjectList(
  markdown: string,
  name: string,
): Map<string, string>[] | null {
  const lines = getSection(markdown, name);
  if (lines === null) return null;
  const groups: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length > 0) {
        groups.push(current);
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) groups.push(current);
  return groups.map((g) => parseKeyValueLines(g)).filter((m) => m.size > 0);
}

// Чтение Page'а с диска с graceful-fallback: ENOENT → null. Любая другая
// ошибка пробрасывается (мы не маскируем permission denied и т.п.).
export async function readPage(
  pagePath: string,
  io: PageReader = { read: (path) => readFile(path, 'utf8') },
  cwd: string = process.cwd(),
): Promise<string | null> {
  const abs = resolve(cwd, pagePath);
  try {
    return await io.read(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}
