// Ручной разовый прогон stateless-фетча support-бота — критерий «сделано»
// фазы 2.1b (plans/): запускаем дважды подряд →
// первый раз N event.support.message + 1 audit.fetch.support, второй —
// 0 новых + 1 audit.fetch.support с `messagesDeduplicated=N`.
//
// ВАЖНО: этот скрипт обращается к РЕАЛЬНОМУ Telegram API через токен из
// macOS Keychain (`pnpm pair:support`). Агент САМ его не запускает — это
// touchpoint с внешним сервисом. Запускает фаундер вручную.
//
// Сшивка `runIteration` → `fetchSupportMessages` отложена до фазы 2.5.
// Сейчас это самостоятельный CLI: ничего не прокидывает в loop.ts, только
// пишет event.support.message + audit.fetch.support, эмитит BridgeEvents.

import { disposePrisma, getPrisma } from '../src/db/client.js';
import { fetchSupportMessages } from '../src/perception/support.js';

async function main(): Promise<void> {
  const db = getPrisma();
  try {
    const result = await fetchSupportMessages({ db });
    console.log('');
    console.log(
      JSON.stringify(
        {
          ...result,
          since: result.since !== null ? result.since.toISOString() : null,
          until: result.until.toISOString(),
        },
        null,
        2,
      ),
    );
  } finally {
    await disposePrisma();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
