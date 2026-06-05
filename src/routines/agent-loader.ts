// Agent-loader — парсит самодостаточную папку agents/<id>/ в Routine.
//
// Контракт (план OSS v1.0): агент — это ПАПКА, а не один .md. Внутри:
//   AGENT.md        — frontmatter (yaml) + body (краткое описание роли)         [required]
//   prompt.md       — полные инструкции агента (== тело legacy-routine)         [required]
//   permissions.yml — tools/bash/dbScopes/secrets/telegram/budget               [опц.]
//   target.yml      — cwd/host/skills/maxTurns/syncEnv (presence = cross-project) [опц.]
//   rules.md        — guardrails (инжектится как ## Guardrails в systemPrompt)   [опц.]
//   report.md       — Telegram-шаблон (первый lookup в render.ts)               [опц.]
//   skills/<name>/SKILL.md — приватные скиллы агента (грузятся skills/registry)  [опц.]
//
// Зачем DUAL loader, а не миграция: legacy routines/*.md продолжают работать.
// agents/ ПОБЕЖДАЮТ при коллизии id (registry молча пропускает legacy).
//
// Frontmatter здесь парсим настоящим `yaml` (в отличие от hand-rolled subset в
// parser.ts) — agent-папки новые, нет legacy-ограничения на YAML-подмножество.
//
// Маппинг полей (см. план 2026-06-04-oss-v1.0-design-and-migration.md §3):
//   AGENT.md displayName → Routine.role        (имя «сотрудника» в 3D-офисе)
//   AGENT.md body        → Routine.description  («Твоя задача: …» в systemPrompt)
//   prompt.md            → Routine.prompt       (полный промт)
//   AGENT.md model       → Routine.model        (алиас opus/sonnet/haiku резолвится)
//   AGENT.md schedule    → Routine.trigger      (manual | cron)
//   AGENT.md output      → Routine.outputType   (алиас telegram/journal/both)
//   permissions.yml      → tools/bashWhitelist/secrets
//   target.yml           → targetCwd/allowedTargetSkills/syncEnv

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  type Routine,
  type RoutineOutputType,
  RoutineParseError,
  parseBool,
  parsePosInt,
  validateModel,
  validateOutputType,
  validateTrigger,
} from './parser.js';

// ── Алиасы ───────────────────────────────────────────────────────────────────
// Короткие имена моделей → полный claude-* id. Полные claude-*/voyage-* id
// пропускаются как есть (validateModel ниже отвергнёт мусор). Менять тут —
// апгрейдит все форки бесплатно при бампе модели.
const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
};

// Короткие имена output → канонический RoutineOutputType.
const OUTPUT_ALIASES: Record<string, RoutineOutputType> = {
  telegram: 'telegram-thread',
  journal: 'journal-only',
  both: 'both',
  // канонические значения принимаем как есть:
  'telegram-thread': 'telegram-thread',
  'journal-only': 'journal-only',
};

const DEFAULT_AGENT_MAX_TOKENS = 16000;
const DEFAULT_AGENT_TIMEOUT_MS = 600000;

// ── Заморожённый контракт агента (OSS v1.0) ───────────────────────────────────
// Версия СХЕМЫ AGENT.md (НЕ путать с VERSION движка). Бампается только при
// breaking-изменении формата frontmatter/permissions/target. Агент с
// schemaVersion НОВЕЕ этой → hard parse error «обнови движок» (forward-compat:
// движок честно говорит, что не понимает файл, вместо тихой деградации).
const CURRENT_AGENT_SCHEMA_VERSION = '1.0';

// Полный набор допустимых ключей frontmatter AGENT.md. Любой иной ключ (опечатка
// 'maxtoken', поле из будущей версии при schemaVersion <= текущей) →
// RoutineParseError. Форк ловит дрейф формата на parse-time, а не молча роняет
// поле в дефолт. Менять синхронно с docs/AGENTS.md §2 и §13.
const FROZEN_AGENT_SCHEMA = new Set<string>([
  'schemaVersion',
  'id',
  'displayName',
  'role',
  'avatar',
  'color',
  'logo',
  'department',
  'model',
  'enabled',
  'schedule',
  'output',
  'maxTokens',
  'timeoutMs',
  'skills',
  'forceLoad',
]);

