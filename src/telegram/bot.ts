// grammy long-poll бот AI-Cofounder. Точка сшивки фазы 1.2:
//   secrets.ts → токен из Keychain + allowlist из Page;
//   middleware.ts → silent drop чужих + audit.security.deny;
//   src/core/triggers.ts (`triggerManual`) + src/core/loop.ts (`runIteration`)
//     → /run дёргает единую точку входа агента (закрывает TODO 1.4 о реальном
//     подключении grammy-handler'а);
//   src/llm/money-report.ts (`getMoneyReport`) → /деньги (закрывает TODO 1.3).
//
// Запуск: `pnpm bot:dev` (foreground long-poll). Скрипт-обёртка живёт в
// scripts/bot-dev.ts и в package.json. Сам файл бот не запускает —
// `createBot()` собирает Bot и возвращает handle, чтобы тесты могли
// инстанцировать его без сетевого long-poll.

import { Bot, GrammyError, HttpError } from 'grammy';
import { ulid } from 'ulid';
import { runIteration } from '../core/loop.js';
import { triggerManual } from '../core/triggers.js';
import { getMoneyReport } from '../llm/money-report.js';
import { emit } from '../observe/bridge.js';
import {
  handleCompactCommand,
  handleHelpCommand,
  handleNewCommand,
  handleResumeCommand,
  handleSessionsCommand,
  handleStatusCommand,
} from './chat-commands.js';
import { handleChatMessage } from './chat-handler.js';
import { allowlistMiddleware } from './middleware.js';
import { handlePipelineCallback } from './pipeline-callbacks.js';
import { getAllowlist, getBotToken } from './secrets.js';

