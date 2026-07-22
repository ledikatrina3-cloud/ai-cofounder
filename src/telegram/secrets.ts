// Единственная точка чтения Telegram-секретов и chat_id-листов из Page'й.
//
// Контракт фазы 1.2 (founder-bot) и фазы 2.1a (support-bot):
//   * Каждый канал имеет отдельный keytar service в macOS Keychain.
//     Ротация одного токена не задевает другие.
//   * Каждый канал держит свой chat_id-лист в отдельной Page'е (markdown'е) —
//     `config/allowlist.md` для founder-bot, `config/support-source.md`
//     для source-каналов support-bot. Формат идентичен: секции `## <name>`,
//     записи `- <chat_id>` (опционально с `# комментарием`).
//   * Никаких .env, никакого `process.env.<TOKEN>` — Biome rule
//     `nursery.noProcessEnv` для `src/telegram/**` физически отвергает любое
//     `process.env.*` (см. `biome.json` + `tests/telegram.test.ts`).
//
// Архитектурный crumb из ретро 1.4 для будущих фаз:
//   "allowlist-проверка ДО runIteration. Чужой chat_id → silent drop +
//    audit.security.deny, без event.trigger." — secrets.ts отдаёт данные,
//    решение принимает middleware.ts; и порядок «чужой → нет event.trigger»
//    держится в bot.ts (allowlist-middleware висит ВЫШЕ команд).
//
// Для фазы 2.1b: support-bot не имеет middleware/handler'ов вообще — он
// stateless-fetch'ится через `getSupportBotToken()` + `getSupportSourceChatIds()`
// (read-only, AI-Cofounder читает входящие, не отвечает; см.
// src/telegram/, секция «Support-бот»).

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getPassword } from 'keytar';

// ---------------------------------------------------------------------------
// Generic primitives — общая инфраструктура secrets/Page-чтения.
// Любой новый канал (M3 GitHub-токен, sales-bot и т.п.) переиспользует это.
// ---------------------------------------------------------------------------

export interface KeychainGetter {
  getPassword: (service: string, account: string) => Promise<string | null>;
}

// Generic «прочитай секрет из Keychain или брось понятную ошибку».
// `onMissing` — фабрика конкретной ошибки канала (TelegramTokenMissingError,
// SupportBotTokenMissingError и т.д.), чтобы вызывающий код мог их различать
// `instanceof`-ом и показывать инструкцию `pnpm pair`/`pnpm pair:support`.
export async function readKeychainSecret(
  service: string,
  account: string,
  onMissing: () => Error,
  keychain: KeychainGetter = { getPassword },
): Promise<string> {
  const value = await keychain.getPassword(service, account);
  if (value === null || value === '') throw onMissing();
  return value;
}

export interface PageReader {
  read: (path: string) => Promise<string>;
}

// Алиас для обратной совместимости с тестами фазы 1.2 — `ReadAllowlist` — был
// первым именем интерфейса. Имя `PageReader` точнее: тип не специфичен для
// allowlist'а и переиспользуется для support-source.md.
export type ReadAllowlist = PageReader;

// Парсер: секции вида `## <section>` + строки `- <chat_id>` или
// `- <chat_id> # ...`. Комментарии (`# ...`), пустые строки и текст вне списков
// игнорируются. chat_id всегда возвращается строкой (Telegram-ID может быть
// отрицательным для групп/каналов; держим единый тип).
export function parsePageChatIds(markdown: string, section: string): string[] {
  const lines = markdown.split('\n');
  const headingRe = /^##\s+(.+?)\s*$/;
  const itemRe = /^-\s+(-?\d+)\s*(?:#.*)?$/;
  const ids: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const heading = headingRe.exec(line);
    if (heading !== null) {
      inSection = heading[1] === section;
      continue;
    }
    if (!inSection) continue;
    const item = itemRe.exec(line);
    if (item !== null && item[1] !== undefined) ids.push(item[1]);
  }
  return ids;
}

// Файл может отсутствовать (никто ещё не пэйрил) — возвращаем пустой массив.
// Для founder-bot: middleware дропнет любой chat_id с audit.security.deny
// (безопасный дефолт). Для support-bot: stateless-фетч 2.1b просто пройдёт
// мимо без ошибок («нет каналов — нечего забирать»).
export async function readPageChatIds(
  pagePath: string,
  section: string,
  io: PageReader = { read: (path) => readFile(path, 'utf8') },
  cwd: string = process.cwd(),
): Promise<string[]> {
  const path = resolve(cwd, pagePath);
  let raw: string;
  try {
    raw = await io.read(path);
  } catch {
    return [];
  }
  return parsePageChatIds(raw, section);
}

