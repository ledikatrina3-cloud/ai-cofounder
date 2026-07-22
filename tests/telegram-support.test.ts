// Тесты для фазы 2.1a (support-bot pairing + Keychain + конфиг).
//
// Контракт, который тут пин'ится для фазы 2.1b:
//   * `getSupportBotToken(keychain?)` читает Keychain под service
//     'ai-cofounder.support-bot', account 'default'. Пусто → понятная ошибка
//     `SupportBotTokenMissingError` с инструкцией про `pnpm pair:support`.
//   * `getSupportSourceChatIds(io?, cwd?)` парсит секцию `## support-source`
//     из `config/support-source.md`. Файл отсутствует → `[]` (а не throw).
//   * `parsePageChatIds(md, section)` — generic primitive, переиспользует и
//     founder-bot и support-bot. На той же фикстуре, что allowlist'а — должен
//     работать (доказательство, что под капотом одна функция).
//   * `runPairing(deps, SUPPORT_PAIRING_CONFIG)` валидирует token+chatId,
//     зовёт saveToken и writeAllowlist с правильным channel ('support-source').
//   * `ensureSupportSourceEntry(chatId, cwd?)` идемпотентна (повторный pair с
//     тем же chat_id не дублирует строку).
//   * Biome rule `noProcessEnv` ловит `process.env.SUPPORT_BOT_TOKEN` в
//     `src/telegram/**` так же, как `TELEGRAM_BOT_TOKEN`.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import { SUPPORT_PAIRING_CONFIG, ensureSupportSourceEntry } from '../scripts/pair-support.js';
import { ensurePageEntry, runPairing, upsertChatId } from '../scripts/pair.js';
import {
  type KeychainGetter,
  type PageReader,
  SUPPORT_KEYTAR_SERVICE,
  SUPPORT_SOURCE_PATH,
  SUPPORT_SOURCE_SECTION,
  SupportBotTokenMissingError,
  getSupportBotToken,
  getSupportSourceChatIds,
  parsePageChatIds,
} from '../src/telegram/secrets.js';

const RUN_ID = ulid().slice(0, 8);

describe('SUPPORT constants — закреплённый контракт для фазы 2.1b', () => {
  it('keytar service фиксирован и отдельный от founder-bot', () => {
    expect(SUPPORT_KEYTAR_SERVICE).toBe('ai-cofounder.support-bot');
    // founder-bot — другой service, ротация одного токена не задевает другой.
    expect(SUPPORT_KEYTAR_SERVICE).not.toBe('ai-cofounder.tg-bot');
  });

  it('Page-путь и имя секции зафиксированы', () => {
    expect(SUPPORT_SOURCE_PATH).toBe('config/support-source.md');
    expect(SUPPORT_SOURCE_SECTION).toBe('support-source');
  });
});

describe('getSupportBotToken', () => {
  it('возвращает токен из Keychain', async () => {
    const mockKeychain: KeychainGetter = {
      getPassword: vi.fn(async () => 'fake-support-token-bbb'),
    };
    await expect(getSupportBotToken(mockKeychain)).resolves.toBe('fake-support-token-bbb');
    expect(mockKeychain.getPassword).toHaveBeenCalledWith('ai-cofounder.support-bot', 'default');
  });

  it('null из Keychain → SupportBotTokenMissingError с инструкцией про pnpm pair:support', async () => {
    const mockKeychain: KeychainGetter = { getPassword: async () => null };
    await expect(getSupportBotToken(mockKeychain)).rejects.toBeInstanceOf(
      SupportBotTokenMissingError,
    );
    await expect(getSupportBotToken(mockKeychain)).rejects.toThrow(/pnpm pair:support/);
  });

  it('пустая строка из Keychain — тоже missing', async () => {
    const mockKeychain: KeychainGetter = { getPassword: async () => '' };
    await expect(getSupportBotToken(mockKeychain)).rejects.toBeInstanceOf(
      SupportBotTokenMissingError,
    );
  });
});

describe('parsePageChatIds (generic primitive — общий с allowlist-ом)', () => {
  it('секция support-source с двумя id', () => {
    const md = `# заголовок

## support-source

- -100200300400 # support группа
- 555666 # личка VIP-клиента
`;
    expect(parsePageChatIds(md, 'support-source')).toEqual(['-100200300400', '555666']);
  });

  it('пустая секция → []', () => {
    const md = '## support-source\n';
    expect(parsePageChatIds(md, 'support-source')).toEqual([]);
  });

  it('запрос несуществующей секции → []', () => {
    const md = '## founder-bot\n\n- 1\n';
    expect(parsePageChatIds(md, 'support-source')).toEqual([]);
  });

  it('игнорирует строки списка вне секций', () => {
    const md = `- 99999

## support-source

- 42
`;
    expect(parsePageChatIds(md, 'support-source')).toEqual(['42']);
  });
});

