// Управление conversational сессиями для Telegram-бота.
//
// Хранилище — существующая Record-таблица (append-only). Никаких миграций.
// Каждое сообщение / событие сессии — отдельная Record с типом chat.*:
//
//   chat.session.start    — properties: { chatId, sessionId }
//   chat.session.end      — properties: { chatId, sessionId, reason }
//   chat.session.resume   — properties: { chatId, sessionId }
//   chat.session.compact  — properties: { chatId, sessionId, summary, replacedCount }
//   chat.message.user     — properties: { chatId, sessionId, text }
//   chat.message.assistant — properties: { chatId, sessionId, text, usd, durationMs, status }
//
// «Активная сессия» для chatId = sessionId последней chat.* записи этого chatId,
// если она moложе TTL. Иначе — нет активной сессии (следующее сообщение откроет новую).

import { ulid } from 'ulid';
import { type PrismaClient, getPrisma } from '../db/client.js';

export const SESSION_TTL_MS = 30 * 60 * 1000; // 30 минут неактивности → новая сессия

export type ChatRole = 'user' | 'assistant';

export interface ChatTurn {
  role: ChatRole;
  text: string;
  createdAt: Date;
}

export interface SessionStats {
  sessionId: string;
  messageCount: number;
  totalUsd: number;
  firstAt: Date | null;
  lastAt: Date | null;
}

export interface SessionListItem {
  sessionId: string;
  firstMessage: string;
  messageCount: number;
  totalUsd: number;
  lastAt: Date;
}

interface RecordRow {
  id: string;
  type: string;
  properties: string;
  createdAt: Date;
}

/**
 * Возвращает sessionId активной сессии для chatId или null.
 * Активная = последняя chat.* запись этого chatId моложе SESSION_TTL_MS.
 */
export async function getCurrentSessionId(
  chatId: number,
  db: PrismaClient = getPrisma(),
  now: () => number = Date.now,
): Promise<string | null> {
  const row = await db.$queryRawUnsafe<RecordRow[]>(
    `SELECT id, type, properties, createdAt FROM "Record"
       WHERE type LIKE 'chat.%'
         AND json_extract(properties, '$.chatId') = ?
       ORDER BY createdAt DESC
       LIMIT 1`,
    chatId,
  );
  const last = row[0];
  if (last === undefined) return null;
  if (last.type === 'chat.session.end') return null;

  const lastMs = new Date(last.createdAt).getTime();
  if (now() - lastMs > SESSION_TTL_MS) return null;

  const props = JSON.parse(last.properties) as { sessionId?: string };
  return props.sessionId ?? null;
}

/** Создаёт новую сессию: пишет chat.session.start, возвращает sessionId. */
export async function startNewSession(
  chatId: number,
  db: PrismaClient = getPrisma(),
): Promise<string> {
  const sessionId = ulid();
  const id = ulid();
  const props = JSON.stringify({ chatId, sessionId });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'chat.session.start', ?, 'founder', 'autonomous', 'closed', ?, ?)`,
    id,
    props,
    Date.now(),
    Date.now(),
  );
  return sessionId;
}

/** Закрывает сессию (фиксирует chat.session.end). Идемпотентно — повтор не ошибка. */
export async function endSession(
  chatId: number,
  sessionId: string,
  reason: 'manual' | 'ttl' | 'replaced',
  db: PrismaClient = getPrisma(),
): Promise<void> {
  const id = ulid();
  const props = JSON.stringify({ chatId, sessionId, reason });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'chat.session.end', ?, 'system', 'autonomous', 'closed', ?, ?)`,
    id,
    props,
    Date.now(),
    Date.now(),
  );
}

/** Возобновляет указанную сессию: пишет chat.session.resume. */
export async function resumeSession(
  chatId: number,
  sessionId: string,
  db: PrismaClient = getPrisma(),
): Promise<void> {
  const id = ulid();
  const props = JSON.stringify({ chatId, sessionId });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'chat.session.resume', ?, 'founder', 'autonomous', 'closed', ?, ?)`,
    id,
    props,
    Date.now(),
    Date.now(),
  );
}

/** Сохраняет user-сообщение. */
export async function appendUserMessage(
  chatId: number,
  sessionId: string,
  text: string,
  db: PrismaClient = getPrisma(),
): Promise<string> {
  const id = ulid();
  const props = JSON.stringify({ chatId, sessionId, text });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'chat.message.user', ?, 'founder', 'autonomous', 'closed', ?, ?)`,
    id,
    props,
    Date.now(),
    Date.now(),
  );
  return id;
}

/** Сохраняет assistant-ответ. */
export async function appendAssistantMessage(
  chatId: number,
  sessionId: string,
  args: { text: string; usd: number; durationMs: number; status: string },
  db: PrismaClient = getPrisma(),
): Promise<string> {
  const id = ulid();
  const props = JSON.stringify({ chatId, sessionId, ...args });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'chat.message.assistant', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    props,
    Date.now(),
    Date.now(),
  );
  return id;
}

/**
 * История сессии для построения промта: все user/assistant сообщения после
 * последнего compact'а (если был), отсортированные по времени.
 */