// ---------------------------------------------------------------------------
// Founder-bot (фаза 1.2). Тонкие обёртки поверх generic primitives.
// ---------------------------------------------------------------------------

export const KEYTAR_SERVICE = 'ai-cofounder.tg-bot';
export const KEYTAR_ACCOUNT = 'default';

export const ALLOWLIST_PATH = 'config/allowlist.md';
export const FOUNDER_CHANNEL = 'founder-bot';

export class TelegramTokenMissingError extends Error {
  constructor() {
    super(
      `Telegram bot token не найден в Keychain. Запусти \`pnpm pair\` и введи токен — он сохранится в macOS Keychain под service '${KEYTAR_SERVICE}'.`,
    );
    this.name = 'TelegramTokenMissingError';
  }
}

// DI для тестов: подменяем keytar на vi.fn без реального Keychain-доступа.
// В проде вызывается без аргумента — keytar пишет в Keychain.app.
export async function getBotToken(keychain: KeychainGetter = { getPassword }): Promise<string> {
  return readKeychainSecret(
    KEYTAR_SERVICE,
    KEYTAR_ACCOUNT,
    () => new TelegramTokenMissingError(),
    keychain,
  );
}

// Сохранена сигнатура фазы 1.2: `parseAllowlist(md, channel)` ≡ `parsePageChatIds`.
// Тесты `tests/telegram.test.ts` и `scripts/pair.ts` импортируют это имя —
// держим алиас, чтобы не трогать вызывающих.
export function parseAllowlist(markdown: string, channel: string): string[] {
  return parsePageChatIds(markdown, channel);
}

export async function getAllowlist(
  channel: string = FOUNDER_CHANNEL,
  io: PageReader = { read: (path) => readFile(path, 'utf8') },
  cwd: string = process.cwd(),
): Promise<string[]> {
  return readPageChatIds(ALLOWLIST_PATH, channel, io, cwd);
}

// ---------------------------------------------------------------------------
// Support-bot (фаза 2.1a). Те же primitives — другой keytar service, другая
// Page и другая семантика: AI-Cofounder ЧИТАЕТ входящие из этого бота
// (stateless fetch в 2.1b), не отвечает на них. Никаких хендлеров, никакого
// long-poll, никакого middleware.
// ---------------------------------------------------------------------------

export const SUPPORT_KEYTAR_SERVICE = 'ai-cofounder.support-bot';
// account общий ('default') — у каждого канала свой service, account фиксирован.
// Если когда-то понадобятся несколько токенов в одном канале — добавим параметр.

export const SUPPORT_SOURCE_PATH = 'config/support-source.md';
export const SUPPORT_SOURCE_SECTION = 'support-source';

export class SupportBotTokenMissingError extends Error {
  constructor() {
    super(
      `Support bot token не найден в Keychain. Запусти \`pnpm pair:support\` и введи токен — он сохранится в macOS Keychain под service '${SUPPORT_KEYTAR_SERVICE}'.`,
    );
    this.name = 'SupportBotTokenMissingError';
  }
}

export async function getSupportBotToken(
  keychain: KeychainGetter = { getPassword },
): Promise<string> {
  return readKeychainSecret(
    SUPPORT_KEYTAR_SERVICE,
    KEYTAR_ACCOUNT,
    () => new SupportBotTokenMissingError(),
    keychain,
  );
}

// Source chat_id-ы канала(ов), откуда AI-Cofounder в фазе 2.1b будет забирать
// входящие сообщения клиентов support-бота. На сегодня — обычно один (личный
// чат поддержки или группа); список — задел на масштабирование (несколько
// support-каналов одного проекта или несколько проектов).
//
// Файл может отсутствовать (фаундер ещё не запускал `pnpm pair:support`) —
// возвращаем []. 2.1b в таком случае логирует «нет source-каналов, нечего
// забирать» и завершает stateless fetch без падения.
export async function getSupportSourceChatIds(
  io: PageReader = { read: (path) => readFile(path, 'utf8') },
  cwd: string = process.cwd(),
): Promise<string[]> {
  return readPageChatIds(SUPPORT_SOURCE_PATH, SUPPORT_SOURCE_SECTION, io, cwd);
}