describe('getSupportSourceChatIds (file IO)', () => {
  it('файл отсутствует → []', async () => {
    const io: PageReader = {
      read: () => {
        throw new Error('ENOENT');
      },
    };
    await expect(getSupportSourceChatIds(io, '/no/such/dir')).resolves.toEqual([]);
  });

  it('читает реальный config/support-source.md из репо', async () => {
    const list = await getSupportSourceChatIds();
    expect(Array.isArray(list)).toBe(true);
    for (const id of list) {
      expect(typeof id).toBe('string');
      expect(/^-?\d+$/.test(id)).toBe(true);
    }
  });
});

describe('runPairing с SUPPORT_PAIRING_CONFIG', () => {
  it('валидный токен и chat_id → saveToken и writeAllowlist вызваны с support-source', async () => {
    const saveToken = vi.fn(async () => {});
    const writeAllowlist = vi.fn(async () => {});

    await runPairing(
      {
        promptToken: async () => '987654321:zyxwvutsrqponmlkjihgfedcba9876543210',
        promptChatId: async () => '-100200300400',
        saveToken,
        writeAllowlist,
        log: () => {},
      },
      SUPPORT_PAIRING_CONFIG,
    );

    expect(saveToken).toHaveBeenCalledWith('987654321:zyxwvutsrqponmlkjihgfedcba9876543210');
    // КРИТИЧЕСКИ важно: канал — 'support-source', не 'support-bot' и не 'founder-bot'.
    // Это пин на контракт ensureSupportSourceEntry.
    expect(writeAllowlist).toHaveBeenCalledWith('support-source', '-100200300400');
  });

  it('тот же runPairing с дефолтным config (founder) пишет в founder-bot — regression', async () => {
    const saveToken = vi.fn(async () => {});
    const writeAllowlist = vi.fn(async () => {});

    await runPairing({
      promptToken: async () => '123456789:abcdefghijklmnopqrstuvwxyz0123456789',
      promptChatId: async () => '12345',
      saveToken,
      writeAllowlist,
      log: () => {},
    });

    // Дефолтный конфиг фазы 1.2 не сломан — критично для `pnpm pair`.
    expect(writeAllowlist).toHaveBeenCalledWith('founder-bot', '12345');
  });

  it('невалидный токен → бросает с инструкцией про @BotFather', async () => {
    await expect(
      runPairing(
        {
          promptToken: async () => 'not-a-token',
          promptChatId: async () => '-100200300400',
          saveToken: async () => {},
          writeAllowlist: async () => {},
          log: () => {},
        },
        SUPPORT_PAIRING_CONFIG,
      ),
    ).rejects.toThrow(/BotFather/);
  });
});

describe('ensureSupportSourceEntry (file write)', () => {
  it('создаёт config/support-source.md из шаблона и добавляет первый chat_id', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tg-support-'));
    try {
      await ensureSupportSourceEntry('-100200300400', tmp);
      const written = await readFile(join(tmp, 'config/support-source.md'), 'utf8');
      expect(parsePageChatIds(written, 'support-source')).toEqual(['-100200300400']);

      // Идемпотентность — повторный pair с тем же chat_id не дублирует.
      await ensureSupportSourceEntry('-100200300400', tmp);
      const second = await readFile(join(tmp, 'config/support-source.md'), 'utf8');
      expect(parsePageChatIds(second, 'support-source')).toEqual(['-100200300400']);

      // Добавление второго source-канала — оба видны.
      await ensureSupportSourceEntry('555666', tmp);
      const third = await readFile(join(tmp, 'config/support-source.md'), 'utf8');
      expect(parsePageChatIds(third, 'support-source')).toEqual(['-100200300400', '555666']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('ensurePageEntry (generic — для будущих каналов)', () => {
  it('создаёт произвольный Page по шаблону и добавляет в произвольную секцию', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tg-generic-'));
    try {
      await ensurePageEntry(
        'config/some-other-channel.md',
        'whatever-section',
        '777',
        '## whatever-section\n',
        tmp,
      );
      const written = await readFile(join(tmp, 'config/some-other-channel.md'), 'utf8');
      expect(parsePageChatIds(written, 'whatever-section')).toEqual(['777']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('upsertChatId — generic, не привязан к founder-bot', () => {
  it('работает с секцией support-source', () => {
    const md = '## support-source\n\n- 1\n';
    const out = upsertChatId(md, 'support-source', '2');
    expect(parsePageChatIds(out, 'support-source')).toEqual(['1', '2']);
  });

  it('создаёт отсутствующую секцию support-source', () => {
    const md = '# title\n';
    const out = upsertChatId(md, 'support-source', '-100');
    expect(parsePageChatIds(out, 'support-source')).toEqual(['-100']);
  });
});

describe('Biome rule noProcessEnv ловит process.env.SUPPORT_BOT_TOKEN в src/telegram/**', () => {
  it('временный src/telegram/__lint-fixture-support-X.ts с process.env.SUPPORT_BOT_TOKEN падает на biome check', () => {
    const fixturePath = join(process.cwd(), 'src/telegram', `__lint-fixture-support-${RUN_ID}.ts`);
    const fixture = `// @ts-nocheck
// fixture для проверки Biome rule noProcessEnv (SUPPORT_BOT_TOKEN). Удаляется тестом.
const t = process.env.SUPPORT_BOT_TOKEN;
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
      rmSync(fixturePath, { force: true });
    }
  }, 30_000);
});