export async function getSessionHistory(
  sessionId: string,
  db: PrismaClient = getPrisma(),
): Promise<{ summary: string | null; turns: ChatTurn[] }> {
  // Ищем последний compact для этой сессии — если есть, история начинается ПОСЛЕ него.
  const compactRow = await db.$queryRawUnsafe<RecordRow[]>(
    `SELECT id, type, properties, createdAt FROM "Record"
       WHERE type = 'chat.session.compact'
         AND json_extract(properties, '$.sessionId') = ?
       ORDER BY createdAt DESC
       LIMIT 1`,
    sessionId,
  );
  const compact = compactRow[0];
  const compactCreatedAt = compact !== undefined ? new Date(compact.createdAt).getTime() : 0;
  const summary =
    compact !== undefined
      ? ((JSON.parse(compact.properties) as { summary?: string }).summary ?? null)
      : null;

  const messageRows = await db.$queryRawUnsafe<RecordRow[]>(
    `SELECT id, type, properties, createdAt FROM "Record"
       WHERE type IN ('chat.message.user', 'chat.message.assistant')
         AND json_extract(properties, '$.sessionId') = ?
         AND createdAt > ?
       ORDER BY createdAt ASC`,
    sessionId,
    compactCreatedAt,
  );

  const turns: ChatTurn[] = messageRows.map((r) => {
    const props = JSON.parse(r.properties) as { text?: string };
    return {
      role: r.type === 'chat.message.user' ? 'user' : 'assistant',
      text: props.text ?? '',
      createdAt: new Date(r.createdAt),
    };
  });

  return { summary, turns };
}

/** Статистика по сессии: число сообщений, сумма $, временные метки. */
export async function getSessionStats(
  sessionId: string,
  db: PrismaClient = getPrisma(),
): Promise<SessionStats> {
  const rows = await db.$queryRawUnsafe<RecordRow[]>(
    `SELECT id, type, properties, createdAt FROM "Record"
       WHERE type IN ('chat.message.user', 'chat.message.assistant')
         AND json_extract(properties, '$.sessionId') = ?
       ORDER BY createdAt ASC`,
    sessionId,
  );

  let totalUsd = 0;
  for (const r of rows) {
    if (r.type === 'chat.message.assistant') {
      const props = JSON.parse(r.properties) as { usd?: number };
      totalUsd += props.usd ?? 0;
    }
  }

  return {
    sessionId,
    messageCount: rows.length,
    totalUsd,
    firstAt: rows[0] !== undefined ? new Date(rows[0].createdAt) : null,
    lastAt: rows[rows.length - 1] !== undefined ? new Date(rows[rows.length - 1]!.createdAt) : null,
  };
}

/** Список последних N сессий пользователя за 7 дней. */
export async function listRecentSessions(
  chatId: number,
  limit = 10,
  db: PrismaClient = getPrisma(),
): Promise<SessionListItem[]> {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const rows = await db.$queryRawUnsafe<RecordRow[]>(
    `SELECT id, type, properties, createdAt FROM "Record"
       WHERE type IN ('chat.message.user', 'chat.message.assistant')
         AND json_extract(properties, '$.chatId') = ?
         AND createdAt > ?
       ORDER BY createdAt ASC`,
    chatId,
    sevenDaysAgo,
  );

  // Группировка по sessionId с агрегацией.
  const sessions = new Map<
    string,
    { firstMessage: string; messageCount: number; totalUsd: number; lastAt: Date }
  >();
  for (const r of rows) {
    const props = JSON.parse(r.properties) as { sessionId?: string; text?: string; usd?: number };
    const sid = props.sessionId;
    if (sid === undefined) continue;
    const existing = sessions.get(sid);
    if (existing === undefined) {
      sessions.set(sid, {
        firstMessage: r.type === 'chat.message.user' ? (props.text ?? '').slice(0, 60) : '',
        messageCount: 1,
        totalUsd: r.type === 'chat.message.assistant' ? (props.usd ?? 0) : 0,
        lastAt: new Date(r.createdAt),
      });
    } else {
      existing.messageCount += 1;
      if (r.type === 'chat.message.assistant') existing.totalUsd += props.usd ?? 0;
      existing.lastAt = new Date(r.createdAt);
      if (existing.firstMessage === '' && r.type === 'chat.message.user') {
        existing.firstMessage = (props.text ?? '').slice(0, 60);
      }
    }
  }

  return Array.from(sessions.entries())
    .map(([sessionId, agg]) => ({ sessionId, ...agg }))
    .sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime())
    .slice(0, limit);
}

/** Проверяет что сессия принадлежит этому chatId (для /resume — защита от чужих id). */
export async function sessionBelongsToChat(
  chatId: number,
  sessionId: string,
  db: PrismaClient = getPrisma(),
): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<RecordRow[]>(
    `SELECT id FROM "Record"
       WHERE type LIKE 'chat.%'
         AND json_extract(properties, '$.chatId') = ?
         AND json_extract(properties, '$.sessionId') = ?
       LIMIT 1`,
    chatId,
    sessionId,
  );
  return rows.length > 0;
}

/** Сохраняет результат компакции (summary). */
export async function saveCompactSummary(
  chatId: number,
  sessionId: string,
  summary: string,
  replacedCount: number,
  db: PrismaClient = getPrisma(),
): Promise<string> {
  const id = ulid();
  const props = JSON.stringify({ chatId, sessionId, summary, replacedCount });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'chat.session.compact', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    props,
    Date.now(),
    Date.now(),
  );
  return id;
}
