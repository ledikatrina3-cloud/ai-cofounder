// Routine runtime (фаза 3.1, 3.2).
//
// executeRoutine — «мозг» M3': берёт Routine + ProjectMeta + runDate,
// формирует system prompt, маппит tools в SDK builtins, запускает
// sub-agent через runSubagent и возвращает RoutineResult.
//
// Что делает executeRoutine:
//   1. Загружает ProjectMap (для digest в system prompt).
//   2. resolveToolMappings(routine.tools) → sdkTools + unsupportedTools.
//   3. Если unsupportedTools.length > 0 — console.warn (не ошибка).
//   4. Строит systemPrompt из трёх частей (characterPrelude + projectMapDigest
//      + [unsupported-notice] + routinePrompt), разделённых `\n\n---\n\n`.
//   5. Строит canUseTool callback через buildCanUseTool (фаза 3.2):
//      - проверяет, что вызванный tool входит в sdkTools routine'а;
//      - если Bash — дополнительно проверяет whitelist;
//      - при deny — пишет audit.security.tool.deny в БД.
//   6. Вызывает runSubagent.
//   7. Вычисляет output (текст из последнего assistant message).
//   8. Считает toolCallCount (tool_use блоки по всем messages).
//   9. Возвращает RoutineResult.
//
// Что НЕ делает:
//   * Не пишет audit.routine.* Records — это dispatcher.ts.
//   * Не отправляет Telegram — это фаза 3.3.
//   * Не управляет idempotency — это dispatcher.ts.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { PrismaClient } from '../db/client.js';
import { getPrisma } from '../db/client.js';
import { type SubagentRunResult, runSubagent as defaultRunSubagent } from '../llm/subagent.js';
import { emit } from '../observe/bridge.js';
import { getOrg as defaultGetOrg } from '../org/registry.js';
import type { OrgKnowledge } from '../org/types.js';
import type { DbConnConfig, ProjectMap } from '../projects/map.js';
import { loadProjectMap as defaultLoadProjectMap } from '../projects/map.js';
import { type ProjectMeta, getProject as defaultGetProject } from '../projects/registry.js';
import { resolveDeps as defaultResolveDeps } from '../skills/registry.js';
import type { Skill } from '../skills/types.js';
import { DEFAULT_WHITELIST, canRunCommand } from '../tools/project-bash/index.js';
import { type DbQueryResult, projectDbQuery } from '../tools/project-db/index.js';
import { resolveRuleInclude } from './agent-loader.js';
import type { Routine } from './parser.js';
import { PREFETCHED_TOOL_NAMES, resolveToolMappings } from './tool-registry.js';

// Тип canUseTool берём из SubagentRunOptions — он уже совместим с SDK CanUseTool.
type CanUseTool = NonNullable<Parameters<typeof defaultRunSubagent>[0]['canUseTool']>;

// ---------------------------------------------------------------------------
// Публичный контракт.
// ---------------------------------------------------------------------------

export interface RoutineResult {
  /** 'ok' — sub-agent завершился успешно; 'timeout' — AbortController сработал;
   *  'failed' — SDK вернул is_error или SubagentRunResult.result?.is_error. */
  status: 'ok' | 'failed' | 'timeout';
  /** Финальный текст от sub-agent — все text-блоки последнего assistant-сообщения. */
  output: string;
  totalUsd: number;
  totalTokens: number;
  durationMs: number;
  /** Количество tool_use блоков по всем messages (для Bridge и audit). */
  toolCallCount: number;
  /** ID Записи audit.spend или null (если sub-agent упал до usage). */
  spendRecordId: string | null;
}

export interface ExecRoutineDeps {
  runSubagent?: typeof defaultRunSubagent;
  loadProjectMap?: (projectId: string) => Promise<ProjectMap>;
  db?: PrismaClient;
  /** DI для тестов: заменяет fetchDbContext (иначе идёт реальный запрос к БД). */
  fetchDbContextFn?: (projectMap: ProjectMap, runDate: string) => Promise<string>;
  /**
   * DI для тестов: заменяет skills/registry.resolveDeps. Принимает имена скиллов,
   * возвращает массив Skill с уже резолвнутыми транзитивными зависимостями
   * в топологическом порядке (deps первыми). Прод — использует skills/registry.
   */
  resolveSkillDeps?: (skillNames: string[]) => Promise<Skill[]>;
  /**
   * DI для тестов: заменяет org/registry.getOrg. Должен вернуть OrgKnowledge
   * или null (если org/ отсутствует / не нужно инжектировать). Прод —
   * вызывает getOrg() из реального cwd; при отсутствии файлов ловим
   * OrgParseError и инжекцию пропускаем silently.
   */
  getOrg?: () => Promise<OrgKnowledge | null>;
  /**
   * DI для тестов: заменяет projects/registry.getProject. Используется только
   * unattended-веткой (executeUnattendedRoutine) для резолва routine.targetProject
   * в ProjectMeta. Прод — реальный реестр из config/projects.md.
   */
  getProject?: (id: string) => Promise<ProjectMeta | null>;
}

/**
 * Результат резолва скиллов routine'ы. Используется executeRoutine'ом для
 * подсчёта объединённых permissions, для дополнения system prompt и для
 * передачи имён в audit.routine.start.
 *
 * `resolvedSkills` — массив скиллов в топологическом порядке (deps первыми),
 * включая транзитивные зависимости. Пустой массив если routine не объявила
 * skills.
 *
 * `bashWhitelistUnion` — дедуплицированный union routine.bashWhitelist + всех
 * `skill.permissions.bashWhitelist`. null если ни один источник не задал
 * (значит canRunCommand использует DEFAULT_WHITELIST).
 *
 * `extraSdkTools` — SDK builtins, которые требуют скиллы поверх routine.tools.
 * Например, если скилл требует Bash, а routine не объявил project.bash, мы
 * добавляем Bash и логируем warning. Дедуплицировано.
 *
 * `maxSteps` — минимум из всех `skill.permissions.maxStepsPerInvocation`.
 * undefined если ни один скилл не задал — runtime не лимитирует.
 *
 * Экспортирован, чтобы dispatcher.ts мог переиспользовать резолв для
 * `audit.routine.start.properties.skills`.
 */
export interface ResolvedRoutineSkills {
  resolvedSkills: Skill[];
  bashWhitelistUnion: string[] | null;
  extraSdkTools: string[];
  maxSteps: number | undefined;
}

// ---------------------------------------------------------------------------
// Главная функция.
// ---------------------------------------------------------------------------

