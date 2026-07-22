// Routine serializer — обратная операция к `src/routines/parser.ts`.
//
// Две функции с разными контрактами:
//
//   * `serializeRoutine(routine)` — полная сериализация для СОЗДАНИЯ нового
//     файла `routines/<id>.md`. Канонический порядок полей, минимальное
//     квотирование. Контракт: `parseRoutineSource(serializeRoutine(r)) === r`
//     (семантический round-trip, без filePath).
//
//   * `applyRoutinePatch(source, patch)` — ХИРУРГИЧЕСКОЕ редактирование уже
//     существующего файла. Меняет только строки затронутых полей, СОХРАНЯЯ
//     комментарии (`# ...` во frontmatter), порядок строк и неизвестные поля.
//     Это критично: реальные routine-файлы содержат многострочные `#`-заметки
//     (разбор инцидентов), которые parser выкидывает — полная ре-сериализация
//     их бы потеряла. Поэтому UPDATE идёт по тексту, а не через модель.
//
// Формат полностью совпадает с parser'ом: scalar `key: value` и flow-array
// `key: [a, b]`. Nested mapping в routine-frontmatter нет (в отличие от skill).

import type { Routine } from './parser.js';

// ---------------------------------------------------------------------------
// Патч: какие поля разрешено менять из UI. undefined — не трогать; для
// опциональных полей null — удалить строку из frontmatter.
// ---------------------------------------------------------------------------

export interface RoutinePatch {
  enabled?: boolean;
  trigger?: string;
  tools?: string[];
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  outputType?: string;
  description?: string;
  /** Body (промт). undefined — не трогать (сохранить байт-в-байт). */
  prompt?: string;
  // Опциональные поля: значение — установить, null — удалить, undefined — не трогать.
  role?: string | null;
  avatar?: string | null;
  color?: string | null;
  logo?: string | null;
  bashWhitelist?: string[] | null;
  skills?: string[] | null;
  forceLoad?: string[] | null;
  departmentId?: string | null;
  targetProject?: string | null;
}

const FRONTMATTER_DELIM = '---';
const KEY_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/;

// ---------------------------------------------------------------------------
// Квотирование. Парсер: scalar = всё после `key: `, `stripQuotes` снимает
// обрамляющие кавычки (без unescape). Поэтому квотируем ТОЛЬКО когда без
// кавычек значение распарсилось бы неверно, плюс по конвенции — hex-цвета.
// Значения с внутренними кавычками не экранируем (выбираем свободный
// quote-char), иначе round-trip сломается.
// ---------------------------------------------------------------------------

export function serializeScalar(value: string): string {
  if (value === '') return '""';
  const looksLikeArray = value.startsWith('[') && value.endsWith(']');
  const hasEdgeSpace = value !== value.trim();
  const isHexColor = value.startsWith('#'); // конвенция: color: "#FF8800"
  // Значение, реально начинающееся/кончающееся кавычкой, БЕЗ квотирования было бы
  // снято stripQuotes на чтении (data loss, ревью finding #8) — квотируем.
  const edgeQuote =
    value.startsWith('"') || value.endsWith('"') || value.startsWith("'") || value.endsWith("'");
  if (!looksLikeArray && !hasEdgeSpace && !isHexColor && !edgeQuote) return value;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  // Внутри и `"` и `'` — наш формат не умеет экранировать. Падаем ГРОМКО, а не
  // молча выдаём битую строку (ревью finding #9).
  throw new RoutineSerializeError(
    `значение нельзя безопасно сериализовать — содержит и ' и " одновременно: '${value}'.`,
  );
}

function serializeArrayItem(item: string): string {
  if (item === '') return '""';
  // Запятая/скобки ломают flow-array на ЧТЕНИИ (parseFlowArray режет по запятой
  // ДО снятия кавычек) — квотирование не спасает. Падаем громко (ревью finding #7).
  if (/[,[\]{}]/.test(item)) {
    throw new RoutineSerializeError(
      `элемент массива '${item}' содержит , [ ] { } — flow-array формат это не поддерживает.`,
    );
  }
  // Пробелы внутри элемента — ок (parseFlowArray тримит весь элемент); квотируем
  // только ради сохранения leading/trailing пробелов.
  if (item === item.trim()) return item;
  if (!item.includes('"')) return `"${item}"`;
  if (!item.includes("'")) return `'${item}'`;
  throw new RoutineSerializeError(`элемент массива '${item}' нельзя сериализовать (и ' и ").`);
}

function serializeArray(items: string[]): string {
  return `[${items.map(serializeArrayItem).join(', ')}]`;
}

// ---------------------------------------------------------------------------
// serializeRoutine — полный файл для CREATE.
// ---------------------------------------------------------------------------

