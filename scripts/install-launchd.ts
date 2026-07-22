// Установка launchd-job для утреннего детектива.
//
// Что делает:
//   1. Резолвит пути pnpm/node через `which` (CLAUDE.md: не хардкодить динамику).
//   2. Подставляет их в шаблон infrastructure/launchd/com.ai-cofounder.morning-detective.plist.
//   3. Кладёт результат в ~/Library/LaunchAgents/.
//   4. plutil -lint для синтаксической валидации.
//   5. **НЕ ЗАПУСКАЕТ** `launchctl load` — это touchpoint с пользовательской системой,
//      делает фаундер сам командой:
//          launchctl load ~/Library/LaunchAgents/com.ai-cofounder.morning-detective.plist
//      и проверяет:
//          launchctl list | grep ai-cofounder
//
// Флаги:
//   --dry-run  — не пишет в ~/Library/LaunchAgents/, выводит подставленный plist
//                в stdout и прогоняет plutil -lint на временный файл.
//
// План фазы 1.4 (plans/): «не запускай установку сам».

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TEMPLATE_PATH = join(
  REPO_ROOT,
  'infrastructure',
  'launchd',
  'com.ai-cofounder.morning-detective.plist',
);
const TARGET_DIR = join(homedir(), 'Library', 'LaunchAgents');
const TARGET_PATH = join(TARGET_DIR, 'com.ai-cofounder.morning-detective.plist');

interface ResolvedPaths {
  pnpm: string;
  node: string;
  pathEnv: string;
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

function resolvePaths(): ResolvedPaths {
  const pnpm = whichOrThrow('pnpm');
  const node = whichOrThrow('node');
  // launchd запускает job с минимальным PATH. Добавляем директории pnpm/node
  // и стандартные системные пути, чтобы постфазы (git, gh, ...) работали.
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
  // dedupe, сохраняя порядок.
  const seen = new Set<string>();
  const pathEnv = pathParts.filter((p) => (seen.has(p) ? false : seen.add(p))).join(':');
  return { pnpm, node, pathEnv };
}

function renderPlist(paths: ResolvedPaths): string {
  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  return template
    .replaceAll('__PNPM_PATH__', paths.pnpm)
    .replaceAll('__NODE_PATH__', paths.node)
    .replaceAll('__REPO_PATH__', REPO_ROOT)
    .replaceAll('__PATH_ENV__', paths.pathEnv);
}

function plutilLint(path: string): void {
  try {
    execFileSync('/usr/bin/plutil', ['-lint', path], { stdio: 'inherit' });
  } catch {
    throw new Error(`plutil -lint провалился на ${path}`);
  }
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const paths = resolvePaths();
  const rendered = renderPlist(paths);

  console.log(`pnpm  → ${paths.pnpm}`);
  console.log(`node  → ${paths.node}`);
  console.log(`repo  → ${REPO_ROOT}`);
  console.log(`PATH  → ${paths.pathEnv}`);
  console.log('');

  if (dryRun) {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ai-cofounder-launchd-'));
    const tmpPath = join(tmpDir, 'morning-detective.plist');
    writeFileSync(tmpPath, rendered, 'utf8');
    plutilLint(tmpPath);
    console.log(`✓ dry-run OK. Подставленный plist лежит в: ${tmpPath}`);
    console.log('');
    console.log('--- BEGIN PLIST ---');
    console.log(rendered);
    console.log('--- END PLIST ---');
    return;
  }

  // Перед записью прогоняем plutil -lint на отрисованный plist через временный файл —
  // не пишем в ~/Library/LaunchAgents/, если он невалиден.
  const tmpDir = mkdtempSync(join(tmpdir(), 'ai-cofounder-launchd-'));
  const tmpPath = join(tmpDir, 'morning-detective.plist');
  writeFileSync(tmpPath, rendered, 'utf8');
  plutilLint(tmpPath);

  writeFileSync(TARGET_PATH, rendered, 'utf8');
  console.log(`✓ plist записан в ${TARGET_PATH}`);
  console.log('');
  console.log('Что дальше — РУКАМИ:');
  console.log(`  launchctl load ${TARGET_PATH}`);
  console.log('  launchctl list | grep ai-cofounder');
  console.log('');
  console.log('Если уже был загружен раньше — сначала unload:');
  console.log(`  launchctl unload ${TARGET_PATH}`);
}

main();
