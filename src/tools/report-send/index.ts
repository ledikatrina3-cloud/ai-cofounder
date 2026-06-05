// Tool: report.send — отправка отчёта в Telegram founder-чат.
//
// Тонкая обёртка над существующим `src/report/sender.ts`. НЕ дублирует логику:
// retry-backoff, FounderChatMissingError, plain-text fallback — всё в sender.ts.
//
// Ограничение: только founder chatId (из allowlist). Не позволяет отправлять
// в произвольные чаты — routine не может передать свой chatId.
//
// DI: `deps` пробрасываются в `sendReport` — тесты подменяют botApi без сети.

import type { PrismaClient } from '../../db/client.js';
import type { TelegramMessage } from '../../report/morning.js';
import type { TelegramBotApi } from '../../report/sender.js';
import { sendReport } from '../../report/sender.js';

// ---------------------------------------------------------------------------
// Публичные типы.
// ---------------------------------------------------------------------------

export interface ReportMessage {
  /** Markdown-текст сообщения. */
  text: string;
  /** parse_mode для Telegram. Default: Markdown (как в sender.ts). */
  parseMode?: 'Markdown' | 'HTML';
}

// DI-точка для тестов: подменяем botApi и resolveFounderChatId.
export interface ReportSendDeps {
  botApi?: TelegramBotApi;
  resolveFounderChatId?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Ошибки.
// ---------------------------------------------------------------------------

export class ReportSendError extends Error {
  constructor(message: string) {
    super(`report.send: ${message}`);
    this.name = 'ReportSendError';
  }
}

// ---------------------------------------------------------------------------
// Главная функция.
// ---------------------------------------------------------------------------

/**
 * Отправляет массив сообщений в founder Telegram-чат.
 *
 * - Сообщения отправляются последовательно.
 * - Первое сообщение — без reply; последующие — в тред (reply_to header).
 * - Ошибка sendReport пробрасывается как ReportSendError.
 * - db не используется напрямую (sender.ts не пишет в БД при отправке),
 *   параметр оставлен для будущего audit-логирования.
 */
export async function reportSend(
  messages: ReportMessage[],
  deps: ReportSendDeps = {},
  _db?: PrismaClient,
): Promise<void> {
  if (messages.length === 0) return;

  // Конвертируем ReportMessage[] → TelegramMessage[] (контракт morning.ts).
  // parseMode с дефолтом 'Markdown' как у остального кода.
  const telegramMessages: TelegramMessage[] = messages.map((m) => ({
    text: m.text,
    parseMode: m.parseMode ?? 'Markdown',
    kind: 'header' as const,
  }));

  try {
    await sendReport(telegramMessages, {
      botApi: deps.botApi,
      resolveFounderChatId: deps.resolveFounderChatId,
      sleep: deps.sleep,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ReportSendError(msg);
  }
}
