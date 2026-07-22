import { ulid } from 'ulid';

// EventTrigger — вход для runIteration. Каждый адаптер триггера
// (cron, telegram, ручной dev:tick) возвращает EventTrigger; runIteration
// сам пишет соответствующую Запись `event.trigger` с idempotencyKey
// (src/core/triggers.ts, src/core/loop.ts).
//
// Pivot 2026-05-01 (плана `routines.md`, фаза 1.3): рядом с EventTrigger
// (старый M2-pipeline) живёт RunRoutineTrigger — вход для нового dispatcher'а
// `runRoutine`. Старые `triggerCronMorning / triggerManual / triggerDevTick`
// сохраняются как-есть — через них работает deprecated wrapper `runIteration`
// и старые тесты (idempotency, runIteration-e2e). Новые
// `triggerCronRoutine / triggerManualRoutine` — для нового dispatcher'а.

export type TriggerSource = 'cron' | 'manual' | 'tg.callback' | 'tg.message';

export interface EventTrigger {
  source: TriggerSource;
  idempotencyKey: string;
  // Сырые данные адаптера для записи в Record.properties — например, cron-kind или ULID для manual.
  properties: Record<string, unknown>;
}

// RunRoutineTrigger — минимальный контракт для нового dispatcher'а
// `runRoutine` (фаза 1.3). source — только 'cron' | 'manual': для routines нет
// telegram-callback-входа (он приходит в M5'/approval).
//
// idempotencyKey:
//   * cron: `routine:<routineId>:<YYYY-MM-DD>` — ровно один проход на дату
//     для launchd-job'а (фаза 1.4). Повторный launchctl или ручной запуск с
//     тем же routineId в ту же дату → audit.repeat.
//   * manual: `routine:<routineId>:manual:<ULID>` — каждый /run или
//     `pnpm dev:run` уникален. ULID гарантирует строгое возрастание во времени
//     (полезно для логов), без дедупа.
export interface RunRoutineTrigger {
  source: 'cron' | 'manual';
  idempotencyKey: string;
}

// Cron 07:00 утренний детектив (src/core/triggers.ts:17,
// plans/ фаза 1.4).
// Ключ — локальная дата мака. Один проход на дату; повторный пуск
// (например, фаундер вручную поднял launchd job второй раз в тот же день)
// идёт в audit.repeat.
export function triggerCronMorning(now: Date = new Date()): EventTrigger {
  return {
    source: 'cron',
    idempotencyKey: `morning-detective:${localDateIso(now)}`,
    properties: { kind: 'cron.morning-detective', date: localDateIso(now) },
  };
}

// Telegram /run — заглушка до фазы 1.2. Контракт зафиксирован сейчас, чтобы
// 1.2 подключила grammy-handler без правок ядра. Каждый /run — новый ULID,
// без дедупа: фаундер хочет принудительный прогон сейчас.
export function triggerManual(): EventTrigger {
  const id = ulid();
  return {
    source: 'manual',
    idempotencyKey: `manual:${id}`,
    properties: { kind: 'manual', ulid: id },
  };
}

// Дев-тик: детерминированный ключ по дате локального времени мака.
// Повторный pnpm dev:tick в ту же дату даёт audit.repeat — это и есть
// критерий «сделано» из плана фазы 1.4.
export function triggerDevTick(now: Date = new Date()): EventTrigger {
  return {
    source: 'manual',
    idempotencyKey: `manual-tick:${localDateIso(now)}`,
    properties: { kind: 'dev-tick', date: localDateIso(now) },
  };
}

function localDateIso(now: Date): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Routine-триггеры (фаза 1.3 нового плана). Используются `runRoutine`
// (`src/core/dispatcher.ts`). Не пересекаются по namespace с EventTrigger:
// idempotencyKey префикс `routine:<id>:...`, а у EventTrigger —
// `morning-detective:`, `manual:`, `manual-tick:`. Глобальный UNIQUE поверх
// Record.idempotencyKey — общий, и пересечение допустимо только при коллизии
// префиксов; namespacing исключает её.
// ---------------------------------------------------------------------------

// Cron-trigger для конкретной routine. Ключ детерминирован по дате + HHMM
// локального времени мака — повторный launchd-tick в тот же слот → audit.repeat,
// но разные слоты одного дня (например, 10:35 / 16:47 / 20:15) идут как
// независимые прогоны. Раньше ключ был только по дате, что блокировало
// несколько cron-слотов в день для одной routine.
export function triggerCronRoutine(routineId: string, now: Date = new Date()): RunRoutineTrigger {
  return {
    source: 'cron',
    idempotencyKey: `routine:${routineId}:${localDateIso(now)}:${localHourMinute(now)}`,
  };
}

function localHourMinute(now: Date): string {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${hh}${mm}`;
}

// Manual-trigger для конкретной routine. Каждый вызов даёт свежий ULID —
// фаундер сознательно дёргает routine, два подряд /run должны идти как два
// прогона, не как audit.repeat.
export function triggerManualRoutine(routineId: string): RunRoutineTrigger {
  return {
    source: 'manual',
    idempotencyKey: `routine:${routineId}:manual:${ulid()}`,
  };
}
