// Pipeline-типы — контракт между parser, executor, state и recovery.
//
// Pipeline в плане 2026-05-21-skills-architecture-v3 — это граф нод, который
// описывает workflow отдела маркетинга (research → outline → approve →
// draft → seo + cover → adapt-vc + adapt-dzen → approve-publish → publish
// parallel → analytics).
//
// Контракты:
//   * `Pipeline` — корневой объект из `pipeline.yml`. Только `nodes[]` сейчас.
//   * `PipelineNode` — discriminated union по `kind`:
//     - 'employee' (вызов routine через runRoutine),
//     - 'human-gate' (Telegram approve/reject),
//     - 'parallel' (Promise.all нескольких employee-нод).
//   * `onFail`/`onTimeout` — policy, executor решает что делать при failure.
//
// `${date}` в путях output — НЕ резолвится в parser, оставляется как template
// для executor (он подставит runDate в формате YYYY-MM-DD).

export type OnFailAction = 'alert' | 'halt' | 'continue' | 'skip-pipeline';
export type OnTimeoutAction = 'skip-pipeline' | 'halt' | 'auto-approve';

/**
 * Политика обработки ошибок employee-ноды. Все поля опциональны:
 * - retries: число повторов перед фейлом (0 = без повторов).
 * - backoffMs: задержка между повторами в миллисекундах.
 * - then: что делать после исчерпания retries.
 *   * alert — Bridge event + Telegram, продолжаем pipeline.
 *   * halt — останавливаем pipeline (последующие ноды не запускаем).
 *   * continue — игнорим failure, продолжаем pipeline (нода в state как 'failed').
 *   * skip-pipeline — весь pipeline в failed (синоним halt с другим статусом).
 */
export interface OnFailPolicy {
  retries: number;
  backoffMs?: number;
  then: OnFailAction;
}

/**
 * Lookback для analytics-нод. Источник: `lookback: publish:24h` →
 * `{ source: 'publish', windowMs: 86_400_000 }`. Executor не использует
 * сейчас (это для аналитики в Фазе 6); парсер просто прокидывает структуру.
 */
export interface PipelineLookback {
  source: string;
  windowMs: number;
}

/**
 * Employee-нода: вызов routine через `runRoutine(employee, runDate, trigger)`.
 *
 * - `employee` — id routine (например, 'marketing-content-researcher').
 * - `inputs` — id нод-предков, чьи output'ы являются входом для этой ноды.
 * - `output` — путь к артефакту (с template `${date}` для executor'а).
 * - `model` — опциональный override модели (Sonnet/Haiku) для этой ноды.
 * - `schedule` — опциональный cron, если нода триггерится отдельно
 *   (например, analytics ежедневно в 8:00). Не используется executor'ом
 *   pipeline'а — это для отдельного launchd/cron.
 * - `timeoutMs` — общий timeout для одного запуска routine'ы (override
 *   routine.timeoutMs). Если не задан — берётся из routine-файла.
 * - `onFail` — policy при failure.
 */
export interface EmployeeNode {
  kind: 'employee';
  id: string;
  employee: string;
  inputs: string[];
  output: string;
  schedule?: string;
  model?: string;
  timeoutMs?: number;
  onTimeout?: OnTimeoutAction;
  onFail?: OnFailPolicy;
  lookback?: PipelineLookback;
}

/**
 * Human-gate нода: executor отправляет Telegram-сообщение с inline-кнопками
 * ✅/❌/✏️ и блокируется до ответа фаундера или timeout'а.
 *
 * - `via` — канал (только 'telegram' сейчас).
 * - `timeoutMs` — сколько ждать (например, 24h = 86_400_000).
 * - `onTimeout` — что делать при таймауте.
 * - `inputs` — id нод, чьи artifacts надо показать (превью в Telegram).
 */
export interface HumanGateNode {
  kind: 'human-gate';
  id: string;
  via: string;
  timeoutMs: number;
  onTimeout: OnTimeoutAction;
  inputs: string[];
}

/**
 * Parallel-нода: Promise.all нескольких employee-веток. Если любая ветка
 * упала с `then: halt` — отменяем остальные.
 *
 * - `branches` — массив employee-конфигов (без id, executor генерирует
 *   id ветки как `<parallel.id>:<index>`).
 */
export interface ParallelBranch {
  employee: string;
  input?: string; // одиночный input — упрощение для parallel-веток
  inputs?: string[];
  output?: string;
  model?: string;
  timeoutMs?: number;
  onFail?: OnFailPolicy;
}

export interface ParallelNode {
  kind: 'parallel';
  id: string;
  branches: ParallelBranch[];
  inputs: string[]; // объединённый список inputs всех веток (для toposort)
}

export type PipelineNode = EmployeeNode | HumanGateNode | ParallelNode;

export interface Pipeline {
  nodes: PipelineNode[];
}

/**
 * Парсит duration-строки '5m', '24h', '1d', '500ms', '3s' → миллисекунды.
 *
 * Поддерживаемые суффиксы: ms, s, m, h, d. Целые числа без суффикса трактуются
 * как миллисекунды. Невалидные значения — throw'аем с понятным сообщением.
 *
 * Экспортирована для переиспользования в parser, тестах и (в будущем)
 * launchd-генератора departments.
 */
export function parseDuration(raw: string, field?: string): number {
  const fieldLabel = field !== undefined ? ` поля '${field}'` : '';
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`pipeline:${fieldLabel} duration не должен быть пустым.`);
  }
  const trimmed = raw.trim();
  // ms — единственный двухсимвольный суффикс; смотрим первым.
  const msMatch = /^(\d+)ms$/.exec(trimmed);
  if (msMatch !== null && msMatch[1] !== undefined) return Number.parseInt(msMatch[1], 10);
  const m = /^(\d+)([smhd])$/.exec(trimmed);
  if (m === null || m[1] === undefined || m[2] === undefined) {
    // plain integer = ms.
    if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
    throw new Error(
      `pipeline:${fieldLabel} duration '${raw}' не распознан. Используй формат '5m', '24h', '1d', '500ms' или целое число (миллисекунды).`,
    );
  }
  const n = Number.parseInt(m[1], 10);
  const unit = m[2];
  switch (unit) {
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    case 'd':
      return n * 86_400_000;
    default:
      throw new Error(
        `pipeline:${fieldLabel} duration '${raw}': неподдерживаемая единица '${unit}'.`,
      );
  }
}
