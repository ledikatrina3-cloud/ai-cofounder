// Отправка утреннего отчёта в Telegram (фаза 2.5).
//
// Контракт:
//   * Принимает массив TelegramMessage из buildReport(): первый — шапка,
//     остальные — items. Для пустого/error-отчёта массив из 1 message с
//     kind='header'.
//   * Шапка отправляется первой, без `reply_to_message_id`. Возвращённый
//     `message_id` используется как parent для последующих item'ов: каждое
//     item-сообщение шлётся с `reply_to_message_id = headerMsgId` — Telegram
//     отрисует один вложенный тред (план: «N+1 сообщений в одном треде»).
//   * Founder-чат — первый chat_id из allowlist (config/allowlist.md секция
//     `## founder-bot`). На пустой allowlist падаем с понятной ошибкой
//     (фаундер не запускал `pnpm pair`).
//   * Сетевая ошибка Telegram → retry до `sendRetries` раз с экспоненциальным
//     бэкоффом + jitter. После исчерпания — throw (caller в runIteration
//     ловит и пишет audit.report.send.failed; ошибка НЕ валит цикл).
//   * Markdown-сообщение с «нерендерящимся» куском (например, незакрытый
//     backtick) → grammy кидает GrammyError 'can't parse entities'. Fallback:
//     повтор того же сообщения без parse_mode (plain text). Это план: «HTML-
//     fallback»; фактически проще plain — фаундер не теряет содержание.
//
// DI: `botApi` подменяется тестами на mock без сети. Прод-default — построение
// grammy `Bot.api` поверх founder-bot токена из Keychain (тот же Bot, что в
// `src/telegram/bot.ts`, но у нас нет хендлеров — мы только api.sendMessage).

import { ulid } from 'ulid';
import { getAllowlist, getBotToken } from '../telegram/secrets.js';
import { type ReportConfig, loadReportConfig } from './config.js';
import type { ItemRef, TelegramMessage } from './morning.js';

// ---------------------------------------------------------------------------
// Контракт API клиента — минимум, что нам нужен от grammy для тестов.
// Структурно совместим с `Bot.api` (sendMessage возвращает Message с message_id).
// ---------------------------------------------------------------------------

export interface SendMessageOptions {
  parse_mode?: 'Markdown' | 'HTML';
  reply_to_message_id?: number;
  disable_web_page_preview?: boolean;
}

export interface SendMessageResult {
  message_id: number;
}

export interface TelegramBotApi {
  sendMessage: (
    chatId: string | number,
    text: string,
    opts?: SendMessageOptions,
  ) => Promise<SendMessageResult>;
}

export interface SendReportResult {
  // Отправленные message_id в порядке messages[i]. Может быть короче чем
  // messages.length, если retry исчерпал лимит на полпути (но в этом случае
  // мы throw'аем — массив возвращается только при полном успехе).
  sentMessageIds: number[];
  // Сами TelegramMessage'ы, которые соответствуют sentMessageIds (для
  // runIteration: чтобы записать audit.report.sent.properties.mentioned*Ids
  // в правильном порядке).
  messages: TelegramMessage[];
  // Founder chat_id (первый из allowlist). Не секрет, можно класть в audit.
  founderChatId: string;
}

// ---------------------------------------------------------------------------
// Ошибки.
// ---------------------------------------------------------------------------

export class FounderChatMissingError extends Error {
  constructor() {
    super(
      `Founder chat не настроен: \`${'config/allowlist.md'}\` секция \`## founder-bot\` пуста или файл не существует. Запусти \`pnpm pair\`.`,
    );
    this.name = 'FounderChatMissingError';
  }
}

export class TelegramSendFailedError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastErrorClass: string,
  ) {
    super(message);
    this.name = 'TelegramSendFailedError';
  }
}

// ---------------------------------------------------------------------------
// DI.
// ---------------------------------------------------------------------------

