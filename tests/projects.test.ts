// Тесты для фазы 1.1 (project registry + project map).
//
// Стратегия изоляции: каждый тест работает в собственном tmpdir-cwd с
// fixture-файлами `config/projects.md` и `projects/<id>/map.md`. БД не
// нужна — этот модуль только парсит markdown.
//
// Регрессия: этот модуль не должен сломать
//   * `tests/telegram.test.ts` (44 кейса фазы 1.2 — getAllowlist через
//     parsePageChatIds)
//   * `tests/telegram-support.test.ts` (фаза 2.1a — parsePageChatIds)
// Поэтому новый generic primitive `parsePageSections` живёт ОТДЕЛЬНО
// (`src/lib/page-sections.ts`), а старый `parsePageChatIds` остаётся в
// `src/telegram/secrets.ts` без правок.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectMapError, ProjectMapNotFound, loadProjectMap } from '../src/projects/map.js';
import {
  ProjectRegistryError,
  getEnabledProjects,
  getProject,
  listProjects,
} from '../src/projects/registry.js';

// ---------------------------------------------------------------------------
// Fixture helpers — каждый тест строит свой repo-снапшот в tmpdir и работает
// через `cwd`-опцию. Никаких глобальных мок-переменных.
// ---------------------------------------------------------------------------

interface Fixture {
  cwd: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const cwd = mkdtempSync(join(tmpdir(), 'projects-test-'));
  return {
    cwd,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

function writeFile(cwd: string, relPath: string, content: string): void {
  const full = join(cwd, relPath);
  const dir = full.replace(/\/[^/]+$/, '');
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content, 'utf8');
}

// pathExists-стаб: считает существующими все пути из набора `existing`.
function makePathExists(existing: Set<string>) {
  return async (p: string) => existing.has(p);
}

// Мини-реестр на один проект example-project с фейковым path.
const EXAMPLE_PATH = '/fixture/example-project';
const EXAMPLE_REGISTRY = `# Реестр

## example-project

- name: Acme Academy
- path: ${EXAMPLE_PATH}
- enabled: true
- mapPath: projects/example-project/map.md
- routinesGlob: routines/example-project-*.md
`;

const EXAMPLE_MAP = `# Карта Acme Academy

## description

Online-школа на Next.js + Prisma. Воркеры BullMQ для асинхронных задач.

## key-directories

- src/app: Next.js App Router
- src/lib: бизнес-логика
- prisma: схема БД и миграции

## key-files

- prisma/schema.prisma: ~99 моделей PostgreSQL
- src/workers/queue.ts: BullMQ-очереди

## db-connections

- id: example-project-prod
- driver: postgres
- keychainService: ai-cofounder.example-project.db
- description: production-БД (read-only)
- allowedTables: []
- queryTimeoutMs: 10000
- rowLimit: 1000

## telegram-channels

## notes

Когда подключим project.db.query — заполни allowedTables[].
`;

// ---------------------------------------------------------------------------
// listProjects + getProject — happy path.
// ---------------------------------------------------------------------------

describe('listProjects', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    fx.cleanup();
  });

  it('возвращает все проекты из config/projects.md', async () => {
    writeFile(fx.cwd, 'config/projects.md', EXAMPLE_REGISTRY);
    const list = await listProjects({
      cwd: fx.cwd,
      pathExists: makePathExists(new Set([EXAMPLE_PATH])),
    });
    // Синтетический built-in 'self' всегда присутствует (owner agents/<id>/);
    // тест проверяет парсинг ПОЛЬЗОВАТЕЛЬСКИХ проектов из config/projects.md.
    expect(list.some((p) => p.id === 'self')).toBe(true);
    const userProjects = list.filter((p) => p.id !== 'self');
    expect(userProjects).toHaveLength(1);
    expect(userProjects[0]).toEqual({
      id: 'example-project',
      name: 'Acme Academy',
      path: EXAMPLE_PATH,
      enabled: true,
      mapPath: 'projects/example-project/map.md',
      routinesGlob: 'routines/example-project-*.md',
    });
  });

  it('два проекта в одном реестре — оба видны в порядке секций', async () => {
    const md = `${EXAMPLE_REGISTRY}
## another

- name: Other
- path: /fixture/another
- enabled: false
- mapPath: projects/another/map.md
- routinesGlob: routines/another-*.md
`;
    writeFile(fx.cwd, 'config/projects.md', md);
    const list = await listProjects({
      cwd: fx.cwd,
      pathExists: makePathExists(new Set([EXAMPLE_PATH, '/fixture/another'])),
    });
    const userProjects = list.filter((p) => p.id !== 'self');
    expect(userProjects).toHaveLength(2);
    expect(userProjects[0]?.id).toBe('example-project');
    expect(userProjects[1]?.id).toBe('another');
    expect(userProjects[1]?.enabled).toBe(false);
  });

  it('отсутствует config/projects.md → только синтетический self (self-contained форк)', async () => {
    // projects.md опционален; форк без кросс-проектов его не имеет. Движок не падает,
    // отдаёт только built-in 'self' (owner agents/<id>/).
    const list = await listProjects({ cwd: fx.cwd, pathExists: async () => true });
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('self');
  });

  it('секция без обязательного поля name → ProjectRegistryError', async () => {
    writeFile(
      fx.cwd,
      'config/projects.md',
      `## broken

- path: /fixture/x
- enabled: true
- mapPath: projects/x/map.md
- routinesGlob: routines/x-*.md
`,
    );
    await expect(
      listProjects({ cwd: fx.cwd, pathExists: makePathExists(new Set(['/fixture/x'])) }),
    ).rejects.toThrow(/обязательное поле 'name'/);
  });

  it('enabled со странным значением → ProjectRegistryError', async () => {
    writeFile(
      fx.cwd,
      'config/projects.md',
      `## broken

- name: X
- path: /fixture/x
- enabled: maybe
- mapPath: projects/x/map.md
- routinesGlob: routines/x-*.md
`,
    );
    await expect(listProjects({ cwd: fx.cwd })).rejects.toThrow(/'true' или 'false'/);
  });

  it('path относительный → ProjectRegistryError', async () => {
    writeFile(
      fx.cwd,
      'config/projects.md',
      `## broken

- name: X
- path: relative/path
- enabled: true
- mapPath: projects/x/map.md
- routinesGlob: routines/x-*.md
`,
    );
    await expect(listProjects({ cwd: fx.cwd })).rejects.toThrow(/абсолютным путём/);
  });
});

