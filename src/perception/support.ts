// Stateless-fetch входящих сообщений support-бота целевого проекта (фаза 2.1b).
//
// Контракт:
//   * Один вызов `fetchSupportMessages()` = один проход через
//     `bot.api.getUpdates`, чьи message-update'ы фильтруются по
//     `getSupportSourceChatIds()` и пишутся как `event.support.message` Records.
//   * Дедуп — на уровне БД через партишн-UNIQUE индекс на
//     `(json_extract(properties, '$.chatId'), json_extract(properties, '$.messageId'))`
//     где `type='event.support.message'`. Миграция
//     `20260501000000_event_support_message_unique`.
//   * Каждый прогон создаёт ровно один `audit.fetch.support` Record с
//     properties `{messagesFound, messagesInserted, messagesDeduplicated, since,
//     until, chatIds}` — даже на пустом инпуте.
//   * Bridge-эмиттер шлёт `support.fetch.start` (с `since`) и
//     `support.fetch.end` (с recordId аудита и счётчиками + длительностью).
//   * Никакого long-poll'а, никаких хендлеров — read-only stateless вызов.
//
// Решение по offset (см. ретро 2.1b):
//   * Передаётся offset в paginated-сессии: первый вызов без offset → next с
//     `offset = max(update_id) + 1`, и так пока batch не пуст или не достигнут
//     `MAX_PAGES`. Это «подтверждает» предыдущий batch ТОЛЬКО после успешного
//     INSERT'а — Telegram дропает только после нашего следующего getUpdates.
//   * Между прогонами офсет НЕ персистируется. Полагаемся на UNIQUE-индекс,
//     если та же сессия пересеклась с предыдущей.
//   * Известные риски (документированы в retrospectives/):
//     1. Telegram хранит недоставленные updates 24 ч. Если процесс не делал
//        fetch >24 ч — пропавшие сообщения потеряны навсегда.
//     2. Если процесс упал между getUpdates(offset=N) (Telegram сбросил <N) и
//        INSERT'ом — потерянная страница не восстанавливается.
//     Митигация для MVP: cron в 07:00 ежедневно, 24-часового окна нет; ручные
//     `pnpm dev:fetch:support` бьются по тому же offset'у.
//
// План явно говорит «stateless». Если фаундер захочет «надёжно без потерь» —
// добавится `SyncCheckpoint(source='telegram-support')` в отдельной фазе,
// без переписывания этого модуля (DI-friendly).
//
// Чужой `chat_id` (тот, кто нашёл support-бота через @search и пишет ему) —
// silent skip без INSERT'а. Аудит «чужого» отложен до фазы триажа: если
// поток лишних окажется значимым, добавим `audit.support.unknown_source`.

import { ulid } from 'ulid';
import type { PrismaClient } from '../db/client.js';
import { getPrisma } from '../db/client.js';
import { emit } from '../observe/bridge.js';

// ---------------------------------------------------------------------------
// Контракт «фетчер» — то, что мы ждём от Telegram-сервера. DI-friendly:
// прод использует grammy `bot.api.getUpdates`, тесты подкладывают мок-функцию.
// Тип сужен к минимуму того, что нам нужно (text + voice attachment), чтобы
// не таскать всю grammy-схему в тесты. Реальные ответы grammy совместимы
// (структурное соответствие).
// ---------------------------------------------------------------------------

/**
 * @deprecated since 2026-05-01 pivot — routine support-triage заменяет этот pipeline
 */
export interface SupportUpdateMessage {
  message_id: number;
  date: number; // Unix-секунды
  // Telegram возвращает chat.id числом, но мы внутри сразу приводим к строке
  // (отрицательные id групп — стандарт; единый тип в `properties.chatId`).
  // Тесты подменяют DI и иногда удобно подложить string-маркер с RUN_ID для
  // изоляции прогонов в shared dev.db — поэтому contract допускает оба типа.
  chat: { id: number | string };
  from?: { id: number; username?: string };
  text?: string;
  caption?: string;
  voice?: { file_id: string; duration?: number };
}

export interface SupportUpdate {
  update_id: number;
  message?: SupportUpdateMessage;
}

export interface SupportFetcher {
  // offset undefined → Telegram отдаёт earliest unconfirmed.
  // Limit 100 — стандарт getUpdates; больше Telegram не отдаст за один вызов.
  // allowed_updates: ['message'] — экономим трафик: callback_query/edited_message
  // нам не нужны, у бота нет хендлеров.
  fetchUpdates(opts: { offset?: number; limit?: number }): Promise<SupportUpdate[]>;
}

// ---------------------------------------------------------------------------
// Контракт результата + properties event.support.message.
// ---------------------------------------------------------------------------

