// Render routine output → TelegramMessage[] (фаза 3.3).
//
// Логика:
//   1. Ищет шаблон `src/report/templates/${routine.id}.md`. Если существует —
//      подставляет плейсхолдеры: {{output}}, {{status}}, {{usd}}, {{durationMs}},
//      {{durationHuman}}, {{description}}, {{routineId}}.
//   2. Если шаблона нет — использует дефолтный шаблон (hardcoded fallback,
//      аналогичный default.md).
//   3. Если итоговый текст > 4096 символов → split на части ≤ 4096.
//      Split сначала по двойному переносу строки (абзацы), при необходимости
//      по одиночным строкам.
//   4. Каждая часть → один TelegramMessage.
//
// НЕ зависит от I/O напрямую: файловый ридер инжектируется через deps (DI).
// В тестах — мок без реального fs.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Контракт.
// ---------------------------------------------------------------------------

export interface TelegramMessage {
  text: string; // plain text или Markdown
}

export interface RenderRoutineInput {
  id: string;
  description: string;
  outputType: string;
}

export interface RenderResultInput {
  status: string;
  output: string;
  totalUsd: number;
  durationMs: number;
}

export interface RenderRoutineDeps {
  /** Читает шаблон по абсолютному пути. Выбрасывает если файл не существует. */
  readTemplate?: (path: string) => Promise<string>;
  /** Базовая директория для поиска шаблонов (по умолчанию — cwd + src/report/templates). */
  templatesDir?: string;
}

// ---------------------------------------------------------------------------
// Константы.
// ---------------------------------------------------------------------------

const TELEGRAM_MAX_LEN = 4096;

// Дефолтный шаблон (используется, если нет ни routine-специфичного, ни default.md).
// Используем конкатенацию строк, чтобы {{...}} не воспринимались как template literals.
const DEFAULT_TEMPLATE =
  '🤖 *{{description}}* завершён\n' +
  'Статус: {{status}} · ${{usd}} · {{durationMs}}ms\n' +
  '\n' +
  '{{output}}';

// ---------------------------------------------------------------------------
// Публичный API.
// ---------------------------------------------------------------------------

/**
 * renderRoutineOutput — форматирует результат routine в TelegramMessage[].
 *
 * Если текст > 4096 символов — возвращает несколько сообщений (split).
 */
export async function renderRoutineOutput(
  routine: RenderRoutineInput,
  result: RenderResultInput,
  deps: RenderRoutineDeps = {},
): Promise<TelegramMessage[]> {
  const reader = deps.readTemplate ?? defaultReadTemplate;
  const templatesDir = deps.templatesDir ?? resolve(process.cwd(), 'src', 'report', 'templates');

  // Порядок lookup'а: agents/<id>/report.md → templates/<id>.md → default.md → hardcoded.
  let template: string | null = null;

  // 0. Agent-специфичный шаблон: agents/<id>/report.md (живёт в cwd агента, не в
  //    templatesDir). Так per-agent report едет в самой папке агента.
  const agentReportPath = resolve(process.cwd(), 'agents', routine.id, 'report.md');
  try {
    template = await reader(agentReportPath);
  } catch {
    // Нет agent-шаблона — пробуем templates/<id>.md.
  }

  // 1. Routine-специфичный шаблон: <routineId>.md
  if (template === null) {
    const routineTemplatePath = resolve(templatesDir, `${routine.id}.md`);
    try {
      template = await reader(routineTemplatePath);
    } catch {
      // Не существует — пробуем default.md.
    }
  }

  // 2. default.md
  if (template === null) {
    const defaultPath = resolve(templatesDir, 'default.md');
    try {
      template = await reader(defaultPath);
    } catch {
      // Нет и default.md — используем hardcoded fallback.
    }
  }

  // 3. Hardcoded fallback.
  if (template === null) {
    template = DEFAULT_TEMPLATE;
  }

  // Подставляем плейсхолдеры.
  const usdFormatted = result.totalUsd.toFixed(4);
  // Post-process output: убираем литеральные ``` (codefence), которые могли
  // прилететь из агентского message'а — внутри codeblock'а Telegram не
  // делает URL'ы кликабельными (прецедент 2026-05-22, marketing-content-example).
  // Также убираем `_` экранирование рядом с `*` чтобы не ломать Markdown parser.
  const cleanedOutput = stripCodeFences(result.output);
  const text = template
    .replaceAll('{{output}}', cleanedOutput)
    .replaceAll('{{status}}', result.status)
    .replaceAll('{{usd}}', usdFormatted)
    .replaceAll('{{durationMs}}', String(result.durationMs))
    .replaceAll('{{durationHuman}}', formatDurationHuman(result.durationMs))
    .replaceAll('{{description}}', routine.description)
    .replaceAll('{{routineId}}', routine.id);

  // Split по лимиту Telegram.
  const parts = splitForTelegram(text, TELEGRAM_MAX_LEN);
  return parts.map((part) => ({ text: part }));
}

