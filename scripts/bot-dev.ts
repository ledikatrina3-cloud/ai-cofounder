// `pnpm bot:dev` — запуск grammy long-poll бота в foreground.
// Тонкая обёртка: createBot() читает токен из Keychain + allowlist из Page,
// поднимает middleware и хендлеры, затем bot.start() блокирует процесс
// до Ctrl-C / SIGTERM. Любая ошибка бота (5xx от Telegram, парсинг update'а)
// логируется через bot.catch() в bot.ts; сам процесс остаётся жив.
//
// АГЕНТ САМ ЭТОТ СКРИПТ НЕ ЗАПУСКАЕТ — это touchpoint с реальным Telegram API.

import { disposePrisma } from '../src/db/client.js';
import { createBot } from '../src/telegram/bot.js';

async function main(): Promise<void> {
  const handle = await createBot();

  // Корректно останавливаем long-poll на сигналах от systemd/Ctrl-C.
  const onSignal = (signal: string) => {
    console.log(`\n[bot:dev] получен ${signal}, останавливаем long-poll`);
    handle
      .stop()
      .catch((err: unknown) => {
        console.error('[bot:dev] ошибка остановки бота:', err);
      })
      .finally(() => {
        void disposePrisma().finally(() => process.exit(0));
      });
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  await handle.start();
}

main().catch((err: unknown) => {
  console.error('[bot:dev] не удалось запустить бота:', err);
  void disposePrisma().finally(() => process.exit(1));
});
