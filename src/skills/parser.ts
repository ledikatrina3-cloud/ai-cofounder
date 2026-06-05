// Skill parser — единственная точка чтения `skills/<name>/SKILL.md` (+
// опционального `permissions.md`).
//
// Контракт фазы 1 (план 2026-05-21-skills-architecture-v3):
//   * `parseSkill(skillDir)` — читает SKILL.md (обязательно) и
//     permissions.md (опционально, дефолт `{}`), валидирует frontmatter и
//     возвращает `Skill`.
//   * Узкий YAML-парсер (как в `src/routines/parser.ts`): scalar,
//     flow-array, простой nested mapping, flow-array of inline maps.
//     Никаких anchors / multiline / nested-в-nested.
//   * Ошибки → `SkillParseError` с указанием skill-id и поля.
//
// Почему свой парсер, а не `gray-matter` / `yaml`:
//   * Формат skill frontmatter узкий и фиксированный — нечего разруливать.
//   * Меньше зависимостей, согласовано с уже принятым решением в
//     `src/routines/parser.ts`.
//   * Ошибки — на нашем языке («поле X должно быть Y»), не «yaml syntax
//     error at line 4 col 12».
//
// Особенности (что поддерживаем сверх routines-парсера):
//   * Nested mapping (один уровень) для `compatibleWith` и `healthCheck`:
//       compatibleWith:
//         runtime: ">=1.0.0 <2.0.0"
//   * Flow-array of inline maps для `requiresApproval`:
//       requiresApproval: [{action: publish, via: telegram}]
//   * НЕ поддерживаем: вложенные nested mapping (>1 уровень), массивы
//     scalar'ов внутри inline-map, multiline-строки.

import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { SKILL_CATEGORIES, type SkillCategory } from './categories.js';
import type {
  Skill,
  SkillApprovalRequest,
  SkillCompatibility,
  SkillHealthCheck,
  SkillPermissions,
} from './types.js';

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

export class SkillParseError extends Error {
  constructor(skillId: string, message: string) {
    super(`skill '${skillId}': ${message}`);
    this.name = 'SkillParseError';
  }
}

// ---------------------------------------------------------------------------
// Регулярки и константы валидации.
// ---------------------------------------------------------------------------

const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{3,8}$/;
const KEY_VALUE_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/;
const FRONTMATTER_DELIM = '---';

// Bash-prefix для скилла обязан начинаться с
// `pnpm exec tsx skills/<name>/scripts/` — это гарантирует, что скилл =
// data, не code (multi-user решение #1).
function bashPrefixForSkill(name: string): string {
  return `pnpm exec tsx skills/${name}/scripts/`;
}

// ---------------------------------------------------------------------------
// Низкоуровневый сплит frontmatter + body.
// ---------------------------------------------------------------------------

interface FrontmatterAndBody {
  frontmatterLines: string[];
  body: string;
}