export interface BotHandle {
  bot: Bot;
  processUlid: string;
  allowlistSize: number;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export async function createBot(): Promise<BotHandle> {
  const token = await getBotToken();
  const allowlist = await getAllowlist();
  const processUlid = ulid();

  const bot = new Bot(token);

  // Allowlist-middleware ВЫШЕ команд — иначе чужой chat_id успеет прочитать
  // ответ /hello до фильтра. Фабрика middleware'а строится один раз на старте
  // бота: allowlist считан из Page при createBot(), пересоздавать нечего.
  const gate = allowlistMiddleware({ allowlist });
  bot.use(async (ctx, next) => {
    await gate(
      {
        chat: ctx.chat !== undefined ? { id: ctx.chat.id } : undefined,
        from: ctx.from !== undefined ? { id: ctx.from.id, username: ctx.from.username } : undefined,
        message: ctx.message !== undefined ? { text: ctx.message.text } : undefined,
        callbackQuery:
          ctx.callbackQuery !== undefined ? { data: ctx.callbackQuery.data } : undefined,
      },
      next,
    );
  });

  bot.command('hello', async (ctx) => {
    await ctx.reply(`бот жив @ ${processUlid}`);
  });

  bot.command('run', async (ctx) => {
    const result = await runIteration(triggerManual());
    await ctx.reply(
      `🚀 runIteration: ${result.outcome}\nkey: \`${result.idempotencyKey}\`\nrecord: \`${result.triggerRecordId}\``,
      { parse_mode: 'Markdown' },
    );
  });

  // Хендлер `/деньги` — закрытие TODO из src/llm/money-report.ts:106.
  // grammy 1.x не любит cyrillic-команды через bot.command('деньги') —
  // валидирует имя как latin slug. Используем regex-hears, который ловит
  // `/деньги` (с/без аргументов).
  bot.hears(/^\/деньги(?:@\w+)?(?:\s|$)/u, async (ctx) => {
    const report = await getMoneyReport();
    await ctx.reply(report);
  });

  // ── Команды управления conversational сессиями. ─────────────────────────
  bot.command(['new', 'clear'], async (ctx) => {
    if (ctx.chat === undefined) return;
    const reply = await handleNewCommand(ctx.chat.id);
    await ctx.reply(reply, { parse_mode: 'Markdown' });
  });
  bot.command('status', async (ctx) => {
    if (ctx.chat === undefined) return;
    const reply = await handleStatusCommand(ctx.chat.id);
    await ctx.reply(reply, { parse_mode: 'Markdown' });
  });
  bot.command('sessions', async (ctx) => {
    if (ctx.chat === undefined) return;
    const reply = await handleSessionsCommand(ctx.chat.id);
    await ctx.reply(reply, { parse_mode: 'Markdown' });
  });
  bot.command('resume', async (ctx) => {
    if (ctx.chat === undefined) return;
    const sessionId = ctx.match.trim();
    const reply = await handleResumeCommand(ctx.chat.id, sessionId);
    await ctx.reply(reply, { parse_mode: 'Markdown' });
  });
  bot.command('compact', async (ctx) => {
    if (ctx.chat === undefined) return;
    await ctx.replyWithChatAction('typing').catch(() => {});
    const reply = await handleCompactCommand(ctx.chat.id);
    await ctx.reply(reply);
  });
  bot.command('help', async (ctx) => {
    await ctx.reply(handleHelpCommand());
  });

  // Callback queries — pipeline approve gate (Фаза 5). Если callback_data
  // начинается с `pipe:` — обрабатываем сразу. Другие callback'и пока не
  // используются, но фильтр оставлен на будущее.
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data ?? '';
    const handled = await handlePipelineCallback({
      data,
      ...(ctx.chat !== undefined ? { chatId: ctx.chat.id } : {}),
      answer: async (text?: string) => {
        try {
          await ctx.answerCallbackQuery(text === undefined ? {} : { text });
        } catch {
          /* swallow */
        }
      },
    });
    if (!handled) {
      // Не наш callback — отвечаем 'ok' чтобы Telegram убрал loading-индикатор.
      try {
        await ctx.answerCallbackQuery();
      } catch {
        /* swallow */
      }
    }
  });

  // Conversational handler: любой текст без команды → проксируем в Claude Code
  // sub-agent через handleChatMessage. История сессии (или summary после /compact)
  // подмешивается в prompt. Сессия живёт 30 минут после последнего сообщения.
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // команды обрабатываются выше
    if (ctx.chat === undefined) return;
    await ctx.replyWithChatAction('typing').catch(() => {});
    const reply = await handleChatMessage(ctx.chat.id, text);
    // Markdown — чтобы **жирный**, *курсив*, `code` рендерились. Если у агента
    // невалидный markdown (несбалансированные * или _) — Telegram отклонит
    // парс. Фоллбек: повтор без parse_mode plain-текстом.
    try {
      await ctx.reply(reply.text, { parse_mode: 'Markdown' });
    } catch {
      await ctx.reply(reply.text);
    }
  });

  // Catch-all для непойманных ошибок: grammy сам логирует, но мы дополнительно
  // не падаем процессом — bot.start() должен быть устойчив к разовым 5xx от
  // Telegram API. Если ошибка повторяется — фаундер увидит в stdout.
  bot.catch((err) => {
    const update = err.ctx.update.update_id;
    if (err.error instanceof GrammyError) {
      console.error(`[telegram] GrammyError update=${update}:`, err.error.description);
    } else if (err.error instanceof HttpError) {
      console.error(`[telegram] HttpError update=${update}:`, err.error.message);
    } else {
      console.error(`[telegram] unknown error update=${update}:`, err.error);
    }
  });

  return {
    bot,
    processUlid,
    allowlistSize: allowlist.length,
    start: async () => {
      // Регистрируем команды в Telegram — даёт кнопку Menu с выпадашкой.
      // Идемпотентно: при каждом старте перезатираем актуальным списком.
      await bot.api
        .setMyCommands([
          { command: 'help', description: 'Список команд' },
          { command: 'new', description: 'Новая сессия' },
          { command: 'clear', description: 'Очистить и начать новую сессию' },
          { command: 'status', description: 'Статус текущей сессии' },
          { command: 'sessions', description: 'История сессий за 7 дней' },
          { command: 'resume', description: 'Возобновить сессию по id' },
          { command: 'compact', description: 'Сжать историю в summary' },
          { command: 'hello', description: 'Проверка живости' },
        ])
        .catch((err: unknown) => {
          console.error('[telegram] setMyCommands failed:', err);
        });

      await emit({
        type: 'bot.start',
        processUlid,
        allowlistSize: allowlist.length,
      });
      console.log(
        `[telegram] long-poll старт: processUlid=${processUlid} allowlist=${allowlist.length}`,
      );
      // bot.start() — бесконечный long-poll, await блокирует вызывающий код
      // до bot.stop(). scripts/bot-dev.ts держит процесс живым в foreground.
      await bot.start();
    },
    stop: async () => {
      await bot.stop();
    },
  };
}
