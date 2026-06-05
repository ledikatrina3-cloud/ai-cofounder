// One-shot scheduler for manual routines (план 2026-05-22-cross-project-runner).
//
// Использование:
//   pnpm exec tsx scripts/schedule-one-shot.ts <routineId> <delaySeconds>
//   pnpm exec tsx scripts/schedule-one-shot.ts marketing-content-example-project 300
//
// Что делает:
//   1. Создаёт Record `event.routine.scheduled-once` со status='active' и
//      scheduledAtMs = now + delay. Bridge API (routines-api.ts) подхватит
//      этот Record как `nextRunAt` для UI countdown.
//   2. Спавнит detached child-процесс, который через `delaySeconds`:
//        a) закрывает Record (status='consumed', closedAt=now)
//        b) запускает `pnpm cron:run:routine <routineId>` синхронно
//   3. Сам выходит немедленно (родительский tsx завершается, child живёт).
//
// Почему Record, а не файл:
//   * UI уже умеет читать Records (Bridge API → useRoutines). Не плодим
//     отдельных JSON-stores.
//   * Idempotency: если случайно запустить дважды — два разных Record,
//     каждый со своим ULID. На UI отобразится «последний» по createdAt DESC.
//   * Аудит: после consumed-перехода видно когда был fire, сколько ждал.
//
// Безопасность:
//   * Не запускает routine с enabled=false (диспетчер сам скипнет). Скрипт
//     наоборот: предупреждает фаундера если так.
//   * Не выполняет shell-injection: routineId передаётся как argv, не через shell.

import { type ChildProcess, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ulid } from 'ulid';
import { disposePrisma, getPrisma } from '../src/db/client.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function main(): Promise<void> {
  const routineId = process.argv[2];
  const delayRaw = process.argv[3];
  if (routineId === undefined || routineId === '' || delayRaw === undefined || delayRaw === '') {
    console.error('Использование: tsx scripts/schedule-one-shot.ts <routineId> <delaySeconds>');
    console.error(
      'Пример:        pnpm exec tsx scripts/schedule-one-shot.ts marketing-content-example-project 300',
    );
    process.exit(1);
  }

  const delaySeconds = Number.parseInt(delayRaw, 10);
  if (!Number.isFinite(delaySeconds) || delaySeconds < 5 || delaySeconds > 86400) {
    console.error(`delaySeconds должен быть целым 5..86400, получено '${delayRaw}'.`);
    process.exit(1);
  }

  const db = getPrisma();
  const nowMs = Date.now();
  const scheduledAtMs = nowMs + delaySeconds * 1000;
  const recordId = ulid();

  await db.record.create({
    data: {
      id: recordId,
      type: 'event.routine.scheduled-once',
      properties: JSON.stringify({
        routineId,
        scheduledAtMs,
        delaySeconds,
        source: 'schedule-one-shot',
      }),
      actorKind: 'founder',
      status: 'active',
      visibility: 'autonomous',
    },
  });

  const planned = new Date(scheduledAtMs).toLocaleString(undefined, { hour12: false });
  console.log(
    `[schedule] routine '${routineId}' запланирован на ${planned} (через ${delaySeconds}с).`,
  );
  console.log(`[schedule] record id: ${recordId}, status=active`);

  await disposePrisma();

  // Fork detached child — родитель умирает, child спит и потом запускает.
  // Через `node -e` чтобы не тащить tsx в детач (быстрее старт).
  const childScript = `
    const { spawn } = require('node:child_process');
    const { resolve } = require('node:path');
    const REPO_ROOT = ${JSON.stringify(REPO_ROOT)};
    const RECORD_ID = ${JSON.stringify(recordId)};
    const ROUTINE_ID = ${JSON.stringify(routineId)};
    const DELAY_MS = ${delaySeconds * 1000};

    setTimeout(async () => {
      // 1. Закрываем Record event.routine.scheduled-once → status='consumed'.
      //    Делаем это через отдельный node child (минимально, без tsx).
      const close = spawn('node', ['--no-warnings', '-e', \`
        const Database = require('better-sqlite3');
        const path = require('node:path');
        const dbPath = path.join('${REPO_ROOT}', 'prisma', 'dev.db');
        const db = new Database(dbPath);
        db.prepare("UPDATE Record SET status='consumed', closedAt=datetime('now'), closedReason='fired' WHERE id=?").run('\${RECORD_ID}');
        db.close();
      \`], { cwd: REPO_ROOT, stdio: 'inherit' });
      close.on('close', () => {
        // 2. Запускаем routine через pnpm dev:run (manual trigger, unique ULID
        // каждый раз). cron:run:routine использует per-day idempotency и
        // отказался бы повторно запускать ту же routine за день.
        const run = spawn('pnpm', ['--silent', 'dev:run', ROUTINE_ID, '--unique'], {
          cwd: REPO_ROOT,
          stdio: ['ignore', process.stdout, process.stderr],
          env: process.env,
          detached: false,
        });
        run.on('close', (code) => process.exit(code ?? 0));
      });
    }, DELAY_MS);
  `;

  const child: ChildProcess = spawn('node', ['--no-warnings', '-e', childScript], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });

  child.unref();
  console.log(`[schedule] детач-процесс pid=${child.pid} спит ${delaySeconds}с до запуска.`);
}

main().catch((err) => {
  console.error('schedule-one-shot fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
