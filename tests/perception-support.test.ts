// Тесты для фазы 2.1b (stateless-fetch + event.support.message + дедуп).
//
// Контракт, который тут пин'ится:
//   * `fetchSupportMessages({fetcher, chatIds, db})` — DI-friendly. Реальный
//     grammy подменяется мок-функцией; реальный config — массивом.
//   * Один прогон → N event.support.message + ровно 1 audit.fetch.support.
//   * Повторный прогон с тем же mock → 0 новых INSERT, +1 audit (с
//     `messagesDeduplicated=N`).
//   * Voice → properties.attachments[0].type='voice', transcribed=false,
//     placeholder сохранён.
//   * UNIQUE-индекс физически работает: ручной INSERT дубля → SQLite error.
//   * Чужой chat_id (не из source-листа) → silent skip без INSERT.
//
// Тесты делят dev.db с другими файлами (vitest singleFork, см. ретро 1.3
// и 1.4). Изоляция — уникальный prefix chat_id'а на каждый прогон файла:
//   chatId = `2.1b-test-${RUN_ID}-...`
// Все count-запросы фильтруют по `properties LIKE '%${RUN_ID}%'` — не
// зависят от записей других тестов и не делают DELETE (append-only).

import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSchemaInvariants } from '../src/db/invariants-check.js';
import {
  type SupportFetcher,
  type SupportUpdate,
  fetchSupportMessages,
} from '../src/perception/support.js';

const RUN_ID = ulid().slice(0, 8);
// Используем prefix внутри chatId, чтобы UNIQUE-индекс по
// (chatId, messageId) сегрегировал тестовые записи между прогонами.
const TEST_CHAT_ID = `2.1b-${RUN_ID}`;
// Второй чат для проверки multi-source листа.
const TEST_CHAT_ID_B = `2.1b-${RUN_ID}-b`;
// Чужой чат — НЕ в source-листе. Его сообщения должны быть silent-skip'нуты.
const FOREIGN_CHAT_ID = `2.1b-${RUN_ID}-foreign`;

const db = new PrismaClient();

beforeAll(async () => {
  await db.$connect();
  await assertSchemaInvariants(db);
});

