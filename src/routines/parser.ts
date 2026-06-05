// Routine parser — единственная точка чтения файла `routines/<id>.md`.
//
// Контракт фазы 1.2:
//   * `parseRoutineFile(path)` — читает файл, парсит frontmatter (минимальный
//     YAML-подмножество) + body (markdown промт), валидирует обязательные
//     поля. На ошибку — `RoutineParseError` с указанием файла и поля.
//   * `Routine` — стабильный тип-контракт для 1.3 (dispatcher) и далее.
//
// Почему свой YAML-парсер, а не `gray-matter`:
//   * Формат фиксирован и узок: scalar (string|number|boolean) и flow-array
//     `[a, b, c]` или `[]` для `tools`. Никаких nested mapping, anchors,
//     multiline-strings — нечего разруливать.
//   * Зависимость меньше: согласовано с принципом `src/lib/page-sections.ts`
//     (свой узкий парсер для известного формата). Если позже формат
//     понадобится расширить — переходим на `gray-matter` ровно один раз.
//   * Ошибки — на нашем языке (не «yaml syntax error at line 4 col 12»,
//     а «routine 'X': поле tools должно быть массивом строк»).
//
// Cron-валидация — через `cron-parser` (`CronExpressionParser.parse`).
// Lib небольшая, без зависимостей. На невалидной cron-строке — кидает,
// мы перехватываем и оборачиваем в `RoutineParseError`.

import { readFile } from 'node:fs/promises';
import { CronExpressionParser } from 'cron-parser';

export type RoutineOutputType = 'telegram-thread' | 'journal-only' | 'both';