function splitFrontmatterAndBody(skillId: string, source: string): FrontmatterAndBody {
  const lines = source.split('\n');
  if (lines[0]?.trim() !== FRONTMATTER_DELIM) {
    throw new SkillParseError(
      skillId,
      "SKILL.md должен начинаться с '---' (frontmatter delimiter).",
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
    throw new SkillParseError(skillId, "не найден закрывающий '---' frontmatter'а SKILL.md.");
  }
  return {
    frontmatterLines: lines.slice(1, endIdx),
    body: lines
      .slice(endIdx + 1)
      .join('\n')
      .trim(),
  };
}

// ---------------------------------------------------------------------------
// Узкий YAML-парсер. Поддерживает три типа значений на верхнем уровне:
//   key: scalar           — строка
//   key: [a, b, "c d"]    — flow-array (строки) или [{k: v, ...}, ...]
//   key:                  — nested-mapping (один уровень, indent ≥ 2 пробела)
//     subkey: value
//   key: []               — пустой массив
// Также поддерживает комментарии (# в начале строки или после ` # `).
// ---------------------------------------------------------------------------

type ScalarValue = string;
type ArrayValue = string[] | InlineMap[];
type MappingValue = Map<string, string>;
type FrontmatterValue = ScalarValue | ArrayValue | MappingValue;

interface InlineMap {
  [key: string]: string;
}

interface ParsedFrontmatter {
  values: Map<string, FrontmatterValue>;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}

function isCommentOrBlank(line: string): boolean {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

// `[a, b]` или `[{k: v, q: w}, ...]` или `[]`. Не поддерживает массивы
// массивов и вложенные quoted-запятые (для нашего формата — лишнее).
function parseFlowArray(skillId: string, key: string, raw: string): string[] | InlineMap[] {
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];

  // Эвристика типа: если начинается с `{` — массив inline-maps.
  if (inner.startsWith('{')) {
    return parseFlowArrayOfMaps(skillId, key, inner);
  }

  // Обычный массив scalar'ов: split по запятым, strip quotes.
  const parts = splitTopLevelComma(skillId, key, inner);
  return parts.map((p) => {
    const cleaned = stripQuotes(p.trim());
    if (cleaned.includes('[') || cleaned.includes(']') || cleaned.includes('{')) {
      throw new SkillParseError(
        skillId,
        `поле '${key}': массив должен содержать простые строки без вложенных скобок.`,
      );
    }
    return cleaned;
  });
}

// Разбивает строку на части по запятым верхнего уровня. Учитывает
// фигурные скобки (для inline-map) — не режет запятые внутри `{...}`.
// Кавычки в нашем формате не должны содержать запятых (документировано).
function splitTopLevelComma(skillId: string, key: string, raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of raw) {
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth < 0) {
        throw new SkillParseError(skillId, `поле '${key}': лишняя '}' в значении.`);
      }
    }
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (depth !== 0) {
    throw new SkillParseError(skillId, `поле '${key}': незакрытая '{' в значении.`);
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

// Парсит `{action: publish, via: telegram}, {action: x, via: y}` →
// массив InlineMap. На вход даётся inner (без обрамляющих `[` `]`).
function parseFlowArrayOfMaps(skillId: string, key: string, inner: string): InlineMap[] {
  const items = splitTopLevelComma(skillId, key, inner);
  const out: InlineMap[] = [];
  for (const raw of items) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
      throw new SkillParseError(
        skillId,
        `поле '${key}': элемент массива должен быть inline-map '{k: v, ...}', получено '${trimmed}'.`,
      );
    }
    const body = trimmed.slice(1, -1);
    const entries = body
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const map: InlineMap = {};
    for (const e of entries) {
      const m = KEY_VALUE_RE.exec(e);
      if (m === null || m[1] === undefined || m[2] === undefined) {
        throw new SkillParseError(
          skillId,
          `поле '${key}': inline-map '${trimmed}' содержит некорректную пару '${e}'.`,
        );
      }
      map[m[1]] = stripQuotes(m[2].trim());
    }
    out.push(map);
  }
  return out;
}

