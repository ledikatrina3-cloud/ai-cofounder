// CLI `pnpm pair:support` — интерактивный pairing второго Telegram-инстанса:
// support-бота downstream-проекта. AI-Cofounder будет ЧИТАТЬ из него входящие
// сообщения клиентов в фазе 2.1b (stateless fetch), не отвечать. Никаких
// хендлеров, никакого long-poll, никакого middleware.
//
// Что делает CLI:
//   1. Спрашивает support-bot token у фаундера (от @BotFather downstream-проекта).
//   2. Спрашивает source chat_id — откуда забирать сообщения (личный чат
//      поддержки или группа клиентов).
//   3. Кладёт токен в Keychain под service='ai-cofounder.support-bot',
//      account='default' — отдельный от founder-bot service, чтобы ротация
//      одного токена не задевала другой.
//   4. Дописывает chat_id в Page `config/support-source.md`, секцию
//      `## support-source`. Идемпотентно (повторный запуск с тем же chat_id
//      не дублирует), формат — как у `config/allowlist.md`.
//
// Запуск: фаундер вручную `pnpm pair:support`. Агент НЕ запускает —
// touchpoint с реальным Telegram (получение токена у @BotFather, выбор канала).
//
// Тесты: переиспользует `runPairing(deps, SUPPORT_PAIRING_CONFIG)` и
// `ensureSupportSourceEntry(chatId, cwd?)` через DI — vitest подменяет I/O
// без реального Keychain'а (см. `tests/telegram.test.ts`).

import { type Interface as ReadlineInterface, createInterface } from 'node:readline/promises';
import { setPassword } from 'keytar';
import {
  KEYTAR_ACCOUNT,
  SUPPORT_KEYTAR_SERVICE,
  SUPPORT_SOURCE_PATH,
  SUPPORT_SOURCE_SECTION,
} from '../src/telegram/secrets.js';
import { type PairingConfig, ensurePageEntry, runPairing } from './pair.js';

export const SUPPORT_PAIRING_CONFIG: PairingConfig = {
  channel: SUPPORT_SOURCE_SECTION,
  keytarTarget: `${SUPPORT_KEYTAR_SERVICE} / ${KEYTAR_ACCOUNT}`,
  pagePath: SUPPORT_SOURCE_PATH,
  banner: 'Telegram pairing AI-Cofounder (support-bot, read-only)',
  promptTokenLabel: 'Support bot token (формат "12345:AAA..."): ',
  promptChatIdLabel: 'Source chat_id (откуда читать клиентов; -100… для группы): ',
  successHint:
    'Готово. Фактический забор сообщений включится в фазе 2.1b ' +
    '(`pnpm dev:fetch:support`). Сейчас бот никуда не подключается.',
};

const SUPPORT_SOURCE_TEMPLATE = `# Support-bot source channels

Список chat_id-ов, откуда AI-Cofounder читает входящие сообщения support-бота
downstream-проекта (фаза 2.1b, stateless fetch). Read-only — бот не отвечает.

Формат:
- Секция \`## support-source\` — единственный список source-каналов.
- Записи: \`- <chat_id>\` или \`- <chat_id> # <комментарий>\`
  (положительное число — личка клиента, отрицательное — группа/канал).

Изменения этого файла идут через \`pnpm pair:support\` (фаза 2.1a).
Ручная правка тоже легитимна — формат стабилен.

## support-source
`;

export async function ensureSupportSourceEntry(
  chatId: string,
  cwd: string = process.cwd(),
): Promise<void> {
  return ensurePageEntry(
    SUPPORT_SOURCE_PATH,
    SUPPORT_SOURCE_SECTION,
    chatId,
    SUPPORT_SOURCE_TEMPLATE,
    cwd,
  );
}

async function cli(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await runPairing(
      {
        promptToken: () => prompt(rl, SUPPORT_PAIRING_CONFIG.promptTokenLabel),
        promptChatId: () => prompt(rl, SUPPORT_PAIRING_CONFIG.promptChatIdLabel),
        saveToken: (token) => setPassword(SUPPORT_KEYTAR_SERVICE, KEYTAR_ACCOUNT, token),
        writeAllowlist: (_section, chatId) => ensureSupportSourceEntry(chatId),
      },
      SUPPORT_PAIRING_CONFIG,
    );
  } finally {
    rl.close();
  }
}

async function prompt(rl: ReadlineInterface, question: string): Promise<string> {
  return rl.question(question);
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedAsScript) {
  cli().catch((err: unknown) => {
    console.error('Pairing failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