describe('getProject', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
    writeFile(fx.cwd, 'config/projects.md', EXAMPLE_REGISTRY);
  });

  afterEach(() => {
    fx.cleanup();
  });

  it('возвращает корректный ProjectMeta для известного id', async () => {
    const p = await getProject('example-project', {
      cwd: fx.cwd,
      pathExists: makePathExists(new Set([EXAMPLE_PATH])),
    });
    expect(p).not.toBeNull();
    expect(p?.id).toBe('example-project');
    expect(p?.name).toBe('Acme Academy');
    expect(p?.enabled).toBe(true);
  });

  it('возвращает null для неизвестного id', async () => {
    const p = await getProject('unknown-project', {
      cwd: fx.cwd,
      pathExists: makePathExists(new Set([EXAMPLE_PATH])),
    });
    expect(p).toBeNull();
  });

  it('path физически отсутствует → enabled=false автоматически + warning', async () => {
    const warn = vi.fn();
    const p = await getProject('example-project', {
      cwd: fx.cwd,
      pathExists: makePathExists(new Set()), // пустой набор — ничего не существует
      warn,
    });
    expect(p).not.toBeNull();
    expect(p?.enabled).toBe(false);
    // example-project warn'ится; синтетический 'self' (path=resolve(cwd)) под этим
    // DI-pathExists (пустой набор) тоже warn'нётся, поэтому проверяем факт + текст
    // именно для example-project, а не точное число/порядок вызовов.
    const exampleWarn = warn.mock.calls.find((c) =>
      /\[projects\] проект 'example-project'/.test(String(c[0])),
    );
    expect(exampleWarn).toBeDefined();
    expect(String(exampleWarn?.[0])).toMatch(/graceful degradation/);
  });
});