// Допустимые top-level ключи permissions.yml и target.yml (см. AGENT.md §3, §8).
const PERMISSIONS_SCHEMA = new Set<string>([
  'tools',
  'bash',
  'dbScopes',
  'secrets',
  'telegram',
  'maxStepsPerRun',
  'budget',
]);
const TARGET_SCHEMA = new Set<string>(['cwd', 'host', 'skills', 'maxTurns', 'syncEnv']);

// "1.2.3" → [1,2,3]; недостающие/нечисловые сегменты → 0. Без semver-зависимости
// (новый пакет ломал бы `pnpm install --frozen-lockfile` в CI). declared > current?
function isSchemaVersionNewer(declared: string, current: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const p = v.replace(/^v/, '').split('.');
    const n = (i: number): number => {
      const x = Number.parseInt(p[i] ?? '0', 10);
      return Number.isFinite(x) ? x : 0;
    };
    return [n(0), n(1), n(2)];
  };
  const [a0, a1, a2] = parse(declared);
  const [b0, b1, b2] = parse(current);
  if (a0 !== b0) return a0 > b0;
  if (a1 !== b1) return a1 > b1;
  return a2 > b2;
}

// Кидает RoutineParseError, если в obj есть ключ вне allowed. what — имя формата
// для сообщения ('frontmatter AGENT.md' / 'permissions.yml' / 'target.yml').
function rejectUnknownKeys(
  filePath: string,
  obj: Record<string, unknown>,
  allowed: Set<string>,
  what: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new RoutineParseError(
        filePath,
        `неизвестное поле ${what} '${key}'. Допустимые: ${[...allowed].join(', ')}.`,
      );
    }
  }
}

export interface ParseAgentOptions {
  /** DI: чтение файла (тесты). По умолчанию fs/promises readFile utf8. */
  read?: (path: string) => Promise<string>;
  /** DI: существование файла (опц. permissions.yml/target.yml/rules.md/report.md/prompt.md). */
  fileExists?: (path: string) => Promise<boolean>;
  /** projectId, который проставляется агенту. По умолчанию 'self' (синтетический
   *  built-in проект, см. src/projects/registry.ts). */
  projectId?: string;
}

interface AgentPermissions {
  tools?: unknown;
  bash?: unknown;
  dbScopes?: { read?: unknown; write?: unknown };
  secrets?: unknown;
  telegram?: unknown;
  maxStepsPerRun?: unknown;
  budget?: { perRunUsd?: unknown };
}

interface AgentTarget {
  cwd?: unknown;
  host?: unknown;
  skills?: unknown;
  maxTurns?: unknown;
  syncEnv?: unknown;
}

async function defaultRead(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}

// Делит AGENT.md на frontmatter (yaml между --- ... ---) и body.
function splitAgentMd(agentMdPath: string, source: string): { fm: string; body: string } {
  const lines = source.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new RoutineParseError(
      agentMdPath,
      'AGENT.md должен начинаться с frontmatter-делимитера ---.',
    );
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) {
    throw new RoutineParseError(agentMdPath, 'AGENT.md frontmatter не закрыт вторым ---.');
  }
  const fm = lines.slice(1, close).join('\n');
  const body = lines
    .slice(close + 1)
    .join('\n')
    .trim();
  return { fm, body };
}

function resolveModelAlias(filePath: string, raw: string): string {
  const trimmed = raw.trim();
  const resolved = MODEL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
  // Hard-guard: после резолва модель ОБЯЗАНА быть полным claude-*/voyage-* id.
  // validateModel кидает RoutineParseError если нет — это гард перед raw
  // --model passthrough в runtime (см. executeUnattendedRoutine).
  return validateModel(filePath, resolved);
}

function resolveOutputAlias(filePath: string, raw: string): RoutineOutputType {
  const trimmed = raw.trim();
  const aliased = OUTPUT_ALIASES[trimmed.toLowerCase()];
  // Не алиас — отдаём в каноническую валидацию (даст понятную ошибку).
  return aliased ?? validateOutputType(filePath, trimmed);
}

function requireString(filePath: string, obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (v === undefined || v === null) {
    throw new RoutineParseError(filePath, `frontmatter: отсутствует обязательное поле '${key}'.`);
  }
  const s = String(v).trim();
  if (s === '') {
    throw new RoutineParseError(filePath, `frontmatter: поле '${key}' не может быть пустым.`);
  }
  return s;
}