export interface Routine {
  id: string;
  projectId: string;
  enabled: boolean;
  trigger: 'manual' | string; // string = cron expression (5 или 6 полей)
  tools: string[];
  model: string;
  maxTokens: number;
  timeoutMs: number;
  outputType: RoutineOutputType;
  description: string;
  prompt: string; // body
  filePath: string; // абсолютный путь к routine-файлу
  // ── Опциональные UI-поля (план 2026-05-17 «3D-офис»). Не валидируются строго:
  // если присутствуют в frontmatter — попадают сюда, иначе undefined. Существующие
  // routine-файлы без этих полей продолжают парситься без изменений.
  role?: string; // «Утренний детектив» — человекочитаемая роль для UI
  avatar?: string; // emoji (👮 / 🕵️ / 📊) — fallback-индикатор в офисе
  color?: string; // hex (#a8e063) или tailwind-имя (emerald-400) для подсветки
  // Путь к SVG/PNG лого, относительный к bridge/app/public/ (т.е. сервится Vite'ом
  // от root: '/logos/vc.svg'). Рендерится как круглый бейдж над сотрудником в офисе.
  // Если задан — приоритетнее avatar emoji.
  logo?: string;
  // Дополнительные Bash-prefix'ы, разрешённые ТОЛЬКО этому routine. Расширяет
  // DEFAULT_WHITELIST из src/tools/project-bash, не заменяет. Используется
  // для routines, которые имеют право на write-операции (например, маркетолог
  // вызывает `pnpm publish vc <draft>`). FORBIDDEN_SUBSTRINGS (pipe, redirect,
  // backtick, eval, &&, ||) применяются к расширенным командам так же —
  // расширение whitelist'а НЕ ослабляет инъекционные проверки.
  bashWhitelist?: string[];
  // Имена скиллов, которые routine «нанимает» (плановая интеграция Фазы 2
  // плана 2026-05-21-skills-architecture-v3). Опциональное поле во
  // frontmatter:
  //   skills: [vc-publishing, browser-control]
  // Runtime резолвит транзитивные deps через `resolveDeps`, инжектит
  // discovery layer (name+description, ~80 ток/скилл) в system prompt, и
  // объединяет permissions (bashWhitelist union, maxStepsPerInvocation min).
  // `undefined` означает «скиллы не объявлены» (legacy-routine). Пустой
  // массив [] — «явно не нанимаем скиллов» (для self-documenting routines).
  skills?: string[];
  // Имена скиллов, для которых нужно сразу инжектить body SKILL.md (full
  // instruction layer, не только discovery). Используется когда routine
  // ЗАВЕДОМО будет использовать скилл — экономит circle round-trip между
  // агентом и runtime'ом (LLM-managed disclosure появится позже).
  // Все имена обязаны входить в `skills` (или в их транзитивные deps) —
  // валидируется в runtime, не в parser'е.
  forceLoad?: string[];
  // id отдела (departments/<id>/), к которому относится routine. Используется
  // department-level бюджетом (Фаза 5 плана 2026-05-21-skills-architecture-v3,
  // п.8): pre-call guard в src/llm/budget.ts агрегирует spend всех routines с
  // тем же departmentId. Опциональное поле во frontmatter:
  //   departmentId: marketing-content
  // Если не задан — routine не привязана к отделу, dept-cap не применяется.
  departmentId?: string;
  // id целевого проекта из config/projects.md, в чьём cwd надо запустить
  // `claude -p` в bypassPermissions-режиме. Если задан — routine исполняется
  // как «unattended cross-project worker»: HQ не строит свой systemPrompt и
  // не ограничивает tools, потому что в target project уже есть свой CLAUDE.md,
  // свои `.claude/skills/*` и свой `.claude/settings.json`. Контракт прост:
  // promt-фразой триггерим skill в чужом репо, спавненный `claude` сам
  // проходит свои этапы (включая sub-agents, браузер, прод-деплой), мы
  // ловим NDJSON-стрим и финал.
  //
  //   targetProject: example-project
  //
  // Резолвится в runtime через src/projects/registry.getProject. Если
  // проект не найден или disabled — executeRoutine throw'ит, dispatcher
  // ловит и пишет audit.routine.end status='failed'.
  //
  // Совместимо с departmentId: routine может «лежать» в отделе
  // marketing-content, но «исполняться» в проекте example-project.
  targetProject?: string;
  // ── Поля, заполняемые ТОЛЬКО agent-loader'ом (agents/<id>/). Legacy
  // routines/*.md их не выставляют (остаются undefined). См.
  // src/routines/agent-loader.ts.
  /** Содержимое agents/<id>/rules.md (если файл есть). Инжектится как
   *  `## Guardrails` секция в buildSystemPrompt. */
  rules?: string;
  /** Имена секретов из permissions.yml `secrets:` — Keychain-allowlist.
   *  При cross-project syncEnv синкаются только эти ключи (см. runtime). */
  secrets?: string[];
  /** Абсолютный cwd целевого проекта из agents/<id>/target.yml (cwd:).
   *  Если задан — cross-project unattended-режим (аналог targetProject). */
  targetCwd?: string;
  /** skills: из target.yml — какие skills агента разрешено тащить в чужой
   *  репо при cross-project запуске. */
  allowedTargetSkills?: string[];
  /** Имена env-ключей из target.yml `syncEnv:` — синкаются в <cwd>/.env.local
   *  перед cross-project спавном. Пересекается с `secrets` (allowlist). */
  syncEnv?: string[];
  /** Абсолютный путь к agents/<id>/report.md (первый lookup для рендера). */
  reportTemplatePath?: string;
  /** Абсолютный путь к самой папке agents/<id>/. */
  agentDir?: string;
  /** Версия СХЕМЫ AGENT.md (agent-loader, не VERSION движка). Отсутствие в
   *  файле = текущая версия движка. Агент с версией НОВЕЕ движка отвергается
   *  на parse-time (forward-compat: «обнови движок»). См. agent-loader.ts. */
  schemaVersion?: string;
}

export class RoutineParseError extends Error {
  constructor(filePath: string, message: string) {
    super(`routine ${filePath}: ${message}`);
    this.name = 'RoutineParseError';
  }
}

const VALID_OUTPUT_TYPES = new Set<RoutineOutputType>(['telegram-thread', 'journal-only', 'both']);