describe('getEnabledProjects', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    fx.cleanup();
  });

  it('фильтрует по enabled (как в файле, так и динамическому)', async () => {
    const md = `${EXAMPLE_REGISTRY}
## disabled-in-file

- name: Off
- path: /fixture/off
- enabled: false
- mapPath: projects/off/map.md
- routinesGlob: routines/off-*.md

## missing-on-disk

- name: Missing
- path: /fixture/missing
- enabled: true
- mapPath: projects/missing/map.md
- routinesGlob: routines/missing-*.md
`;
    writeFile(fx.cwd, 'config/projects.md', md);
    const list = await getEnabledProjects({
      cwd: fx.cwd,
      pathExists: makePathExists(new Set([EXAMPLE_PATH, '/fixture/off'])),
      warn: () => {},
    });
    expect(list.map((p) => p.id)).toEqual(['example-project']);
  });
});

// ---------------------------------------------------------------------------
// loadProjectMap.
// ---------------------------------------------------------------------------

describe('loadProjectMap', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
    writeFile(fx.cwd, 'config/projects.md', EXAMPLE_REGISTRY);
  });

  afterEach(() => {
    fx.cleanup();
  });

  it('парсит карту Acme Academy', async () => {
    writeFile(fx.cwd, 'projects/example-project/map.md', EXAMPLE_MAP);
    const map = await loadProjectMap('example-project', {
      cwd: fx.cwd,
      registryOptions: { cwd: fx.cwd, pathExists: makePathExists(new Set([EXAMPLE_PATH])) },
    });

    expect(map.description).toMatch(/Online-школа на Next.js/);
    expect(map.keyDirectories).toEqual([
      { path: 'src/app', note: 'Next.js App Router' },
      { path: 'src/lib', note: 'бизнес-логика' },
      { path: 'prisma', note: 'схема БД и миграции' },
    ]);
    expect(map.keyFiles).toHaveLength(2);
    expect(map.keyFiles[0]?.path).toBe('prisma/schema.prisma');

    expect(map.dbConnections).toHaveLength(1);
    expect(map.dbConnections[0]).toMatchObject({
      id: 'example-project-prod',
      driver: 'postgres',
      keychainService: 'ai-cofounder.example-project.db',
      allowedTables: [],
      queryTimeoutMs: 10000,
      rowLimit: 1000,
    });

    expect(map.telegramChannels).toEqual([]);
    expect(map.metricsEndpoints).toEqual([]);
    expect(map.notes).toMatch(/allowedTables/);
  });

  it('файл карты отсутствует → ProjectMapNotFound', async () => {
    // Нет файла projects/example-project/map.md
    await expect(
      loadProjectMap('example-project', {
        cwd: fx.cwd,
        registryOptions: { cwd: fx.cwd, pathExists: makePathExists(new Set([EXAMPLE_PATH])) },
      }),
    ).rejects.toBeInstanceOf(ProjectMapNotFound);
  });

  it('проект отсутствует в реестре → ProjectMapError', async () => {
    await expect(
      loadProjectMap('not-in-registry', {
        cwd: fx.cwd,
        registryOptions: { cwd: fx.cwd, pathExists: makePathExists(new Set()), warn: () => {} },
      }),
    ).rejects.toThrow(/не найден в реестре/);
  });

  it('карта без обязательной секции description → ProjectMapError', async () => {
    const broken = EXAMPLE_MAP.replace(/## description[\s\S]*?(?=## key-directories)/, '');
    writeFile(fx.cwd, 'projects/example-project/map.md', broken);
    await expect(
      loadProjectMap('example-project', {
        cwd: fx.cwd,
        registryOptions: { cwd: fx.cwd, pathExists: makePathExists(new Set([EXAMPLE_PATH])) },
      }),
    ).rejects.toThrow(/обязательная секция '## description'/);
  });

  it('db-connections с невалидным driver → ProjectMapError', async () => {
    const broken = EXAMPLE_MAP.replace('driver: postgres', 'driver: oracle');
    writeFile(fx.cwd, 'projects/example-project/map.md', broken);
    await expect(
      loadProjectMap('example-project', {
        cwd: fx.cwd,
        registryOptions: { cwd: fx.cwd, pathExists: makePathExists(new Set([EXAMPLE_PATH])) },
      }),
    ).rejects.toThrow(/driver 'oracle' не поддерживается/);
  });

  it('db-connections без обязательного поля keychainService → ProjectMapError', async () => {
    const broken = EXAMPLE_MAP.replace('- keychainService: ai-cofounder.example-project.db\n', '');
    writeFile(fx.cwd, 'projects/example-project/map.md', broken);
    await expect(
      loadProjectMap('example-project', {
        cwd: fx.cwd,
        registryOptions: { cwd: fx.cwd, pathExists: makePathExists(new Set([EXAMPLE_PATH])) },
      }),
    ).rejects.toThrow(/keychainService/);
  });

  it('telegram-channels с непустыми записями парсится правильно', async () => {
    const withTg = EXAMPLE_MAP.replace(
      '## telegram-channels\n',
      `## telegram-channels

- id: support
- chatId: -100200300400
- purpose: support-чат клиентов
- botKeychainService: ai-cofounder.example-project.tg.support
`,
    );
    writeFile(fx.cwd, 'projects/example-project/map.md', withTg);
    const map = await loadProjectMap('example-project', {
      cwd: fx.cwd,
      registryOptions: { cwd: fx.cwd, pathExists: makePathExists(new Set([EXAMPLE_PATH])) },
    });
    expect(map.telegramChannels).toEqual([
      {
        id: 'support',
        chatId: '-100200300400',
        purpose: 'support-чат клиентов',
        botKeychainService: 'ai-cofounder.example-project.tg.support',
      },
    ]);
  });

  it('telegram-channels с невалидным chatId → ProjectMapError', async () => {
    const withBad = EXAMPLE_MAP.replace(
      '## telegram-channels\n',
      `## telegram-channels

- id: support
- chatId: not-a-number
- botKeychainService: ai-cofounder.example-project.tg.support
`,
    );
    writeFile(fx.cwd, 'projects/example-project/map.md', withBad);
    await expect(
      loadProjectMap('example-project', {
        cwd: fx.cwd,
        registryOptions: { cwd: fx.cwd, pathExists: makePathExists(new Set([EXAMPLE_PATH])) },
      }),
    ).rejects.toThrow(/chatId 'not-a-number'/);
  });

  it('явно переданный meta — не дёргает registry', async () => {
    writeFile(fx.cwd, 'projects/example-project/map.md', EXAMPLE_MAP);
    // Передаём cwd без config/projects.md — если бы registry читался,
    // упало бы с ProjectRegistryError.
    const fxNoRegistry = makeFixture();
    try {
      writeFile(fxNoRegistry.cwd, 'projects/example-project/map.md', EXAMPLE_MAP);
      const map = await loadProjectMap('example-project', {
        cwd: fxNoRegistry.cwd,
        meta: {
          id: 'example-project',
          name: 'Acme Academy',
          path: EXAMPLE_PATH,
          enabled: true,
          mapPath: 'projects/example-project/map.md',
          routinesGlob: 'routines/example-project-*.md',
        },
      });
      expect(map.description).toMatch(/Online-школа/);
    } finally {
      fxNoRegistry.cleanup();
    }
  });
});
