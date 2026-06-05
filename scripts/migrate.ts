// migrate — раннер миграций ПОЛЬЗОВАТЕЛЬСКОГО слоя при обновлении движка.
//
// Зачем: `prisma migrate` мигрирует схему БД. Но обновление движка может менять
// и формат пользовательских файлов (AGENT.md, permissions.yml, config/*). Этот
// раннер — шов для таких миграций: version-gated, идемпотентный.
//
// v1.0 — заглушка: MIGRATIONS пуст (мигрировать нечего), раннер просто фиксирует
// текущую версию. Когда vNext поменяет формат user-файлов — добавляем сюда запись
// { from, to, run } и она применится на `pnpm migrate` после `git pull`.
//
// Использование: pnpm migrate   (вызывается из scripts/update-engine.sh)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface UserFileMigration {
  /** Применяется при апгрейде С версии < `appliesUpToVersion`. */
  appliesUpToVersion: string;
  description: string;
  run: (repoRoot: string) => Promise<void>;
}

// v1.0: миграций пользовательского слоя нет.
const MIGRATIONS: UserFileMigration[] = [];

const STATE_FILE = '.ai-cofounder-migrate-state'; // последняя применённая версия (gitignored)

/** Сравнение semver: -1 | 0 | 1. Терпит «1.2» (недостающие сегменты = 0). */
export function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Какие миграции реально надо применить, апгрейдясь С версии `last`.
 * Миграция с `appliesUpToVersion: X` нужна, если апгрейдимся С версии < X
 * (т.е. её ещё не применяли). `last === null` (первый прогон) → нужны все.
 * Это и есть version-gate: без него loop крутил бы все миграции каждый раз.
 */
export function pendingMigrations(
  last: string | null,
  migrations: readonly UserFileMigration[] = MIGRATIONS,
): UserFileMigration[] {
  if (last === null) return [...migrations];
  return migrations.filter((m) => cmpSemver(last, m.appliesUpToVersion) < 0);
}

function readVersion(repoRoot: string): string {
  const p = resolve(repoRoot, 'VERSION');
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : '0.0.0';
}

function readLastApplied(repoRoot: string): string | null {
  const p = resolve(repoRoot, STATE_FILE);
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const version = readVersion(repoRoot);
  const last = readLastApplied(repoRoot);

  const pending = pendingMigrations(last);
  if (pending.length === 0) {
    console.log(
      `migrate: миграций пользовательского слоя нет (v${version}, last=${last ?? 'none'}). OK.`,
    );
  } else {
    let applied = 0;
    for (const m of pending) {
      console.log(`migrate: применяю «${m.description}» (до v${m.appliesUpToVersion})...`);
      await m.run(repoRoot);
      applied++;
    }
    console.log(`migrate: применено ${applied} миграций пользовательского слоя.`);
  }

  writeFileSync(resolve(repoRoot, STATE_FILE), `${version}\n`, 'utf8');
  if (last !== null && last !== version) {
    console.log(`migrate: версия ${last} -> ${version} зафиксирована.`);
  }
}

// Запускаем main() только при прямом вызове (tsx scripts/migrate.ts), не при
// импорте из тестов — иначе импорт writeFileSync'нул бы state-файл как сайд-эффект.
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isDirectRun) {
  main().catch((err) => {
    console.error('migrate: ошибка', err);
    process.exit(1);
  });
}
