// Skill Builder — bridge-side обвязка для wizard'а создания скиллов
// (Фаза 7 плана 2026-05-21-skills-architecture-v3, пункт C).
//
// Контракт:
//   * `handleSkillBuilderMessage({history, userMessage})` — один turn
//     чат-сессии. Передаёт history+userMessage в Sonnet через `call()`
//     из dist/src/llm/call.js (тот же транспорт, что routines — биллинг
//     через gateway/claude.ai-подписку). Просит модель ответить
//     JSON-объектом:
//       {
//         "assistantMessage": "...",       // что показать пользователю
//         "draftSkillMd": "...",           // полный SKILL.md (full-replace)
//         "draftPermissionsMd": "..."      // полный permissions.md
//       }
//     Возвращает то, что распарсилось.
//   * `saveNewSkill({name, skillMd, permissionsMd})` — валидирует через
//     parseSkillSources, пишет в skills/<name>/{SKILL.md, permissions.md}.
//     Кидает Error с понятным сообщением при невалидности или конфликте.
//
// Почему bridge, а не src/skills/:
//   * Bridge — отдельный процесс с собственным tsconfig (rootDir=bridge),
//     эндпоинты живут здесь. Helpers, специфичные для UI-фичи (а не для
//     ядра), логичнее держать рядом с эндпоинтом.
//
// Безопасность:
//   * `name` валидируется regex kebab-case + проверка «нет такой
//     директории» (нельзя перезаписать существующий скилл этим эндпоинтом).
//   * `path.resolve(skillsRoot, name)` сверяется с `startsWith(skillsRoot)`
//     — защита от попыток вроде name='../etc/passwd'.
//   * Системный промпт ясно говорит «не используй секреты, не публикуй
//     креды» — но это secondary, основная защита — schema-валидация.

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SKILLS_DIR_NAME = 'skills';

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export interface SkillBuilderHistoryItem {
  role: 'user' | 'assistant';
  text: string;
}

export interface SkillBuilderRequest {
  history: SkillBuilderHistoryItem[];
  userMessage: string;
}

export interface SkillBuilderReply {
  assistantMessage: string;
  draftSkillMd: string;
  draftPermissionsMd: string;
}

export interface SaveSkillRequest {
  name: string;
  skillMd: string;
  permissionsMd: string;
}

export interface SaveSkillResult {
  name: string;
  filePath: string;
}

export interface SaveSkillDeps {
  /**
   * DI для тестов: подменяет parseSkillSources, чтобы не требовать
   * скомпилированного dist/src/skills/parser.js. По умолчанию грузим
   * runtime'ом из dist/.
   */
  parseSkillSources?: (
    skillDir: string,
    skillSource: string,
    permissionsSource: string | null,
  ) => { name: string };
  /** DI для тестов: подменяет корень skills/. По умолчанию process.cwd()/skills. */
  skillsRoot?: string;
}

// ---------------------------------------------------------------------------
// LLM call adapter. call.ts (src/llm) лежит в src/, поэтому грузим из
// dist/src через dynamic import. То же поведение, что у chat-handler.
// ---------------------------------------------------------------------------

interface CallModule {
  call: (opts: {
    promptId: string;
    model: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    system?: string;
    maxTokens?: number;
  }) => Promise<{ text: string }>;
}

let cachedCall: CallModule | null = null;

async function loadCall(): Promise<CallModule> {
  if (cachedCall !== null) return cachedCall;
  const callPath = resolve(process.cwd(), 'dist', 'src', 'llm', 'call.js');
  const mod = (await import(pathToFileURL(callPath).href)) as CallModule;
  cachedCall = mod;
  return cachedCall;
}

// ---------------------------------------------------------------------------
// Parser loader: для saveNewSkill нужен parseSkillSources, но он в src/.
// ---------------------------------------------------------------------------

interface ParserModule {
  parseSkillSources: (
    skillDir: string,
    skillSource: string,
    permissionsSource: string | null,
  ) => {
    name: string;
  };
}

let cachedParser: ParserModule | null = null;

async function loadParser(): Promise<ParserModule> {
  if (cachedParser !== null) return cachedParser;
  const path = resolve(process.cwd(), 'dist', 'src', 'skills', 'parser.js');
  const mod = (await import(pathToFileURL(path).href)) as ParserModule;
  cachedParser = mod;
  return cachedParser;
}

// ---------------------------------------------------------------------------
// System prompt.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Ты — архитектор скиллов AI-Cofounder. Твоя задача — помочь пользователю
создать SKILL.md и permissions.md для нового скилла маркетплейса.