// `model` — формат `claude-*` либо `voyage-*`. Не проверяем, что модель
// реально существует у Anthropic / Voyage — это runtime-задача `src/llm/call.ts`.
const VALID_MODEL_PREFIX_RE = /^(claude|voyage)-[a-z0-9.-]+$/i;

const REQUIRED_SCALAR_FIELDS = [
  'id',
  'projectId',
  'enabled',
  'trigger',
  'model',
  'maxTokens',
  'timeoutMs',
  'outputType',
  'description',
] as const;

// ---------------------------------------------------------------------------
// Frontmatter parser. Принимает текст между двумя `---`, возвращает Map.
// Поддерживает:
//   key: value           — scalar (string)
//   key: 123             — number (передаём строкой, валидация выше)
//   key: true / false    — boolean (передаём строкой)
//   key: [a, b, "c d"]   — flow-array
// Не поддерживает: nested mapping, multiline, anchors, типы JSON-литералов
// (null/~). Если фаундеру понадобится — переходим на `gray-matter`.
// ---------------------------------------------------------------------------

interface ParsedFrontmatter {
  scalars: Map<string, string>;
  arrays: Map<string, string[]>;
}

const KEY_VALUE_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/;

function parseFrontmatter(filePath: string, raw: string): ParsedFrontmatter {
  const scalars = new Map<string, string>();
  const arrays = new Map<string, string[]>();

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const m = KEY_VALUE_RE.exec(line);
    if (m === null || m[1] === undefined || m[2] === undefined) {
      throw new RoutineParseError(
        filePath,
        `frontmatter line ${i + 1}: ожидалось 'ключ: значение', получено '${line}'.`,
      );
    }
    const key = m[1];
    const value = m[2].trim();

    if (value.startsWith('[') && value.endsWith(']')) {
      arrays.set(key, parseFlowArray(filePath, key, value));
    } else {
      scalars.set(key, stripQuotes(value));
    }
  }
  return { scalars, arrays };
}

// `[a, b, "c d"]` или `[]` → string[]. Toleratesпустую запись и кавычки.
function parseFlowArray(filePath: string, key: string, raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];
  // Простой split по запятым; кавычки внутри элементов не должны содержать
  // запятых — это документировано в формате.
  const parts = inner.split(',').map((s) => s.trim());
  return parts.map((p) => {
    const cleaned = stripQuotes(p);
    if (cleaned.includes(',') || cleaned.includes('[') || cleaned.includes(']')) {
      throw new RoutineParseError(
        filePath,
        `frontmatter поле '${key}': массив должен содержать простые строки без вложенных запятых/скобок.`,
      );
    }
    return cleaned;
  });
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Frontmatter + body splitter. Файл должен начинаться с `---\n`, потом
// frontmatter, потом `\n---\n`, потом body.
// ---------------------------------------------------------------------------

const FRONTMATTER_DELIM = '---';

function splitFrontmatterAndBody(
  filePath: string,
  source: string,
): { frontmatter: string; body: string } {
  const lines = source.split('\n');
  if (lines[0]?.trim() !== FRONTMATTER_DELIM) {
    throw new RoutineParseError(
      filePath,
      "файл должен начинаться с '---' (frontmatter delimiter).",
    );
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FRONTMATTER_DELIM) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new RoutineParseError(filePath, "не найден закрывающий '---' frontmatter'а.");
  }
  const frontmatter = lines.slice(1, endIdx).join('\n');
  const body = lines
    .slice(endIdx + 1)
    .join('\n')
    .trim();
  return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// Валидация полей.
// ---------------------------------------------------------------------------

function requireScalar(filePath: string, scalars: Map<string, string>, key: string): string {
  const v = scalars.get(key);
  if (v === undefined || v === '') {
    throw new RoutineParseError(filePath, `frontmatter не содержит обязательное поле '${key}'.`);
  }
  return v;
}

