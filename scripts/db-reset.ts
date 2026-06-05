// Полная пересборка dev.db.
//
// Почему отдельный скрипт, а не `prisma migrate reset`:
//   * После `pnpm db:migrate` в БД появляется virtual table `vec_intent_problem`
//     и её shadow-таблицы (`vec_intent_problem_chunks`, `_info`, `_rowids`,
//     `_vector_chunks00`). Они валидны для sqlite-vec, но Prisma sqlite-driver
//     их не понимает — `prisma migrate reset` падает с
//     «database disk image is malformed» при попытке прочитать `_prisma_migrations`,
//     даже после явного DROP TABLE через vec-aware connection.
//   * Самый надёжный путь — удалить файлы dev.db / -wal / -shm физически, затем
//     `prisma migrate deploy` поднимет схему с нуля + наш `init-vec.ts` создаст
//     virtual table.
//
// Гард: требует переменную PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION (тот же
// механизм, что у Prisma 6+ для migrate reset). Без неё агенту нельзя сносить БД.

import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { resolveSqliteFilePath } from '../src/db/client.js';

function ensureConsent(): void {
  if (!process.env.PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION) {
    // eslint-disable-next-line no-console
    console.error('db:reset: требует PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION (см. ретро 1.1).');
    process.exit(1);
  }
}

function removeIfExists(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
    // eslint-disable-next-line no-console
    console.log(`✓ removed ${path}`);
  }
}

function main(): void {
  ensureConsent();
  const dbPath = resolveSqliteFilePath();
  removeIfExists(dbPath);
  removeIfExists(`${dbPath}-wal`);
  removeIfExists(`${dbPath}-shm`);

  // Делаем `prisma migrate deploy` через дочерний процесс — у него своя
  // sqlite-driver-сессия, никаких артефактов от наших коннектов.
  const deploy = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: process.env,
  });
  if (deploy.status !== 0) {
    process.exit(deploy.status ?? 1);
  }

  // init-vec — тоже отдельным процессом, чтобы не таскать в этот скрипт
  // зависимость от @xenova/transformers (init-vec её не требует, но избегаем
  // shared cache с прочими модулями).
  const init = spawnSync('pnpm', ['exec', 'tsx', 'scripts/init-vec.ts'], {
    stdio: 'inherit',
    env: process.env,
  });
  if (init.status !== 0) {
    process.exit(init.status ?? 1);
  }
}

main();
