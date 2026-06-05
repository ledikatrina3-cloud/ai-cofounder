// cron.ts — генератор launchd plist'ов из routine.trigger (фаза 1.4).
//
// Два публичных экспорта:
//   * `cronToStartCalendarInterval(expr)` — конвертирует cron-expression в
//     launchd StartCalendarInterval (dict или array of dicts). Картезианское
//     произведение специфичных полей.
//   * `generateRoutinePlistXml(routine, paths)` — генерирует plist XML для
//     routines с cron-trigger. Throws если trigger === 'manual'.
//
// cron-parser v5 API:
//   * `CronExpressionParser.parse(expr)` — парсим.
//   * `parsed.fields.minute.values` — getter, возвращает number[].
//   * Полный wildcard (`*`): minute.values.length=60, hour=24,
//     dayOfMonth=31, month=12, dayOfWeek=8 (Sunday=0 и Sunday=7,
//     т.е. 0–7 включительно).
//   * dayOfWeek нормализуем через `v % 7` (7→0) и убираем дубли через Set.
//
// Launchd StartCalendarInterval:
//   * Один dict   → `<key>StartCalendarInterval</key>\n<dict>...</dict>`
//   * Массив dict → `<key>StartCalendarInterval</key>\n<array>\n  <dict>...</dict>...\n</array>`
//   * Пустой dict (из `* * * * *`) → каждую минуту.
//
// Принципы CLAUDE.md:
//   * Не хардкодить динамику (пути, имена бинарей).
//   * Удалять одноразовый код.

import { CronExpressionParser } from 'cron-parser';
import type { Routine } from './parser.js';

// ---------------------------------------------------------------------------
// cronToStartCalendarInterval
// ---------------------------------------------------------------------------

// Максимальные размеры полей cron (если length === max — поле "all", не специфично).
const FIELD_MAXES = {
  minute: 60,
  hour: 24,
  dayOfMonth: 31,
  month: 12,
  dayOfWeek: 8,
} as const;

// Соответствие полей cron-parser → ключи launchd.
const FIELD_TO_LAUNCHD_KEY = {
  minute: 'Minute',
  hour: 'Hour',
  dayOfMonth: 'Day',
  month: 'Month',
  dayOfWeek: 'Weekday',
} as const;

type FieldName = keyof typeof FIELD_MAXES;

/**
 * Конвертирует cron-expression в launchd StartCalendarInterval.
 *
 * Поддерживает ';'-разделённые выражения для произвольных пар (час, минута),
 * которые не выражаются одним cron-выражением без декартового произведения
 * (например, "10:35; 16:47; 20:15" — три слота, не 9).
 *
 * Возвращает:
 *   - `{}` если все поля любого из выражений — wildcard → launchd = каждую минуту.
 *   - `Record<string, number>` если итоговая одна комбинация.
 *   - `Record<string, number>[]` если несколько (объединение по всем выражениям).
 */
export function cronToStartCalendarInterval(
  expr: string,
): Record<string, number> | Record<string, number>[] {
  const parts = expr
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (parts.length === 0) {
    throw new Error(`cronToStartCalendarInterval: пустое выражение '${expr}'.`);
  }

  const dicts: Record<string, number>[] = [];
  for (const part of parts) {
    const single = singleCronToDicts(part);
    if (Array.isArray(single)) {
      dicts.push(...single);
    } else if (Object.keys(single).length === 0) {
      // Любой wildcard ⇒ каждую минуту, поглощает остальные слоты.
      return {};
    } else {
      dicts.push(single);
    }
  }

  if (dicts.length === 1) return dicts[0] as Record<string, number>;
  return dicts;
}

