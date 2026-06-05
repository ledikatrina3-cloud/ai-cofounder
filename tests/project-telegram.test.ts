// Тесты для src/tools/project-telegram/index.ts (фаза 2.4).
//
// Стратегия: без реального Telegram API.
// 1. Чистые кейсы через `parseUpdatesToMessages` — никакой сети, никакого grammy.
// 2. DI-кейсы через `botApiOverride` + `keychainOverride` — изоляция keytar.

import { describe, expect, it } from 'vitest';
import type { TgChannelConfig } from '../src/projects/map.js';
import {
  type TelegramReadOptions,
  TelegramToolError,
  type Update,
  parseUpdatesToMessages,
  projectTelegramRead,
} from '../src/tools/project-telegram/index.js';

// ---------------------------------------------------------------------------
// Хелперы — построение Update-объектов для тестов.
// ---------------------------------------------------------------------------

function makeUpdate(overrides: {
  update_id?: number;
  message?: Partial<NonNullable<Update['message']>>;
}): Update {
  const { update_id = 1, message } = overrides;
  if (message === undefined) return { update_id };
  return {
    update_id,
    message: {
      message_id: message.message_id ?? 42,
      date: message.date ?? 1_000_000,
      chat: message.chat ?? { id: '-100123' },
      from: message.from,
      text: message.text,
    },
  };
}

const TEST_CHANNEL: TgChannelConfig = {
  id: 'support',
  chatId: '-100123',
  purpose: 'support chat',
  botKeychainService: 'ai-cofounder.example-project.tg.support',
};

const SINCE_MS = 900_000 * 1000; // 900_000 секунд в ms — чуть раньше date=1_000_000

// ---------------------------------------------------------------------------
// parseUpdatesToMessages — чистые тесты без сети.
// ---------------------------------------------------------------------------