export async function executeRoutine(
  routine: Routine,
  project: ProjectMeta,
  runDate: string,
  deps: ExecRoutineDeps = {},
): Promise<RoutineResult> {
  const db = deps.db ?? getPrisma();
  const runSubagent = deps.runSubagent ?? defaultRunSubagent;
  const loadMap = deps.loadProjectMap ?? defaultLoadProjectMap;
  const fetchDbCtx = deps.fetchDbContextFn ?? fetchDbContext;

  // ── Unattended cross-project ветка (план 2026-05-22-cross-project-runner).
  //
  // Если в routine.targetProject указан id чужого проекта — НЕ строим свой
  // systemPrompt, НЕ ограничиваем tools, НЕ резолвим скиллы HQ. Просто
  // спавним `claude -p` в cwd=targetProject.path с bypassPermissions — там
  // живёт свой CLAUDE.md, свои `.claude/skills/*`, свои MCP-серверы. Skill
  // в чужом репо триггерится по prompt'у автономно (14 этапов, sub-agents,
  // браузер, прод-деплой). Мы парсим stream-json и возвращаем RoutineResult
  // тем же контрактом, что и in-process ветка — dispatcher не различает.
  if (routine.targetProject !== undefined || routine.targetCwd !== undefined) {
    return executeUnattendedRoutine(routine, project, runDate, runSubagent, db, deps);
  }

  // 1. Загружаем ProjectMap.
  const projectMap = await loadMap(project.id);

  // 2. Маппинг tools.
  const { sdkTools, unsupportedTools } = resolveToolMappings(routine.tools);

  // 3. Логируем unsupported — не блокируемся.
  if (unsupportedTools.length > 0) {
    const names = unsupportedTools.map((t) => t.name).join(', ');
    console.warn(
      `[routine:runtime] routine '${routine.id}': следующие tools не поддерживаются через SDK в этом запуске и будут пропущены: ${names}. Используй system prompt для инъекции данных.`,
    );
    for (const t of unsupportedTools) {
      console.warn(`  [routine:runtime]   - ${t.name}: ${t.reason}`);
    }
  }

  // 3a. Pre-fetch DB context если routine объявила project.db.query.
  //     Данные инжектируются в system prompt — агент получает готовые числа без tool-вызовов.
  const dbContext = routine.tools.includes('project.db.query')
    ? await fetchDbCtx(projectMap, runDate)
    : '';

  // 3b. Резолвим скиллы (Фаза 2 плана 2026-05-21-skills-architecture-v3).
  //     resolveSkills — pure: один пробег по skills/registry + проверка forceLoad
  //     против резолвнутого набора. Возвращает skills + permissions union.
  const resolved = await resolveRoutineSkills(routine, deps.resolveSkillDeps);

  // 3c. Эмит skill.loaded для каждого инжектируемого скилла (discovery / forceLoad).
  //     Fire-and-forget; Bridge может быть выключен.
  const forceLoadSet = new Set<string>(routine.forceLoad ?? []);
  for (const skill of resolved.resolvedSkills) {
    const mode: 'discovery' | 'forceLoad' = forceLoadSet.has(skill.name)
      ? 'forceLoad'
      : 'discovery';
    void emit({
      type: 'skill.loaded',
      routineId: routine.id,
      skillName: skill.name,
      ...(skill.displayName !== undefined ? { displayName: skill.displayName } : {}),
      ...(skill.icon !== undefined ? { icon: skill.icon } : {}),
      mode,
    });
  }

  // 3d. Org knowledge (Фаза 3 плана 2026-05-21-skills-architecture-v3, п.2).
  //     Если среди резолвнутых скиллов есть writing/research — подгружаем
  //     org/identity.md + brand-voice.md + audience.md. Если org/ нет или
  //     ни один скилл не нуждается в org-знаниях — null, инжекция пропускается.
  const org = await loadOrgIfNeeded(resolved.resolvedSkills, deps.getOrg);

  // 3e. Guardrails — раскрываем rules.md агента (agents/<id>/rules.md), если есть:
  //     inline-текст плюс @<relative-path> include'ы (resolveRuleInclude отвергает
  //     '..'-traversal за пределы папки агента). Legacy routines/*.md не задают
  //     routine.rules → guardrails === null, секция не инжектится.
  let guardrails: string | null = null;
  if (routine.rules !== undefined) {
    if (routine.agentDir !== undefined) {
      const agentDir = routine.agentDir;
      const expanded: string[] = [];
      for (const line of routine.rules.split('\n')) {
        const m = line.match(/^@(\S+)\s*$/);
        if (m !== null && m[1] !== undefined) {
          const incAbs = resolveRuleInclude(agentDir, m[1]); // кидает на '..'
          expanded.push(await readFile(incAbs, 'utf8'));
        } else {
          expanded.push(line);
        }
      }
      guardrails = expanded.join('\n');
    } else {
      guardrails = routine.rules;
    }
  }

  // 4. Строим systemPrompt (+ skill discovery / forceLoad блоки + org-knowledge + guardrails).
  const systemPrompt = buildSystemPrompt({
    routine,
    project,
    runDate,
    projectMap,
    unsupportedTools,
    dbContext,
    skills: resolved.resolvedSkills,
    forceLoad: forceLoadSet,
    org,
    guardrails,
  });

  // 5. canUseTool callback (фаза 3.2): проверка набора tools + Bash-whitelist.
  //    Routine.bashWhitelist + skills.bashWhitelist объединяются (set-union,
  //    дедуплицировано). FORBIDDEN_SUBSTRINGS применяются всегда — расширение
  //    не ослабляет защиту от инъекций. См. resolveRoutineSkills.
  //
  //    Скилловые SDK tools (например, Bash требуемый скиллом) автоматически
  //    добавляются в allowedTools поверх routine.tools. Это нужно, чтобы скилл
  //    мог запустить свой `pnpm exec tsx skills/<name>/scripts/...` даже если
  //    routine забыл объявить project.bash. Warning логируется.
  const augmentedSdkTools = mergeUnique(sdkTools, resolved.extraSdkTools);
  if (resolved.extraSdkTools.length > 0) {
    console.warn(
      `[routine:runtime] routine '${routine.id}': скиллы потребовали дополнительные SDK tools: ${resolved.extraSdkTools.join(', ')}. Добавил в allowedTools (routine.tools не покрывал их).`,
    );
  }
  const effectiveWhitelist =
    resolved.bashWhitelistUnion !== null && resolved.bashWhitelistUnion.length > 0
      ? mergeUnique(DEFAULT_WHITELIST as string[], resolved.bashWhitelistUnion)
      : undefined; // undefined → canRunCommand использует DEFAULT_WHITELIST

  // Tracker для skill.action.start/end: canUseTool записывает сюда инфу о
  // bash-командах, начинающихся с `pnpm exec tsx skills/<name>/scripts/`.
  // После runSubagent проходим по messages и эмитим .end по сопоставлению
  // tool_use.id ↔ tool_result.tool_use_id.
  const skillActionTracker = new Map<string, SkillActionEntry>();
  const canUseTool: CanUseTool = buildCanUseTool(
    augmentedSdkTools,
    routine.id,
    db,
    effectiveWhitelist,
    skillActionTracker,
  );

  // 6. Вызываем runSubagent. maxTurns: если скилл указал maxStepsPerInvocation,
  //    используем минимум; иначе старый дефолт 50.
  const maxTurns = resolved.maxSteps ?? 50;
  const subagentResult = await runSubagent(
    {
      promptId: 'routine:run',
      prompt: routine.prompt,
      systemPrompt,
      model: routine.model,
      cwd: project.path,
      allowedTools: augmentedSdkTools,
      canUseTool,
      timeoutMs: routine.timeoutMs,
      maxTurns,
      cycleParentId: null,
      routineId: routine.id,
    },
    db,
  );

  // 6a. Emit skill.action.end по результатам tool-вызовов скиллов.
  emitSkillActionEnds(subagentResult, skillActionTracker, routine.id);

  // 7. Вычисляем output.
  const output = extractOutput(subagentResult);

  // 8. Считаем toolCallCount.
  const toolCallCount = countToolCalls(subagentResult);

  // 9. Определяем status.
  const status = resolveStatus(subagentResult);

  // 10. Вычисляем токены.
  const totalTokens = computeTotalTokens(subagentResult);

  return {
    status,
    output,
    totalUsd: subagentResult.result?.total_cost_usd ?? 0,
    totalTokens,
    durationMs: subagentResult.durationMs,
    toolCallCount,
    spendRecordId: subagentResult.spendRecordId,
  };
}

