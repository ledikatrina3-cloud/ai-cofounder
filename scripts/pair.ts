// CLI `pnpm pair` — интерактивный pairing Telegram founder-бота AI-Cofounder.
// Спрашивает bot token и chat_id фаундера. Токен → Keychain через keytar
// (service='ai-cofounder.tg-bot', account='default'). chat_id → Page
// `config/allowlist.md`, секция `## founder-bot` (формат — см. allowlist.md).
//
// Запуск: `pnpm pair` (фаундер вводит руками; агент НЕ запускает).
// Тесты: `runPairing(opts, config?)` принимает promptToken/promptChatId/saveToken/
// writeAllowlist через DI — vitest подменяет I/O без реального Keychain'а.
//
// Re-runs идемпотентны: повторный chat_id в той же секции не дублируется
// (см. upsertChatId). Пересохранение токена в Keychain — штатный setPassword
// перезатирает прошлое значение.
//
// Фаза 2.1a (support-bot) переиспользует runPairing/upsertChatId/ensurePageEntry
// с другим PairingConfig и другим Keychain service. Скрипт-точка для support —
// `scripts/pair-support.ts` (`pnpm pair:support`).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { type Interface as ReadlineInterface, createInterface } from 'node:readline/promises';
import { setPassword } from 'keytar';
import {
  ALLOWLIST_PATH,
  FOUNDER_CHANNEL,
  KEYTAR_ACCOUNT,
  KEYTAR_SERVICE,
  parseAllowlist,
} from '../src/telegram/secrets.js';

export interface PairingDeps {
  promptToken: () => Promise<string>;
  promptChatId: () => Promise<string>;
  saveToken: (token: string) => Promise<void>;
  // channel передаётся внутрь, потому что некоторые DI-реализации
  // (напр., тестовые spy) различают, в какую секцию записали chat_id.
  writeAllowlist: (channel: string, chatId: string) => Promise<void>;
  log?: (message: string) => void;
}

// Конфиг конкретного канала: лейблы для интерактивного CLI (что спрашивать
// у пользователя, куда сохраняем, что показать в финале) + параметры записи
// (имя секции, к которой будет сделан writeAllowlist). Generic-параметризация
// runPairing — поэтому 2.1a (support-bot) переиспользует тот же flow без
// копипасты.
export interface PairingConfig {
  channel: string;
  // «service / account» в Keychain — одна строка для лога, чтобы человек видел,
  // куда лёг токен (Keychain.app можно открыть и проверить).
  keytarTarget: string;
  pagePath: string;
  banner: string;
  promptTokenLabel: string;
  promptChatIdLabel: string;
  successHint: string;
}

const TOKEN_RE = /^\d{8,12}:[A-Za-z0-9_-]{30,}$/;
const CHAT_ID_RE = /^-?\d+$/;

export const FOUNDER_PAIRING_CONFIG: PairingConfig = {
  channel: FOUNDER_CHANNEL,
  keytarTarget: `${KEYTAR_SERVICE} / ${KEYTAR_ACCOUNT}`,
  pagePath: ALLOWLIST_PATH,
  banner: 'Telegram pairing AI-Cofounder (founder-bot)',
  promptTokenLabel: 'Bot token (формат "12345:AAA..."): ',
  promptChatIdLabel: 'Founder chat_id (число от @userinfobot): ',
  successHint: 'Готово. Запусти `pnpm bot:dev` и пиши боту /hello.',
};

export async function runPairing(
  deps: PairingDeps,
  config: PairingConfig = FOUNDER_PAIRING_CONFIG,
): Promise<void> {
  const log = deps.log ?? ((msg: string) => console.log(msg));

  log(config.banner);
  log(`Service в Keychain: ${config.keytarTarget}`);
  log(`Page-файл: ${config.pagePath} (секция: ${config.channel})`);
  log('');

  const token = (await deps.promptToken()).trim();
  if (!TOKEN_RE.test(token)) {
    throw new Error(
      'Невалидный bot token. Ожидался формат "<8–12 digits>:<35+ base64url chars>". ' +
        'Получи токен у @BotFather в Telegram.',
    );
  }

  const chatId = (await deps.promptChatId()).trim();
  if (!CHAT_ID_RE.test(chatId)) {
    throw new Error(
      'Невалидный chat_id. Ожидалось целое число (положительное — личка, отрицательное — группа/канал). ' +
        'Узнать свой chat_id можно через @userinfobot.',
    );
  }

  await deps.saveToken(token);
  log('✓ Токен сохранён в Keychain');

  await deps.writeAllowlist(config.channel, chatId);
  log(`✓ chat_id ${chatId} → ${config.pagePath} (секция ${config.channel})`);
  log('');
  log(config.successHint);
}

