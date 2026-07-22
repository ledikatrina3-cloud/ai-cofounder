// Skill health-check runner (Фаза 7 плана 2026-05-21-skills-architecture-v3).
//
// Контракт:
//   * runHealthCheck(skillName) — резолвит скилл через listSkills(), читает
//     permissions.healthCheck.script. Если нет — возвращает status='skipped'.
//   * Если есть — запускает `pnpm exec tsx <skillDir>/<script>` через
//     child_process.spawn с тайм-аутом 30s.
//   * Парсит ПОСЛЕДНЮЮ строку stdout как JSON (скрипт обязан её эмитить).
//     Если JSON невалидный или скрипт завершился с exit != 0 — status='failed'.
//   * Эмитит `skill.health.ok` / `skill.health.failed` в Bridge.
//   * Возвращает HealthCheckResult, ничего не пишет в БД (это задача
//     health-store.ts, который зовётся из CLI-обёртки run-skill-healthchecks.ts).
//
// Почему spawn, а не exec:
//   * exec буферизует весь stdout → может OOM на больших output'ах.
//   * spawn даёт нам контроль над timeout'ом (SIGKILL после 30s).
//   * Можем стримить и парсить последнюю строку без сборки гигантского буфера
//     в памяти (хотя на практике health-check output'ы маленькие, < 1KB).
//
// Безопасность:
//   * `script` берётся из permissions.md скилла — это data, не user-input.
//     Но мы всё равно ОБЯЗАНЫ проверить, что путь не вылез за пределы
//     директории скилла (path-traversal). resolve + startsWith-check.
//   * Команда — `pnpm exec tsx <path>`. Аргумент <path> передаётся через
//     args-array spawn (не через shell), поэтому shell-инъекции невозможны.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { emit } from '../observe/bridge.js';
import { type SkillRegistryOptions, listSkills } from './registry.js';
import type { Skill } from './types.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export type HealthCheckStatus = 'ok' | 'failed' | 'skipped';

export interface HealthCheckResult {
  skillName: string;
  status: HealthCheckStatus;
  /** Сколько миллисекунд занял запуск скрипта. Для 'skipped' — 0. */
  durationMs: number;
  /** Парсед JSON от скрипта (последняя строка stdout). undefined если skipped/невалидный JSON. */
  output?: Record<string, unknown>;
  /** Текстовое описание ошибки (для 'failed'). */
  error?: string;
  /** Unix ms timestamp когда health-check завершился. */
  timestamp: number;
  /** Причина skipped (например 'no health-check defined' или 'skill not found'). */
  reason?: string;
}

// ---------------------------------------------------------------------------
// DI для тестов: подмена spawn (или registry-loader).
// ---------------------------------------------------------------------------

export interface HealthCheckDeps {
  /** Загрузчик списка скиллов (по умолчанию listSkills из реестра). */
  listSkills?: (options?: SkillRegistryOptions) => Promise<Skill[]>;
  /**
   * Запускает скрипт. Должен возвращать `{stdout, stderr, exitCode, timedOut}`.
   * По умолчанию — реальный spawn (`pnpm exec tsx <script>`).
   */
  runScript?: (args: RunScriptArgs) => Promise<RunScriptResult>;
  /** Бридж-эмиттер (для тестов). По умолчанию — реальный emit из observe/bridge. */
  emit?: typeof emit;
  /** Опции реестра — пробрасываются в listSkills. */
  registryOptions?: SkillRegistryOptions;
}

export interface RunScriptArgs {
  /** Абсолютный путь к скрипту (после path-traversal-check). */
  scriptPath: string;
  /** Cwd для запуска (директория скилла). */
  cwd: string;
  /** Таймаут в миллисекундах. По истечении — SIGKILL. */
  timeoutMs: number;
}

export interface RunScriptResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** true если процесс был убит по тайм-ауту. */
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// runHealthCheck — основная точка входа.
// ---------------------------------------------------------------------------