export interface SupportAttachmentVoice {
  type: 'voice';
  file_id: string;
  // Заглушка фазы 2.1b: blob не качается, транскрипция — work для 3.2b.
  transcribed: false;
  // Маркер «знаем, что вложение есть; разбор отложен». 2.2 (триаж) увидит этот
  // флаг и не будет пытаться вытащить текст оттуда.
  _placeholder: 'attachment present, not parsed (3.2b)';
}

export type SupportAttachment = SupportAttachmentVoice;

// Контракт `event.support.message.properties` — критичен для 2.2a (триаж читает
// text + attachment метаданные). Любое изменение этого shape — breaking change
// для 2.2.
export interface SupportMessageProperties {
  chatId: string;
  messageId: number;
  userId: string | null;
  username: string | null;
  text: string;
  attachments: SupportAttachment[];
  // Unix-ms (Telegram отдаёт секунды; мы нормализуем в ms, как везде в БД).
  timestamp: number;
}

export interface FetchSupportResult {
  messagesFound: number;
  messagesInserted: number;
  messagesDeduplicated: number;
  // null означает «в журнале нет ни одного event.support.message — это первый
  // прогон». Иначе — ms-timestamp последнего event.support.message ДО fetch'а.
  since: Date | null;
  until: Date;
  chatIds: string[];
  auditRecordId: string;
}

export interface FetchSupportDeps {
  fetcher?: SupportFetcher;
  chatIds?: string[];
  db?: PrismaClient;
  // Маржинальная страховка: getUpdates лимит 100, но если поток за 24 ч превысит
  // 100×MAX_PAGES сообщений — мы не зацикливаемся бесконечно. Типичный support-
  // канал ≪ 1000/сутки.
  maxPages?: number;
}

const DEFAULT_MAX_PAGES = 10;
const PAGE_LIMIT = 100;

// ---------------------------------------------------------------------------
// Основная функция.
// ---------------------------------------------------------------------------

export async function fetchSupportMessages(
  deps: FetchSupportDeps = {},
): Promise<FetchSupportResult> {
  const db = deps.db ?? getPrisma();
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;

  const chatIds = deps.chatIds ?? (await loadChatIds());
  const fetcher = deps.fetcher ?? (await buildGrammyFetcher());

  const allowedChatIds = new Set(chatIds);
  const since = await getMaxSupportCreatedAt(db);
  const startedAt = Date.now();

  await emit({
    type: 'support.fetch.start',
    since: since !== null ? since.getTime() : null,
    chatIds,
  });

  let messagesFound = 0;
  let messagesInserted = 0;
  let messagesDeduplicated = 0;

  let offset: number | undefined;
  for (let page = 0; page < maxPages; page++) {
    const updates = await fetcher.fetchUpdates({ offset, limit: PAGE_LIMIT });
    if (updates.length === 0) break;

    let maxUpdateId = -1;
    for (const update of updates) {
      if (update.update_id > maxUpdateId) maxUpdateId = update.update_id;
      const message = update.message;
      if (message === undefined) continue;

      const chatId = String(message.chat.id);
      if (!allowedChatIds.has(chatId)) {
        // Чужой source — silent skip. Аудит — отложен (см. шапка файла).
        continue;
      }
      messagesFound += 1;

      const properties = buildProperties(message, chatId);
      const inserted = await insertEventSupportMessage(db, properties);
      if (inserted) messagesInserted += 1;
      else messagesDeduplicated += 1;
    }

    // Подтверждаем предыдущий batch только после успешных INSERT'ов:
    // следующий getUpdates с offset=maxUpdateId+1 дропнет их с сервера.
    if (maxUpdateId < 0) break;
    offset = maxUpdateId + 1;

    // Если страница пришла короче лимита — данных больше нет, не дёргаем
    // Telegram впустую (обычно их кидает на следующей итерации с offset).
    if (updates.length < PAGE_LIMIT) break;
  }

  const until = new Date();
  const auditRecordId = await recordFetchAudit(db, {
    messagesFound,
    messagesInserted,
    messagesDeduplicated,
    since,
    until,
    chatIds,
  });

  await emit({
    type: 'support.fetch.end',
    recordId: auditRecordId,
    messagesFound,
    messagesInserted,
    messagesDeduplicated,
    durationMs: Date.now() - startedAt,
  });

  return {
    messagesFound,
    messagesInserted,
    messagesDeduplicated,
    since,
    until,
    chatIds,
    auditRecordId,
  };
}

// ---------------------------------------------------------------------------
// Построение properties из Telegram Message.
// ---------------------------------------------------------------------------