export interface SendReportDeps {
  botApi?: TelegramBotApi;
  configOverride?: ReportConfig;
  // Для тестов: подменить «откуда брать allowlist + token».
  resolveFounderChatId?: () => Promise<string>;
  buildBotApi?: (token: string) => TelegramBotApi;
  // Часы и random для бэкоффа — детерминизм тестов.
  now?: () => number;
  random?: () => number;
  // Для тестов и удобства: кастомный sleep, чтобы не ждать реальные ms.
  sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Главная функция.
// ---------------------------------------------------------------------------

export async function sendReport(
  messages: TelegramMessage[],
  deps: SendReportDeps = {},
): Promise<SendReportResult> {
  if (messages.length === 0) {
    throw new Error(
      'sendReport: пустой массив messages — buildReport должен вернуть хотя бы один.',
    );
  }

  const config = deps.configOverride ?? (await loadReportConfig());
  const founderChatId = (await (deps.resolveFounderChatId ?? defaultResolveFounderChatId)()) ?? '';
  if (founderChatId.length === 0) throw new FounderChatMissingError();

  const botApi = deps.botApi ?? (await defaultBuildBotApi(deps));
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? defaultSleep;

  const sentMessageIds: number[] = [];
  // header — первое в массиве (план + buildReport контракт).
  const head = messages[0];
  if (head === undefined) throw new Error('sendReport: messages[0] undefined');
  const headResult = await sendOneWithRetry({
    botApi,
    chatId: founderChatId,
    text: head.text,
    parseMode: head.parseMode,
    config,
    random,
    sleep,
  });
  sentMessageIds.push(headResult.message_id);

  for (let i = 1; i < messages.length; i++) {
    const m = messages[i];
    if (m === undefined) continue;
    const result = await sendOneWithRetry({
      botApi,
      chatId: founderChatId,
      text: m.text,
      parseMode: m.parseMode,
      replyToMessageId: headResult.message_id,
      config,
      random,
      sleep,
    });
    sentMessageIds.push(result.message_id);
  }

  return { sentMessageIds, messages, founderChatId };
}

// ---------------------------------------------------------------------------
// Helpers — отправка одного сообщения с retry/backoff.
// ---------------------------------------------------------------------------

interface SendOneArgs {
  botApi: TelegramBotApi;
  chatId: string;
  text: string;
  parseMode: 'Markdown' | 'HTML';
  replyToMessageId?: number;
  config: ReportConfig;
  random: () => number;
  sleep: (ms: number) => Promise<void>;
}

async function sendOneWithRetry(args: SendOneArgs): Promise<SendMessageResult> {
  const totalAttempts = args.config.sendRetries + 1;
  let lastError: unknown = null;
  let lastErrorClass = 'unknown';

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    try {
      const opts: SendMessageOptions = {
        parse_mode: args.parseMode,
        disable_web_page_preview: true,
      };
      if (args.replyToMessageId !== undefined) {
        opts.reply_to_message_id = args.replyToMessageId;
      }
      return await args.botApi.sendMessage(args.chatId, args.text, opts);
    } catch (err) {
      lastError = err;
      lastErrorClass = err instanceof Error ? err.constructor.name : 'UnknownError';
      // Markdown-валидатор Telegram ругается. Один раз пробуем plain без parse_mode:
      // сообщение читаемо, но без жирного/кода. Лучше так, чем ничего.
      if (isMarkdownParseError(err) && attempt === 0) {
        try {
          const opts: SendMessageOptions = { disable_web_page_preview: true };
          if (args.replyToMessageId !== undefined) {
            opts.reply_to_message_id = args.replyToMessageId;
          }
          return await args.botApi.sendMessage(args.chatId, args.text, opts);
        } catch (err2) {
          lastError = err2;
          lastErrorClass = err2 instanceof Error ? err2.constructor.name : 'UnknownError';
          // Падаем дальше в retry-loop.
        }
      }
      // Последняя попытка — выбрасываем без sleep.
      if (attempt === totalAttempts - 1) break;
      const jitter = Math.floor(args.random() * args.config.sendRetryJitterMs);
      // Экспоненциальный бэкофф: base × 2^attempt + jitter.
      const delayMs = args.config.sendRetryBaseMs * 2 ** attempt + jitter;
      await args.sleep(delayMs);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new TelegramSendFailedError(
    `sendReport: ${totalAttempts} попыток исчерпаны. Последняя: ${lastErrorClass}: ${message}`,
    totalAttempts,
    lastErrorClass,
  );
}

function isMarkdownParseError(err: unknown): boolean {
  // grammy GrammyError имеет .description; Telegram возвращает "Bad Request:
  // can't parse entities ..." при невалидной markdown-разметке.
  if (err instanceof Error && err.message.toLowerCase().includes("can't parse entities")) {
    return true;
  }
  // Defensive: некоторые версии grammy кидают объект с description.
  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>;
    const desc = typeof obj.description === 'string' ? obj.description : '';
    if (desc.toLowerCase().includes("can't parse entities")) return true;
  }
  return false;
}

async function defaultSleep(ms: number): Promise<void> {
  return new Promise((res) => {
    setTimeout(res, ms);
  });
}

// ---------------------------------------------------------------------------
// DI-defaults: real grammy Bot.api + read founder chat from allowlist.
// ---------------------------------------------------------------------------

async function defaultResolveFounderChatId(): Promise<string> {
  const allowlist = await getAllowlist();
  const first = allowlist[0];
  if (first === undefined) throw new FounderChatMissingError();
  return first;
}

async function defaultBuildBotApi(deps: SendReportDeps): Promise<TelegramBotApi> {
  if (deps.buildBotApi !== undefined) {
    const token = await getBotToken();
    return deps.buildBotApi(token);
  }
  const token = await getBotToken();
  // Ленивый импорт grammy: чтобы тесты, которые подменяют botApi через DI,
  // не загружали grammy в process.
  const { Bot } = await import('grammy');
  const bot = new Bot(token);
  return {
    sendMessage: async (chatId, text, opts) => bot.api.sendMessage(chatId, text, opts ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Утилита для runIteration: «дай мне списки mentionedProblemIds /
// mentionedDiagnosisIds / mentionedProposalIds в правильном порядке».
// Использует ItemRef из buildReport. Чисто чтоб caller не дублировал логику.
// ---------------------------------------------------------------------------

export interface MentionedIds {
  problemIds: string[];
  diagnosisIds: string[];
  proposalIds: string[];
}

export function collectMentionedIds(messages: TelegramMessage[]): MentionedIds {
  const problemIds: string[] = [];
  const diagnosisIds: string[] = [];
  const proposalIds: string[] = [];
  for (const m of messages) {
    const ref: ItemRef | undefined = m.itemRef;
    if (ref === undefined) continue;
    if (ref.problemId !== undefined) problemIds.push(ref.problemId);
    if (ref.diagnosisId !== undefined) diagnosisIds.push(ref.diagnosisId);
    if (ref.proposalId !== undefined) proposalIds.push(ref.proposalId);
  }
  return { problemIds, diagnosisIds, proposalIds };
}

// Удобно тестам: ULID-генератор фиксируется только для тестов; в коде sender'а
// он не используется — оставлен на случай, если в будущем понадобится unique-id
// для retry-tracing.
export const _internal = { ulid };
