// Тесты для src/org/parser.ts.
//
// Стратегия: DI для read / exists. Никакого реального FS — собираем org/
// in-memory через Map<path, content>. Это держит тесты быстрыми и
// детерминированными.
//
// Покрываем (план 2026-05-21-skills-architecture-v3, Фаза 3 п.6):
//   1. Все 4 файла → корректный OrgKnowledge.
//   2. identity отсутствует → OrgParseError.
//   3. product-knowledge отсутствует → productKnowledge=null, OK.
//   4. examples/ существует/отсутствует → examplesDir заполняется/null.
//   5. Frontmatter сверху файла (если есть) — вырезается.
//   6. Пустой обязательный файл → OrgParseError.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OrgParseError, parseOrg } from '../src/org/parser.js';

// ---------------------------------------------------------------------------
// Helpers — mock FS.
// ---------------------------------------------------------------------------

interface MockFs {
  files: Map<string, string>;
  dirs: Set<string>;
}

function makeMockFs(): MockFs {
  return { files: new Map(), dirs: new Set() };
}

function makeReader(fs: MockFs) {
  return async (path: string): Promise<string> => {
    const content = fs.files.get(path);
    if (content === undefined) {
      const err = new Error(
        `ENOENT: no such file or directory, open '${path}'`,
      ) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return content;
  };
}

function makeExists(fs: MockFs) {
  return async (path: string): Promise<boolean> => fs.files.has(path) || fs.dirs.has(path);
}

const ORG_DIR = '/tmp/test-org';

function makeFullOrgFs(): MockFs {
  const fs = makeMockFs();
  fs.files.set(join(ORG_DIR, 'identity.md'), '# Кто мы\n\nМы строим X для Y.');
  fs.files.set(join(ORG_DIR, 'brand-voice.md'), '# Тон\n\nПрямо, без воды.');
  fs.files.set(join(ORG_DIR, 'audience.md'), '# Аудитория\n\nСоло-фаундеры.');
  fs.files.set(
    join(ORG_DIR, 'product-knowledge.md'),
    '# Продукт\n\nLocal-first приложение на маке.',
  );
  fs.dirs.add(join(ORG_DIR, 'examples'));
  return fs;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('parseOrg', () => {
  it('все 4 файла + examples/ → корректный OrgKnowledge', async () => {
    const fs = makeFullOrgFs();
    const org = await parseOrg(ORG_DIR, { read: makeReader(fs), exists: makeExists(fs) });

    expect(org.identity).toContain('Мы строим X для Y');
    expect(org.brandVoice).toContain('Прямо, без воды');
    expect(org.audience).toContain('Соло-фаундеры');
    expect(org.productKnowledge).toContain('Local-first приложение');
    expect(org.examplesDir).toBe(join(ORG_DIR, 'examples'));
    expect(org.filePath).toBe(ORG_DIR);
  });

  it('identity отсутствует → OrgParseError', async () => {
    const fs = makeFullOrgFs();
    fs.files.delete(join(ORG_DIR, 'identity.md'));

    await expect(
      parseOrg(ORG_DIR, { read: makeReader(fs), exists: makeExists(fs) }),
    ).rejects.toThrow(OrgParseError);
    await expect(
      parseOrg(ORG_DIR, { read: makeReader(fs), exists: makeExists(fs) }),
    ).rejects.toThrow(/identity\.md/);
  });

  it('brand-voice отсутствует → OrgParseError', async () => {
    const fs = makeFullOrgFs();
    fs.files.delete(join(ORG_DIR, 'brand-voice.md'));

    await expect(
      parseOrg(ORG_DIR, { read: makeReader(fs), exists: makeExists(fs) }),
    ).rejects.toThrow(/brand-voice\.md/);
  });

  it('audience отсутствует → OrgParseError', async () => {
    const fs = makeFullOrgFs();
    fs.files.delete(join(ORG_DIR, 'audience.md'));

    await expect(
      parseOrg(ORG_DIR, { read: makeReader(fs), exists: makeExists(fs) }),
    ).rejects.toThrow(/audience\.md/);
  });

  it('product-knowledge отсутствует → productKnowledge=null, остальное OK', async () => {
    const fs = makeFullOrgFs();
    fs.files.delete(join(ORG_DIR, 'product-knowledge.md'));

    const org = await parseOrg(ORG_DIR, { read: makeReader(fs), exists: makeExists(fs) });
    expect(org.productKnowledge).toBeNull();
    expect(org.identity).toContain('Мы строим X для Y');
  });

  it('examples/ отсутствует → examplesDir=null', async () => {
    const fs = makeFullOrgFs();
    fs.dirs.delete(join(ORG_DIR, 'examples'));

    const org = await parseOrg(ORG_DIR, { read: makeReader(fs), exists: makeExists(fs) });
    expect(org.examplesDir).toBeNull();
  });

  it('вырезает frontmatter если он есть в начале файла', async () => {
    const fs = makeFullOrgFs();
    fs.files.set(
      join(ORG_DIR, 'identity.md'),
      '---\nlastReviewed: 2026-05-21\n---\n\n# Кто мы\n\nReal content.',
    );

    const org = await parseOrg(ORG_DIR, { read: makeReader(fs), exists: makeExists(fs) });
    expect(org.identity).not.toContain('lastReviewed');
    expect(org.identity).toContain('# Кто мы');
    expect(org.identity).toContain('Real content');
  });

  it('файлы без frontmatter — возвращает body как есть (trimmed)', async () => {
    const fs = makeFullOrgFs();
    fs.files.set(join(ORG_DIR, 'identity.md'), '\n\n# Plain markdown\n\nNo frontmatter here.\n\n');

    const org = await parseOrg(ORG_DIR, { read: makeReader(fs), exists: makeExists(fs) });
    expect(org.identity).toBe('# Plain markdown\n\nNo frontmatter here.');
  });

  it('пустой обязательный файл → OrgParseError', async () => {
    const fs = makeFullOrgFs();
    fs.files.set(join(ORG_DIR, 'identity.md'), '   \n\n\n');

    await expect(
      parseOrg(ORG_DIR, { read: makeReader(fs), exists: makeExists(fs) }),
    ).rejects.toThrow(/пустой/);
  });
});
