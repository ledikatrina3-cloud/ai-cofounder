// migrate-routines — кодмод legacy `routines/<id>.md` → самодостаточная папка
// `agents/<id>/` (OSS v1.0). Для форкеров, у которых есть старые flat-routine'ы.
//
// Использование:
//   pnpm exec tsx scripts/migrate-routines.ts                 # dry-run, все routines
//   pnpm exec tsx scripts/migrate-routines.ts --write         # применить
//   pnpm exec tsx scripts/migrate-routines.ts --write --delete  # + удалить flat-файл
//   pnpm exec tsx scripts/migrate-routines.ts --out examples <id> [<id>...]  # выбранные, в examples/
//
// Маппинг (обратный к agent-loader.ts):
//   routine.id            → имя папки agents/<id>/ (ВАЖНО: launchd-плисты вшивают
//                           frontmatter id, поэтому папка = id, не имя файла)
//   role||id              → AGENT.md displayName
//   description           → тело AGENT.md
//   prompt (body)         → prompt.md
//   tools, bashWhitelist  → permissions.yml (tools / bash)
//   targetProject         → target.yml (cwd резолвится из config/projects.md)
//   src/report/templates/<id>.md → agents/<id>/report.md (если есть)
//
// Идемпотентно по флагу: повторный --write перезаписывает файлы агента.
// FORBIDDEN: не трогает живой launchd. Миграция cron-агента в проде = ещё и
// `launchctl bootout` старого плиста + переустановка (см. план §3, ручной шаг).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import fg from 'fast-glob';
import { stringify as stringifyYaml } from 'yaml';
import { getProject } from '../src/projects/registry.js';
import { type Routine, parseRoutineFile } from '../src/routines/parser.js';

interface Args {
  write: boolean;
  del: boolean;
  outDir: string;
  ids: string[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = { write: false, del: false, outDir: 'agents', ids: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') out.write = true;
    else if (a === '--delete') out.del = true;
    else if (a === '--out') {
      i++;
      out.outDir = argv[i] ?? 'agents';
    } else if (a !== undefined && !a.startsWith('--')) out.ids.push(a);
  }
  return out;
}

// Каноническое значение → короткий алиас (для читаемого AGENT.md).
const OUTPUT_TO_ALIAS: Record<string, string> = {
  'telegram-thread': 'telegram',
  'journal-only': 'journal',
  both: 'both',
};

function buildAgentMd(r: Routine): string {
  // Frontmatter — плоский YAML-маппинг. Только заданные поля.
  const fm: Record<string, unknown> = {
    id: r.id,
    displayName: r.role ?? r.id,
    ...(r.role !== undefined ? { role: r.role } : {}),
    ...(r.avatar !== undefined ? { avatar: r.avatar } : {}),
    ...(r.color !== undefined ? { color: r.color } : {}),
    ...(r.logo !== undefined ? { logo: r.logo } : {}),
    model: r.model,
    enabled: r.enabled,
    schedule: r.trigger,
    output: OUTPUT_TO_ALIAS[r.outputType] ?? r.outputType,
    maxTokens: r.maxTokens,
    timeoutMs: r.timeoutMs,
    ...(r.departmentId !== undefined ? { department: r.departmentId } : {}),
    ...(r.skills !== undefined ? { skills: r.skills } : {}),
    ...(r.forceLoad !== undefined ? { forceLoad: r.forceLoad } : {}),
  };
  const body = r.description.trim();
  return `---\n${stringifyYaml(fm).trimEnd()}\n---\n\n${body}\n`;
}

function buildPermissionsYml(r: Routine): string | null {
  // Нет ни tools, ни bashWhitelist → permissions.yml не нужен (silence = safe).
  if (r.tools.length === 0 && (r.bashWhitelist === undefined || r.bashWhitelist.length === 0)) {
    return null;
  }
  const perms: Record<string, unknown> = { tools: r.tools };
  if (r.bashWhitelist !== undefined && r.bashWhitelist.length > 0) perms.bash = r.bashWhitelist;
  return stringifyYaml(perms);
}

async function buildTargetYml(r: Routine, cwd: string): Promise<string | null> {
  if (r.targetProject === undefined) return null;
  let resolvedCwd = `# TODO: путь к репозиторию проекта '${r.targetProject}'`;
  try {
    const proj = await getProject(r.targetProject, { cwd });
    if (proj !== null && proj.path !== '') resolvedCwd = proj.path;
  } catch {
    // реестр недоступен — оставляем TODO-плейсхолдер
  }
  return stringifyYaml({ cwd: resolvedCwd });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  // README.md — это документация папки routines/, а не routine-файл; исключаем,
  // иначе на свежем клоне dry-run печатает ложный "parse error" по ней.
  const files = await fg(['routines/*.md', '!routines/README.md'], {
    cwd,
    absolute: true,
    onlyFiles: true,
  });
  const selected =
    args.ids.length > 0 ? files.filter((f) => args.ids.includes(basename(f, '.md'))) : files;

  if (selected.length === 0) {
    console.log('Не найдено routine-файлов для миграции (routines/*.md).');
    return;
  }

  const mode = args.write ? (args.del ? 'WRITE+DELETE' : 'WRITE') : 'DRY-RUN';
  console.log(`migrate-routines [${mode}] → ${args.outDir}/<id>/  (${selected.length} файлов)\n`);

  let migrated = 0;
  for (const file of selected) {
    let r: Routine;
    try {
      r = await parseRoutineFile(resolve(file));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${basename(file)}: пропуск (parse error): ${msg}`);
      continue;
    }

    const agentDir = join(cwd, args.outDir, r.id);
    const agentMd = buildAgentMd(r);
    const permsYml = buildPermissionsYml(r);
    const targetYml = await buildTargetYml(r, cwd);
    const templatePath = join(cwd, 'src', 'report', 'templates', `${r.id}.md`);
    const hasTemplate = existsSync(templatePath);

    const planned = [
      `${args.outDir}/${r.id}/AGENT.md`,
      `${args.outDir}/${r.id}/prompt.md`,
      ...(permsYml !== null ? [`${args.outDir}/${r.id}/permissions.yml`] : []),
      ...(targetYml !== null ? [`${args.outDir}/${r.id}/target.yml`] : []),
      ...(hasTemplate ? [`${args.outDir}/${r.id}/report.md`] : []),
    ];
    console.log(`  ${basename(file)} → ${r.id}/  [${planned.map((p) => basename(p)).join(', ')}]`);

    if (args.write) {
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'AGENT.md'), agentMd, 'utf8');
      writeFileSync(join(agentDir, 'prompt.md'), `${r.prompt.trim()}\n`, 'utf8');
      if (permsYml !== null) writeFileSync(join(agentDir, 'permissions.yml'), permsYml, 'utf8');
      if (targetYml !== null) writeFileSync(join(agentDir, 'target.yml'), targetYml, 'utf8');
      if (hasTemplate) {
        writeFileSync(join(agentDir, 'report.md'), readFileSync(templatePath, 'utf8'), 'utf8');
      }
      if (args.del) {
        rmSync(resolve(file));
        if (hasTemplate) rmSync(templatePath);
      }
    }
    migrated++;
  }

  console.log(`\n${args.write ? 'Готово' : 'Dry-run'}: ${migrated} агентов.`);
  if (!args.write)
    console.log('Запусти с --write чтобы применить (--delete — удалить flat-файлы).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