export function parseBool(filePath: string, raw: string, key: string): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new RoutineParseError(
    filePath,
    `поле '${key}' должно быть 'true' или 'false', получено '${raw}'.`,
  );
}

export function parsePosInt(filePath: string, raw: string, key: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== raw) {
    throw new RoutineParseError(
      filePath,
      `поле '${key}' должно быть положительным целым числом, получено '${raw}'.`,
    );
  }
  return n;
}

export function validateTrigger(filePath: string, raw: string): 'manual' | string {
  if (raw === 'manual') return 'manual';
  // cron expression — 5 или 6 полей. CronExpressionParser принимает оба.
  // Несколько слотов: ';'-separated, например '35 10 * * *; 47 16 * * *' —
  // нужно, когда декартово произведение полей не подходит (произвольные пары
  // часов и минут). Каждое выражение валидируется отдельно.
  const parts = raw
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (parts.length === 0) {
    throw new RoutineParseError(filePath, `поле 'trigger' пустое после разбора '${raw}'.`);
  }
  for (const part of parts) {
    try {
      CronExpressionParser.parse(part);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RoutineParseError(
        filePath,
        `поле 'trigger' должно быть 'manual' или валидным cron-expression (можно несколько через ';'), некорректное выражение '${part}'. Ошибка cron-parser: ${message}.`,
      );
    }
  }
  return raw;
}

export function validateOutputType(filePath: string, raw: string): RoutineOutputType {
  if (!VALID_OUTPUT_TYPES.has(raw as RoutineOutputType)) {
    throw new RoutineParseError(
      filePath,
      `поле 'outputType' должно быть одним из: ${[...VALID_OUTPUT_TYPES].join(', ')}, получено '${raw}'.`,
    );
  }
  return raw as RoutineOutputType;
}

export function validateModel(filePath: string, raw: string): string {
  if (!VALID_MODEL_PREFIX_RE.test(raw)) {
    throw new RoutineParseError(
      filePath,
      `поле 'model' должно начинаться с 'claude-' или 'voyage-' (формат '<provider>-<name>'), получено '${raw}'.`,
    );
  }
  return raw;
}