// ---------------------------------------------------------------------------
// Unattended cross-project выполнение (план 2026-05-22-cross-project-runner).
//
// Используется когда routine.targetProject задан. Контракт прост: prompt
// (routine.prompt) проксируется в `claude -p` в чужом cwd под bypassPermissions.
// Никакого HQ-systemPrompt, никаких allowedTools, никакого canUseTool — там
// уже есть свой CLAUDE.md и `.claude/settings.json`. RoutineResult формируется
// тем же путём (extractOutput/resolveStatus/...), что и in-process ветка.
//
// `maxTurns` поднят до 500 — 14-этапные workflow со множеством sub-agent'ов
// (например, build-guide) легко делают сотни turns. Меньше —
// рискуем нарваться на «max_turns exceeded» в середине прогона.
//
// Modelы: routine.model передаётся в --model. Если фаундер хочет лимит на
// opus — ставит claude-opus-4-7 в frontmatter. Бюджет — common pre-call
// guard (loadBudgetLimits/guardOrDeny) внутри runSubagentViaCli.
//
// Безопасность: при unattended-режиме отказываемся работать с disabled-
// проектами (path не существует или enabled=false). Это защищает от
// случайного запуска skill'а в репо, которого физически нет на маке.
// ---------------------------------------------------------------------------

const UNATTENDED_MAX_TURNS = 500;

async function executeUnattendedRoutine(
  routine: Routine,
  _hostProject: ProjectMeta,
  _runDate: string,
  runSubagent: NonNullable<ExecRoutineDeps['runSubagent']>,
  db: PrismaClient,
  deps: ExecRoutineDeps,
): Promise<RoutineResult> {
  // Разрешаем cwd чужого репо: либо из target.yml агента (targetCwd), либо из
  // legacy targetProject (config/projects.md). targetCwd имеет приоритет.
  let targetPath: string;
  if (routine.targetCwd !== undefined && routine.targetCwd !== '') {
    targetPath = routine.targetCwd;
  } else {
    const targetId = routine.targetProject;
    if (targetId === undefined || targetId === '') {
      throw new Error(
        `routine '${routine.id}': executeUnattendedRoutine вызван без targetProject и без targetCwd — это баг runtime'а.`,
      );
    }
    const getProject = deps.getProject ?? defaultGetProject;
    const target = await getProject(targetId);
    if (target === null) {
      throw new Error(
        `routine '${routine.id}': targetProject='${targetId}' не найден в config/projects.md. Добавь секцию [## ${targetId}] в реестр или поправь поле targetProject в routine-файле.`,
      );
    }
    if (!target.enabled) {
      throw new Error(
        `routine '${routine.id}': targetProject='${targetId}' помечен enabled=false (path '${target.path}' не существует или явно отключён). Unattended-routine не запускается на disabled-проектах — это защита от случайного запуска skill в репо, которого нет на маке.`,
      );
    }
    targetPath = target.path;
  }

  // Hard-guard модели перед raw --model passthrough: к этому моменту agent-loader
  // уже резолвнул алиасы (opus/sonnet/haiku) в полный claude-*/voyage-* id. Если
  // прилетело что-то иное — падаем ДО спавна claude, а не молча с битой моделью.
  if (!/^(claude|voyage)-[a-z0-9.-]+$/i.test(routine.model)) {
    throw new Error(
      `routine '${routine.id}': model='${routine.model}' не полный claude-*/voyage-* id перед --model passthrough. Алиасы (opus/sonnet/haiku) должны резолвиться в agent-loader.`,
    );
  }

  // syncEnv (cross-project secrets-allowlist): копируем в <targetPath>/.env.local
  // ТОЛЬКО ключи из target.yml syncEnv, которые также объявлены в permissions.yml
  // secrets[]. Агент не может утечь секрет, который не заявил (план §6).
  if (routine.syncEnv !== undefined && routine.syncEnv.length > 0) {
    await syncEnvToTarget(routine, targetPath);
  }

  // Note: routine.start уже эмитнут dispatcher'ом до вызова executeRoutine,
  // дублировать не надо. assistant.message/tool.start/tool.end эмитятся из
  // runSubagentViaCli по мере стрима — UI получит «живой» процесс из чужого
  // репо тем же каналом, что и in-process subagent.

  const subagentResult = await runSubagent(
    {
      promptId: 'routine:unattended',
      prompt: routine.prompt,
      // systemPrompt НЕ задаём — claude CLI в --print подгружает свой
      // дефолт (Claude Code skin) + target's CLAUDE.md из cwd. Это и нужно:
      // не хотим инжектировать ai-cofounder-контекст в чужую сессию.
      model: routine.model,
      cwd: targetPath,
      // allowedTools пустой — claude CLI использует все встроенные tools
      // плюс MCP/plugins из target's .claude/settings.json. Restricting не
      // имеет смысла: в чужом проекте сами settings.json диктуют что можно.
      allowedTools: [],
      timeoutMs: routine.timeoutMs,
      maxTurns: UNATTENDED_MAX_TURNS,
      permissionMode: 'bypassPermissions',
      cycleParentId: null,
      routineId: routine.id,
    },
    db,
  );

  const output = extractOutput(subagentResult);
  const status = resolveStatus(subagentResult);
  const totalTokens = computeTotalTokens(subagentResult);
  const toolCallCount = countToolCalls(subagentResult);

  return {
    status,
    output,
    totalUsd: subagentResult.result?.total_cost_usd ?? 0,
    totalTokens,
    durationMs: subagentResult.durationMs,
    toolCallCount,
    spendRecordId: subagentResult.spendRecordId,
  };
}

