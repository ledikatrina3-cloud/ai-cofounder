// Запись audit.security.deny — повторная доставка отвергнутого Telegram-сообщения
// в журнал. Применяется allowlist-middleware (src/telegram/middleware.ts) каждый
// раз, когда чужой chat_id пробует достучаться до бота.
//
// Стиль INSERT'а — копия src/llm/spend.ts: actorKind='agent', visibility='autonomous',
// status='closed', closedAt=createdAt=now. audit.* всегда immutable
// (prisma/schema.prisma:24).
//
// Тип `audit.security.deny` — новый подтип Record (не упомянут в schema.prisma
// как known type, но и `audit.spend`/`audit.budget.deny` из 1.3 туда же не
// добавляли — schema хранит type как открытое строковое поле). Когда фаза M2/M3
// потребует JSON-Schema валидацию по типу (см. сущности.md:30), сюда добавится
// shape для security-событий.

import { ulid } from 'ulid';
import type { PrismaClient } from '../db/client.js';
import { getPrisma } from '../db/client.js';

export interface SecurityDenyInput {
  chatId: string | null;
  userId: string | null;
  username: string | null;
  command: string;
}

export interface SecurityDenyProperties {
  chatId: string | null;
  userId: string | null;
  username: string | null;
  command: string;
}

export async function recordSecurityDeny(
  input: SecurityDenyInput,
  db: PrismaClient = getPrisma(),
): Promise<string> {
  const id = ulid();
  const properties: SecurityDenyProperties = {
    chatId: input.chatId,
    userId: input.userId,
    username: input.username,
    command: input.command,
  };
  const now = Date.now();
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt) VALUES (?, 'audit.security.deny', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    JSON.stringify(properties),
    now,
    now,
  );
  return id;
}