function optStr(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

// YAML-массив строк → string[] (опц.). Имена не могут быть пустыми/с пробелами;
// точка разрешена (namespaced skill '<agentId>.<skill>').
function optStrArray(filePath: string, value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new RoutineParseError(filePath, `поле '${label}' должно быть YAML-массивом строк.`);
  }
  const arr = value.map((v) => String(v).trim());
  for (const s of arr) {
    if (s === '' || /\s/.test(s)) {
      throw new RoutineParseError(
        filePath,
        `поле '${label}': элемент '${s}' не может быть пустым или содержать пробелы.`,
      );
    }
  }
  return arr;
}

// Как optStrArray, но для bash-prefix'ов: внутренние пробелы РАЗРЕШЕНЫ ('git log'),
// запрещён только пустой элемент. (Зеркалит legacy parser.ts: bashWhitelist
// допускает пробелы внутри prefix'а — FORBIDDEN_SUBSTRINGS энфорсятся в runtime.)
function optBashArray(filePath: string, value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new RoutineParseError(filePath, `поле '${label}' должно быть YAML-массивом строк.`);
  }
  const arr = value.map((v) => String(v).trim());
  for (const s of arr) {
    if (s === '') {
      throw new RoutineParseError(filePath, `поле '${label}': пустой prefix недопустим.`);
    }
  }
  return arr;
}

/**
 * parseAgentFolder — читает agents/<id>/ и собирает Routine.
 * @param dir абсолютный путь к папке агента.
 */