// syncEnvToTarget — пишет в <targetPath>/.env.local ключи из routine.syncEnv,
// которые ТАКЖЕ объявлены в routine.secrets[] (secrets-allowlist). Idempotent
// merge: читает существующий .env.local, обновляет разрешённые ключи, дописывает
// отсутствующие. Ключи не из secrets[] — пропускаются с warning'ом (агент не
// может утечь секрет, который не заявил). Срабатывает ТОЛЬКО для cross-project
// агентов с target.yml syncEnv — для self-contained агентов недостижимо.
async function syncEnvToTarget(routine: Routine, targetPath: string): Promise<void> {
  const requested = routine.syncEnv ?? [];
  const allowedSet = new Set(routine.secrets ?? []);
  const allowed = requested.filter((k) => allowedSet.has(k));
  const skipped = requested.filter((k) => !allowedSet.has(k));
  if (skipped.length > 0) {
    console.warn(
      `[routine:runtime] routine '${routine.id}': syncEnv ключи [${skipped.join(', ')}] не объявлены в permissions.yml secrets[] — НЕ синкаю (secrets-allowlist).`,
    );
  }
  const present = allowed.filter((k) => {
    const v = process.env[k];
    return typeof v === 'string' && v !== '';
  });
  if (present.length === 0) return;

  const envLocalPath = join(targetPath, '.env.local');
  let existing = '';
  try {
    existing = await readFile(envLocalPath, 'utf8');
  } catch {
    // файла нет — создадим
  }
  const lines = existing === '' ? [] : existing.split('\n');
  const indexByKey = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]?.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (m?.[1] !== undefined) indexByKey.set(m[1], i);
  }
  for (const key of present) {
    const entry = `${key}=${JSON.stringify(process.env[key] ?? '')}`;
    const idx = indexByKey.get(key);
    if (idx !== undefined) lines[idx] = entry;
    else lines.push(entry);
  }
  const out = lines.join('\n');
  await writeFile(envLocalPath, out.endsWith('\n') ? out : `${out}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Skills резолв + permissions union (Фаза 2 плана 2026-05-21-skills-architecture-v3).
// ---------------------------------------------------------------------------

/**
 * resolveRoutineSkills — собирает Skill-объекты по `routine.skills`, резолвит
 * транзитивные deps через skills/registry.resolveDeps, и считает объединённые
 * permissions:
 *
 *   - bashWhitelistUnion: дедуплицированный union routine.bashWhitelist +
 *     каждый skill.permissions.bashWhitelist.
 *   - extraSdkTools: SDK builtins, которые требуют скиллы поверх routine.tools.
 *     Например, скилл с `requiredSdkTools: [Bash]` добавляет Bash, даже если
 *     routine.tools не содержит `project.bash`. Warning логируется в executeRoutine.
 *   - maxSteps: минимум `maxStepsPerInvocation` по всем скиллам. undefined,
 *     если ни один скилл не задал — runtime не лимитирует.
 *
 * Безопасность: bashWhitelist скилла валидируется на формат `pnpm exec tsx
 * skills/<name>/scripts/...` уже в skills/parser.ts (см. validateBashWhitelist).
 * Здесь дополнительной валидации не нужно — доверяем парсеру скилла.
 *
 * Forсeload-валидация: проверяем что все имена в routine.forceLoad входят в
 * резолвнутый набор (после deps). Кидаем Error если нет — лучше явная ошибка
 * на старте, чем тихое отсутствие инструкции в prompt'е.
 *
 * Экспортирован, чтобы dispatcher.ts мог получить имена скиллов для
 * audit.routine.start.properties без второго резолва.
 */
export async function resolveRoutineSkills(
  routine: Routine,
  resolveDepsImpl?: (skillNames: string[]) => Promise<Skill[]>,
): Promise<ResolvedRoutineSkills> {
  const routineBash = routine.bashWhitelist ?? [];
  if (routine.skills === undefined || routine.skills.length === 0) {
    return {
      resolvedSkills: [],
      bashWhitelistUnion: routineBash.length > 0 ? mergeUnique([], routineBash) : null,
      extraSdkTools: [],
      maxSteps: undefined,
    };
  }

  const resolveDeps = resolveDepsImpl ?? ((names: string[]) => defaultResolveDeps(names));
  const resolvedSkills = await resolveDeps(routine.skills);

  // Валидация forceLoad: все имена должны входить в резолвнутый набор.
  const resolvedNames = new Set(resolvedSkills.map((s) => s.name));
  for (const name of routine.forceLoad ?? []) {
    if (!resolvedNames.has(name)) {
      throw new Error(
        `routine '${routine.id}': forceLoad содержит '${name}', но этот скилл не объявлен в skills (и не является транзитивной зависимостью). Добавь его в skills: [...] или убери из forceLoad.`,
      );
    }
  }

  // Объединяем permissions.
  let bashList: string[] = [...routineBash];
  const extraTools: string[] = [];
  let minSteps: number | undefined;

  for (const skill of resolvedSkills) {
    const perms = skill.permissions;
    if (perms.bashWhitelist !== undefined) {
      bashList = mergeUnique(bashList, perms.bashWhitelist);
    }
    if (perms.requiredSdkTools !== undefined) {
      for (const tool of perms.requiredSdkTools) {
        if (!extraTools.includes(tool)) extraTools.push(tool);
      }
    }
    if (perms.maxStepsPerInvocation !== undefined) {
      minSteps =
        minSteps === undefined
          ? perms.maxStepsPerInvocation
          : Math.min(minSteps, perms.maxStepsPerInvocation);
    }
  }

  return {
    resolvedSkills,
    bashWhitelistUnion: bashList.length > 0 ? bashList : null,
    extraSdkTools: extraTools,
    maxSteps: minSteps,
  };
}

/** Дедуплицированный union с сохранением порядка из `a`, затем `b`. */
function mergeUnique(a: string[], b: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const arr of [a, b]) {
    for (const v of arr) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool authorization (фаза 3.2).
// ---------------------------------------------------------------------------

/**
 * Запись skill-action в tracker'е. Используется для скрепления
 * skill.action.start (эмитится на canUseTool allow) и skill.action.end
 * (эмитится после runSubagent, когда мы видим tool_result).
 */
export interface SkillActionEntry {
  skillName: string;
  actionId: string;
  startedAt: number;
  command: string;
}

/**
 * Извлекает имя скилла из bash-команды, начинающейся с
 * `pnpm exec tsx skills/<name>/scripts/...`. Возвращает null если команда
 * не соответствует skill-формату.
 *
 * Экспортирован для тестов.
 */
export function extractSkillNameFromBash(cmd: string): string | null {
  const m = /^pnpm exec tsx skills\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/scripts\//.exec(cmd);
  return m === null ? null : (m[1] ?? null);
}

/**
 * buildCanUseTool — строит canUseTool callback для sub-agent'а.
 *
 * Логика:
 *   1. Если toolName не в sdkTools → deny + audit.security.tool.deny (reason: 'tool-not-in-routine-declaration').
 *   2. Если toolName === 'Bash' → проверить cmd через canRunCommand.
 *      - Если blocked → deny + audit.security.tool.deny (reason: 'bash-whitelist-violation').
 *      - Если allow и cmd matches `pnpm exec tsx skills/<name>/scripts/...` →
 *        регистрируем в skillActionTracker и эмитим skill.action.start.
 *   3. allow.
 *
 * Экспортируется для тестов.
 */
export function buildCanUseTool(
  sdkTools: string[],
  routineId: string,
  db: PrismaClient,
  bashWhitelist?: string[],
  skillActionTracker?: Map<string, SkillActionEntry>,
): CanUseTool {
  return async (toolName: string, input: Record<string, unknown>, ctx: unknown) => {
    // 1. Проверяем, что tool входит в объявленный набор routine.
    if (!sdkTools.includes(toolName)) {
      // Аудит в try/catch: если БД недоступна — всё равно возвращаем deny, не бросаем.
      try {
        await recordSecurityToolDeny(
          { routineId, toolName, input, reason: 'tool-not-in-routine-declaration' },
          db,
        );
      } catch (auditErr) {
        console.error('[runtime:security] audit write failed (denying anyway):', auditErr);
      }
      return {
        behavior: 'deny' as const,
        message: `tool '${toolName}' не объявлен в routine '${routineId}'`,
      };
    }

    // 2. Если это Bash — дополнительная проверка whitelist.
    if (toolName === 'Bash') {
      const cmd = typeof input.command === 'string' ? input.command : '';
      if (!canRunCommand(cmd, bashWhitelist)) {
        try {
          await recordSecurityToolDeny(
            { routineId, toolName, input, reason: 'bash-whitelist-violation' },
            db,
          );
        } catch (auditErr) {
          console.error('[runtime:security] audit write failed (denying anyway):', auditErr);
        }
        return {
          behavior: 'deny' as const,
          message: `Bash-команда не в whitelist'е: ${cmd.slice(0, 80)}`,
        };
      }

      // Skill-action tracking: если cmd запускает skill-скрипт и нам передан
      // tracker — регистрируем и эмитим skill.action.start. End эмитится из
      // executeRoutine после прохода по messages.
      if (skillActionTracker !== undefined) {
        const skillName = extractSkillNameFromBash(cmd);
        if (skillName !== null) {
          // SDK передаёт tool_use_id в ctx (если есть). Пробуем разные shape'ы.
          const ctxRecord = ctx as Record<string, unknown> | null | undefined;
          const toolUseId = (
            ctxRecord !== null && ctxRecord !== undefined
              ? (ctxRecord.tool_use_id ?? ctxRecord.toolUseId ?? null)
              : null
          ) as string | null;
          const actionId =
            typeof toolUseId === 'string' && toolUseId.length > 0 ? toolUseId : ulid();
          const entry: SkillActionEntry = {
            skillName,
            actionId,
            startedAt: Date.now(),
            command: cmd,
          };
          // tracker keyed by actionId — если у нас нет реального toolUseId,
          // emitSkillActionEnds в любом случае пройдётся по messages и эмитит
          // end по последовательности (best-effort).
          skillActionTracker.set(actionId, entry);
          void emit({
            type: 'skill.action.start',
            routineId,
            skillName,
            actionId,
            command: cmd,
          });
        }
      }
    }

    // 3. Разрешаем.
    return { behavior: 'allow' as const, updatedInput: input };
  };
}

