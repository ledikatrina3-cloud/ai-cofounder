// scripts/install-skill-healthchecks-launchd.ts — устанавливает launchd plist
// для запуска всех skill health-check'ов раз в час.
//
// По образцу scripts/install-routines-launchd.ts (Фаза 1.3 routines), но
// упрощённый: один plist на всю пачку, запускает
// `pnpm exec tsx scripts/run-skill-healthchecks.ts`. Скрипт сам пройдёт
// по всем скиллам с healthCheck'ом — нет смысла плодить N plist'ов,
// если все они в любом случае запускаются по одной cron-шапке `0 7 * * *`
// (фаза 7 MVP: одна шапка для всех).
//
// Что делает:
//   1. Резолвит pnpm/node через `which`.
//   2. Генерирует plist'ный XML для StartCalendarInterval (по умолчанию 7:00).
//   3. plutil -lint в temp-файле для синтаксической проверки.
//   4. Записывает в ~/Library/LaunchAgents/com.ai-cofounder.skill-healthchecks.plist.
//   5. НЕ вызывает launchctl — печатает инструкцию (CLAUDE.md «не деплоить
//      без явной команды»).
//
// Флаги:
//   --dry-run  — только stdout + lint, не пишет в LaunchAgents.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');
const PLIST_NAME = 'com.ai-cofounder.skill-healthchecks.plist';
const PLIST_LABEL = 'com.ai-cofounder.skill-healthchecks';
// Дефолт — 7:00 утра локально (фаундер обычно заходит в 9-10).
// Поменять можно правкой этого скрипта или сразу plist'а.
const DEFAULT_HOUR = 7;
const DEFAULT_MINUTE = 0;

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

interface ResolvedPaths {
  pnpm: string;
  node: string;
  pathEnv: string;
}

function resolvePaths(): ResolvedPaths {
  const pnpm = whichOrThrow('pnpm');
  const node = whichOrThrow('node');
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
  return { pnpm, node, pathEnv };
}

function generatePlistXml(opts: { pnpm: string; pathEnv: string; repoRoot: string }): string {
  // StartCalendarInterval — раз в день в указанный час/минуту.
  // Логи в /tmp на одну прогон (launchd перезаписывает при следующем запуске).
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.pnpm}</string>
    <string>exec</string>
    <string>tsx</string>
    <string>scripts/run-skill-healthchecks.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${opts.repoRoot}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${opts.pathEnv}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${DEFAULT_HOUR}</integer>
    <key>Minute</key>
    <integer>${DEFAULT_MINUTE}</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>/tmp/${PLIST_LABEL}.out</string>
  <key>StandardErrorPath</key>
  <string>/tmp/${PLIST_LABEL}.err</string>
</dict>
</plist>
`;
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

  console.log(`pnpm  → ${paths.pnpm}`);
  console.log(`node  → ${paths.node}`);
  console.log(`repo  → ${REPO_ROOT}`);
  console.log(`PATH  → ${paths.pathEnv}`);
  console.log(
    `schedule → daily @ ${String(DEFAULT_HOUR).padStart(2, '0')}:${String(DEFAULT_MINUTE).padStart(2, '0')} local`,
  );
  console.log('');

  const xml = generatePlistXml({
    pnpm: paths.pnpm,
    pathEnv: paths.pathEnv,
    repoRoot: REPO_ROOT,
  });

  const tmpDir = mkdtempSync(join(tmpdir(), 'ai-cofounder-health-launchd-'));
  const tmpPath = join(tmpDir, PLIST_NAME);
  writeFileSync(tmpPath, xml, 'utf8');
  plutilLint(tmpPath);

  if (dryRun) {
    console.log(`--- BEGIN PLIST: ${PLIST_NAME} ---`);
    console.log(xml);
    console.log(`--- END PLIST: ${PLIST_NAME} ---`);
    console.log('');
    console.log('✓ dry-run OK. plist прошёл plutil -lint.');
    return;
  }

  const targetPath = join(LAUNCH_AGENTS_DIR, PLIST_NAME);
  writeFileSync(targetPath, xml, 'utf8');
  console.log(`✓ plist записан: ${targetPath}`);
  console.log('');
  console.log('Что дальше — РУКАМИ:');
  console.log(`  launchctl load ${targetPath}`);
  console.log('');
  console.log('Проверка:');
  console.log(`  launchctl list | grep ${PLIST_LABEL}`);
  console.log('');
  console.log('Если уже был загружен раньше — сначала unload:');
  console.log(`  launchctl unload ${targetPath}`);
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
