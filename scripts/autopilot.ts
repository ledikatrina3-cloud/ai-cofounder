// `pnpm autopilot` — один портативный entrypoint, поднимающий долгоживущие
// сервисы кофаундера: bridge-сервер (бэкенд 3D-офиса) + Telegram-бот. Чтобы
// форкеру не держать три терминала вручную.
//
// Что делает:
//   1. Preflight: проверяет DATABASE_URL, прогоняет `pnpm db:migrate` (best-effort).
//   2. Спавнит bridge-сервер, ждёт /healthz (необязательно — продолжаем даже если
//      health не ответил: бот от bridge не зависит).
//   3. Спавнит Telegram-бот. Нет токена в Keychain → бот сам падает, мы это
//      логируем и продолжаем БЕЗ бота (graceful degradation, не валим autopilot).
//   4. SIGINT/SIGTERM → корректно гасим детей и выходим.
//
// Что НЕ делает: не планирует cron-запуски. Расписание агентов — через launchd
// (`pnpm install:launchd:routines`, macOS). tick-cron одноразовый, гонять его в
// цикле здесь было бы неверно. Кросс-платформенный планировщик — задача v1.1+.
//
// Это НОВЫЙ opt-in скрипт: существующие потоки (launchd, bot:dev, bridge:server)
// он не трогает и не вызывается ими — нулевой риск регрессии.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';

const BRIDGE_PORT = process.env.BRIDGE_PORT ?? process.env.PORT ?? '3737';
const HEALTH_URL = `http://127.0.0.1:${BRIDGE_PORT}/healthz`;
const HEALTH_TIMEOUT_MS = 8000;
const HEALTH_INTERVAL_MS = 400;

const children: ChildProcess[] = [];
let shuttingDown = false;

function log(msg: string): void {
  console.log(`[autopilot] ${msg}`);
}

function preflight(): void {
  if (!process.env.DATABASE_URL) {
    log('DATABASE_URL не задан — задай в .env.local (file:./prisma/dev.db для локали).');
  }
  log('db:migrate (prisma deploy + sqlite-vec init)…');
  const res = spawnSync('pnpm', ['db:migrate'], { stdio: 'inherit' });
  if (res.status !== 0) {
    log('db:migrate завершился с ненулевым кодом — продолжаю, но БД может быть не готова.');
  }
}

function spawnService(name: string, command: string, args: string[]): ChildProcess {
  log(`старт ${name}: ${command} ${args.join(' ')}`);
  const child = spawn(command, args, { stdio: 'inherit' });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    log(`${name} завершился (code=${code ?? '-'}, signal=${signal ?? '-'}). Продолжаю без него.`);
  });
  child.on('error', (err) => {
    log(`${name} не удалось запустить: ${err.message}`);
  });
  return child;
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) {
        log(`bridge готов (${HEALTH_URL}).`);
        return;
      }
    } catch {
      // ещё поднимается
    }
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
  }
  log(
    `bridge не ответил на ${HEALTH_URL} за ${HEALTH_TIMEOUT_MS}мс — продолжаю (бот не зависит от него).`,
  );
}

function installSignalHandlers(): void {
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`получен ${signal} — гашу сервисы…`);
    for (const child of children) {
      if (!child.killed) child.kill('SIGTERM');
    }
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function main(): Promise<void> {
  log('запуск автопилота (bridge + telegram-бот).');
  installSignalHandlers();
  preflight();

  spawnService('bridge-server', 'pnpm', ['bridge:server']);
  await waitForHealth();
  spawnService('telegram-bot', 'pnpm', ['bot:dev']);

  log(
    'сервисы подняты. Расписание агентов — через launchd: pnpm install:launchd:routines (macOS).',
  );
  log('Ctrl-C для остановки.');
}

main().catch((err: unknown) => {
  console.error('[autopilot] fatal:', err);
  process.exit(1);
});