function singleCronToDicts(expr: string): Record<string, number> | Record<string, number>[] {
  const parsed = CronExpressionParser.parse(expr);

  // Собираем специфичные поля: те, у которых length < max.
  const specificFields: { key: string; values: number[] }[] = [];

  for (const field of Object.keys(FIELD_MAXES) as FieldName[]) {
    const max = FIELD_MAXES[field];
    let values: number[] = parsed.fields[field].values as number[];

    // dayOfWeek: нормализуем 7→0 и убираем дубли.
    if (field === 'dayOfWeek') {
      const normalized = new Set(values.map((v) => v % 7));
      values = [...normalized].sort((a, b) => a - b);
      // После нормализации проверяем специфичность: если в values только {0}
      // (т.е. и 0, и 7 были в исходном массиве), это ещё может быть конкретным.
      // Но если после дедупа всё равно 7 уникальных значений (0–6) — это "all".
      // Мы используем размер нормализованного Set: если normalized.size < 7 — специфично.
      if (normalized.size >= 7) continue;
    } else if (values.length >= max) {
      // Поле охватывает все возможные значения — не включаем.
      continue;
    }

    const launchdKey = FIELD_TO_LAUNCHD_KEY[field];
    specificFields.push({ key: launchdKey, values });
  }

  // Если нет специфичных полей — возвращаем пустой dict.
  if (specificFields.length === 0) {
    return {};
  }

  // Картезианское произведение всех специфичных полей.
  // Каждая комбинация — один dict { Minute: ..., Hour: ..., ... }.
  let combinations: Record<string, number>[] = [{}];

  for (const { key, values } of specificFields) {
    const nextCombinations: Record<string, number>[] = [];
    for (const combo of combinations) {
      for (const v of values) {
        nextCombinations.push({ ...combo, [key]: v });
      }
    }
    combinations = nextCombinations;
  }

  if (combinations.length === 1) {
    return combinations[0] as Record<string, number>;
  }

  return combinations;
}

// ---------------------------------------------------------------------------
// generateRoutinePlistXml
// ---------------------------------------------------------------------------

export interface PlistPaths {
  // Абсолютный путь к node (вне ~/Documents — критично под macOS TCC). launchd
  // не может exec'ить sh-скрипты из ~/Documents ("Operation not permitted"),
  // но Mach-O бинарь node за пределами Documents запускается без проблем,
  // а потом сам открывает .ts/.mjs внутри Documents через стандартный file IO.
  node: string;
  // Абсолютный путь к tsx CLI entry (cli.mjs внутри node_modules/.pnpm/tsx@*).
  // Минует sh-обёртку tsx и pnpm:
  //  * pnpm 10.x + Node 25 под launchd воспроизводимо падает EINTR в uv_cwd
  //    (баг get-source/stacktracey, .err пустой .log).
  //  * sh-обёртка tsx под launchd ловит TCC "Operation not permitted" при
  //    попытке kernel-shebang resolution для файла в ~/Documents.
  tsxCli: string;
  pathEnv: string;
  repoRoot: string;
}

/**
 * Генерирует строку plist XML для routine с cron-trigger.
 *
 * Throws если `routine.trigger === 'manual'`.
 */
export function generateRoutinePlistXml(routine: Routine, paths: PlistPaths): string {
  if (routine.trigger === 'manual') {
    throw new Error(
      `generateRoutinePlistXml: routine '${routine.id}' имеет trigger='manual'. launchd plist генерируется только для cron-routines.`,
    );
  }

  const label = `com.ai-cofounder.routine-${routine.id}`;
  const logBase = `${paths.repoRoot}/dist/launchd.routine-${routine.id}`;
  const startCalendarIntervalXml = renderStartCalendarInterval(
    cronToStartCalendarInterval(routine.trigger),
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${paths.node}</string>
        <string>${paths.tsxCli}</string>
        <string>scripts/cron-run-routine.ts</string>
        <string>${routine.id}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${paths.repoRoot}</string>

${startCalendarIntervalXml}
    <key>RunAtLoad</key>
    <false/>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${paths.pathEnv}</string>
    </dict>

    <key>StandardOutPath</key>
    <string>${logBase}.log</string>
    <key>StandardErrorPath</key>
    <string>${logBase}.err</string>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>`;
}

// ---------------------------------------------------------------------------
// XML-рендеринг StartCalendarInterval.
// ---------------------------------------------------------------------------

function renderDict(dict: Record<string, number>, indent: string): string {
  const lines: string[] = [`${indent}<dict>`];
  for (const [k, v] of Object.entries(dict)) {
    lines.push(`${indent}    <key>${k}</key>`);
    lines.push(`${indent}    <integer>${v}</integer>`);
  }
  lines.push(`${indent}</dict>`);
  return lines.join('\n');
}

function renderStartCalendarInterval(
  sci: Record<string, number> | Record<string, number>[],
): string {
  const base = '    '; // отступ под <dict> plist'а

  if (Array.isArray(sci)) {
    const dictLines = sci.map((d) => renderDict(d, `${base}    `)).join('\n');
    return `${base}<key>StartCalendarInterval</key>\n${base}<array>\n${dictLines}\n${base}</array>`;
  }

  // Single dict (включая пустой — каждую минуту).
  return `${base}<key>StartCalendarInterval</key>\n${renderDict(sci, base)}`;
}
