// src/routines/launchd.ts — применение/снятие launchd-расписания для ОДНОЙ
// routine из UI (Ф3 плана 2026-06-22-bridge-control-panel).
//
// Зачем отдельно от scripts/install-routines-launchd.ts:
//   * Скрипт намеренно НЕ вызывает `launchctl load` (пишет plist + печатает
//     инструкцию). Для панели управления нужна кнопка «применить» с реальным
//     load'ом — поэтому здесь есть `applyRoutineSchedule`, который пишет plist
//     И грузит его в launchd.
//   * Резолв путей (node/tsx/PATH) повторяет логику скрипта. Это осознанная
//     копия ~40 строк: рефакторить рабочий launchd-скрипт ради DRY рискованнее,
//     чем продублировать чистую функцию резолва. При расхождении —
//     синхронизировать с scripts/install-routines-launchd.ts.
//
// launchctl: используем legacy `unload`/`load -w` (как в инструкциях скрипта) —
// идемпотентно (unload игнорирует «не загружен», потом load).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateRoutinePlistXml } from './cron.js';
import { ROUTINE_ID_RE, type Routine } from './parser.js';

const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');

export interface LaunchdPaths {
  pnpm: string;
  node: string;
  tsxCli: string;
  pathEnv: string;
  repoRoot: string;
}

export function routinePlistLabel(id: string): string {
  return `com.ai-cofounder.routine-${id}`;
}

export function routinePlistPath(id: string, launchAgentsDir: string = LAUNCH_AGENTS_DIR): string {
  return join(launchAgentsDir, `${routinePlistLabel(id)}.plist`);
}

function whichOrThrow(bin: string): string {
  try {
    const out = execFileSync('/usr/bin/which', [bin], { encoding: 'utf8' }).trim();
    if (out === '') throw new Error('empty output');
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`which ${bin} не нашёл бинарь (${msg}). Установи ${bin} и проверь $PATH.`);
  }
}

function resolveTsxCli(repoRoot: string): string {
  const pnpmDir = join(repoRoot, 'node_modules', '.pnpm');
  let entries: string[];
  try {
    entries = readdirSync(pnpmDir).filter((n) => n.startsWith('tsx@'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`не могу прочитать ${pnpmDir} (${msg}). Запусти 'pnpm install' и повтори.`);
  }
  if (entries.length === 0) throw new Error(`tsx не найден в ${pnpmDir}. Запусти 'pnpm install'.`);
  entries.sort().reverse();
  const cli = join(pnpmDir, entries[0] as string, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!existsSync(cli))
    throw new Error(`tsx CLI отсутствует по пути ${cli}. Запусти 'pnpm install'.`);
  return cli;
}

export function resolveLaunchdPaths(repoRoot: string): LaunchdPaths {
  const pnpm = whichOrThrow('pnpm');
  const node = whichOrThrow('node');
  const tsxCli = resolveTsxCli(repoRoot);
  const pathParts = [
    dirname(pnpm),
    dirname(node),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  const seen = new Set<string>();
  const pathEnv = pathParts.filter((p) => (seen.has(p) ? false : seen.add(p))).join(':');
  return { pnpm, node, tsxCli, pathEnv, repoRoot };
}

function plutilLint(path: string): void {
  try {
    execFileSync('/usr/bin/plutil', ['-lint', path], { stdio: 'ignore' });
  } catch {
    throw new Error(`plutil -lint провалился на ${path}`);
  }
}

/** Пишет plist (через temp + lint) в LaunchAgents. launchctl НЕ трогает. */
export function writeRoutinePlist(
  routine: Routine,
  paths: LaunchdPaths,
  launchAgentsDir: string = LAUNCH_AGENTS_DIR,
): string {
  // Fail-closed на границе launchd: id вшивается в plist XML и имя файла.
  // Защита остаётся даже если read-путь когда-то забудет валидировать id.
  if (!ROUTINE_ID_RE.test(routine.id)) {
    throw new Error(`launchd: routine.id '${routine.id}' не kebab-case — отказ записи plist.`);
  }
  const xml = generateRoutinePlistXml(routine, {
    node: paths.node,
    tsxCli: paths.tsxCli,
    pathEnv: paths.pathEnv,
    repoRoot: paths.repoRoot,
  });
  const plistName = `${routinePlistLabel(routine.id)}.plist`;
  const tmpDir = mkdtempSync(join(tmpdir(), 'ai-cofounder-launchd-'));
  const tmpPath = join(tmpDir, plistName);
  writeFileSync(tmpPath, xml, 'utf8');
  plutilLint(tmpPath);
  const targetPath = join(launchAgentsDir, plistName);
  writeFileSync(targetPath, xml, 'utf8');
  return targetPath;
}

function launchctlUnload(plistPath: string): void {
  try {
    execFileSync('/bin/launchctl', ['unload', plistPath], { stdio: 'ignore' });
  } catch {
    // «не загружен» — это норма для идемпотентного reload.
  }
}

function launchctlLoad(plistPath: string): void {
  execFileSync('/bin/launchctl', ['load', '-w', plistPath], { stdio: 'ignore' });
}

export type ScheduleAction = 'loaded' | 'unloaded' | 'noop';

export interface ApplyScheduleResult {
  action: ScheduleAction;
  plistPath?: string;
  /** Человекочитаемое объяснение для UI. */
  reason: string;
}

/**
 * Синхронизирует launchd с текущим состоянием routine:
 *   * enabled && cron  → пишет plist + (re)load в launchd → 'loaded'.
 *   * manual || disabled → unload + удаляет plist → 'unloaded' (или 'noop').
 *
 * Опасная операция (мутирует живой планировщик мака) — вызывается только по
 * явному подтверждению из UI.
 */
export function applyRoutineSchedule(
  routine: Routine,
  opts: { repoRoot?: string; launchAgentsDir?: string } = {},
): ApplyScheduleResult {
  if (!ROUTINE_ID_RE.test(routine.id)) {
    throw new Error(`launchd: routine.id '${routine.id}' не kebab-case — отказ.`);
  }
  const repoRoot = opts.repoRoot ?? process.cwd();
  const launchAgentsDir = opts.launchAgentsDir ?? LAUNCH_AGENTS_DIR;
  const plistPath = routinePlistPath(routine.id, launchAgentsDir);

  if (routine.enabled && routine.trigger !== 'manual') {
    const paths = resolveLaunchdPaths(repoRoot);
    const written = writeRoutinePlist(routine, paths, launchAgentsDir);
    launchctlUnload(written); // идемпотентный reload
    launchctlLoad(written);
    return {
      action: 'loaded',
      plistPath: written,
      reason: `cron '${routine.trigger}' активен в launchd`,
    };
  }

  const why = routine.enabled ? "trigger='manual'" : 'routine выключен (enabled=false)';
  if (existsSync(plistPath)) {
    launchctlUnload(plistPath);
    rmSync(plistPath);
    return { action: 'unloaded', plistPath, reason: `снят с launchd: ${why}` };
  }
  return { action: 'noop', reason: `нечего применять: ${why}` };
}