function buildProperties(message: SupportUpdateMessage, chatId: string): SupportMessageProperties {
  const attachments: SupportAttachment[] = [];
  if (message.voice !== undefined) {
    attachments.push({
      type: 'voice',
      file_id: message.voice.file_id,
      transcribed: false,
      _placeholder: 'attachment present, not parsed (3.2b)',
    });
  }

  // text может отсутствовать (только voice/caption); приводим к пустой строке,
  // чтобы 2.2 (триаж) могла безопасно читать `properties.text` без проверки.
  // Если есть caption (например, voice + подпись) — берём caption как text.
  const text = message.text ?? message.caption ?? '';

  return {
    chatId,
    messageId: message.message_id,
    userId: message.from !== undefined ? String(message.from.id) : null,
    username: message.from?.username ?? null,
    text,
    attachments,
    // Telegram date в секундах → ms.
    timestamp: message.date * 1000,
  };
}

// ---------------------------------------------------------------------------
// БД: чтение «since», INSERT event.support.message, INSERT audit.fetch.support.
// ---------------------------------------------------------------------------

async function getMaxSupportCreatedAt(db: PrismaClient): Promise<Date | null> {
  // Партишн UNIQUE индекс по `(chatId, messageId)` — но для «since» нужен
  // максимум по createdAt всех event.support.message. Используем индекс
  // `Record_type_createdAt_idx` (тот же, что 1.1 закладывал под Слой 2).
  const rows = await db.$queryRawUnsafe<{ createdAt: number | bigint }[]>(
    `SELECT MAX(createdAt) AS createdAt FROM "Record" WHERE type = 'event.support.message'`,
  );
  const top = rows[0]?.createdAt;
  if (top === null || top === undefined) return null;
  return new Date(Number(top));
}

async function insertEventSupportMessage(
  db: PrismaClient,
  properties: SupportMessageProperties,
): Promise<boolean> {
  const id = ulid();
  const now = Date.now();
  // ON CONFLICT DO NOTHING без conflict-target: SQLite UPSERT не умеет указать
  // expression-индекс таргетом. Без таргета — матчится любое UNIQUE/PK
  // violation. Для event.support.message единственный возможный — наш
  // `Record_event_support_message_chatId_messageId_unique` (idempotencyKey
  // не задаётся), поэтому семантически = «дубликат → silent skip».
  // RETURNING id: пустой массив = конфликт = deduplicated.
  // actorKind='external' — сообщение от клиента, который вне организации.
  const inserted = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt)
     VALUES (?, 'event.support.message', ?, 'external', 'autonomous', 'active', ?)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    id,
    JSON.stringify(properties),
    now,
  );
  return inserted.length === 1;
}

interface AuditFetchSupportInput {
  messagesFound: number;
  messagesInserted: number;
  messagesDeduplicated: number;
  since: Date | null;
  until: Date;
  chatIds: string[];
}

async function recordFetchAudit(db: PrismaClient, input: AuditFetchSupportInput): Promise<string> {
  const id = ulid();
  const now = Date.now();
  const properties = JSON.stringify({
    messagesFound: input.messagesFound,
    messagesInserted: input.messagesInserted,
    messagesDeduplicated: input.messagesDeduplicated,
    since: input.since !== null ? input.since.getTime() : null,
    until: input.until.getTime(),
    chatIds: input.chatIds,
  });
  // audit.* контракт (правила-нерушимые.md:24): status='closed', closedAt=now,
  // visibility='autonomous', actorKind='agent'. Тот же паттерн, что
  // audit.spend в src/llm/spend.ts и audit.security.deny в src/telegram/audit.ts.
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.fetch.support', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    properties,
    now,
    now,
  );
  return id;
}

// ---------------------------------------------------------------------------
// DI-defaults: реальный grammy + чтение source-листа из Page'и.
// Импорты ленивые: тесты подменяют через FetchSupportDeps без загрузки grammy.
// ---------------------------------------------------------------------------

async function loadChatIds(): Promise<string[]> {
  const { getSupportSourceChatIds } = await import('../telegram/secrets.js');
  return getSupportSourceChatIds();
}

async function buildGrammyFetcher(): Promise<SupportFetcher> {
  const { getSupportBotToken } = await import('../telegram/secrets.js');
  const { Bot } = await import('grammy');
  const token = await getSupportBotToken();
  // Bot init() не дёргаем — для api.getUpdates он не обязателен (init нужен
  // только для bot.start() / bot.handleUpdate()). У нас чистый api-вызов.
  const bot = new Bot(token);
  return {
    fetchUpdates: async (opts) => {
      // allowed_updates: ['message'] — у support-бота нет других хендлеров,
      // экономим трафик и предотвращаем накопление мусорных update'ов.
      const updates = await bot.api.getUpdates({
        offset: opts.offset,
        limit: opts.limit ?? PAGE_LIMIT,
        timeout: 0,
        allowed_updates: ['message'],
      });
      // grammy Update структурно совместим с SupportUpdate (мы используем только
      // message_id, date, chat.id, from.{id,username}, text, caption, voice).
      // Каст безопасен: лишние поля игнорируются.
      return updates as unknown as SupportUpdate[];
    },
  };
}