/**
 * emitSkillActionEnds — проходит по сообщениям sub-agent'а, ищет tool_use
 * блоки Bash, чьи команды соответствуют skill-скриптам, и эмитит
 * skill.action.end с durationMs (от entry.startedAt до tool_result время).
 *
 * Если в tracker'е нет соответствия по toolUseId, делаем best-effort:
 * сопоставляем по последовательности (FIFO match по skillName).
 */
function emitSkillActionEnds(
  result: SubagentRunResult,
  tracker: Map<string, SkillActionEntry>,
  routineId: string,
): void {
  if (tracker.size === 0) return;

  // Соберём все tool_use Bash блоки (id, command) и tool_result (id, isError).
  type ToolUseInfo = { id: string; command: string };
  const toolUses: ToolUseInfo[] = [];
  type ToolResultInfo = { id: string; isError: boolean };
  const toolResults = new Map<string, ToolResultInfo>();

  for (const msg of result.messages) {
    const m = msg as Record<string, unknown>;
    if (m.type === 'assistant') {
      const message = m.message as Record<string, unknown> | undefined;
      const content = (message?.content ?? m.content) as unknown;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type !== 'tool_use' || b.name !== 'Bash' || typeof b.id !== 'string') continue;
        const inputObj = b.input as Record<string, unknown> | undefined;
        const cmd = typeof inputObj?.command === 'string' ? inputObj.command : '';
        toolUses.push({ id: b.id, command: cmd });
      }
    } else if (m.type === 'user') {
      const message = m.message as Record<string, unknown> | undefined;
      const content = (message?.content ?? m.content) as unknown;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
        toolResults.set(b.tool_use_id, { id: b.tool_use_id, isError: b.is_error === true });
      }
    }
  }

  // FIFO queue trackEntries по skillName — чтобы сопоставить ту, что попала
  // в tracker по ulid (без реального toolUseId).
  const queueBySkill = new Map<string, SkillActionEntry[]>();
  for (const e of tracker.values()) {
    let q = queueBySkill.get(e.skillName);
    if (q === undefined) {
      q = [];
      queueBySkill.set(e.skillName, q);
    }
    q.push(e);
  }
  for (const q of queueBySkill.values()) {
    q.sort((a, b) => a.startedAt - b.startedAt);
  }

  for (const tu of toolUses) {
    const skillName = extractSkillNameFromBash(tu.command);
    if (skillName === null) continue;
    let entry = tracker.get(tu.id);
    if (entry === undefined) {
      // Best-effort: возьмём первый по FIFO для этого skillName.
      const q = queueBySkill.get(skillName);
      if (q !== undefined && q.length > 0) {
        entry = q.shift();
      }
    }
    if (entry === undefined) continue;

    const tr = toolResults.get(tu.id);
    const durationMs = Date.now() - entry.startedAt;
    const isError = tr?.isError ?? false;
    void emit({
      type: 'skill.action.end',
      routineId,
      skillName,
      actionId: entry.actionId,
      durationMs,
      isError,
    });
  }
}

/**
 * recordSecurityToolDeny — записывает audit.security.tool.deny в БД.
 *
 * properties: { routineId, toolName, reason, inputPreview (первые 200 символов JSON) }.
 */
export async function recordSecurityToolDeny(
  args: {
    routineId: string;
    toolName: string;
    input: Record<string, unknown>;
    reason: string;
  },
  db: PrismaClient,
): Promise<void> {
  const id = ulid();
  const properties = {
    routineId: args.routineId,
    toolName: args.toolName,
    reason: args.reason,
    inputPreview: JSON.stringify(args.input).slice(0, 200),
  };
  const now = Date.now();
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, parentId, actorKind, visibility, status, closedAt, createdAt) VALUES (?, 'audit.security.tool.deny', ?, NULL, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    JSON.stringify(properties),
    now,
    now,
  );
}

// ---------------------------------------------------------------------------
// DB context pre-fetch (project.db.query через инъекцию в system prompt).
// ---------------------------------------------------------------------------

/**
 * fetchDbContext — предзагружает COUNT-статистику за 24ч из БД проекта.
 *
 * Для каждого db-connection с непустым allowedTables[] определяет наличие
 * created_at / updated_at через information_schema (postgres/mysql) или try/catch (sqlite),
 * затем запрашивает COUNT(*) по каждой разрешённой таблице.
 * Возвращает markdown-блок для инъекции в system prompt перед routinePrompt.
 * Ошибки graceful: при недоступности таблицы пишет 'н/д' и логирует warn.
 */