function parseFrontmatter(skillId: string, lines: string[]): ParsedFrontmatter {
  const values = new Map<string, FrontmatterValue>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) {
      i++;
      continue;
    }
    if (isCommentOrBlank(line)) {
      i++;
      continue;
    }
    if (indentOf(line) > 0) {
      throw new SkillParseError(
        skillId,
        `frontmatter строка ${i + 1}: неожиданный отступ '${line}'. Nested-mapping начинается с родительского 'ключ:' без значения.`,
      );
    }

    const m = KEY_VALUE_RE.exec(line);
    if (m === null || m[1] === undefined || m[2] === undefined) {
      throw new SkillParseError(
        skillId,
        `frontmatter строка ${i + 1}: ожидалось 'ключ: значение', получено '${line}'.`,
      );
    }
    const key = m[1];
    const valueRaw = m[2].trim();

    // ── Nested-mapping: `key:` без значения, дальше indent ≥ 2 ──
    if (valueRaw === '') {
      const mapping = new Map<string, string>();
      i++;
      while (i < lines.length) {
        const sub = lines[i];
        if (sub === undefined) break;
        if (isCommentOrBlank(sub)) {
          i++;
          continue;
        }
        const subIndent = indentOf(sub);
        if (subIndent === 0) break; // верхнеуровневая строка — конец nested
        const subTrim = sub.trim();
        const sm = KEY_VALUE_RE.exec(subTrim);
        if (sm === null || sm[1] === undefined || sm[2] === undefined) {
          throw new SkillParseError(
            skillId,
            `frontmatter строка ${i + 1}: в nested-mapping '${key}' ожидалась пара 'ключ: значение', получено '${sub}'.`,
          );
        }
        const subVal = sm[2].trim();
        if (subVal === '' || subVal.startsWith('[') || subVal.startsWith('{')) {
          throw new SkillParseError(
            skillId,
            `frontmatter поле '${key}.${sm[1]}': nested-mapping поддерживает только скалярные значения (без массивов/вложенных map'ов).`,
          );
        }
        mapping.set(sm[1], stripQuotes(subVal));
        i++;
      }
      if (mapping.size === 0) {
        throw new SkillParseError(
          skillId,
          `frontmatter поле '${key}': nested-mapping не должен быть пустым.`,
        );
      }
      values.set(key, mapping);
      continue;
    }

    // ── Flow-array: [a, b] или [{...}, ...] ──
    if (valueRaw.startsWith('[') && valueRaw.endsWith(']')) {
      values.set(key, parseFlowArray(skillId, key, valueRaw));
      i++;
      continue;
    }

    // ── Scalar ──
    values.set(key, stripQuotes(valueRaw));
    i++;
  }
  return { values };
}

// ---------------------------------------------------------------------------
// Type-guards и хелперы доступа.
// ---------------------------------------------------------------------------

function asScalar(skillId: string, key: string, v: FrontmatterValue | undefined): string {
  if (v === undefined) {
    throw new SkillParseError(skillId, `frontmatter не содержит обязательное поле '${key}'.`);
  }
  if (typeof v !== 'string') {
    throw new SkillParseError(
      skillId,
      `поле '${key}' должно быть скалярной строкой, а не массивом/map'ом.`,
    );
  }
  return v;
}

function optionalScalar(
  skillId: string,
  key: string,
  v: FrontmatterValue | undefined,
): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    throw new SkillParseError(
      skillId,
      `поле '${key}' должно быть скалярной строкой, а не массивом/map'ом.`,
    );
  }
  const trimmed = v.trim();
  return trimmed === '' ? undefined : trimmed;
}

function asStringArray(skillId: string, key: string, v: FrontmatterValue): string[] {
  if (!Array.isArray(v)) {
    throw new SkillParseError(skillId, `поле '${key}' должно быть массивом строк.`);
  }
  for (const item of v) {
    if (typeof item !== 'string') {
      throw new SkillParseError(
        skillId,
        `поле '${key}' должно быть массивом строк, а не массивом объектов.`,
      );
    }
  }
  return v as string[];
}

function asInlineMapArray(skillId: string, key: string, v: FrontmatterValue): InlineMap[] {
  if (!Array.isArray(v)) {
    throw new SkillParseError(
      skillId,
      `поле '${key}' должно быть массивом inline-map'ов '[{k: v, ...}, ...]'.`,
    );
  }
  for (const item of v) {
    if (typeof item === 'string') {
      throw new SkillParseError(
        skillId,
        `поле '${key}' должно быть массивом inline-map'ов, а не массивом строк.`,
      );
    }
  }
  return v as InlineMap[];
}

