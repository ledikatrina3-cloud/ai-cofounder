// Alerting когда health-check скилла упал (Фаза 7 плана 2026-05-21-skills-architecture-v3).
//
// Идея: при `status: 'failed'` — пытаемся отправить личное сообщение в
// Telegram через founder-bot. Если бот ещё не настроен (`pnpm pair` не
// запускался) или допустим Keychain пустой — НЕ падаем, просто логируем
// в console.warn. Bridge event `skill.health.failed` всё равно ушёл из
// runHealthCheck(), так что фаундер увидит проблему в UI.
//
// Никаких зависимостей от grammy уровня bot.ts (с middleware/longpoll) —
// нам нужна одна функция `bot.api.sendMessage`. Делаем минимальный
// Bot-инстанс прямо здесь.

import { Bot } from 'grammy';
import { getAllowlist, getBotToken } from '../telegram/secrets.js';
import type { HealthCheckResult } from './health.js';

export interface AlertDeps {
  /** Загрузчик токена. По умолчанию — Keychain через getBotToken. */
  loadToken?: () => Promise<string>;
  /** Загрузчик allowlist'а. По умолчанию — config/allowlist.md. */
  loadAllowlist?: () => Promise<string[]>;
  /** Фабрика sendMessage (для тестов). По умолчанию — grammy. */
  sendMessage?: (chatId: string, text: string) => Promise<void>;
  /** Куда писать «бот не настроен» лог. */
  log?: (level: 'warn' | 'info', msg: string) => void;
}

export async function alertFounderOnFailure(
  result: HealthCheckResult,
  deps: AlertDeps = {},
): Promise<void> {
  if (result.status !== 'failed') return;

  const log = deps.log ?? ((lvl, msg) => console[lvl](`[health-alert] ${msg}`));

  const loadAllowlist = deps.loadAllowlist ?? (async () => getAllowlist());
  let chatIds: string[];
  try {
    chatIds = await loadAllowlist();
  } catch (err) {
    log('warn', `failed to load allowlist: ${(err as Error).message}`);
    return;
  }
  if (chatIds.length === 0) {
    log('info', 'no allowlist chats — skipping telegram alert');
    return;
  }

  let sendMessage = deps.sendMessage;
  if (sendMessage === undefined) {
    const loadToken = deps.loadToken ?? (async () => getBotToken());
    let token: string;
    try {
      token = await loadToken();
    } catch {
      // Бот не настроен — `pnpm pair` ещё не запускался. Это валидный кейс
      // (фаундер ещё не пэйрил), просто пишем в лог и выходим.
      log('info', 'telegram bot not configured (run `pnpm pair`); skipping alert');
      return;
    }
    const bot = new Bot(token);
    sendMessage = async (chatId, text) => {
      await bot.api.sendMessage(chatId, text);
    };
  }

  const text = formatAlert(result);
  // Шлём всем chat_id из allowlist'а (обычно один — фаундер).
  for (const chatId of chatIds) {
    try {
      await sendMessage(chatId, text);
    } catch (err) {
      log('warn', `sendMessage failed for chatId=${chatId}: ${(err as Error).message}`);
    }
  }
}

export function formatAlert(result: HealthCheckResult): string {
  const err = result.error ?? 'unknown error';
  return `❌ Skill '${result.skillName}' health-check failed: ${err}`;
}