function validateTools(filePath: string, arrays: Map<string, string[]>): string[] {
  // tools — обязательное поле, но может быть пустым массивом.
  if (!arrays.has('tools')) {
    throw new RoutineParseError(
      filePath,
      "frontmatter не содержит обязательное поле 'tools' (массив строк, может быть пустым).",
    );
  }
  const tools = arrays.get('tools') ?? [];
  for (const t of tools) {
    if (t === '' || /\s/.test(t)) {
      throw new RoutineParseError(
        filePath,
        `поле 'tools': имя tool '${t}' не может быть пустым или содержать пробелы.`,
      );
    }
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export interface ParseRoutineOptions {
  // DI для тестов: заменить чтение с диска.
  read?: (path: string) => Promise<string>;
}

export async function parseRoutineFile(
  filePath: string,
  options: ParseRoutineOptions = {},
): Promise<Routine> {
  const read = options.read ?? ((p) => readFile(p, 'utf8'));
  const source = await read(filePath);
  return parseRoutineSource(filePath, source);
}

// Экспортируется отдельно для unit-тестов парсера (без I/O).
export function parseRoutineSource(filePath: string, source: string): Routine {
  const { frontmatter, body } = splitFrontmatterAndBody(filePath, source);
  const { scalars, arrays } = parseFrontmatter(filePath, frontmatter);

  // Сначала проверяем обязательные scalar-поля по списку. tools — особый
  // случай (массив, проверяется отдельно).
  for (const f of REQUIRED_SCALAR_FIELDS) {
    requireScalar(filePath, scalars, f);
  }

  const id = requireScalar(filePath, scalars, 'id');
  const projectId = requireScalar(filePath, scalars, 'projectId');
  const enabled = parseBool(filePath, requireScalar(filePath, scalars, 'enabled'), 'enabled');
  const trigger = validateTrigger(filePath, requireScalar(filePath, scalars, 'trigger'));
  const tools = validateTools(filePath, arrays);
  const model = validateModel(filePath, requireScalar(filePath, scalars, 'model'));
  const maxTokens = parsePosInt(
    filePath,
    requireScalar(filePath, scalars, 'maxTokens'),
    'maxTokens',
  );
  const timeoutMs = parsePosInt(
    filePath,
    requireScalar(filePath, scalars, 'timeoutMs'),
    'timeoutMs',
  );
  const outputType = validateOutputType(filePath, requireScalar(filePath, scalars, 'outputType'));
  const description = requireScalar(filePath, scalars, 'description');

  if (body.length === 0) {
    throw new RoutineParseError(
      filePath,
      'body (промт) не должен быть пустым. Опиши, что routine должна сделать.',
    );
  }

  // ── Опциональные UI-поля. Не обязательны, не валидируются строго: парсим
  // как scalar строки, если фаундер положил их в frontmatter. Пустую строку
  // («color: ») трактуем как отсутствие.
  const optionalScalar = (key: string): string | undefined => {
    const v = scalars.get(key);
    if (v === undefined) return undefined;
    const trimmed = v.trim();
    return trimmed === '' ? undefined : trimmed;
  };

  const role = optionalScalar('role');
  const avatar = optionalScalar('avatar');
  const color = optionalScalar('color');
  const logo = optionalScalar('logo');
  // bashWhitelist — необязательный массив prefix'ов. Если фаундер положил —
  // валидируем что не пустые строки. Запретные substring'и НЕ проверяем здесь:
  // это runtime-задача `canRunCommand` (whitelist расширяет набор префиксов,
  // но инъекционные паттерны блокируются всегда).
  const bashWhitelistRaw = arrays.get('bashWhitelist');
  let bashWhitelist: string[] | undefined;
  if (bashWhitelistRaw !== undefined) {
    for (const w of bashWhitelistRaw) {
      if (w === '' || w.trim() !== w) {
        throw new RoutineParseError(
          filePath,
          `поле 'bashWhitelist': prefix '${w}' не может быть пустым или содержать leading/trailing пробелы.`,
        );
      }
    }
    bashWhitelist = bashWhitelistRaw;
  }

  // skills / forceLoad — flow-array of strings (kebab-case имена скиллов).
  // Различаем «не задано» (undefined) и «явно пусто» ([]). Имена не
  // валидируем строго на kebab-case здесь — это сделает skills/parser.ts
  // при попытке резолва. Здесь — только smoke-check на пустые элементы.
  const validateNameArray = (key: string, raw: string[]): string[] => {
    for (const s of raw) {
      if (s === '' || /\s/.test(s)) {
        throw new RoutineParseError(
          filePath,
          `поле '${key}': имя '${s}' не может быть пустым или содержать пробелы.`,
        );
      }
    }
    return raw;
  };
  const skillsRaw = arrays.get('skills');
  const skills = skillsRaw === undefined ? undefined : validateNameArray('skills', skillsRaw);

  const forceLoadRaw = arrays.get('forceLoad');
  const forceLoad =
    forceLoadRaw === undefined ? undefined : validateNameArray('forceLoad', forceLoadRaw);

  const departmentId = optionalScalar('departmentId');
  const targetProject = optionalScalar('targetProject');

  return {
    id,
    projectId,
    enabled,
    trigger,
    tools,
    model,
    maxTokens,
    timeoutMs,
    outputType,
    description,
    prompt: body,
    filePath,
    ...(role !== undefined ? { role } : {}),
    ...(avatar !== undefined ? { avatar } : {}),
    ...(color !== undefined ? { color } : {}),
    ...(logo !== undefined ? { logo } : {}),
    ...(bashWhitelist !== undefined ? { bashWhitelist } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(forceLoad !== undefined ? { forceLoad } : {}),
    ...(departmentId !== undefined ? { departmentId } : {}),
    ...(targetProject !== undefined ? { targetProject } : {}),
  };
}