/**
 * formatDurationHuman — миллисекунды → «47 мин» / «1 ч 12 мин» / «32 с».
 * Округляем до минут от 1 минуты и выше; ниже минуты — секунды.
 */
export function formatDurationHuman(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 с';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} с`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} мин`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} ч` : `${hours} ч ${minutes} мин`;
}

/**
 * stripCodeFences — убирает обрамляющие ```...``` если output полностью
 * завёрнут в один codeblock. Это спасает Telegram Markdown от случая,
 * когда агент буквально пишет ``` вокруг финального блока — Telegram
 * рендерит весь блок как monospace и URL'ы внутри становятся
 * некликабельными. Прецедент: 2026-05-22, routine marketing-content-example.
 *
 * Логика:
 *   1. Если output начинается с ```...\n и заканчивается на \n```... — снимаем оба.
 *   2. Иначе возвращаем как есть (внутренние codeblock'и не трогаем).
 */
export function stripCodeFences(output: string): string {
  const trimmed = output.trim();
  // Открывающий ``` (опционально с языком) + перенос строки. Закрывающий ``` в конце.
  const fenceOpenRe = /^```[a-z0-9]*\n/i;
  const fenceCloseRe = /\n```$/;
  if (fenceOpenRe.test(trimmed) && fenceCloseRe.test(trimmed)) {
    return trimmed.replace(fenceOpenRe, '').replace(fenceCloseRe, '');
  }
  return output;
}

/**
 * splitForTelegram — делит текст на части ≤ maxLen символов.
 *
 * Алгоритм:
 *   1. Делим по двойному переносу строки (абзацы).
 *   2. Если один абзац > maxLen — делим по одиночным строкам.
 *   3. Если одна строка > maxLen — режем жёстко по maxLen.
 *   4. Собираем части: добавляем фрагменты пока не превышаем maxLen.
 */
export function splitForTelegram(text: string, maxLen: number = TELEGRAM_MAX_LEN): string[] {
  if (text.length <= maxLen) return [text];

  // Разбиваем на абзацы.
  const paragraphs = text.split(/\n\n/);

  // Разворачиваем каждый абзац в минимальные чанки ≤ maxLen.
  const chunks: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxLen) {
      chunks.push(paragraph);
    } else {
      // Абзац слишком длинный — делим по строкам.
      const lines = paragraph.split('\n');
      for (const line of lines) {
        if (line.length <= maxLen) {
          chunks.push(line);
        } else {
          // Строка тоже слишком длинная — режем жёстко.
          let remaining = line;
          while (remaining.length > maxLen) {
            chunks.push(remaining.slice(0, maxLen));
            remaining = remaining.slice(maxLen);
          }
          if (remaining.length > 0) chunks.push(remaining);
        }
      }
    }
  }

  // Собираем части: жадно добавляем чанки пока не превышаем maxLen.
  const parts: string[] = [];
  let current = '';
  for (const chunk of chunks) {
    const separator = current.length === 0 ? '' : '\n\n';
    const candidate = current + separator + chunk;
    if (candidate.length <= maxLen) {
      current = candidate;
    } else {
      if (current.length > 0) parts.push(current);
      current = chunk;
    }
  }
  if (current.length > 0) parts.push(current);

  return parts.length > 0 ? parts : [text.slice(0, maxLen)];
}

// ---------------------------------------------------------------------------
// DI-defaults.
// ---------------------------------------------------------------------------

async function defaultReadTemplate(path: string): Promise<string> {
  return readFile(path, 'utf8');
}