export async function fetchDbContext(projectMap: ProjectMap, runDate: string): Promise<string> {
  const conns = projectMap.dbConnections.filter((c) => c.allowedTables.length > 0);
  if (conns.length === 0) return '';

  const parts: string[] = [`## Данные из БД (предзагружено, runDate: ${runDate})`];

  for (const conn of conns) {
    parts.push(`\n### БД: ${conn.id}`);
    const dateColMap = await detectDateColumns(conn);
    const groupColMap = await detectGroupableColumns(conn);

    for (const table of conn.allowedTables) {
      try {
        let qResult: DbQueryResult;
        if (conn.driver === 'sqlite') {
          qResult = await sqliteCountWithFallback(conn, table);
        } else {
          const dateCol = dateColMap.get(table) ?? null;
          const sql = buildContextSql(conn.driver, table, dateCol);
          qResult = await projectDbQuery({ connection: conn, sql });
        }
        const row = qResult.rows[0] ?? {};
        const count = Number(row.count ?? row['COUNT(*)'] ?? row['count(*)'] ?? 0);
        const dateCol = dateColMap.get(table) ?? null;
        const label = dateCol !== null ? 'за последние 24ч' : 'всего';
        parts.push(`- **${table}**: ${count} записей ${label}`);

        // GROUP BY breakdowns для каждой groupable колонки.
        const groupCols = groupColMap.get(table) ?? [];
        for (const col of groupCols) {
          try {
            const breakdownSql = buildBreakdownSql(conn.driver, table, col, dateCol);
            const breakdown = await projectDbQuery({ connection: conn, sql: breakdownSql });
            if (breakdown.rows.length > 0) {
              const items = breakdown.rows
                .map((r) => `${r[col] ?? '(null)'}=${r.cnt ?? r.count ?? 0}`)
                .join(', ');
              parts.push(`  - по \`${col}\`: ${items}`);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80);
            console.warn(`[routine:runtime] breakdown ${table}.${col}:`, msg);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100);
        parts.push(`- **${table}**: н/д (${msg})`);
        console.warn(`[routine:runtime] fetchDbContext: ${conn.id}.${table}:`, err);
      }
    }
  }

  return parts.join('\n');
}

/** Колонки которые имеет смысл группировать для аналитики. */
const GROUPABLE_COLUMN_NAMES = [
  'status',
  'state',
  'error_type',
  'type',
  'event_type',
  'channel',
  'source',
  'category',
  'severity',
  'level',
  'provider',
  'kind',
  'role',
];

/**
 * detectGroupableColumns — находит в таблицах колонки из GROUPABLE_COLUMN_NAMES.
 *
 * Один запрос на conn (postgres/mysql) к information_schema. SQLite — пропускаем
 * (нет дешёвого способа узнать колонки массово).
 */
async function detectGroupableColumns(conn: DbConnConfig): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (conn.driver === 'sqlite') return result;

  const schemaConn: DbConnConfig = { ...conn, allowedTables: [] };

  try {
    let sql: string;
    let params: unknown[];

    if (conn.driver === 'postgres') {
      sql = `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[]) AND column_name = ANY($2::text[]) ORDER BY table_name, column_name`;
      params = [conn.allowedTables, GROUPABLE_COLUMN_NAMES];
    } else {
      const tablePh = conn.allowedTables.map(() => '?').join(', ');
      const colPh = GROUPABLE_COLUMN_NAMES.map(() => '?').join(', ');
      sql = `SELECT TABLE_NAME as table_name, COLUMN_NAME as column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${tablePh}) AND COLUMN_NAME IN (${colPh}) ORDER BY TABLE_NAME, COLUMN_NAME`;
      params = [...conn.allowedTables, ...GROUPABLE_COLUMN_NAMES];
    }

    const qResult = await projectDbQuery({ connection: schemaConn, sql, params });
    for (const row of qResult.rows) {
      const tbl = String(row.table_name ?? '');
      const col = String(row.column_name ?? '');
      if (!tbl || !col) continue;
      const existing = result.get(tbl) ?? [];
      existing.push(col);
      result.set(tbl, existing);
    }
  } catch (err) {
    console.warn(
      '[routine:runtime] detectGroupableColumns: не удалось прочитать information_schema:',
      err,
    );
  }

  return result;
}

/** Строит GROUP BY запрос с фильтром по дате (top 10 групп). */
function buildBreakdownSql(
  driver: DbConnConfig['driver'],
  table: string,
  col: string,
  dateCol: 'created_at' | 'updated_at' | null,
): string {
  const where =
    dateCol === null
      ? ''
      : driver === 'postgres'
        ? `WHERE ${dateCol} >= NOW() - INTERVAL '24 hours'`
        : driver === 'mysql'
          ? `WHERE ${dateCol} >= NOW() - INTERVAL 24 HOUR`
          : `WHERE ${dateCol} >= datetime('now', '-1 day')`;
  return `SELECT ${col}, COUNT(*) as cnt FROM ${table} ${where} GROUP BY ${col} ORDER BY cnt DESC LIMIT 10`;
}

/**
 * detectDateColumns — определяет наличие created_at / updated_at через information_schema.
 *
 * Один запрос на все таблицы conn'а (postgres/mysql). SQLite — возвращает пустую Map,
 * fallback через sqliteCountWithFallback. Использует temp-conn с allowedTables: [] чтобы
 * пройти validateSql — information_schema не входит в user-whitelist, но это системный запрос.
 */
async function detectDateColumns(
  conn: DbConnConfig,
): Promise<Map<string, 'created_at' | 'updated_at'>> {
  const result = new Map<string, 'created_at' | 'updated_at'>();
  if (conn.driver === 'sqlite') return result;

  const schemaConn: DbConnConfig = { ...conn, allowedTables: [] };

  try {
    let sql: string;
    let params: unknown[];

    if (conn.driver === 'postgres') {
      sql = `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[]) AND column_name IN ('created_at', 'updated_at') ORDER BY table_name, CASE column_name WHEN 'created_at' THEN 0 ELSE 1 END`;
      params = [conn.allowedTables];
    } else {
      // mysql: IN (?, ?, ...)
      const ph = conn.allowedTables.map(() => '?').join(', ');
      sql = `SELECT TABLE_NAME as table_name, COLUMN_NAME as column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${ph}) AND COLUMN_NAME IN ('created_at', 'updated_at') ORDER BY TABLE_NAME, CASE COLUMN_NAME WHEN 'created_at' THEN 0 ELSE 1 END`;
      params = [...conn.allowedTables];
    }

    const qResult = await projectDbQuery({ connection: schemaConn, sql, params });
    for (const row of qResult.rows) {
      const tbl = String(row.table_name ?? '');
      const col = String(row.column_name ?? '');
      if (tbl && !result.has(tbl) && (col === 'created_at' || col === 'updated_at')) {
        result.set(tbl, col as 'created_at' | 'updated_at');
      }
    }
  } catch (err) {
    console.warn(
      '[routine:runtime] detectDateColumns: не удалось прочитать information_schema:',
      err,
    );
  }

  return result;
}