export async function runHealthCheck(
  skillName: string,
  deps: HealthCheckDeps = {},
): Promise<HealthCheckResult> {
  const listSkillsFn = deps.listSkills ?? listSkills;
  const emitFn = deps.emit ?? emit;
  const runScriptFn = deps.runScript ?? defaultRunScript;
  const now = Date.now;

  // 1. Найти скилл.
  const all = await listSkillsFn(deps.registryOptions);
  const skill = all.find((s) => s.name === skillName);
  if (skill === undefined) {
    return {
      skillName,
      status: 'skipped',
      durationMs: 0,
      timestamp: now(),
      reason: 'skill not found',
    };
  }

  const hc = skill.permissions.healthCheck;
  if (hc === undefined) {
    return {
      skillName,
      status: 'skipped',
      durationMs: 0,
      timestamp: now(),
      reason: 'no health-check defined',
    };
  }

  // 2. Резолвим путь к скрипту. permissions.healthCheck.script — относительный к
  //    директории скилла. Защищаемся от path-traversal: после resolve путь должен
  //    лежать внутри filePath скилла.
  const scriptAbs = resolve(skill.filePath, hc.script);
  const skillDirAbs = resolve(skill.filePath);
  if (!scriptAbs.startsWith(`${skillDirAbs}/`) && scriptAbs !== skillDirAbs) {
    const error = `script '${hc.script}' resolves outside skill dir`;
    await emitFn({
      type: 'skill.health.failed',
      skillName,
      durationMs: 0,
      error,
    });
    return {
      skillName,
      status: 'failed',
      durationMs: 0,
      error,
      timestamp: now(),
    };
  }

  // 3. Запускаем скрипт.
  const startedAt = Date.now();
  let result: RunScriptResult;
  try {
    result = await runScriptFn({
      scriptPath: scriptAbs,
      cwd: skillDirAbs,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startedAt;
    await emitFn({
      type: 'skill.health.failed' as never,
      skillName,
      durationMs,
      error: msg,
    } as never);
    return {
      skillName,
      status: 'failed',
      durationMs,
      error: `spawn failed: ${msg}`,
      timestamp: now(),
    };
  }
  const durationMs = Date.now() - startedAt;

  // 4. Анализ результата.
  if (result.timedOut) {
    const error = `timeout after ${DEFAULT_TIMEOUT_MS}ms`;
    await emitFn({
      type: 'skill.health.failed',
      skillName,
      durationMs,
      error,
    });
    return {
      skillName,
      status: 'failed',
      durationMs,
      error,
      timestamp: now(),
    };
  }

  // Пытаемся распарсить JSON из последней непустой строки stdout.
  const parsed = parseLastJsonLine(result.stdout);

  if (result.exitCode !== 0) {
    const error =
      parsed?.error !== undefined
        ? String(parsed.error)
        : `exit ${result.exitCode}: ${truncate(result.stderr, 500)}`;
    await emitFn({
      type: 'skill.health.failed',
      skillName,
      durationMs,
      error,
    });
    const out: HealthCheckResult = {
      skillName,
      status: 'failed',
      durationMs,
      error,
      timestamp: now(),
    };
    if (parsed !== null) out.output = parsed;
    return out;
  }

  if (parsed === null) {
    const error = 'script did not emit JSON on last stdout line';
    await emitFn({
      type: 'skill.health.failed',
      skillName,
      durationMs,
      error,
    });
    return {
      skillName,
      status: 'failed',
      durationMs,
      error,
      timestamp: now(),
    };
  }

  // Если в JSON status='failed' — даже при exit=0 считаем провалом.
  const parsedStatus = typeof parsed.status === 'string' ? parsed.status : undefined;
  if (parsedStatus === 'failed') {
    const error =
      typeof parsed.error === 'string'
        ? parsed.error
        : Array.isArray(parsed.errors) && parsed.errors.length > 0
          ? String(parsed.errors[0])
          : 'script reported status=failed without error message';
    await emitFn({
      type: 'skill.health.failed',
      skillName,
      durationMs,
      error,
    });
    return {
      skillName,
      status: 'failed',
      durationMs,
      output: parsed,
      error,
      timestamp: now(),
    };
  }

  // OK.
  await emitFn({
    type: 'skill.health.ok',
    skillName,
    durationMs,
  });
  return {
    skillName,
    status: 'ok',
    durationMs,
    output: parsed,
    timestamp: now(),
  };
}

// ---------------------------------------------------------------------------
// Реальный runScript: spawn `pnpm exec tsx <scriptPath>` с тайм-аутом.
// ---------------------------------------------------------------------------

async function defaultRunScript(args: RunScriptArgs): Promise<RunScriptResult> {
  return new Promise((resolveProm) => {
    const child = spawn('pnpm', ['exec', 'tsx', args.scriptPath], {
      cwd: args.cwd,
      env: process.env,
      // shell: false — аргументы передаются как array, никаких shell-инъекций
      // даже если в scriptPath окажутся подозрительные символы.
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL — здесь не выбираем мягкий путь: если health-check висит >30s,
      // он не уложится в наш fast-failure контракт. Лучше прибить и записать
      // 'failed', чем держать процесс на pnpm exec tsx.
      try {
        child.kill('SIGKILL');
      } catch {
        // process уже мог завершиться — игнорим
      }
    }, args.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      // err.message например 'ENOENT' если pnpm не нашёлся.
      clearTimeout(timer);
      stderr += `\n[spawn error] ${err.message}`;
      resolveProm({ stdout, stderr, exitCode: null, timedOut });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolveProm({ stdout, stderr, exitCode: code, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// parseLastJsonLine — берёт последнюю непустую строку stdout и пробует JSON.parse.
// ---------------------------------------------------------------------------

function parseLastJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split('\n').map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || line === '') continue;
    try {
      const v = JSON.parse(line);
      if (typeof v === 'object' && v !== null) {
        return v as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}