afterAll(async () => {
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// Хелперы для подсчёта тестовых записей.
// ---------------------------------------------------------------------------

async function countSupportMessagesByChatId(chatIdMarker: string): Promise<number> {
  // Фильтруем по подстроке RUN_ID в properties JSON — фильтр устойчив к
  // другим тестам/прогонам. Может ловить разные chatId с тем же RUN_ID,
  // что и нужно для теста.
  const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n FROM "Record" WHERE type = 'event.support.message' AND properties LIKE ?`,
    `%${chatIdMarker}%`,
  );
  return Number(rows[0]?.n ?? 0n);
}

async function countAuditFetchSupport(): Promise<number> {
  // audit.fetch.support пишется один на каждый вызов fetchSupportMessages,
  // независимо от inputа — мерилом «сколько раз дёргнули» работает счётчик
  // по подстроке RUN_ID в chatIds (мы передаём свой массив с RUN_ID).
  const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n FROM "Record" WHERE type = 'audit.fetch.support' AND properties LIKE ?`,
    `%${RUN_ID}%`,
  );
  return Number(rows[0]?.n ?? 0n);
}

async function loadSupportMessagesByChatId(
  chatIdMarker: string,
): Promise<Array<{ id: string; properties: string; createdAt: number }>> {
  const rows = await db.$queryRawUnsafe<{ id: string; properties: string; createdAt: number }[]>(
    `SELECT id, properties, createdAt FROM "Record"
       WHERE type = 'event.support.message' AND properties LIKE ?
       ORDER BY createdAt ASC`,
    `%${chatIdMarker}%`,
  );
  return rows;
}

async function loadLastAuditFetchSupport(): Promise<{ properties: string } | null> {
  const rows = await db.$queryRawUnsafe<{ properties: string }[]>(
    `SELECT properties FROM "Record"
       WHERE type = 'audit.fetch.support' AND properties LIKE ?
       ORDER BY createdAt DESC, id DESC LIMIT 1`,
    `%${RUN_ID}%`,
  );
  return rows[0] ?? null;
}

function makeFetcher(updates: SupportUpdate[]): SupportFetcher {
  // Простейший «one-shot» мок: первый вызов отдаёт весь массив, последующие — [].
  // pagination в production-коде корректно работает: на page 0 получаем все,
  // page 1 уже пуст → break.
  let served = false;
  return {
    fetchUpdates: async () => {
      if (served) return [];
      served = true;
      return updates;
    },
  };
}

function makeMessageUpdate(opts: {
  updateId: number;
  chatId: string;
  messageId: number;
  text?: string;
  caption?: string;
  voice?: { file_id: string; duration?: number };
  userId?: number;
  username?: string;
  date?: number;
}): SupportUpdate {
  // chat.id у нас допускает `number | string` (см. `SupportUpdateMessage`).
  // В production Telegram отдаёт number; здесь подкладываем строку с RUN_ID,
  // чтобы LIKE-фильтр по properties JSON изолировал прогоны в shared dev.db.
  // production-код всё равно делает `String(message.chat.id)`.
  return {
    update_id: opts.updateId,
    message: {
      message_id: opts.messageId,
      chat: { id: opts.chatId },
      from: opts.userId !== undefined ? { id: opts.userId, username: opts.username } : undefined,
      text: opts.text,
      caption: opts.caption,
      voice: opts.voice,
      date: opts.date ?? Math.floor(Date.now() / 1000),
    },
  };
}

// ---------------------------------------------------------------------------
// Тесты.
// ---------------------------------------------------------------------------

describe('fetchSupportMessages — happy-path', () => {
  it('первый прогон 10 моковых сообщений → 10 INSERT + 1 audit.fetch.support', async () => {
    const updates: SupportUpdate[] = [];
    for (let i = 0; i < 10; i++) {
      updates.push(
        makeMessageUpdate({
          updateId: 1000 + i,
          chatId: TEST_CHAT_ID,
          messageId: 1 + i,
          text: `hello-${RUN_ID}-${i}`,
          userId: 7000 + i,
          username: `user-${RUN_ID}`,
        }),
      );
    }

    const beforeAudit = await countAuditFetchSupport();
    const beforeMessages = await countSupportMessagesByChatId(RUN_ID);

    const result = await fetchSupportMessages({
      db,
      fetcher: makeFetcher(updates),
      chatIds: [TEST_CHAT_ID],
    });

    expect(result.messagesFound).toBe(10);
    expect(result.messagesInserted).toBe(10);
    expect(result.messagesDeduplicated).toBe(0);
    expect(result.chatIds).toEqual([TEST_CHAT_ID]);

    const afterAudit = await countAuditFetchSupport();
    const afterMessages = await countSupportMessagesByChatId(RUN_ID);
    expect(afterAudit - beforeAudit).toBe(1);
    expect(afterMessages - beforeMessages).toBe(10);

    // Один из сообщений — sanity check содержимого properties.
    const stored = await loadSupportMessagesByChatId(`hello-${RUN_ID}-3`);
    expect(stored.length).toBe(1);
    const props = JSON.parse(stored[0]!.properties) as Record<string, unknown>;
    expect(props.chatId).toBe(TEST_CHAT_ID);
    expect(props.messageId).toBe(4);
    expect(props.userId).toBe('7003');
    expect(props.username).toBe(`user-${RUN_ID}`);
    expect(props.text).toBe(`hello-${RUN_ID}-3`);
    expect(props.attachments).toEqual([]);
    expect(typeof props.timestamp).toBe('number');
  });

  it('повторный прогон с тем же mock → 0 INSERT, 10 deduplicated, +1 audit', async () => {
    const updates: SupportUpdate[] = [];
    for (let i = 0; i < 10; i++) {
      updates.push(
        makeMessageUpdate({
          updateId: 1000 + i,
          chatId: TEST_CHAT_ID,
          messageId: 1 + i,
          text: `hello-${RUN_ID}-${i}`,
          userId: 7000 + i,
          username: `user-${RUN_ID}`,
        }),
      );
    }

    const beforeAudit = await countAuditFetchSupport();
    const beforeMessages = await countSupportMessagesByChatId(RUN_ID);

    const result = await fetchSupportMessages({
      db,
      fetcher: makeFetcher(updates),
      chatIds: [TEST_CHAT_ID],
    });

    expect(result.messagesFound).toBe(10);
    expect(result.messagesInserted).toBe(0);
    expect(result.messagesDeduplicated).toBe(10);

    const afterAudit = await countAuditFetchSupport();
    const afterMessages = await countSupportMessagesByChatId(RUN_ID);
    expect(afterAudit - beforeAudit).toBe(1);
    expect(afterMessages - beforeMessages).toBe(0);

    // since != null — это «второй» проход, в журнале уже есть event.support.message.
    expect(result.since).not.toBeNull();
    expect(result.since instanceof Date).toBe(true);
  });
});

describe('fetchSupportMessages — пустой инпут', () => {
  it('фетчер вернул [] → 0 INSERT, 1 audit.fetch.support с messagesFound=0', async () => {
    const beforeAudit = await countAuditFetchSupport();

    const result = await fetchSupportMessages({
      db,
      fetcher: makeFetcher([]),
      chatIds: [TEST_CHAT_ID],
    });

    expect(result.messagesFound).toBe(0);
    expect(result.messagesInserted).toBe(0);
    expect(result.messagesDeduplicated).toBe(0);

    const afterAudit = await countAuditFetchSupport();
    expect(afterAudit - beforeAudit).toBe(1);

    // audit.fetch.support shape — критично для 2.5 (отчёт ссылается на эти поля).
    const audit = await loadLastAuditFetchSupport();
    expect(audit).not.toBeNull();
    const props = JSON.parse(audit!.properties) as Record<string, unknown>;
    expect(props.messagesFound).toBe(0);
    expect(props.messagesInserted).toBe(0);
    expect(props.messagesDeduplicated).toBe(0);
    expect(props.chatIds).toEqual([TEST_CHAT_ID]);
    expect(typeof props.until).toBe('number');
    // since может быть null или number (если предыдущие тесты в этом файле
    // что-то записали); проверяем тип, не значение.
    expect(props.since === null || typeof props.since === 'number').toBe(true);
  });

  it('пустой source-лист → не падает, audit.fetch.support всё равно пишется', async () => {
    // Этот кейс — единственный, где RUN_ID НЕ попадает в audit.properties
    // (chatIds=[] и messages=0). Поэтому LIKE-фильтр по RUN_ID нам не подходит;
    // ассертим напрямую по `result.auditRecordId`.
    const result = await fetchSupportMessages({
      db,
      fetcher: makeFetcher([]),
      chatIds: [],
    });
    expect(result.messagesFound).toBe(0);
    expect(result.chatIds).toEqual([]);
    const auditRow = await db.$queryRawUnsafe<{ id: string; type: string }[]>(
      `SELECT id, type FROM "Record" WHERE id = ?`,
      result.auditRecordId,
    );
    expect(auditRow.length).toBe(1);
    expect(auditRow[0]!.type).toBe('audit.fetch.support');
  });
});

describe('fetchSupportMessages — voice attachment placeholder', () => {
  it('voice без text → properties.attachments[0] = voice placeholder, transcribed=false', async () => {
    const update = makeMessageUpdate({
      updateId: 9001,
      chatId: TEST_CHAT_ID_B,
      messageId: 555,
      voice: { file_id: 'AwACAgIAAxkBAAIB', duration: 12 },
      userId: 8888,
      username: `voiceuser-${RUN_ID}`,
    });

    const result = await fetchSupportMessages({
      db,
      fetcher: makeFetcher([update]),
      chatIds: [TEST_CHAT_ID_B],
    });

    expect(result.messagesInserted).toBe(1);

    const stored = await loadSupportMessagesByChatId(`voiceuser-${RUN_ID}`);
    expect(stored.length).toBe(1);
    const props = JSON.parse(stored[0]!.properties) as {
      text: string;
      attachments: Array<{
        type: string;
        file_id: string;
        transcribed: boolean;
        _placeholder: string;
      }>;
    };
    // У voice-only сообщения нет text — должно быть пустой строкой.
    expect(props.text).toBe('');
    expect(props.attachments).toHaveLength(1);
    expect(props.attachments[0]!.type).toBe('voice');
    expect(props.attachments[0]!.file_id).toBe('AwACAgIAAxkBAAIB');
    expect(props.attachments[0]!.transcribed).toBe(false);
    expect(props.attachments[0]!._placeholder).toBe('attachment present, not parsed (3.2b)');
  });

  it('voice + caption → text = caption, attachment placeholder сохранён', async () => {
    const update = makeMessageUpdate({
      updateId: 9002,
      chatId: TEST_CHAT_ID_B,
      messageId: 556,
      voice: { file_id: 'capvoice-id', duration: 3 },
      caption: `voicecap-${RUN_ID}`,
      userId: 9999,
    });

    await fetchSupportMessages({
      db,
      fetcher: makeFetcher([update]),
      chatIds: [TEST_CHAT_ID_B],
    });

    const stored = await loadSupportMessagesByChatId(`voicecap-${RUN_ID}`);
    expect(stored.length).toBe(1);
    const props = JSON.parse(stored[0]!.properties) as {
      text: string;
      attachments: Array<{ type: string; transcribed: boolean }>;
    };
    expect(props.text).toBe(`voicecap-${RUN_ID}`);
    expect(props.attachments[0]!.type).toBe('voice');
    expect(props.attachments[0]!.transcribed).toBe(false);
  });
});

describe('fetchSupportMessages — фильтр по source-листу', () => {
  it('сообщение из чужого chat_id (не в source) → silent skip, не INSERT', async () => {
    const updates: SupportUpdate[] = [
      makeMessageUpdate({
        updateId: 7000,
        chatId: TEST_CHAT_ID,
        messageId: 9000,
        text: `legit-${RUN_ID}`,
        userId: 1,
      }),
      makeMessageUpdate({
        updateId: 7001,
        chatId: FOREIGN_CHAT_ID,
        messageId: 9001,
        text: `foreign-${RUN_ID}`,
        userId: 2,
      }),
    ];

    const result = await fetchSupportMessages({
      db,
      fetcher: makeFetcher(updates),
      chatIds: [TEST_CHAT_ID],
    });

    // Только один из двух update'ов попал в source — legit.
    expect(result.messagesFound).toBe(1);
    expect(result.messagesInserted).toBe(1);

    // Чужой не INSERT'ился.
    const foreignStored = await loadSupportMessagesByChatId(`foreign-${RUN_ID}`);
    expect(foreignStored.length).toBe(0);
  });
});

describe('UNIQUE-индекс физически работает', () => {
  it('ручной INSERT дубля event.support.message → SQLite UNIQUE error', async () => {
    const chatId = `${TEST_CHAT_ID}-physical`;
    const messageId = 12345;
    const properties = JSON.stringify({
      chatId,
      messageId,
      userId: null,
      username: `physical-${RUN_ID}`,
      text: `physical-${RUN_ID}`,
      attachments: [],
      timestamp: Date.now(),
    });

    // Первый — успех.
    await db.$executeRawUnsafe(
      `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt)
       VALUES (?, 'event.support.message', ?, 'external', 'autonomous', 'active', ?)`,
      ulid(),
      properties,
      Date.now(),
    );

    // Второй — должен упасть на UNIQUE.
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt)
         VALUES (?, 'event.support.message', ?, 'external', 'autonomous', 'active', ?)`,
        ulid(),
        properties,
        Date.now(),
      ),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
  });
});