/** Строит COUNT-запрос с фильтром по дате (или plain COUNT если dateCol не найден). */
function buildContextSql(
  driver: DbConnConfig['driver'],
  table: string,
  dateCol: 'created_at' | 'updated_at' | null,
): string {
  if (dateCol === null) {
    return `SELECT COUNT(*) as count FROM ${table}`;
  }
  switch (driver) {
    case 'postgres':
      return `SELECT COUNT(*) as count FROM ${table} WHERE ${dateCol} >= NOW() - INTERVAL '24 hours'`;
    case 'mysql':
      return `SELECT COUNT(*) as count FROM ${table} WHERE ${dateCol} >= NOW() - INTERVAL 24 HOUR`;
    case 'sqlite':
      return `SELECT COUNT(*) as count FROM ${table} WHERE ${dateCol} >= datetime('now', '-1 day')`;
  }
}

/** SQLite-fallback: пробует created_at, затем updated_at, затем plain COUNT. */
async function sqliteCountWithFallback(conn: DbConnConfig, table: string): Promise<DbQueryResult> {
  for (const col of ['created_at', 'updated_at'] as const) {
    try {
      return await projectDbQuery({
        connection: conn,
        sql: `SELECT COUNT(*) as count FROM ${table} WHERE ${col} >= datetime('now', '-1 day')`,
      });
    } catch {
      // пробуем следующую колонку
    }
  }
  return projectDbQuery({
    connection: conn,
    sql: `SELECT COUNT(*) as count FROM ${table}`,
  });
}

// ---------------------------------------------------------------------------
// Построение system prompt.
// ---------------------------------------------------------------------------

interface BuildSystemPromptArgs {
  routine: Routine;
  project: ProjectMeta;
  runDate: string;
  projectMap: ProjectMap;
  unsupportedTools: Array<{ name: string; reason: string }>;
  dbContext: string;
  /** Резолвнутые скиллы (deps первыми). Пустой массив если routine не объявил skills. */
  skills: Skill[];
  /** Имена скиллов, для которых body SKILL.md инжектится сразу (forceLoad). */
  forceLoad: Set<string>;
  /**
   * Org-knowledge для инжекции (Фаза 3). null если ни один скилл из категорий
   * writing/research не активирован, или если org/ не настроен.
   */
  org: OrgKnowledge | null;
  /**
   * Guardrails из agents/<id>/rules.md (уже с раскрытыми @-include'ами). null
   * для legacy routines/*.md. Инжектится как ## Guardrails секция высоко в промте.
   */
  guardrails: string | null;
}

