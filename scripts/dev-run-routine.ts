// Ручной запуск routine — критерий «сделано» фазы 1.3
// (`plans/`).
//
// Использование:
//   pnpm dev:run <routineId>            — детерминированный ключ по дате (как
//                                          dev:tick); повторный запуск в ту же
//                                          дату → audit.repeat. Это и есть
//                                          критерий «два запуска → один
//                                          event.routine.trigger + один
//                                          audit.repeat».
//   pnpm dev:run <routineId> --unique   — новый ULID, как настоящий /run в
//                                          Telegram: каждый запуск = отдельный
//                                          прогон (фаза 1.6/Telegram).
//
// Почему дефолт детерминированный, а не manual-ULID:
//   * соответствие критерию «сделано» в плане;
//   * параллель со старым `pnpm dev:tick` (который тоже использует
//     `triggerDevTick` — `manual-tick:YYYY-MM-DD`);
//   * фаундер обычно дёргает routine для smoke-теста; двойной запуск без
//     намерения → попадание в audit.repeat = правильное поведение, а не
//     лишний прогон;
//   * настоящий «принудительный заново» — `--unique` или `/run` из Telegram.
//
// Контракт `runRoutine` возвращает Promise<void>: подробности — в audit.routine.*
// Records и emit'ах Bridge. Здесь печатаем минимум для проверки глазами.

import { runRoutine } from '../src/core/dispatcher.js';
import { type RunRoutineTrigger, triggerManualRoutine } from '../src/core/triggers.js';
import { disposePrisma } from '../src/db/client.js';
import { getRoutine } from '../src/routines/registry.js';

function todayLocalIso(now: Date = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Детерминированный manual-trigger для dev-CLI: префикс 'dev' отделяет от
// настоящего cron-триггера ('routine:<id>:<date>') и не пересекается с manual
// ('routine:<id>:manual:<ULID>'). Source='manual', потому что фаундер дёргает
// руками.
function triggerDevRoutine(routineId: string, runDate: string): RunRoutineTrigger {
  return {
    source: 'manual',
    idempotencyKey: `routine:${routineId}:dev:${runDate}`,
  };
}

async function main(): Promise<void> {
  const routineId = process.argv[2];
  if (routineId === undefined || routineId === '') {
    console.error('Использование: pnpm dev:run <routineId> [--unique]');
    console.error('Пример:        pnpm dev:run example-noop');
    process.exit(1);
  }

  const unique = process.argv.includes('--unique');

  const runDate = todayLocalIso();
  const trigger = unique ? triggerManualRoutine(routineId) : triggerDevRoutine(routineId, runDate);

  // Pre-check: диспетчер МОЛЧА пропускает disabled-агента для ЛЮБОГО триггера
  // (audit.routine.* reason=routine-disabled), а runRoutine возвращает void —
  // без этой проверки dev:run печатал бы зелёный ✓, хотя loader→dispatcher→журнал
  // не выполнялся (ровно та ловушка, о которой предупреждает scaffold-agent.md).
  const routine = await getRoutine(routineId);
  if (routine === null) {
    console.error(
      `✗ агент '${routineId}' не найден в реестре (agents/<id>/ или routines/). Нечего запускать.`,
    );
    await disposePrisma();
    process.exit(1);
  }
  if (!routine.enabled) {
    console.error(
      `✗ агент '${routineId}' — enabled:false: диспетчер его ПРОПУСТИТ, прогон не состоится. Поставь enabled:true в AGENT.md и повтори.`,
    );
    await disposePrisma();
    process.exit(1);
  }

  console.log(`▶ runRoutine '${routineId}' runDate=${runDate}`);
  console.log(`  trigger.idempotencyKey=${trigger.idempotencyKey}`);
  if (!unique) {
    console.log('  (детерминированный ключ — повтор в ту же дату даст audit.repeat)');
  }
  console.log('');

  try {
    await runRoutine(routineId, runDate, trigger);
    console.log('');
    console.log('✓ runRoutine завершён. Подробности — в audit.routine.* Records.');
  } finally {
    await disposePrisma();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