function asMapping(skillId: string, key: string, v: FrontmatterValue): Map<string, string> {
  if (typeof v === 'string' || Array.isArray(v)) {
    throw new SkillParseError(
      skillId,
      `поле '${key}' должно быть nested-mapping (с отступом на следующих строках).`,
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// Валидация конкретных полей SKILL.md.
// ---------------------------------------------------------------------------

function validateName(skillId: string, raw: string, expectedFromDir: string): string {
  if (!KEBAB_CASE_RE.test(raw)) {
    throw new SkillParseError(
      skillId,
      `поле 'name' должно быть kebab-case (^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$), получено '${raw}'.`,
    );
  }
  if (raw !== expectedFromDir) {
    throw new SkillParseError(
      skillId,
      `поле 'name'='${raw}' не совпадает с basename директории '${expectedFromDir}'. name должен равняться имени папки скилла.`,
    );
  }
  return raw;
}

function validateDescription(skillId: string, raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new SkillParseError(skillId, "поле 'description' не должно быть пустым.");
  }
  return trimmed;
}

function validateVersion(skillId: string, raw: string): string {
  if (!SEMVER_RE.test(raw)) {
    throw new SkillParseError(
      skillId,
      `поле 'version' должно быть валидным semver вида '1.0.0' (^\\d+\\.\\d+\\.\\d+$), получено '${raw}'.`,
    );
  }
  return raw;
}

function validateCategory(skillId: string, raw: string): SkillCategory {
  if (!(SKILL_CATEGORIES as readonly string[]).includes(raw)) {
    throw new SkillParseError(
      skillId,
      `поле 'category' должно быть одним из: ${SKILL_CATEGORIES.join(', ')}, получено '${raw}'.`,
    );
  }
  return raw as SkillCategory;
}

function validateColor(skillId: string, raw: string): string {
  if (!HEX_COLOR_RE.test(raw)) {
    throw new SkillParseError(
      skillId,
      `поле 'color' должно быть hex-цветом вида '#FF8800', получено '${raw}'.`,
    );
  }
  return raw;
}

function validateCompatibleWith(skillId: string, m: Map<string, string>): SkillCompatibility {
  const runtime = m.get('runtime');
  if (runtime === undefined || runtime.trim() === '') {
    throw new SkillParseError(
      skillId,
      "поле 'compatibleWith.runtime' обязательно и должно быть строкой semver-range (например '>=1.0.0 <2.0.0').",
    );
  }
  // На фазе 1 — только smoke-check, что строка непустая. Полный semver-range
  // парсер подключится, когда runtime начнёт его читать (Фаза 2/4).
  return { runtime: runtime.trim() };
}

function validateApprovalArray(skillId: string, raw: InlineMap[]): SkillApprovalRequest[] {
  return raw.map((item, idx) => {
    const action = item.action;
    const via = item.via;
    if (action === undefined || action === '') {
      throw new SkillParseError(skillId, `поле 'requiresApproval'[${idx}]: 'action' обязателен.`);
    }
    if (via === undefined || via === '') {
      throw new SkillParseError(skillId, `поле 'requiresApproval'[${idx}]: 'via' обязателен.`);
    }
    return { action, via };
  });
}

function validateHealthCheck(skillId: string, m: Map<string, string>): SkillHealthCheck {
  const script = m.get('script');
  const schedule = m.get('schedule');
  if (script === undefined || script.trim() === '') {
    throw new SkillParseError(
      skillId,
      "поле 'healthCheck.script' обязательно и должно быть путём к скрипту.",
    );
  }
  if (schedule === undefined || schedule.trim() === '') {
    throw new SkillParseError(
      skillId,
      "поле 'healthCheck.schedule' обязательно и должно быть cron-expression.",
    );
  }
  return { script: script.trim(), schedule: schedule.trim() };
}

function validateBashWhitelist(skillId: string, name: string, raw: string[]): string[] {
  const prefix = bashPrefixForSkill(name);
  for (const w of raw) {
    if (w === '' || w.trim() !== w) {
      throw new SkillParseError(
        skillId,
        `поле 'bashWhitelist': prefix '${w}' не может быть пустым или содержать leading/trailing пробелы.`,
      );
    }
    if (!w.startsWith(prefix)) {
      throw new SkillParseError(
        skillId,
        `поле 'bashWhitelist': prefix '${w}' должен начинаться с '${prefix}' (скилл = data, не code: multi-user решение #1).`,
      );
    }
  }
  return raw;
}

function parsePosInt(skillId: string, raw: string, key: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== raw) {
    throw new SkillParseError(
      skillId,
      `поле '${key}' должно быть положительным целым числом, получено '${raw}'.`,
    );
  }
  return n;
}

// ---------------------------------------------------------------------------
// permissions.md → SkillPermissions.
// ---------------------------------------------------------------------------

// permissions.md в наших скиллах — это YAML БЕЗ frontmatter-разделителей:
// верхнеуровневые keys прямо в файле. Пример из плана:
//
//   bashWhitelist:
//     - "pnpm exec tsx skills/vc-publishing/scripts/publish.ts"
//
// Наш узкий парсер не поддерживает block-array (`- item`), но поддерживает
// flow-array `[item, item]`. Мы фиксируем формат permissions.md как
// flow-array — это согласовано с тем, как frontmatter работает в SKILL.md.
// Если у пользователя дефис-нотация — даём понятную ошибку.
function parsePermissions(skillId: string, name: string, source: string): SkillPermissions {
  // Эмулируем frontmatter: оборачиваем содержимое в `---\n...\n---\n`,
  // чтобы переиспользовать тот же парсер. Это даёт единый формат и
  // одинаковые ошибки.
  const lines = source.split('\n');
  // Сразу даём осмысленную ошибку на YAML block-array (часто пишут с дефиса).
  for (const line of lines) {
    if (/^\s*-\s+/.test(line)) {
      throw new SkillParseError(
        skillId,
        'permissions.md: block-array \'- item\' не поддерживается. Используй flow-array: bashWhitelist: ["prefix1", "prefix2"].',
      );
    }
  }

  const { values } = parseFrontmatter(skillId, lines);
  const out: SkillPermissions = {};

  if (values.has('bashWhitelist')) {
    const arr = asStringArray(
      skillId,
      'bashWhitelist',
      values.get('bashWhitelist') as FrontmatterValue,
    );
    out.bashWhitelist = validateBashWhitelist(skillId, name, arr);
  }
  if (values.has('requiredSdkTools')) {
    out.requiredSdkTools = asStringArray(
      skillId,
      'requiredSdkTools',
      values.get('requiredSdkTools') as FrontmatterValue,
    );
  }
  if (values.has('maxStepsPerInvocation')) {
    const raw = asScalar(skillId, 'maxStepsPerInvocation', values.get('maxStepsPerInvocation'));
    out.maxStepsPerInvocation = parsePosInt(skillId, raw, 'maxStepsPerInvocation');
  }
  if (values.has('requiresApproval')) {
    const arr = asInlineMapArray(
      skillId,
      'requiresApproval',
      values.get('requiresApproval') as FrontmatterValue,
    );
    out.requiresApproval = validateApprovalArray(skillId, arr);
  }
  if (values.has('healthCheck')) {
    const m = asMapping(skillId, 'healthCheck', values.get('healthCheck') as FrontmatterValue);
    out.healthCheck = validateHealthCheck(skillId, m);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export interface ParseSkillOptions {
  // DI для тестов: подменить чтение файла. Получает абсолютный путь файла,
  // должна вернуть содержимое или бросить (ENOENT и т.п.).
  read?: (path: string) => Promise<string>;
  // DI для тестов: подменить проверку существования файла. По умолчанию —
  // ловим ENOENT от `read` для permissions.md.
  fileExists?: (path: string) => Promise<boolean>;
}

async function defaultRead(p: string): Promise<string> {
  return readFile(p, 'utf8');
}

async function tryReadOptional(
  path: string,
  read: (p: string) => Promise<string>,
  fileExists?: (p: string) => Promise<boolean>,
): Promise<string | null> {
  if (fileExists !== undefined) {
    if (!(await fileExists(path))) return null;
    return read(path);
  }
  try {
    return await read(path);
  } catch (err) {
    // ENOENT — норм для опционального файла.
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export async function parseSkill(
  skillDir: string,
  options: ParseSkillOptions = {},
): Promise<Skill> {
  const read = options.read ?? defaultRead;
  const expectedName = basename(skillDir);
  const skillMdPath = join(skillDir, 'SKILL.md');
  const permissionsPath = join(skillDir, 'permissions.md');

  let skillSource: string;
  try {
    skillSource = await read(skillMdPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SkillParseError(
      expectedName,
      `не удалось прочитать SKILL.md (${skillMdPath}): ${message}`,
    );
  }

  return parseSkillSources(
    skillDir,
    skillSource,
    await tryReadOptional(permissionsPath, read, options.fileExists),
  );
}

// Экспортируется отдельно для unit-тестов парсера (без I/O).
//
// `skillDir` — абсолютный путь к директории скилла. `name` валидируется
// против `basename(skillDir)`.
// `permissionsSource` — null если файла нет (применяются дефолты).
export function parseSkillSources(
  skillDir: string,
  skillSource: string,
  permissionsSource: string | null,
): Skill {
  const expectedName = basename(skillDir);
  const { frontmatterLines, body } = splitFrontmatterAndBody(expectedName, skillSource);
  const { values } = parseFrontmatter(expectedName, frontmatterLines);

  // ── Обязательные поля ──
  const name = validateName(
    expectedName,
    asScalar(expectedName, 'name', values.get('name')),
    expectedName,
  );
  const description = validateDescription(
    expectedName,
    asScalar(name, 'description', values.get('description')),
  );

  // ── Опциональные расширения ──
  const versionRaw = optionalScalar(name, 'version', values.get('version'));
  const version = versionRaw === undefined ? undefined : validateVersion(name, versionRaw);

  const categoryRaw = optionalScalar(name, 'category', values.get('category'));
  const category = categoryRaw === undefined ? undefined : validateCategory(name, categoryRaw);

  const displayName = optionalScalar(name, 'displayName', values.get('displayName'));
  const icon = optionalScalar(name, 'icon', values.get('icon'));

  const colorRaw = optionalScalar(name, 'color', values.get('color'));
  const color = colorRaw === undefined ? undefined : validateColor(name, colorRaw);

  const dependsOn = values.has('dependsOn')
    ? asStringArray(name, 'dependsOn', values.get('dependsOn') as FrontmatterValue)
    : undefined;

  const compatibleWith = values.has('compatibleWith')
    ? validateCompatibleWith(
        name,
        asMapping(name, 'compatibleWith', values.get('compatibleWith') as FrontmatterValue),
      )
    : undefined;

  const requiresScopes = values.has('requiresScopes')
    ? asStringArray(name, 'requiresScopes', values.get('requiresScopes') as FrontmatterValue)
    : undefined;

  // ── permissions.md → permissions ──
  const permissions: SkillPermissions =
    permissionsSource === null ? {} : parsePermissions(name, name, permissionsSource);

  const skill: Skill = {
    name,
    description,
    prompt: body,
    filePath: skillDir,
    permissions,
  };
  if (version !== undefined) skill.version = version;
  if (category !== undefined) skill.category = category;
  if (displayName !== undefined) skill.displayName = displayName;
  if (icon !== undefined) skill.icon = icon;
  if (color !== undefined) skill.color = color;
  if (dependsOn !== undefined) skill.dependsOn = dependsOn;
  if (compatibleWith !== undefined) skill.compatibleWith = compatibleWith;
  if (requiresScopes !== undefined) skill.requiresScopes = requiresScopes;

  return skill;
}