function buildSystemPrompt(args: BuildSystemPromptArgs): string {
  const {
    routine,
    project,
    runDate,
    projectMap,
    unsupportedTools,
    dbContext,
    skills,
    forceLoad,
    org,
    guardrails,
  } = args;

  const parts: string[] = [];

  // a. characterPrelude — роль и дата.
  const characterPrelude = [
    `Ты — AI-кофаундер для проекта ${project.name}.`,
    `Сегодняшняя дата: ${runDate}.`,
    `Твоя задача: ${routine.description}.`,
  ].join('\n');
  parts.push(characterPrelude);

  // a2. Guardrails — agents/<id>/rules.md (если есть). Сразу под ролью, отдельной
  //     секцией (не молча сконкатенировано в промт). Auto-delimited '\n\n---\n\n'.
  if (guardrails !== null && guardrails.trim() !== '') {
    parts.push(`## Guardrails\n\n${guardrails.trim()}`);
  }

  // b. projectMapDigest — ключевые данные из ProjectMap (без credentials).
  const digestLines: string[] = ['## Карта проекта'];

  if (projectMap.description) {
    digestLines.push('');
    digestLines.push(`**Описание:** ${projectMap.description}`);
  }

  if (projectMap.keyDirectories.length > 0) {
    digestLines.push('');
    digestLines.push('**Ключевые директории:**');
    for (const d of projectMap.keyDirectories) {
      digestLines.push(`- ${d.path}${d.note ? `: ${d.note}` : ''}`);
    }
  }

  if (projectMap.keyFiles.length > 0) {
    digestLines.push('');
    digestLines.push('**Ключевые файлы:**');
    for (const f of projectMap.keyFiles) {
      digestLines.push(`- ${f.path}${f.note ? `: ${f.note}` : ''}`);
    }
  }

  if (projectMap.dbConnections.length > 0) {
    digestLines.push('');
    digestLines.push('**Подключения к БД:**');
    for (const db of projectMap.dbConnections) {
      const tables =
        db.allowedTables.length > 0 ? ` (разрешённые таблицы: ${db.allowedTables.join(', ')})` : '';
      digestLines.push(`- ${db.id} (${db.driver})${tables}: ${db.description}`);
    }
  }

  if (projectMap.telegramChannels.length > 0) {
    digestLines.push('');
    digestLines.push('**Telegram-каналы:**');
    for (const ch of projectMap.telegramChannels) {
      digestLines.push(`- ${ch.id} (chatId: ${ch.chatId}): ${ch.purpose}`);
    }
  }

  if (projectMap.notes) {
    digestLines.push('');
    digestLines.push('**Заметки:**');
    digestLines.push(projectMap.notes);
  }

  parts.push(digestLines.join('\n'));

  // c. Unsupported tools notice — показываем только те, что не обрабатываются через pre-fetch.
  //    PREFETCHED_TOOL_NAMES (project.db.query, report.send, journal.search) не нужны агенту
  //    как инструменты: данные уже в system prompt через fetchDbContext / dispatcher.
  const visibleUnsupported = unsupportedTools.filter((t) => !PREFETCHED_TOOL_NAMES.has(t.name));
  if (visibleUnsupported.length > 0) {
    const names = visibleUnsupported.map((t) => t.name).join(', ');
    const unsupportedSection = [
      '## ДОСТУПНЫЕ ВНЕШНИЕ ДАННЫЕ',
      '',
      `Tools [${names}] в этом запуске работают через данные в контексте (MCP появится позже).`,
      'Следующие данные доступны в системном промпте:',
      ...visibleUnsupported.map((t) => `- ${t.name}: данные будут инжектированы в M3.2+`),
    ].join('\n');
    parts.push(unsupportedSection);
  }

  // d. DB context (предзагруженные данные из БД проекта через fetchDbContext).
  if (dbContext) {
    parts.push(dbContext);
  }

  // d2. Skills — discovery layer (name+description, ~80 ток/скилл) + body
  //     для forceLoad-скиллов. Progressive disclosure: discovery всегда,
  //     instruction только когда routine ЗАВЕДОМО использует скилл.
  //     План 2026-05-21-skills-architecture-v3, Фаза 2, п.2.
  if (skills.length > 0) {
    parts.push(buildSkillsSection(skills, forceLoad));
  }

  // d3. Org knowledge — identity/brand-voice/audience, инжектируется только
  //     если есть скиллы категорий writing/research. План 2026-05-21-
  //     skills-architecture-v3, Фаза 3, п.2.
  if (org !== null) {
    const orgSection = buildOrgKnowledgeSection(skills, org);
    if (orgSection !== null) parts.push(orgSection);
  }

  // e. routinePrompt — body из routine файла.
  parts.push(routine.prompt);

  return parts.join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Org knowledge (Фаза 3 плана 2026-05-21-skills-architecture-v3, п.2).
// ---------------------------------------------------------------------------

/** Категории скиллов, которым нужны org-знания (identity/brand-voice/audience). */
const ORG_KNOWLEDGE_CATEGORIES = new Set(['writing', 'research']);

/**
 * loadOrgIfNeeded — подгружает OrgKnowledge только если среди скиллов есть
 * хотя бы один из категорий writing/research. Иначе возвращает null без
 * вызова getOrg (экономим IO).
 *
 * Если getOrg бросает (например, OrgParseError — `org/` отсутствует или один
 * из обязательных файлов не заполнен) — ловим и возвращаем null с warning.
 * Логика «нет org = skip silently» из плана: routine не должна падать только
 * потому, что org/ ещё не настроен.
 *
 * Экспортирован для тестов.
 */
export async function loadOrgIfNeeded(
  skills: Skill[],
  getOrgImpl?: () => Promise<OrgKnowledge | null>,
): Promise<OrgKnowledge | null> {
  const needsOrg = skills.some(
    (s) => s.category !== undefined && ORG_KNOWLEDGE_CATEGORIES.has(s.category),
  );
  if (!needsOrg) return null;

  try {
    if (getOrgImpl !== undefined) {
      return await getOrgImpl();
    }
    return await defaultGetOrg();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[routine:runtime] org-knowledge inject skipped: ${message}. Заполни org/identity.md + brand-voice.md + audience.md, если хочешь чтобы writing/research-скиллы знали про бренд.`,
    );
    return null;
  }
}

/**
 * buildOrgKnowledgeSection — собирает блок «## Org knowledge» для system prompt.
 *
 * Возвращает null если среди skills нет ни одного из категорий
 * writing/research (даже если org/ загружен — нет смысла инжектировать
 * брендовые знания, например, в publishing-скилл).
 *
 * Структура блока (план 2026-05-21-skills-architecture-v3, Фаза 3, п.4):
 *   ## Org knowledge
 *
 *   ### Кто мы
 *   <identity>
 *
 *   ### Как мы звучим
 *   <brandVoice>
 *
 *   ### Аудитория
 *   <audience>
 *
 *   Подробнее о продукте: org/product-knowledge.md (читай через project.read если требуется)
 *
 * product-knowledge.md НЕ инжектируется в discovery — он опционален и читается
 * скиллом через project.read когда нужна специфика. Упоминание о нём идёт
 * только если файл существует.
 *
 * Экспортирован для тестов.
 */
export function buildOrgKnowledgeSection(skills: Skill[], org: OrgKnowledge): string | null {
  const needsOrg = skills.some(
    (s) => s.category !== undefined && ORG_KNOWLEDGE_CATEGORIES.has(s.category),
  );
  if (!needsOrg) return null;

  const parts: string[] = ['## Org knowledge', ''];
  parts.push('### Кто мы');
  parts.push(org.identity);
  parts.push('');
  parts.push('### Как мы звучим');
  parts.push(org.brandVoice);
  parts.push('');
  parts.push('### Аудитория');
  parts.push(org.audience);

  if (org.productKnowledge !== null) {
    parts.push('');
    parts.push(
      'Подробнее о продукте: `org/product-knowledge.md` (читай через project.read если требуется).',
    );
  }
  if (org.examplesDir !== null) {
    parts.push(
      'Образцы текстов: `org/examples/` (читай через project.read если нужны примеры стиля).',
    );
  }

  return parts.join('\n');
}

/**
 * buildSkillsSection — собирает блок «## Доступные скиллы» в system prompt.
 *
 * Для каждого скилла:
 *   - discovery layer (всегда): `## Skill: <name>` + displayName + icon + description.
 *     ~80 токенов на скилл, агент видит «что у меня есть».
 *   - instruction (только forceLoad): body SKILL.md полностью под подзаголовком
 *     «### Инструкция: <name>». Используется когда routine знает заранее,
 *     что скилл будет использоваться.
 *
 * Транзитивные deps уже резолвнуты в `skills` (вход), все они проходят через
 * discovery; body инжектится только для скиллов в `forceLoad`.
 */
function buildSkillsSection(skills: Skill[], forceLoad: Set<string>): string {
  const lines: string[] = ['## Доступные скиллы'];
  lines.push('');
  lines.push(
    'Для каждого скилла есть имя и описание. Если решишь использовать — вызови соответствующий tool (см. permissions). Полная инструкция подгружается по запросу или уже включена ниже для скиллов из forceLoad.',
  );

  for (const skill of skills) {
    lines.push('');
    const header = ['## Skill:', skill.name];
    if (skill.icon !== undefined) header.unshift(skill.icon);
    lines.push(header.join(' '));
    if (skill.displayName !== undefined) {
      lines.push(`**${skill.displayName}**`);
    }
    lines.push(skill.description);
  }

  // Body для forceLoad-скиллов идёт отдельным под-блоком, чтобы агент мог
  // легко найти инструкцию по имени скилла (не смешано с discovery).
  const loaded = skills.filter((s) => forceLoad.has(s.name) && s.prompt.trim() !== '');
  if (loaded.length > 0) {
    lines.push('');
    lines.push('### Полные инструкции (forceLoad)');
    for (const skill of loaded) {
      lines.push('');
      lines.push(`#### ${skill.name}`);
      lines.push('');
      lines.push(skill.prompt);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Вспомогательные функции.
// ---------------------------------------------------------------------------

/** Вытаскивает текст из последнего assistant-сообщения. */
function extractOutput(result: SubagentRunResult): string {
  const messages = result.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg.type !== 'assistant') continue;

    // Поддерживаем два shape: SDK msg.message.content и msg.content напрямую.
    const msgRecord = msg.message as Record<string, unknown> | undefined;
    const content = msgRecord?.content ?? msg.content;
    if (!Array.isArray(content)) continue;

    const textParts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        textParts.push(b.text);
      }
    }
    if (textParts.length > 0) {
      return textParts.join('\n');
    }
  }
  return '';
}

/** Считает все tool_use блоки во всех messages. */
function countToolCalls(result: SubagentRunResult): number {
  let count = 0;
  for (const msg of result.messages) {
    const m = msg as Record<string, unknown>;
    if (m.type !== 'assistant') continue;

    const msgRecord = m.message as Record<string, unknown> | undefined;
    const content = msgRecord?.content ?? m.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_use') count++;
    }
  }
  return count;
}

/** Определяет статус по результату sub-agent. */
function resolveStatus(result: SubagentRunResult): RoutineResult['status'] {
  if (result.timedOut) return 'timeout';
  if (result.result?.is_error === true) return 'failed';
  return 'ok';
}

/** Суммирует все токены из SDK ResultMessage usage. */
function computeTotalTokens(result: SubagentRunResult): number {
  if (result.result === null) return 0;
  const u = result.result.usage;
  return (
    (u.inputTokens ?? u.input_tokens ?? 0) +
    (u.outputTokens ?? u.output_tokens ?? 0) +
    (u.cacheReadInputTokens ?? u.cache_read_input_tokens ?? 0) +
    (u.cacheCreationInputTokens ?? u.cache_creation_input_tokens ?? 0)
  );
}
