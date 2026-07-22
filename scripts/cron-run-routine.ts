// CLI-точка входа для launchd cron-job'а (фаза 1.4).
//
// Использование: tsx scripts/cron-run-routine.ts <routineId>
//   (или через pnpm:  pnpm cron:run:routine <routineId>)
//
// Что делает:
//   * Берёт routineId из process.argv[2]. Если нет — error + process.exit(1).
//   * Формирует runDate по локальному ISO (YYYY-MM-DD) мака.
//   * Создаёт trigger через triggerCronRoutine(routineId, now) из triggers.ts.
//   * Вызывает runRoutine(routineId, runDate, trigger) из dispatcher.ts.
//   * В finally: disposePrisma().
//
// Почему не `dev:run`:
//   * `dev:run` использует детерминированный manual-ключ `:dev:<date>` — он
//     нужен для тестирования без реального launchd. `cron:run:routine`
//     использует настоящий cron-ключ `routine:<id>:<date>` — идемпотентность
//     по дате, как задумано в production.
//
// Что launchd будет выполнять:
//   pnpm --silent cron:run:routine <routineId>
// Это работает из WorkingDirectory репозитория, поэтому все резолвы
// (Prisma, config, routines) идут от cwd=repoRoot.

import { runRoutine } from '../src/core/dispatcher.js';
import { triggerCronRoutine } from '../src/core/triggers.js';
import { disposePrisma } from '../src/db/client.js';

function todayLocalIso(now: Date = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function main(): Promise<void> {
  const routineId = process.argv[2];
  if (routineId === undefined || routineId === '') {
    console.error('Использование: tsx scripts/cron-run-routine.ts <routineId>');
    console.error('Пример:        pnpm cron:run:routine example-noop');
    process.exit(1);
  }

  const now = new Date();
  const runDate = todayLocalIso(now);
  const trigger = triggerCronRoutine(routineId, now);

  try {
    await runRoutine(routineId, runDate, trigger);
  } finally {
    await disposePrisma();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