ПРАВИЛА:
1. Задавай уточняющие вопросы: что скилл делает, какой триггер, какие нужны разрешения.
2. Когда достаточно контекста — генерируй валидный SKILL.md и permissions.md.
3. Format скилла:
   SKILL.md — YAML-frontmatter (между ---) + markdown-тело:
     ---
     name: <kebab-case>
     description: <одна-две фразы>
     version: 1.0.0
     category: publishing | research | writing | analysis | communication | automation | internal
     displayName: <человекочитаемое имя>
     icon: <один emoji>
     color: "#RRGGBB"
     dependsOn: [other-skill-1, other-skill-2]  # опц.
     requiresScopes: [scope.name]  # опц.
     ---

     # <Title>

     ## Назначение
     <что делает>

     ## Алгоритм
     1. ...
     2. ...

   permissions.md — без frontmatter, YAML напрямую:
     bashWhitelist: ["pnpm exec tsx skills/<name>/scripts/<file>.ts"]
     requiredSdkTools: [Bash, Read]
     maxStepsPerInvocation: 20
     requiresApproval: [{action: <name>, via: telegram}]  # опц.
     healthCheck:  # опц.
       script: scripts/health-check.ts
       schedule: "0 7 * * *"

4. bashWhitelist ОБЯЗАН начинаться с "pnpm exec tsx skills/<имя-скилла>/scripts/".
   Любой другой prefix скилл будет отвергнут парсером.
5. ВСЕГДА возвращай ответ строго в JSON-формате:
   {
     "assistantMessage": "что показать пользователю в чате",
     "draftSkillMd": "полный текущий SKILL.md (или пустая строка если рано)",
     "draftPermissionsMd": "полный текущий permissions.md (или пустая строка если рано)"
   }
6. draftSkillMd / draftPermissionsMd — full-replace (не diff). Если пока нет
   контекста — возвращай пустые строки.
7. НЕ используй настоящие пароли/токены в примерах. Если скиллу нужен
   секрет — оформляй через requiresScopes (например vc.publish).
