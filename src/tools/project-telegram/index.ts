// Tool: project.telegram.read (фаза 2.4)
//
// Читает сообщения из Telegram-канала проекта через grammy bot.api.getUpdates.
//
// Контракт:
//   * Входная точка — `projectTelegramRead(opts)`. Получает токен из Keychain
//     (keytar), создаёт grammy Bot, вызывает getUpdates (stateless, offset=0),
//     фильтрует по chatId и sinceMs.
//   * Allowlist — только `opts.channel.chatId`. Апдейты из других чатов
//     фильтруются молча (silent skip).
//   * DI: `opts.botApiOverride` — необязательный параметр для тестов. Если
//     передан — grammy не создаётся, используется переданный mock.
//   * `parseUpdatesToMessages` — чистая функция без сети. Тестируется напрямую.
//
// Безопасность:
//   * Токен — только из Keychain. `.env` / `process.env` не задействован.
//   * Единственный разрешённый chatId — из TgChannelConfig карты проекта.
//     Попытка читать чужой чат — через allowlist на уровне фильтра (silent drop).
//
// Ошибки:
//   * `TelegramToolError` — общая ошибка инструмента.
//   * `TelegramToolPermissionError` — апдейт из недопустимого чата (не бросается
//     сейчас при silent-drop, но доступна для вызывающего кода при необходимости).

import { getPassword } from 'keytar';
import type { TgChannelConfig } from '../../projects/map.js';

// ---------------------------------------------------------------------------
// Публичные типы.
// ---------------------------------------------------------------------------

export interface TelegramReadOptions {
  /** Конфигурация канала из карты проекта (ProjectMap.telegramChannels[N]). */
  channel: TgChannelConfig;
  /** Брать сообщения после этого момента. Timestamp в ms (эпоха Unix). */
  sinceMs: number;
  /** Максимум сообщений. Default 100. */
  limit?: number;
  /**
   * DI-override для тестов: вместо grammy bot.api.getUpdates подставляем mock.
   * В проде не передаётся — grammy создаётся из токена Keychain.
   */
  botApiOverride?: {
    getUpdates: (params: {
      offset: number;
      limit: number;
      timeout: number;
      allowed_updates: string[];
    }) => Promise<Update[]>;
  };
  /**
   * DI-override для keytar (тесты без реального Keychain).
   */
  keychainOverride?: {
    getPassword: (service: string, account: string) => Promise<string | null>;
  };
}

export interface TelegramMessage {
  messageId: number;
  chatId: string;
  text: string | null;
  fromUserId: number | null;
  fromUsername: string | null;
  /** Unix timestamp в секундах (как в Telegram API). */
  date: number;
}

// ---------------------------------------------------------------------------
// Внутренний тип Update — минимальный subset grammy Update.
// Grammy фактически совместим структурно — каст безопасен.
// ---------------------------------------------------------------------------

export interface UpdateMessage {
  message_id: number;
  date: number; // Unix-секунды
  chat: { id: number | string };
  from?: { id: number; username?: string };
  text?: string;
}

export interface Update {
  update_id: number;
  message?: UpdateMessage;
}

// ---------------------------------------------------------------------------
// Ошибки.
// ---------------------------------------------------------------------------

export class TelegramToolError extends Error {
  constructor(message: string) {
    super(`project.telegram.read: ${message}`);
    this.name = 'TelegramToolError';
  }
}

export class TelegramToolPermissionError extends TelegramToolError {
  constructor(chatId: string, allowedChatId: string) {
    super(`доступ к чату ${chatId} запрещён. Разрешён только ${allowedChatId}.`);
    this.name = 'TelegramToolPermissionError';
  }
}

// ---------------------------------------------------------------------------
// Чистая функция — фильтрация и маппинг апдейтов.
// Тестируется напрямую без сети.
// ---------------------------------------------------------------------------

export function parseUpdatesToMessages(
  updates: Update[],
  opts: { chatId: string; sinceMs: number; limit: number },
): TelegramMessage[] {
  const sinceSeconds = opts.sinceMs / 1000;
  const result: TelegramMessage[] = [];

  for (const update of updates) {
    if (result.length >= opts.limit) break;

    const message = update.message;
    if (message === undefined) continue;

    const msgChatId = String(message.chat.id);
    if (msgChatId !== opts.chatId) continue;

    if (message.date < sinceSeconds) continue;

    result.push({
      messageId: message.message_id,
      chatId: opts.chatId,
      text: message.text ?? null,
      fromUserId: message.from?.id ?? null,
      fromUsername: message.from?.username ?? null,
      date: message.date,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Основная функция.
// ---------------------------------------------------------------------------

export async function projectTelegramRead(opts: TelegramReadOptions): Promise<TelegramMessage[]> {
  const limit = opts.limit ?? 100;
  const keychain = opts.keychainOverride ?? { getPassword };

  // 1. Читаем токен из Keychain.
  const token = await keychain.getPassword(opts.channel.botKeychainService, 'token');
  if (token === null || token === '') {
    throw new TelegramToolError(
      `credentials для бота channel '${opts.channel.chatId}' не найдены в Keychain (service='${opts.channel.botKeychainService}')`,
    );
  }

  // 2. Получаем апдейты: либо через override (тесты), либо через grammy (прод).
  let botApi: TelegramReadOptions['botApiOverride'];
  if (opts.botApiOverride !== undefined) {
    botApi = opts.botApiOverride;
  } else {
    // Ленивый импорт grammy: тесты, использующие botApiOverride, не загружают grammy.
    const { Bot } = await import('grammy');
    const bot = new Bot(token);
    botApi = {
      getUpdates: ({ offset, limit, timeout }) =>
        // grammy строго типизирует allowed_updates как readonly-union — передаём
        // значение буквально, чтобы TS вывел literal-тип 'message'.
        bot.api
          .getUpdates({ offset, limit, timeout, allowed_updates: ['message'] })
          .then((updates) => updates as unknown as Update[]),
    };
  }

  // 3. Вызов getUpdates (stateless, offset=0 = все непрочитанные).
  const rawUpdates = await botApi.getUpdates({
    offset: 0,
    limit: 100,
    timeout: 0,
    allowed_updates: ['message'],
  });

  // 4. Фильтрация и маппинг.
  return parseUpdatesToMessages(rawUpdates, {
    chatId: opts.channel.chatId,
    sinceMs: opts.sinceMs,
    limit,
  });
}
