// Human-gate — отправка approve/reject запроса в Telegram и ожидание ответа.
//
// Контракт:
//   * `requestApproval(opts)` — отправляет сообщение фаундеру с
//     inline-keyboard [✅ approve, ❌ reject, ✏️ edit] и возвращает Promise,
//     который резолвится когда фаундер нажал кнопку (или timeout сработал).
//   * Persistence: перед промисом — savePipelineState с
//     `waitingForApproval: nodeId`. При callback — clearWaitingApproval.
//   * Альтернатива «отдельный telegram listener» — отвергнута: используем
//     in-process EventEmitter, который слушает chat-handler/pipeline-callbacks
//     модуль. Если процесс упал и стартовал заново — recoverPipelines() повторно
//     отправит сообщение (см. recover.ts).
//
// callback_data формат: `pipe:<runId>:<nodeId>:<action>`. Парсится в
// `src/telegram/pipeline-callbacks.ts`.

import { EventEmitter } from 'node:events';
import { type PrismaClient, getPrisma } from '../db/client.js';
import { emit } from '../observe/bridge.js';
import { getAllowlist, getBotToken } from '../telegram/secrets.js';
import { clearWaitingApproval, loadPipelineState, savePipelineState } from './state.js';

/** Результат human-gate: approved/rejected/edited/timeout. */
export type ApprovalResult = 'approved' | 'rejected' | 'edited' | 'timeout';

/**
 * Глобальный EventEmitter — pipeline-callbacks модуль (telegram) эмитит
 * `'callback'` event с `{ runId, nodeId, action }` когда фаундер нажал
 * кнопку. requestApproval подписывается и резолвит promise.
 */
export const approvalBus = new EventEmitter();
// Защита от warning'а «MaxListenersExceeded» — у нас в один момент времени
// активно несколько pipeline'ов, каждый со своим human-gate.
approvalBus.setMaxListeners(50);

export interface RequestApprovalOpts {
  pipelineId: string; // department.id
  runId: string;
  nodeId: string;
  message: string;
  /** Опциональные пути файлов-артефактов, чьи имена показать в сообщении. */
  attachments?: string[];
  timeoutMs: number;
  /** DI для тестов. */
  sendMessage?: (text: string) => Promise<void>;
  /** DI для тестов: bus для подписки. По умолчанию глобальный approvalBus. */
  bus?: EventEmitter;
  /** DI для тестов: db для state. */
  db?: PrismaClient;
}

interface CallbackPayload {
  runId: string;
  nodeId: string;
  action: 'approve' | 'reject' | 'edit';
}

export async function requestApproval(opts: RequestApprovalOpts): Promise<ApprovalResult> {
  const db = opts.db ?? getPrisma();
  const bus = opts.bus ?? approvalBus;

  // 1. Persist waitingForApproval в state.
  const existing = await loadPipelineState(opts.runId, db);
  if (existing !== null) {
    await savePipelineState(
      { ...existing, waitingForApproval: opts.nodeId, currentNode: opts.nodeId },
      { db },
    );
  }
  // Если нет existing state — мы ничего не сохраняем (это не сценарий
  // recover; executor сам перед requestApproval делает savePipelineState).

  // 2. Отправляем сообщение.
  const sender = opts.sendMessage ?? buildDefaultSender(opts.runId, opts.nodeId);
  const attachmentsHint =
    opts.attachments !== undefined && opts.attachments.length > 0
      ? `\n\n*Артефакты:*\n${opts.attachments.map((a) => `• \`${a}\``).join('\n')}`
      : '';
  await sender(
    `${opts.message}${attachmentsHint}\n\n*Pipeline:* \`${opts.pipelineId}\`\n*Node:* \`${opts.nodeId}\`\n*Run:* \`${opts.runId}\``,
  );

  // 3. Ждём callback или timeout.
  return new Promise<ApprovalResult>((resolve) => {
    let settled = false;
    const finish = (result: ApprovalResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      bus.off('callback', listener);
      void clearWaitingApproval(opts.runId, { db }).catch(() => {});
      resolve(result);
    };
    const listener = (payload: CallbackPayload): void => {
      if (payload.runId !== opts.runId || payload.nodeId !== opts.nodeId) return;
      if (payload.action === 'approve') finish('approved');
      else if (payload.action === 'reject') finish('rejected');
      else if (payload.action === 'edit') finish('edited');
    };
    bus.on('callback', listener);

    const timeoutHandle = setTimeout(() => finish('timeout'), opts.timeoutMs);
  });
}

/**
 * Эмит для tests/pipeline-callbacks модуля: внешний код принял callback от
 * Telegram и хочет резолвить promise.
 */
export function emitApprovalCallback(
  payload: CallbackPayload,
  bus: EventEmitter = approvalBus,
): void {
  bus.emit('callback', payload);
}

/**
 * Парсит `callback_data` Telegram'а формата `pipe:<runId>:<nodeId>:<action>`.
 * null если не совпадает.
 */
export function parseCallbackData(raw: string): CallbackPayload | null {
  if (!raw.startsWith('pipe:')) return null;
  const parts = raw.split(':');
  if (parts.length < 4) return null;
  const action = parts[parts.length - 1];
  if (action !== 'approve' && action !== 'reject' && action !== 'edit') return null;
  const runId = parts[1];
  if (runId === undefined || runId === '') return null;
  const nodeId = parts.slice(2, -1).join(':'); // nodeId может содержать ':' (parallel:0)
  if (nodeId === '') return null;
  return { runId, nodeId, action };
}

// ---------------------------------------------------------------------------
// Default sender — реальный grammy-вызов с inline-keyboard.
// ---------------------------------------------------------------------------

function buildDefaultSender(runId: string, nodeId: string): (text: string) => Promise<void> {
  return async (text: string) => {
    const allowlist = await getAllowlist();
    const chatId = allowlist[0];
    if (chatId === undefined) {
      throw new Error('human-gate: allowlist пуст — запусти `pnpm pair`.');
    }
    const token = await getBotToken();
    const { Bot, InlineKeyboard } = await import('grammy');
    const bot = new Bot(token);
    const kb = new InlineKeyboard()
      .text('✅ Одобрить', `pipe:${runId}:${nodeId}:approve`)
      .text('❌ Отклонить', `pipe:${runId}:${nodeId}:reject`)
      .text('✏️ Edit', `pipe:${runId}:${nodeId}:edit`);
    try {
      await bot.api.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: kb,
      });
    } catch (err) {
      // best-effort: если Markdown не балансится — без parse_mode.
      try {
        await bot.api.sendMessage(chatId, text, { reply_markup: kb });
      } catch {
        // не падаем дальше — поднимем event и продолжим ждать timeout.
        void emit({
          type: 'audit.security.deny',
          recordId: '',
          chatId: String(chatId),
          command: `human-gate-send: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  };
}
