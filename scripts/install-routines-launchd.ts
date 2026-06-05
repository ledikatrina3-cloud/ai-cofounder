// Установка launchd plist'ов для всех enabled routines с cron-trigger.
//
// По образцу `scripts/install-launchd.ts` (утренний детектив).
//
// Что делает:
//   1. Резолвит пути pnpm/node через `which`.
//   2. getRoutinesByCron() — список enabled cron-routines из реестра.
//   3. Для каждой routine генерирует plist через generateRoutinePlistXml.
//   4. plutil -lint на temp-файл (синтаксическая валидация перед записью).
//   5. Записывает в ~/Library/LaunchAgents/com.ai-cofounder.routine-<id>.plist.
//   6. НЕ ВЫЗЫВАЕТ launchctl — печатает инструкцию для фаундера.
//
// Флаги:
//   --dry-run         — только stdout + plutil-lint, не пишет в LaunchAgents.
//   --only <routineId> — установить plist только для одной routine
//                         (хирургический режим: не трогает остальные cron-routines).
//
// Принципы CLAUDE.md:
//   * «Не запускай launchctl load» — всегда инструкция, не автоматика.
//   * «Не хардкодить динамику» — пути через `which`.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateRoutinePlistXml } from '../src/routines/cron.js';
import { getRoutinesByCron } from '../src/routines/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');

interface ResolvedPaths {
  // pnpm нужен только для pathEnv (info-вывод). В plist кладём node + tsxCli.
  pnpm: string;
  node: string;
  tsxCli: string;
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
  // Резолвим РЕАЛЬНЫЙ tsx CLI entry (не sh-обёртку): pnpm раскладывает пакеты
  // через `node_modules/.pnpm/<name>@<version>/node_modules/<name>/`, ищем
  // самую новую версию tsx. node читает cli.mjs стандартным file-IO под
  // launchd — sh-обёртку TCC блокирует.
  const tsxCli = resolveTsxCli();
  // launchd запускает job с минимальным PATH. Добавляем директории pnpm/node
  // и стандартные системные пути (для side-эффектов вроде `git` / `gh`, которые
  // могут понадобиться внутри routine).
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
  return { pnpm, node, tsxCli, pathEnv };
}

function resolveTsxCli(): string {
  const pnpmDir = join(REPO_ROOT, 'node_modules', '.pnpm');
  let entries: string[];
  try {
    entries = readdirSync(pnpmDir).filter((n) => n.startsWith('tsx@'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`не могу прочитать ${pnpmDir} (${msg}). Запусти 'pnpm install' и повтори.`);
  }
  if (entries.length === 0) {
    throw new Error(`tsx не найден в ${pnpmDir}. Запусти 'pnpm install'.`);
  }
  // Берём первую (на практике одна версия в lockfile). Если несколько — sort desc.
  entries.sort().reverse();
  const cli = join(pnpmDir, entries[0]!, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!existsSync(cli)) {
    throw new Error(`tsx CLI отсутствует по пути ${cli}. Запусти 'pnpm install'.`);
  }
  return cli;
}

function plutilLint(path: string): void {
  try {
    execFileSync('/usr/bin/plutil', ['-lint', path], { stdio: 'inherit' });
  } catch {
    throw new Error(`plutil -lint провалился на ${path}`);
  }
}

function parseOnlyFlag(argv: string[]): string | null {
  const idx = argv.indexOf('--only');
  if (idx === -1) return null;
  const value = argv[idx + 1];
  if (value === undefined || value === '' || value.startsWith('--')) {
    throw new Error("--only требует имя routine: '--only marketing-content-example-project'.");
  }
  return value;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const only = parseOnlyFlag(process.argv);
  const paths = resolvePaths();

  console.log(`pnpm    → ${paths.pnpm}`);
  console.log(`node    → ${paths.node}`);
  console.log(`tsxCli  → ${paths.tsxCli}`);
  console.log(`repo    → ${REPO_ROOT}`);
  console.log(`PATH    → ${paths.pathEnv}`);
  if (only !== null) console.log(`only  → ${only}`);
  console.log('');

  const allCronRoutines = await getRoutinesByCron();
  const routines = only === null ? allCronRoutines : allCronRoutines.filter((r) => r.id === only);

  if (only !== null && routines.length === 0) {
    const known = allCronRoutines.map((r) => r.id).join(', ') || '<пусто>';
    throw new Error(`--only '${only}' не нашёл routine с cron-trigger. Доступные: ${known}.`);
  }

  if (routines.length === 0) {
    console.log('Нет routines с cron-trigger (или все disabled). Ничего устанавливать.');
    return;
  }

  console.log(`Найдено ${routines.length} cron-routine(s):`);
  for (const r of routines) {
    console.log(`  - ${r.id} (trigger: ${r.trigger})`);
  }
  console.log('');

  const installedPaths: string[] = [];

  for (const routine of routines) {
    const xml = generateRoutinePlistXml(routine, {
      node: paths.node,
      tsxCli: paths.tsxCli,
      pathEnv: paths.pathEnv,
      repoRoot: REPO_ROOT,
    });

    const plistName = `com.ai-cofounder.routine-${routine.id}.plist`;

    // Всегда lint через temp-файл.
    const tmpDir = mkdtempSync(join(tmpdir(), 'ai-cofounder-launchd-'));
    const tmpPath = join(tmpDir, plistName);
    writeFileSync(tmpPath, xml, 'utf8');
    plutilLint(tmpPath);

    if (dryRun) {
      console.log(`--- BEGIN PLIST: ${plistName} ---`);
      console.log(xml);
      console.log(`--- END PLIST: ${plistName} ---`);
      console.log('');
      continue;
    }

    const targetPath = join(LAUNCH_AGENTS_DIR, plistName);
    writeFileSync(targetPath, xml, 'utf8');
    console.log(`✓ plist записан: ${targetPath}`);
    installedPaths.push(targetPath);
  }

  if (dryRun) {
    console.log("✓ dry-run OK. Все plist'ы прошли plutil -lint.");
    return;
  }

  if (installedPaths.length > 0) {
    console.log('');
    console.log('Что дальше — РУКАМИ (для каждого plist):');
    for (const p of installedPaths) {
      console.log(`  launchctl load ${p}`);
    }
    console.log('');
    console.log('Проверка:');
    console.log('  launchctl list | grep ai-cofounder.routine');
    console.log('');
    console.log('Если уже был загружен раньше — сначала unload:');
    for (const p of installedPaths) {
      console.log(`  launchctl unload ${p}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
