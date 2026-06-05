import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureAllowlistEntry, runPairing, upsertChatId } from '../scripts/pair.js';
import { assertSchemaInvariants } from '../src/db/invariants-check.js';
import type { BridgeEventInput } from '../src/observe/bridge.js';
import type { SecurityDenyInput } from '../src/telegram/audit.js';
import { allowlistMiddleware } from '../src/telegram/middleware.js';
import {
  type KeychainGetter,
  type ReadAllowlist,
  TelegramTokenMissingError,
  getAllowlist,
  getBotToken,
  parseAllowlist,
} from '../src/telegram/secrets.js';

// Уникальный префикс на прогон файла — изолирует записи audit.security.deny,
// которые этот тест пишет в общую dev.db (vitest singleFork). Фильтр по префиксу
// в countDenies — не зависит от других тестов и не делает DELETE.
const RUN_ID = ulid().slice(0, 8);
const TEST_TAG = `tg-test-${RUN_ID}`;

const db = new PrismaClient();

beforeAll(async () => {
  await db.$connect();
  await assertSchemaInvariants(db);
});

afterAll(async () => {
  await db.$disconnect();
});

async function countSecurityDenies(tag: string): Promise<number> {
  // properties — JSON-string. Фильтр по подстроке надёжен: tag уникален
  // достаточно, чтобы не пересечься с другими записями.
  const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n FROM "Record" WHERE type = 'audit.security.deny' AND properties LIKE ?`,
    `%${tag}%`,
  );
  return Number(rows[0]?.n ?? 0n);
}

describe('parseAllowlist', () => {
  it('пустая строка → пустой список', () => {
    expect(parseAllowlist('', 'founder-bot')).toEqual([]);
  });

  it('секция founder-bot с двумя id, секция support-bot с одним', () => {
    const md = `# title

## founder-bot

- 12345
- 67890 # @founder

## support-bot

- -100200 # group`;
    expect(parseAllowlist(md, 'founder-bot')).toEqual(['12345', '67890']);
    expect(parseAllowlist(md, 'support-bot')).toEqual(['-100200']);
  });

  it('пустая секция → []', () => {
    const md = `## founder-bot

## support-bot

- 11111`;
    expect(parseAllowlist(md, 'founder-bot')).toEqual([]);
    expect(parseAllowlist(md, 'support-bot')).toEqual(['11111']);
  });

  it('игнорирует строки списка вне секций и текстовые блоки', () => {
    const md = `текст
- 99999  ← это вне секции, не должен попасть

## founder-bot

текст внутри секции но не список
- 42

## other

- 1`;
    expect(parseAllowlist(md, 'founder-bot')).toEqual(['42']);
  });

  it('запрос несуществующего канала → []', () => {
    const md = '## founder-bot\n\n- 1';
    expect(parseAllowlist(md, 'no-such-channel')).toEqual([]);
  });
});

describe('getBotToken', () => {
  it('возвращает токен из Keychain', async () => {
    const mockKeychain: KeychainGetter = {
      getPassword: vi.fn(async () => 'fake-token-aaa'),
    };
    await expect(getBotToken(mockKeychain)).resolves.toBe('fake-token-aaa');
    expect(mockKeychain.getPassword).toHaveBeenCalledWith('ai-cofounder.tg-bot', 'default');
  });

  it('null из Keychain → TelegramTokenMissingError с инструкцией про pnpm pair', async () => {
    const mockKeychain: KeychainGetter = { getPassword: async () => null };
    await expect(getBotToken(mockKeychain)).rejects.toBeInstanceOf(TelegramTokenMissingError);
    await expect(getBotToken(mockKeychain)).rejects.toThrow(/pnpm pair/);
  });

  it('пустая строка из Keychain — тоже missing', async () => {
    const mockKeychain: KeychainGetter = { getPassword: async () => '' };
    await expect(getBotToken(mockKeychain)).rejects.toBeInstanceOf(TelegramTokenMissingError);
  });
});