// Точка идемпотентного апдейта Page: добавляет chat_id в секцию `## <section>`,
// если его там ещё нет; не трогает остальной markdown. Pure — для unit-тестов.
export function upsertChatId(markdown: string, section: string, chatId: string): string {
  const existing = parseAllowlist(markdown, section);
  if (existing.includes(chatId)) return markdown;

  const lines = markdown.split('\n');
  const headerRe = new RegExp(`^##\\s+${escapeRegex(section)}\\s*$`);
  const headerIdx = lines.findIndex((line) => headerRe.test(line));

  // Секция отсутствует → дописываем в конец файла.
  if (headerIdx === -1) {
    const trimmed = markdown.replace(/\s*$/, '');
    return `${trimmed}\n\n## ${section}\n\n- ${chatId}\n`;
  }

  // Найти границу секции: следующий `##` или конец файла.
  let nextSectionIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && /^##\s+/.test(line)) {
      nextSectionIdx = i;
      break;
    }
  }

  // Найти последнюю строку списка `- <number>` в этой секции.
  let lastItemIdx = -1;
  const itemRe = /^-\s+-?\d+/;
  for (let i = headerIdx + 1; i < nextSectionIdx; i++) {
    const line = lines[i];
    if (line !== undefined && itemRe.test(line)) lastItemIdx = i;
  }

  const newEntry = `- ${chatId}`;
  if (lastItemIdx >= 0) {
    lines.splice(lastItemIdx + 1, 0, newEntry);
  } else {
    // Пустая секция: вставляем `<blank>\n- chatId` сразу после заголовка
    // (или после уже идущей пустой строки, если она есть).
    let insertAt = headerIdx + 1;
    if (insertAt < nextSectionIdx && lines[insertAt]?.trim() === '') {
      insertAt += 1;
    } else {
      lines.splice(insertAt, 0, '');
      insertAt += 1;
    }
    lines.splice(insertAt, 0, newEntry);
  }

  return lines.join('\n');
}

// Generic запись entry в Page: если файла нет — создаём из шаблона; иначе
// читаем + upsertChatId + перезапись. Шаблон передаётся вызывающим, потому что
// у каждого канала свой стартовый markdown (комментарии, ссылки, перечень
// поддерживаемых секций).
export async function ensurePageEntry(
  pagePath: string,
  section: string,
  chatId: string,
  template: string,
  cwd: string = process.cwd(),
): Promise<void> {
  const path = resolve(cwd, pagePath);
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    content = template;
  }
  const updated = upsertChatId(content, section, chatId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, updated, 'utf8');
}

const ALLOWLIST_TEMPLATE = `# Telegram allowlist

Список разрешённых chat_id для каждого Telegram-канала AI-Cofounder.
Источник правды для allowlist-middleware.

## founder-bot

## support-bot
`;

// Founder-обёртка над ensurePageEntry — сохраняет API фазы 1.2 для тестов и
// CLI. Тесты `tests/telegram.test.ts` и CLI ниже импортируют именно это имя.
export async function ensureAllowlistEntry(
  channel: string,
  chatId: string,
  cwd: string = process.cwd(),
): Promise<void> {
  return ensurePageEntry(ALLOWLIST_PATH, channel, chatId, ALLOWLIST_TEMPLATE, cwd);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// CLI-обёртка: создаётся stdin/stdout readline, прокидывает в runPairing
// реальные keytar.setPassword + ensureAllowlistEntry.
async function cli(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await runPairing({
      promptToken: () => prompt(rl, FOUNDER_PAIRING_CONFIG.promptTokenLabel),
      promptChatId: () => prompt(rl, FOUNDER_PAIRING_CONFIG.promptChatIdLabel),
      saveToken: (token) => setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, token),
      writeAllowlist: (channel, chatId) => ensureAllowlistEntry(channel, chatId),
    });
  } finally {
    rl.close();
  }
}

async function prompt(rl: ReadlineInterface, question: string): Promise<string> {
  return rl.question(question);
}

// Точка входа CLI: запускаем cli() только если файл вызван напрямую через tsx.
const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedAsScript) {
  cli().catch((err: unknown) => {
    console.error('Pairing failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
