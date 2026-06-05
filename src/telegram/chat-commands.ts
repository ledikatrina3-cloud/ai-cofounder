// Обработчики команд управления conversational сессиями: /new, /clear, /status,
// /sessions, /resume, /compact, /help. Каждая возвращает текст для отправки в чат.

import { compactSession } from '../chat/compact.js';
import {
  endSession,
  getCurrentSessionId,
  getSessionStats,
  listRecentSessions,
  resumeSession,
  sessionBelongsToChat,
  startNewSession,
} from '../chat/sessions.js';
import type { PrismaClient } from '../db/client.js';

const HELP_TEXT = [
  'Команды управления сессиями:',
  '',
  '/new — закрыть текущую и начать новую сессию (синоним: /clear)',
  '/status — текущая сессия: число сообщений, $, время',
  '/sessions — список последних 10 сессий',
  '/resume <id> — вернуться к предыдущей сессии (id из /sessions)',
  '/compact — сжать историю текущей сессии в summary',
  '',
  'Прочие:',
  '/hello — проверка живости',
  '/деньги — отчёт по тратам',
  '/help — это сообщение',
  '',
  'Любой текст без / — отправляется агенту в дефолтный проект. ' +
    'Сессия живёт 30 минут после последнего сообщения.',
].join('\n');

export async function handleNewCommand(chatId: number, db?: PrismaClient): Promise<string> {
  const current = await getCurrentSessionId(chatId, db);
  if (current !== null) {
    await endSession(chatId, current, 'manual', db);
  }
  const newId = await startNewSession(chatId, db);
  return `🆕 Новая сессия: \`${newId}\``;
}

export async function handleStatusCommand(chatId: number, db?: PrismaClient): Promise<string> {
  const current = await getCurrentSessionId(chatId, db);
  if (current === null) {
    return 'Активной сессии нет. Напиши любой текст — начнётся новая.';
  }
  const stats = await getSessionStats(current, db);
  const sinceLast =
    stats.lastAt !== null ? Math.round((Date.now() - stats.lastAt.getTime()) / 1000) : null;
  const lines = [
    `🟢 Активная сессия: \`${current}\``,
    `Сообщений: ${stats.messageCount}`,
    `Потрачено: $${stats.totalUsd.toFixed(4)}`,
  ];
  if (sinceLast !== null) {
    lines.push(`Последнее сообщение: ${formatDuration(sinceLast)} назад`);
  }
  return lines.join('\n');
}

export async function handleSessionsCommand(chatId: number, db?: PrismaClient): Promise<string> {
  const sessions = await listRecentSessions(chatId, 10, db);
  if (sessions.length === 0) {
    return 'История пуста — за последние 7 дней сессий не было.';
  }
  const lines = ['Последние сессии (за 7 дней):', ''];
  for (const s of sessions) {
    const minsAgo = Math.round((Date.now() - s.lastAt.getTime()) / 60_000);
    const preview = s.firstMessage.length > 0 ? s.firstMessage : '(пусто)';
    lines.push(
      `\`${s.sessionId}\` · ${s.messageCount} msg · $${s.totalUsd.toFixed(3)} · ${minsAgo}мин назад`,
    );
    lines.push(`  ↳ ${preview}`);
  }
  lines.push('');
  lines.push('Возобновить: /resume <id>');
  return lines.join('\n');
}

export async function handleResumeCommand(
  chatId: number,
  sessionId: string,
  db?: PrismaClient,
): Promise<string> {
  if (sessionId.length === 0) {
    return 'Использование: /resume <sessionId> (id скопируй из /sessions)';
  }
  const belongs = await sessionBelongsToChat(chatId, sessionId, db);
  if (!belongs) {
    return `Сессия \`${sessionId}\` не найдена в твоей истории.`;
  }
  const current = await getCurrentSessionId(chatId, db);
  if (current === sessionId) {
    return 'Эта сессия уже активна.';
  }
  if (current !== null) {
    await endSession(chatId, current, 'replaced', db);
  }
  await resumeSession(chatId, sessionId, db);
  return `↩️ Возобновлена сессия \`${sessionId}\`. Следующее сообщение продолжит её историю.`;
}

export async function handleCompactCommand(chatId: number, db?: PrismaClient): Promise<string> {
  const current = await getCurrentSessionId(chatId, db);
  if (current === null) {
    return 'Нет активной сессии для компакции.';
  }
  const result = await compactSession(chatId, current, db);
  if (result.replacedCount === 0) {
    return 'История сессии пуста — компактить нечего.';
  }
  return [
    `🗜️ Сжато ${result.replacedCount} сообщений в summary (~${result.summary.length} символов).`,
    "Следующее сообщение будет видеть только summary + новые turn'ы.",
  ].join('\n');
}

export function handleHelpCommand(): string {
  return HELP_TEXT;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}с`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}мин`;
  return `${(seconds / 3600).toFixed(1)}ч`;
}