describe('getAllowlist (file IO)', () => {
  it('файл отсутствует → []', async () => {
    const io: ReadAllowlist = {
      read: () => {
        throw new Error('ENOENT');
      },
    };
    await expect(getAllowlist('founder-bot', io, '/no/such/dir')).resolves.toEqual([]);
  });

  it('читает реальный config/allowlist.md из репо (формат стабильный)', async () => {
    // Не предполагаем содержимое — допускаем любые id, но проверяем тип.
    // Ловит регрессию формата шаблона allowlist.md.
    const list = await getAllowlist('founder-bot');
    expect(Array.isArray(list)).toBe(true);
    for (const id of list) {
      expect(typeof id).toBe('string');
      expect(/^-?\d+$/.test(id)).toBe(true);
    }
  });
});

describe('allowlistMiddleware (unit, без grammy long-poll)', () => {
  it('свой chat_id → next() вызван, recordDeny НЕ вызван, emit allow', async () => {
    const next = vi.fn<() => Promise<void>>(async () => {});
    const recordDeny = vi.fn<(input: SecurityDenyInput) => Promise<string>>(
      async () => 'should-not-be-called',
    );
    const emitEvent = vi.fn<(event: BridgeEventInput) => Promise<void>>(async () => {});

    const fn = allowlistMiddleware({
      allowlist: ['12345'],
      recordDeny,
      emitEvent,
    });

    await fn(
      {
        chat: { id: 12345 },
        from: { id: 999, username: 'founder' },
        message: { text: '/hello' },
      },
      next,
    );

    expect(next).toHaveBeenCalledOnce();
    expect(recordDeny).not.toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledOnce();
    const event = emitEvent.mock.calls[0]?.[0] as { type: string; chatId: string; command: string };
    expect(event.type).toBe('audit.security.allow');
    expect(event.chatId).toBe('12345');
    expect(event.command).toBe('/hello');
  });

  it('чужой chat_id → silent drop: next НЕ вызван, recordDeny вызван, emit deny с recordId', async () => {
    const next = vi.fn<() => Promise<void>>(async () => {});
    const recordDeny = vi.fn<(input: SecurityDenyInput) => Promise<string>>(
      async () => 'fake-deny-id-01',
    );
    const emitEvent = vi.fn<(event: BridgeEventInput) => Promise<void>>(async () => {});

    const fn = allowlistMiddleware({
      allowlist: ['12345'],
      recordDeny,
      emitEvent,
    });

    await fn(
      {
        chat: { id: 99999 },
        from: { id: 88888, username: 'stranger' },
        message: { text: '/hello' },
      },
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(recordDeny).toHaveBeenCalledOnce();
    expect(recordDeny.mock.calls[0]?.[0]).toEqual({
      chatId: '99999',
      userId: '88888',
      username: 'stranger',
      command: '/hello',
    });
    const event = emitEvent.mock.calls[0]?.[0] as {
      type: string;
      chatId: string | null;
      command: string;
      recordId: string;
    };
    expect(event.type).toBe('audit.security.deny');
    expect(event.chatId).toBe('99999');
    expect(event.recordId).toBe('fake-deny-id-01');
  });

  it('callback_query без message — command берётся из callbackQuery.data', async () => {
    const next = vi.fn<() => Promise<void>>(async () => {});
    const recordDeny = vi.fn<(input: SecurityDenyInput) => Promise<string>>(async () => 'x');
    const emitEvent = vi.fn<(event: BridgeEventInput) => Promise<void>>(async () => {});
    const fn = allowlistMiddleware({ allowlist: [], recordDeny, emitEvent });

    await fn(
      {
        chat: { id: 11111 },
        from: { id: 22222 },
        callbackQuery: { data: 'approve:01ABC' },
      },
      next,
    );

    expect(recordDeny.mock.calls[0]?.[0].command).toBe('approve:01ABC');
  });

  it('длинный текст обрезается до 64 символов с эллипсисом', async () => {
    const next = vi.fn<() => Promise<void>>(async () => {});
    const recordDeny = vi.fn<(input: SecurityDenyInput) => Promise<string>>(async () => 'x');
    const emitEvent = vi.fn<(event: BridgeEventInput) => Promise<void>>(async () => {});
    const fn = allowlistMiddleware({ allowlist: [], recordDeny, emitEvent });

    const longText = 'a'.repeat(80);
    await fn(
      {
        chat: { id: 1 },
        from: { id: 2 },
        message: { text: longText },
      },
      next,
    );

    const cmd = recordDeny.mock.calls[0]?.[0].command as string;
    expect(cmd.length).toBeLessThanOrEqual(65); // 64 + эллипсис
    expect(cmd).toContain('…');
  });
});

describe('allowlistMiddleware с реальным recordSecurityDeny → audit.security.deny в БД', () => {
  it('чужой chat_id создаёт audit.security.deny с правильным shape properties', async () => {
    const next = vi.fn<() => Promise<void>>(async () => {});
    const emitEvent = vi.fn<(event: BridgeEventInput) => Promise<void>>(async () => {});

    const before = await countSecurityDenies(TEST_TAG);

    // Используем реальный recordSecurityDeny — но через DI, чтобы pass'нуть тестовый Prisma-клиент.
    // import dynamic чтобы не порождать лишних импортов на верхнем уровне.
    const { recordSecurityDeny } = await import('../src/telegram/audit.js');
    const denyWithDb = (input: Parameters<typeof recordSecurityDeny>[0]) =>
      recordSecurityDeny(input, db);

    const fn = allowlistMiddleware({
      allowlist: ['this-is-not-the-chat'],
      recordDeny: denyWithDb,
      emitEvent,
    });

    // Уникальный chat_id и command, чтобы фильтровать по TEST_TAG в countSecurityDenies.
    const stranger = `99${RUN_ID.slice(0, 4)}`;
    await fn(
      {
        chat: { id: Number.parseInt(stranger, 36) || 12345 }, // any number works
        from: { id: 7777 },
        message: { text: `/hello-${TEST_TAG}` },
      },
      next,
    );

    const after = await countSecurityDenies(TEST_TAG);
    expect(after - before).toBe(1);
    expect(next).not.toHaveBeenCalled();

    // Проверим shape: properties JSON содержит chatId, userId, username, command.
    const rows = await db.$queryRawUnsafe<{ properties: string; type: string }[]>(
      `SELECT properties, type FROM "Record" WHERE type = 'audit.security.deny' AND properties LIKE ? ORDER BY createdAt DESC LIMIT 1`,
      `%${TEST_TAG}%`,
    );
    expect(rows.length).toBe(1);
    const props = JSON.parse(rows[0]!.properties) as Record<string, unknown>;
    expect(props.command).toContain(TEST_TAG);
    expect(typeof props.chatId).toBe('string');
    expect(props.userId).toBe('7777');
    expect(props.username).toBeNull();
  });
});

describe('upsertChatId (idempotent allowlist apply)', () => {
  it('пустая секция → добавляет первую запись', () => {
    const md = '## founder-bot\n\n## support-bot\n';
    const out = upsertChatId(md, 'founder-bot', '12345');
    expect(parseAllowlist(out, 'founder-bot')).toEqual(['12345']);
    // support-bot не тронули
    expect(parseAllowlist(out, 'support-bot')).toEqual([]);
  });

  it('секция уже содержит chat_id → markdown не меняется', () => {
    const md = '## founder-bot\n\n- 12345\n';
    const out = upsertChatId(md, 'founder-bot', '12345');
    expect(out).toBe(md);
  });

  it('новая секция, если канал отсутствует', () => {
    const md = '# title\n\n## founder-bot\n\n- 1\n';
    const out = upsertChatId(md, 'support-bot', '-100');
    expect(parseAllowlist(out, 'founder-bot')).toEqual(['1']);
    expect(parseAllowlist(out, 'support-bot')).toEqual(['-100']);
  });

  it('не дублирует и сохраняет порядок при добавлении нового id', () => {
    const md = '## founder-bot\n\n- 1\n- 2\n';
    const out = upsertChatId(md, 'founder-bot', '3');
    expect(parseAllowlist(out, 'founder-bot')).toEqual(['1', '2', '3']);
  });
});

describe('runPairing (DI, без реального Keychain / FS)', () => {
  it('валидный токен и chat_id → saveToken и writeAllowlist вызваны', async () => {
    const saveToken = vi.fn(async () => {});
    const writeAllowlist = vi.fn(async () => {});

    await runPairing({
      promptToken: async () => '123456789:abcdefghijklmnopqrstuvwxyz0123456789',
      promptChatId: async () => '12345',
      saveToken,
      writeAllowlist,
      log: () => {}, // silent
    });

    expect(saveToken).toHaveBeenCalledWith('123456789:abcdefghijklmnopqrstuvwxyz0123456789');
    expect(writeAllowlist).toHaveBeenCalledWith('founder-bot', '12345');
  });

  it('невалидный токен → бросает с инструкцией про @BotFather', async () => {
    await expect(
      runPairing({
        promptToken: async () => 'not-a-token',
        promptChatId: async () => '12345',
        saveToken: async () => {},
        writeAllowlist: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/BotFather/);
  });

  it('невалидный chat_id → бросает', async () => {
    await expect(
      runPairing({
        promptToken: async () => '123456789:abcdefghijklmnopqrstuvwxyz0123456789',
        promptChatId: async () => 'не-число',
        saveToken: async () => {},
        writeAllowlist: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/chat_id/);
  });
});

describe('ensureAllowlistEntry (file write)', () => {
  it('создаёт config/allowlist.md из шаблона и добавляет запись', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tg-allowlist-'));
    try {
      await ensureAllowlistEntry('founder-bot', '54321', tmp);
      const written = await readFile(join(tmp, 'config/allowlist.md'), 'utf8');
      expect(parseAllowlist(written, 'founder-bot')).toEqual(['54321']);
      // Идемпотентность
      await ensureAllowlistEntry('founder-bot', '54321', tmp);
      const second = await readFile(join(tmp, 'config/allowlist.md'), 'utf8');
      expect(parseAllowlist(second, 'founder-bot')).toEqual(['54321']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Biome rule noProcessEnv срабатывает на src/telegram/**', () => {
  // План фазы 1.2: «Проверь, что rule срабатывает на тестовом файле».
  // Создаём временный файл-фикстуру в src/telegram/, прогоняем biome, ожидаем
  // exit != 0 и упоминание noProcessEnv.
  it('временный src/telegram/__lint-fixture-process-env-X.ts с process.env.TELEGRAM_BOT_TOKEN ловится biome check', () => {
    const fixturePath = join(process.cwd(), 'src/telegram', `__lint-fixture-${RUN_ID}.ts`);
    const fixture = `// @ts-nocheck
// fixture для проверки Biome rule noProcessEnv. Удаляется тестом.
const t = process.env.TELEGRAM_BOT_TOKEN;
console.log(t);
`;

    try {
      writeFileSync(fixturePath, fixture, 'utf8');
      const out = spawnSync(
        'pnpm',
        ['exec', 'biome', 'check', '--no-errors-on-unmatched', fixturePath],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(out.status).not.toBe(0);
      const combined = `${out.stdout}\n${out.stderr}`;
      expect(combined).toMatch(/noProcessEnv/);
    } finally {
      // Чистим за собой, иначе следующий `pnpm build` увидит фикстуру и упадёт.
      rmSync(fixturePath, { force: true });
    }
  });

  it('тот же код в src/llm/ НЕ ловится (rule scope = src/telegram/**)', () => {
    const fixturePath = join(process.cwd(), 'src/llm', `__lint-fixture-${RUN_ID}.ts`);
    const fixture = `// @ts-nocheck
// fixture: process.env access вне src/telegram/ — rule НЕ должен сработать.
const t = process.env.SOME_OTHER_KEY;
console.log(t);
`;

    try {
      writeFileSync(fixturePath, fixture, 'utf8');
      const out = spawnSync(
        'pnpm',
        ['exec', 'biome', 'check', '--no-errors-on-unmatched', fixturePath],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      const combined = `${out.stdout}\n${out.stderr}`;
      // noProcessEnv не должен встречаться в выводе.
      expect(combined).not.toMatch(/noProcessEnv/);
    } finally {
      rmSync(fixturePath, { force: true });
    }
  }, 30_000);
});