8. Никаких markdown-блоков вокруг JSON-ответа. Только сырой JSON-объект.`;

// ---------------------------------------------------------------------------
// handleSkillBuilderMessage.
// ---------------------------------------------------------------------------

export async function handleSkillBuilderMessage(
  req: SkillBuilderRequest,
): Promise<SkillBuilderReply> {
  const { call } = await loadCall();
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const h of req.history) {
    messages.push({ role: h.role, content: h.text });
  }
  messages.push({ role: 'user', content: req.userMessage });

  const result = await call({
    promptId: 'skill-builder:turn',
    // sonnet — наш «routine» модель (по плану «Чат: использовать
    // существующий Sonnet-вызов через subagent»).
    model: 'claude-sonnet-4-6',
    system: SYSTEM_PROMPT,
    messages,
    maxTokens: 4_000,
  });

  return parseAssistantReply(result.text);
}

function parseAssistantReply(text: string): SkillBuilderReply {
  // Модели иногда оборачивают JSON в ```json … ```. Снимаем обёртку.
  const trimmed = text.trim();
  const unwrapped = unwrapCodeBlock(trimmed);
  try {
    const obj = JSON.parse(unwrapped) as Record<string, unknown>;
    return {
      assistantMessage: typeof obj.assistantMessage === 'string' ? obj.assistantMessage : '',
      draftSkillMd: typeof obj.draftSkillMd === 'string' ? obj.draftSkillMd : '',
      draftPermissionsMd: typeof obj.draftPermissionsMd === 'string' ? obj.draftPermissionsMd : '',
    };
  } catch {
    // Модель ответила свободным текстом — отдаём как assistantMessage,
    // draft'ы пустые. UI всё равно покажет, и пользователь поймёт.
    return {
      assistantMessage: text,
      draftSkillMd: '',
      draftPermissionsMd: '',
    };
  }
}

function unwrapCodeBlock(s: string): string {
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(s);
  if (m !== null && m[1] !== undefined) return m[1];
  return s;
}

// ---------------------------------------------------------------------------
// saveNewSkill.
// ---------------------------------------------------------------------------

export async function saveNewSkill(
  req: SaveSkillRequest,
  deps: SaveSkillDeps = {},
): Promise<SaveSkillResult> {
  // 1. Валидация имени.
  if (!KEBAB_CASE_RE.test(req.name)) {
    throw new Error(
      `поле 'name'='${req.name}' должно быть kebab-case (^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$).`,
    );
  }

  // 2. Резолв пути с защитой от path-traversal.
  const skillsRoot = deps.skillsRoot ?? resolve(process.cwd(), SKILLS_DIR_NAME);
  const skillDir = resolve(skillsRoot, req.name);
  if (!skillDir.startsWith(`${skillsRoot}/`)) {
    throw new Error(`имя '${req.name}' резолвится за пределы skills/ — отказ.`);
  }

  // 3. Не перезаписываем существующий скилл.
  try {
    await stat(skillDir);
    throw new Error(`скилл '${req.name}' уже существует. Удали папку или выбери другое имя.`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Это либо наша же ошибка из throw выше, либо реальная FS-ошибка.
      throw err;
    }
  }

  // 4. Валидация контента через parseSkillSources (in-memory).
  if (req.skillMd.trim() === '') {
    throw new Error('SKILL.md не должен быть пустым.');
  }
  const parseSkillSources = deps.parseSkillSources ?? (await loadParser()).parseSkillSources;
  try {
    const parsed = parseSkillSources(
      skillDir,
      req.skillMd,
      req.permissionsMd.trim() === '' ? null : req.permissionsMd,
    );
    if (parsed.name !== req.name) {
      throw new Error(
        `frontmatter 'name'='${parsed.name}' не совпадает с указанным '${req.name}'.`,
      );
    }
  } catch (err) {
    // parseSkillSources бросает SkillParseError — пробрасываем как
    // обычную Error с тем же сообщением.
    throw new Error((err as Error).message);
  }

  // 5. Запись.
  await mkdir(skillDir, { recursive: true });
  await mkdir(resolve(skillDir, 'scripts'), { recursive: true });
  await writeFile(resolve(skillDir, 'SKILL.md'), req.skillMd, 'utf8');
  if (req.permissionsMd.trim() !== '') {
    await writeFile(resolve(skillDir, 'permissions.md'), req.permissionsMd, 'utf8');
  }

  return { name: req.name, filePath: skillDir };
}

// ---------------------------------------------------------------------------
// updateSkill / deleteSkill / readSkillRaw (Ф5 — редактирование скиллов из UI).
// ---------------------------------------------------------------------------

function resolveSkillDir(name: string, deps: SaveSkillDeps): string {
  if (!KEBAB_CASE_RE.test(name)) {
    throw new Error(`поле 'name'='${name}' должно быть kebab-case.`);
  }
  const skillsRoot = deps.skillsRoot ?? resolve(process.cwd(), SKILLS_DIR_NAME);
  const skillDir = resolve(skillsRoot, name);
  if (skillDir !== `${skillsRoot}/${name}` && !skillDir.startsWith(`${skillsRoot}/`)) {
    throw new Error(`имя '${name}' резолвится за пределы skills/ — отказ.`);
  }
  return skillDir;
}

/** Перезапись существующего скилла (в отличие от saveNewSkill — требует существования). */
export async function updateSkill(
  req: SaveSkillRequest,
  deps: SaveSkillDeps = {},
): Promise<SaveSkillResult> {
  const skillDir = resolveSkillDir(req.name, deps);

  // Требуем, чтобы скилл уже существовал (update, не create).
  try {
    await stat(skillDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`скилл '${req.name}' не найден. Для создания используй POST /skills.`);
    }
    throw err;
  }

  if (req.skillMd.trim() === '') throw new Error('SKILL.md не должен быть пустым.');
  const parseSkillSources = deps.parseSkillSources ?? (await loadParser()).parseSkillSources;
  try {
    const parsed = parseSkillSources(
      skillDir,
      req.skillMd,
      req.permissionsMd.trim() === '' ? null : req.permissionsMd,
    );
    if (parsed.name !== req.name) {
      throw new Error(`frontmatter 'name'='${parsed.name}' не совпадает с '${req.name}'.`);
    }
  } catch (err) {
    throw new Error((err as Error).message);
  }

  await writeFile(resolve(skillDir, 'SKILL.md'), req.skillMd, 'utf8');
  const permPath = resolve(skillDir, 'permissions.md');
  if (req.permissionsMd.trim() !== '') {
    await writeFile(permPath, req.permissionsMd, 'utf8');
  } else {
    // Пустой permissions → убираем файл (скилл вернётся к дефолтным ограничениям).
    await rm(permPath, { force: true });
  }
  return { name: req.name, filePath: skillDir };
}

export async function deleteSkill(
  name: string,
  deps: SaveSkillDeps = {},
): Promise<{ name: string }> {
  const skillDir = resolveSkillDir(name, deps);
  try {
    await stat(skillDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`скилл '${name}' не найден.`);
    }
    throw err;
  }
  await rm(skillDir, { recursive: true, force: true });
  return { name };
}

/** Сырой SKILL.md + permissions.md (для prefill edit-режима в UI). */
export async function readSkillRaw(
  name: string,
  deps: SaveSkillDeps = {},
): Promise<{ name: string; skillMd: string; permissionsMd: string }> {
  const skillDir = resolveSkillDir(name, deps);
  let skillMd: string;
  try {
    skillMd = await readFile(resolve(skillDir, 'SKILL.md'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`скилл '${name}' не найден.`);
    }
    throw err;
  }
  let permissionsMd = '';
  try {
    permissionsMd = await readFile(resolve(skillDir, 'permissions.md'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return { name, skillMd, permissionsMd };
}
