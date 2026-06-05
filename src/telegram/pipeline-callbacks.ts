// Telegram callback handler для pipeline approve gate (Фаза 5).
//
// Callback_data формат: `pipe:<runId>:<nodeId>:<action>`. Парсится через
// parseCallbackData. Если совпало — эмитим event в approvalBus, который
// requestApproval подписался в human-gate.ts.
//
// Регистрируется в src/telegram/bot.ts при сборке Bot'а: bot.on('callback_query')
// → handlePipelineCallback. Если callback_data не наш — возвращаем false и
// другие обработчики продолжают.

import { emit } from '../observe/bridge.js';
import { emitApprovalCallback, parseCallbackData } from '../pipelines/human-gate.js';

export interface PipelineCallbackCtx {
  data: string;
  chatId?: number;
  answer: (text?: string) => Promise<void>;
}

/**
 * Обрабатывает callback_query. Возвращает true если callback наш и был
 * обработан (бот должен ответить answerCallbackQuery), false иначе.
 */
export async function handlePipelineCallback(ctx: PipelineCallbackCtx): Promise<boolean> {
  const payload = parseCallbackData(ctx.data);
  if (payload === null) return false;

  emitApprovalCallback(payload);

  // edit пока stub.
  const userMsg =
    payload.action === 'approve'
      ? '✅ Одобрено'
      : payload.action === 'reject'
        ? '❌ Отклонено'
        : '✏️ Edit будет в Фазе 7 — пока засчитал как reject';

  await ctx.answer(userMsg);

  await emit({
    type: 'audit.security.allow',
    chatId: ctx.chatId !== undefined ? String(ctx.chatId) : null,
    command: `pipe-callback:${payload.action}:${payload.nodeId}`,
  });

  return true;
}