export async function parseAgentFolder(
  dir: string,
  options: ParseAgentOptions = {},
): Promise<Routine> {
  const read = options.read ?? defaultRead;
  const fileExists = options.fileExists ?? defaultFileExists;
  const projectId = options.projectId ?? 'self';

  if (!isAbsolute(dir)) {
    throw new RoutineParseError(dir, 'parseAgentFolder ожидает абсолютный путь к папке агента.');
  }

  // ── AGENT.md (required) ──
  const agentMdPath = join(dir, 'AGENT.md');
  let agentSource: string;
  try {
    agentSource = await read(agentMdPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RoutineParseError(agentMdPath, `не удалось прочитать AGENT.md: ${msg}`);
  }

  const { fm, body } = splitAgentMd(agentMdPath, agentSource);

  let parsed: unknown;
  try {
    parsed = parseYaml(fm);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RoutineParseError(agentMdPath, `frontmatter не парсится как YAML: ${msg}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RoutineParseError(agentMdPath, 'frontmatter пуст или не является YAML-маппингом.');
  }
  const fmObj = parsed as Record<string, unknown>;

  // ── Заморозка контракта: версия схемы ПЕРЕД проверкой ключей ──
  // schemaVersion ОБЯЗАН быть строкой в кавычках: голый YAML-номер коверкается
  // (`1.10` → число 1.1 → ложное «обнови движок»; `1.0` → 1 → "1"). Требуем
  // кавычки, чтобы footgun падал понятно, а не молча мис-парсился.
  if (typeof fmObj.schemaVersion === 'number') {
    throw new RoutineParseError(
      agentMdPath,
      'schemaVersion должен быть строкой в кавычках (например "1.0"), а не голым числом — YAML коверкает номер (1.10 → 1.1).',
    );
  }
  // Сначала версия: агент из будущей версии получает «обнови движок», а не
  // сбивающее с толку «неизвестное поле» про свой новый (легитимный) ключ.
  const schemaVersion = optStr(fmObj, 'schemaVersion') ?? CURRENT_AGENT_SCHEMA_VERSION;
  if (isSchemaVersionNewer(schemaVersion, CURRENT_AGENT_SCHEMA_VERSION)) {
    throw new RoutineParseError(
      agentMdPath,
      `schemaVersion '${schemaVersion}' новее, чем понимает этот движок (${CURRENT_AGENT_SCHEMA_VERSION}). Обнови движок: pnpm update-engine.`,
    );
  }
  rejectUnknownKeys(agentMdPath, fmObj, FROZEN_AGENT_SCHEMA, 'frontmatter AGENT.md');

  // ── Обязательные поля frontmatter ──
  const displayName = requireString(agentMdPath, fmObj, 'displayName');
  const modelRaw = requireString(agentMdPath, fmObj, 'model');
  const scheduleRaw = requireString(agentMdPath, fmObj, 'schedule');
  const outputRaw = requireString(agentMdPath, fmObj, 'output');
  if (fmObj.enabled === undefined || fmObj.enabled === null) {
    throw new RoutineParseError(
      agentMdPath,
      "frontmatter: отсутствует обязательное поле 'enabled'.",
    );
  }

  // id: имя папки — ЕДИНСТВЕННЫЙ источник истины (load-bearing для launchd:
  // плисты вшивают com.ai-cofounder.routine-<id>). Поле `id:` в frontmatter
  // допустимо только как ИЗБЫТОЧНОЕ подтверждение, и обязано совпадать с
  // basename — иначе осиротит запущенный плист. Рассинхрон = hard parse error.
  const folderId = dir.split('/').filter(Boolean).pop() ?? dir;
  if (fmObj.id !== undefined && fmObj.id !== null) {
    const declaredId = String(fmObj.id).trim();
    if (declaredId === '') {
      throw new RoutineParseError(agentMdPath, "поле 'id' не может быть пустой строкой.");
    }
    if (declaredId !== folderId) {
      throw new RoutineParseError(
        agentMdPath,
        `frontmatter id='${declaredId}' не совпадает с именем папки '${folderId}'. Имя папки агента — единственный источник истины для id (его вшивают launchd-плисты com.ai-cofounder.routine-<id>). Переименуй папку ИЛИ убери поле id из AGENT.md.`,
      );
    }
  }
  const id = folderId;

  const enabled = parseBool(agentMdPath, String(fmObj.enabled), 'enabled');
  const trigger = validateTrigger(agentMdPath, scheduleRaw);
  const model = resolveModelAlias(agentMdPath, modelRaw);
  const outputType = resolveOutputAlias(agentMdPath, outputRaw);

  // description = тело AGENT.md (краткое описание). Fallback — displayName.
  const description = body.length > 0 ? body : displayName;

  // ── prompt.md (required) → Routine.prompt ──
  const promptPath = join(dir, 'prompt.md');
  let prompt: string;
  try {
    prompt = (await read(promptPath)).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RoutineParseError(
      promptPath,
      `не удалось прочитать prompt.md (обязательный): ${msg}`,
    );
  }
  if (prompt.length === 0) {
    throw new RoutineParseError(promptPath, 'prompt.md пуст — опиши, что агент должен делать.');
  }

  // ── skills / forceLoad из AGENT.md frontmatter (ссылки на shared-библиотеку
  //    skills/ ИЛИ на свои namespaced '<id>.<skill>'). ──
  const skills = optStrArray(agentMdPath, fmObj.skills, 'skills');
  const forceLoad = optStrArray(agentMdPath, fmObj.forceLoad, 'forceLoad');

  // ── permissions.yml (опц.) ──
  // tools/bash/secrets энфорсятся; dbScopes/budget/telegram/maxStepsPerRun в
  // v1.0 — декларативные (парсятся, но не ужесточают рантайм). См. план §3.
  const permPath = join(dir, 'permissions.yml');
  let perms: AgentPermissions = {};
  if (await fileExists(permPath)) {
    const permSrc = await read(permPath);
    let p: unknown;
    try {
      p = parseYaml(permSrc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RoutineParseError(permPath, `permissions.yml не парсится как YAML: ${msg}`);
    }
    if (p !== null && p !== undefined) {
      if (typeof p !== 'object' || Array.isArray(p)) {
        throw new RoutineParseError(permPath, 'permissions.yml должен быть YAML-маппингом.');
      }
      perms = p as AgentPermissions;
      rejectUnknownKeys(
        permPath,
        perms as Record<string, unknown>,
        PERMISSIONS_SCHEMA,
        'permissions.yml',
      );
    }
  }

  const tools = optStrArray(permPath, perms.tools, 'tools') ?? [];
  const bashWhitelist = optBashArray(permPath, perms.bash, 'bash');
  const secrets = optStrArray(permPath, perms.secrets, 'secrets');

  // ── target.yml (опц.) — presence = cross-project opt-in ──
  const targetPath = join(dir, 'target.yml');
  let targetCwd: string | undefined;
  let allowedTargetSkills: string[] | undefined;
  let syncEnv: string[] | undefined;
  if (await fileExists(targetPath)) {
    const tSrc = await read(targetPath);
    let t: unknown;
    try {
      t = parseYaml(tSrc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RoutineParseError(targetPath, `target.yml не парсится как YAML: ${msg}`);
    }
    if (t === null || typeof t !== 'object' || Array.isArray(t)) {
      throw new RoutineParseError(targetPath, 'target.yml должен быть YAML-маппингом с полем cwd.');
    }
    const tObj = t as AgentTarget;
    rejectUnknownKeys(targetPath, tObj as Record<string, unknown>, TARGET_SCHEMA, 'target.yml');
    if (typeof tObj.cwd !== 'string' || tObj.cwd.trim() === '') {
      throw new RoutineParseError(
        targetPath,
        "target.yml: обязательное поле 'cwd' (абсолютный путь).",
      );
    }
    if (!isAbsolute(tObj.cwd)) {
      throw new RoutineParseError(
        targetPath,
        `target.yml: 'cwd' должен быть абсолютным путём, получено '${tObj.cwd}'.`,
      );
    }
    targetCwd = tObj.cwd;
    allowedTargetSkills = optStrArray(targetPath, tObj.skills, 'skills');
    syncEnv = optStrArray(targetPath, tObj.syncEnv, 'syncEnv');
  }

  // ── rules.md (опц.) → ## Guardrails ──
  const rulesPath = join(dir, 'rules.md');
  let rules: string | undefined;
  if (await fileExists(rulesPath)) {
    const r = (await read(rulesPath)).trim();
    rules = r === '' ? undefined : r;
  }

  // ── report.md (опц.) — путь для первого lookup в render.ts ──
  const reportPath = join(dir, 'report.md');
  const reportTemplatePath = (await fileExists(reportPath)) ? reportPath : undefined;

  // ── maxTokens / timeoutMs (опц. с дефолтами) ──
  const maxTokens =
    fmObj.maxTokens === undefined || fmObj.maxTokens === null
      ? DEFAULT_AGENT_MAX_TOKENS
      : parsePosInt(agentMdPath, String(fmObj.maxTokens), 'maxTokens');
  const timeoutMs =
    fmObj.timeoutMs === undefined || fmObj.timeoutMs === null
      ? DEFAULT_AGENT_TIMEOUT_MS
      : parsePosInt(agentMdPath, String(fmObj.timeoutMs), 'timeoutMs');

  // ── Презентационные опц. поля ──
  const role = displayName; // имя «сотрудника» в 3D-офисе
  const avatar = optStr(fmObj, 'avatar');
  const color = optStr(fmObj, 'color');
  const logo = optStr(fmObj, 'logo');
  const departmentId = optStr(fmObj, 'department');

  return {
    id,
    schemaVersion,
    projectId,
    enabled,
    trigger,
    tools,
    model,
    maxTokens,
    timeoutMs,
    outputType,
    description,
    prompt,
    filePath: agentMdPath,
    agentDir: dir,
    role,
    ...(avatar !== undefined ? { avatar } : {}),
    ...(color !== undefined ? { color } : {}),
    ...(logo !== undefined ? { logo } : {}),
    ...(bashWhitelist !== undefined ? { bashWhitelist } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(forceLoad !== undefined ? { forceLoad } : {}),
    ...(departmentId !== undefined ? { departmentId } : {}),
    // targetProject остаётся undefined — cross-project у агентов через targetCwd.
    ...(targetCwd !== undefined ? { targetCwd } : {}),
    ...(allowedTargetSkills !== undefined ? { allowedTargetSkills } : {}),
    ...(syncEnv !== undefined ? { syncEnv } : {}),
    ...(secrets !== undefined ? { secrets } : {}),
    ...(rules !== undefined ? { rules } : {}),
    ...(reportTemplatePath !== undefined ? { reportTemplatePath } : {}),
  };
}

export {
  MODEL_ALIASES,
  OUTPUT_ALIASES,
  CURRENT_AGENT_SCHEMA_VERSION,
  FROZEN_AGENT_SCHEMA,
  PERMISSIONS_SCHEMA,
  TARGET_SCHEMA,
};

// Защита @<relative-path> include внутри rules.md: путь не должен выходить за
// пределы agentDir (no `..` traversal). Возвращает абсолютный путь или кидает.
// Вынесено сюда — runtime импортирует при раскрытии guardrails.
export function resolveRuleInclude(agentDir: string, includeRel: string): string {
  if (includeRel.includes('..')) {
    throw new RoutineParseError(
      join(agentDir, 'rules.md'),
      `@-include '${includeRel}' содержит '..' — traversal за пределы папки агента запрещён.`,
    );
  }
  const abs = resolve(agentDir, includeRel);
  const rel = relative(agentDir, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new RoutineParseError(
      join(agentDir, 'rules.md'),
      `@-include '${includeRel}' резолвится за пределы папки агента.`,
    );
  }
  return abs;
}
