// Allowlist-middleware для grammy. Вешается на `bot.use(...)` ПЕРЕД любым
// command-handler'ом — иначе чужой chat_id увидит ответ /hello, что нарушает
// контракт «silent drop + audit.security.deny» из плана фазы 1.2.
//
// Дизайн:
//   * Pure-функция-фабрика, принимает зависимости через DI: allowlist (массив
//     chat_id-строк), recordDeny (writer audit.security.deny), emitEvent
//     (Bridge-эмиттер). Реальные реализации подставляются в bot.ts; в тестах —
//     vi.fn'ы. Это убирает необходимость поднимать grammy для unit-тестов
//     (план 1.2: «mock grammy через unit-тесты на middleware (не настоящий
//     long-poll)»).
//   * Тип `MinimalContext` — подмножество grammy.Context, нужное middleware'у.
//     Вместо импорта тяжёлого Context — берём только chat.id, from.id,
//     from.username и опциональный message.text. Тесты создают plain object'ы,
//     не Context-инстансы.

import type { BridgeEventInput } from '../observe/bridge.js';
import { emit as defaultEmit } from '../observe/bridge.js';
import { type SecurityDenyInput, recordSecurityDeny as defaultRecordDeny } from './audit.js';

export interface MinimalContext {
  chat?: { id: number };
  from?: { id: number; username?: string };
  message?: { text?: string };
  callbackQuery?: { data?: string };
}

export type Next = () => Promise<void>;

export type MiddlewareFn = (ctx: MinimalContext, next: Next) => Promise<void>;

export interface AllowlistMiddlewareOptions {
  allowlist: string[];
  recordDeny?: (input: SecurityDenyInput) => Promise<string>;
  emitEvent?: (event: BridgeEventInput) => Promise<void>;
}

export function allowlistMiddleware(opts: AllowlistMiddlewareOptions): MiddlewareFn {
  const { allowlist, recordDeny = defaultRecordDeny, emitEvent = defaultEmit } = opts;
  const allowSet = new Set(allowlist);
  return async (ctx, next) => {
    const chatId = ctx.chat?.id;
    const chatIdStr = chatId !== undefined ? String(chatId) : null;
    const command = extractCommand(ctx);

    if (chatIdStr !== null && allowSet.has(chatIdStr)) {
      await emitEvent({
        type: 'audit.security.allow',
        chatId: chatIdStr,
        command,
      });
      await next();
      return;
    }

    // Silent drop: не зовём next, не отвечаем в чат. Только аудит + Bridge.
    const denyId = await recordDeny({
      chatId: chatIdStr,
      userId: ctx.from?.id !== undefined ? String(ctx.from.id) : null,
      username: ctx.from?.username ?? null,
      command,
    });
    await emitEvent({
      type: 'audit.security.deny',
      recordId: denyId,
      chatId: chatIdStr,
      command,
    });
  };
}

// Извлекаем команду из update'а: сначала текст сообщения, потом callback-data,
// потом '<unknown>'. Для audit-properties достаточно префикса 64 символа —
// длинные тексты обрезаем, чтобы JSON в Record.properties не разбухал.
export function extractCommand(ctx: MinimalContext): string {
  const text = ctx.message?.text ?? ctx.callbackQuery?.data ?? '<unknown>';
  return text.length > 64 ? `${text.slice(0, 64)}…` : text;
}
