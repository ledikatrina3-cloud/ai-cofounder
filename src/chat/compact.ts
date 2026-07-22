// Компакция чат-сессии: одним вызовом Sonnet превращает историю turn'ов в сжатое
// summary, которое потом подставляется вместо turn'ов в следующих промтах.
//
// Триггер компакции — пока ручной (/compact из Telegram). Автоматическую
// компакцию по N turn'ов или по размеру контекста можно добавить позже.

import type { PrismaClient } from '../db/client.js';
import { call } from '../llm/call.js';
import { type ChatTurn, getSessionHistory, saveCompactSummary } from './sessions.js';

const COMPACT_PROMPT_ID = 'chat:compact';
const COMPACT_MAX_TOKENS = 1024;

export interface CompactResult {
  summary: string;
  replacedCount: number;
  recordId: string | null;
}

export async function compactSession(
  chatId: number,
  sessionId: string,
  db?: PrismaClient,
): Promise<CompactResult> {
  const { summary: existingSummary, turns } = await getSessionHistory(sessionId, db);
  if (turns.length === 0) {
    return { summary: existingSummary ?? '', replacedCount: 0, recordId: null };
  }

  const formatted = formatTurnsForCompaction(existingSummary, turns);

  const result = await call(
    {
      promptId: COMPACT_PROMPT_ID,
      model: 'claude-sonnet-4-6',
      maxTokens: COMPACT_MAX_TOKENS,
      system:
        'Ты сжимаешь длинную переписку фаундера с AI-кофаундером в краткое summary (≤200 слов). ' +
        'Сохрани: ключевые факты обсуждения, решения, открытые вопросы, важные находки. ' +
        'Убери: формальности, повторы, низкоуровневые детали инструментов. ' +
        'Пиши на русском, в третьем лице («фаундер просил…», «агент нашёл…»).',
      messages: [{ role: 'user', content: formatted }],
    },
    db,
  );

  const recordId = await saveCompactSummary(chatId, sessionId, result.text, turns.length, db);
  return { summary: result.text, replacedCount: turns.length, recordId };
}

function formatTurnsForCompaction(existingSummary: string | null, turns: ChatTurn[]): string {
  const parts: string[] = [];
  if (existingSummary !== null && existingSummary.length > 0) {
    parts.push('## Предыдущее summary этой сессии');
    parts.push(existingSummary);
    parts.push('');
  }
  parts.push("## Новые turn'ы для включения в summary");
  for (const turn of turns) {
    const roleLabel = turn.role === 'user' ? 'ФАУНДЕР' : 'АГЕНТ';
    parts.push(`### ${roleLabel} (${turn.createdAt.toISOString()})`);
    parts.push(turn.text);
    parts.push('');
  }
  return parts.join('\n');
}