describe('parseUpdatesToMessages', () => {
  it('апдейт с правильным chatId и датой >= since попадает в результат', () => {
    const updates: Update[] = [
      makeUpdate({
        update_id: 1,
        message: { chat: { id: '-100123' }, date: 1_000_000, text: 'hello' },
      }),
    ];

    const result = parseUpdatesToMessages(updates, {
      chatId: '-100123',
      sinceMs: SINCE_MS,
      limit: 100,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe('hello');
  });

  it('апдейт с правильным chatId но датой < since не попадает', () => {
    const updates: Update[] = [
      makeUpdate({
        update_id: 1,
        message: { chat: { id: '-100123' }, date: 800_000, text: 'old msg' },
      }),
    ];

    const result = parseUpdatesToMessages(updates, {
      chatId: '-100123',
      sinceMs: SINCE_MS,
      limit: 100,
    });

    expect(result).toHaveLength(0);
  });

  it('апдейт с чужим chatId не попадает', () => {
    const updates: Update[] = [
      makeUpdate({
        update_id: 1,
        message: { chat: { id: '-999999' }, date: 1_000_000, text: 'spy msg' },
      }),
    ];

    const result = parseUpdatesToMessages(updates, {
      chatId: '-100123',
      sinceMs: SINCE_MS,
      limit: 100,
    });

    expect(result).toHaveLength(0);
  });

  it('апдейт без message (update.message undefined) не попадает', () => {
    const updates: Update[] = [
      { update_id: 1 }, // нет message
    ];

    const result = parseUpdatesToMessages(updates, {
      chatId: '-100123',
      sinceMs: SINCE_MS,
      limit: 100,
    });

    expect(result).toHaveLength(0);
  });

  it('лимит: 10 апдейтов, limit=3 → возвращает 3', () => {
    const updates: Update[] = Array.from({ length: 10 }, (_, i) =>
      makeUpdate({
        update_id: i + 1,
        message: { chat: { id: '-100123' }, date: 1_000_000 + i, text: `msg ${i}` },
      }),
    );

    const result = parseUpdatesToMessages(updates, {
      chatId: '-100123',
      sinceMs: SINCE_MS,
      limit: 3,
    });

    expect(result).toHaveLength(3);
  });

  it('TelegramMessage корректно маппится: text, fromUserId, fromUsername, date', () => {
    const updates: Update[] = [
      makeUpdate({
        update_id: 7,
        message: {
          message_id: 55,
          chat: { id: '-100123' },
          date: 1_234_567,
          text: 'test text',
          from: { id: 12345, username: 'alice' },
        },
      }),
    ];

    const result = parseUpdatesToMessages(updates, {
      chatId: '-100123',
      sinceMs: 0,
      limit: 100,
    });

    expect(result).toHaveLength(1);
    const msg = result[0];
    expect(msg).toBeDefined();
    expect(msg!.messageId).toBe(55);
    expect(msg!.chatId).toBe('-100123');
    expect(msg!.text).toBe('test text');
    expect(msg!.fromUserId).toBe(12345);
    expect(msg!.fromUsername).toBe('alice');
    expect(msg!.date).toBe(1_234_567);
  });

  it('апдейт с message без from (анонимный) → fromUserId=null, fromUsername=null', () => {
    const updates: Update[] = [
      makeUpdate({
        update_id: 8,
        message: {
          message_id: 56,
          chat: { id: '-100123' },
          date: 1_000_000,
          text: 'anon msg',
          // from отсутствует
        },
      }),
    ];

    const result = parseUpdatesToMessages(updates, {
      chatId: '-100123',
      sinceMs: SINCE_MS,
      limit: 100,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.fromUserId).toBeNull();
    expect(result[0]?.fromUsername).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// projectTelegramRead — DI-тесты (без реального Keychain / grammy).
// ---------------------------------------------------------------------------

describe('projectTelegramRead', () => {
  it('keytar возвращает null → TelegramToolError', async () => {
    const opts: TelegramReadOptions = {
      channel: TEST_CHANNEL,
      sinceMs: SINCE_MS,
      keychainOverride: {
        getPassword: async () => null,
      },
    };

    await expect(projectTelegramRead(opts)).rejects.toThrow(TelegramToolError);
    await expect(projectTelegramRead(opts)).rejects.toThrow(
      "credentials для бота channel '-100123' не найдены в Keychain",
    );
  });

  it('botApiOverride используется вместо grammy, возвращает отфильтрованные сообщения', async () => {
    const mockUpdates: Update[] = [
      makeUpdate({
        update_id: 1,
        message: {
          message_id: 10,
          chat: { id: '-100123' },
          date: 1_000_000,
          text: 'привет',
          from: { id: 777, username: 'founder' },
        },
      }),
      // Чужой chatId — не должен попасть
      makeUpdate({
        update_id: 2,
        message: {
          message_id: 11,
          chat: { id: '-999' },
          date: 1_000_001,
          text: 'spy',
        },
      }),
    ];

    const opts: TelegramReadOptions = {
      channel: TEST_CHANNEL,
      sinceMs: SINCE_MS,
      limit: 10,
      keychainOverride: {
        getPassword: async () => 'fake-token',
      },
      botApiOverride: {
        getUpdates: async () => mockUpdates,
      },
    };

    const result = await projectTelegramRead(opts);

    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe('привет');
    expect(result[0]?.chatId).toBe('-100123');
    expect(result[0]?.fromUsername).toBe('founder');
  });

  it('limit применяется через botApiOverride', async () => {
    const mockUpdates: Update[] = Array.from({ length: 20 }, (_, i) =>
      makeUpdate({
        update_id: i + 1,
        message: {
          message_id: i + 100,
          chat: { id: '-100123' },
          date: 1_000_000 + i,
          text: `msg ${i}`,
        },
      }),
    );

    const opts: TelegramReadOptions = {
      channel: TEST_CHANNEL,
      sinceMs: SINCE_MS,
      limit: 5,
      keychainOverride: {
        getPassword: async () => 'fake-token',
      },
      botApiOverride: {
        getUpdates: async () => mockUpdates,
      },
    };

    const result = await projectTelegramRead(opts);
    expect(result).toHaveLength(5);
  });

  it('апдейт с датой < since не попадает через botApiOverride', async () => {
    const mockUpdates: Update[] = [
      makeUpdate({
        update_id: 1,
        message: {
          message_id: 10,
          chat: { id: '-100123' },
          date: 100, // очень старый
          text: 'too old',
        },
      }),
    ];

    const opts: TelegramReadOptions = {
      channel: TEST_CHANNEL,
      sinceMs: SINCE_MS,
      keychainOverride: {
        getPassword: async () => 'fake-token',
      },
      botApiOverride: {
        getUpdates: async () => mockUpdates,
      },
    };

    const result = await projectTelegramRead(opts);
    expect(result).toHaveLength(0);
  });
});