export function serializeRoutine(routine: Routine): string {
  const lines: string[] = [];
  const scalar = (key: string, v: string): void => {
    lines.push(`${key}: ${serializeScalar(v)}`);
  };
  const raw = (key: string, v: string): void => {
    lines.push(`${key}: ${v}`);
  };

  scalar('id', routine.id);
  scalar('projectId', routine.projectId);
  if (routine.departmentId !== undefined) scalar('departmentId', routine.departmentId);
  if (routine.targetProject !== undefined) scalar('targetProject', routine.targetProject);
  raw('enabled', String(routine.enabled));
  scalar('trigger', routine.trigger);
  raw('tools', serializeArray(routine.tools));
  scalar('model', routine.model);
  raw('maxTokens', String(routine.maxTokens));
  raw('timeoutMs', String(routine.timeoutMs));
  scalar('outputType', routine.outputType);
  scalar('description', routine.description);
  if (routine.role !== undefined) scalar('role', routine.role);
  if (routine.avatar !== undefined) scalar('avatar', routine.avatar);
  if (routine.color !== undefined) scalar('color', routine.color);
  if (routine.logo !== undefined) scalar('logo', routine.logo);
  if (routine.bashWhitelist !== undefined)
    raw('bashWhitelist', serializeArray(routine.bashWhitelist));
  if (routine.skills !== undefined) raw('skills', serializeArray(routine.skills));
  if (routine.forceLoad !== undefined) raw('forceLoad', serializeArray(routine.forceLoad));

  const body = routine.prompt.replace(/\s+$/, '');
  return `${FRONTMATTER_DELIM}\n${lines.join('\n')}\n${FRONTMATTER_DELIM}\n\n${body}\n`;
}

// ---------------------------------------------------------------------------
// applyRoutinePatch — хирургическое редактирование с сохранением комментариев.
// ---------------------------------------------------------------------------

export class RoutineSerializeError extends Error {
  constructor(message: string) {
    super(`routine serialize: ${message}`);
    this.name = 'RoutineSerializeError';
  }
}

export function applyRoutinePatch(source: string, patch: RoutinePatch): string {
  const lines = source.split('\n');
  if (lines[0]?.trim() !== FRONTMATTER_DELIM) {
    throw new RoutineSerializeError("файл должен начинаться с '---'.");
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FRONTMATTER_DELIM) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new RoutineSerializeError("не найден закрывающий '---' frontmatter'а.");
  }

  const fmLines = lines.slice(1, endIdx);
  const bodyLines = lines.slice(endIdx + 1);

  // Собираем редактирования frontmatter: key -> новая строка | null (удалить).
  const edits: Array<{ key: string; line: string | null }> = [];
  const setScalar = (key: string, v: string | null | undefined): void => {
    if (v === undefined) return;
    edits.push({ key, line: v === null ? null : `${key}: ${serializeScalar(v)}` });
  };
  const setArray = (key: string, v: string[] | null | undefined): void => {
    if (v === undefined) return;
    edits.push({ key, line: v === null ? null : `${key}: ${serializeArray(v)}` });
  };
  const setRaw = (key: string, v: string | number | boolean | undefined): void => {
    if (v === undefined) return;
    edits.push({ key, line: `${key}: ${String(v)}` });
  };

  setRaw('enabled', patch.enabled);
  if (patch.trigger !== undefined)
    edits.push({ key: 'trigger', line: `trigger: ${serializeScalar(patch.trigger)}` });
  setArray('tools', patch.tools);
  if (patch.model !== undefined)
    edits.push({ key: 'model', line: `model: ${serializeScalar(patch.model)}` });
  setRaw('maxTokens', patch.maxTokens);
  setRaw('timeoutMs', patch.timeoutMs);
  if (patch.outputType !== undefined)
    edits.push({ key: 'outputType', line: `outputType: ${serializeScalar(patch.outputType)}` });
  if (patch.description !== undefined)
    edits.push({ key: 'description', line: `description: ${serializeScalar(patch.description)}` });
  setScalar('role', patch.role);
  setScalar('avatar', patch.avatar);
  setScalar('color', patch.color);
  setScalar('logo', patch.logo);
  setScalar('departmentId', patch.departmentId);
  setScalar('targetProject', patch.targetProject);
  setArray('bashWhitelist', patch.bashWhitelist);
  setArray('skills', patch.skills);
  setArray('forceLoad', patch.forceLoad);

  for (const { key, line } of edits) {
    const idx = fmLines.findIndex((l) => {
      const m = KEY_RE.exec(l);
      return m !== null && m[1] === key;
    });
    if (idx >= 0) {
      if (line === null) fmLines.splice(idx, 1);
      else fmLines[idx] = line;
    } else if (line !== null) {
      // Нового поля во frontmatter нет — добавляем в конец блока.
      fmLines.push(line);
    }
  }

  if (patch.prompt !== undefined) {
    const body = patch.prompt.replace(/\s+$/, '');
    return `${FRONTMATTER_DELIM}\n${fmLines.join('\n')}\n${FRONTMATTER_DELIM}\n\n${body}\n`;
  }
  // prompt не трогаем — body байт-в-байт (включая внутренние пустые строки).
  return [FRONTMATTER_DELIM, ...fmLines, FRONTMATTER_DELIM, ...bodyLines].join('\n');
}
