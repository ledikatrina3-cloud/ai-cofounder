// Тесты для фазы 1.2 (routine parser + routine registry).
//
// Стратегия изоляции:
//   * Парсер тестируется через `parseRoutineSource(filePath, source)` — без
//     I/O, чисто на строках.
//   * Registry тестируется в tmpdir-cwd с fixture-файлами `config/projects.md`
//     и `routines/*.md`. Glob — реальный fast-glob через `cwd` (без моков),
//     чтобы тестировать настоящий resolve-path.
//   * pathExists прокидывается в registryOptions, чтобы projects-реестр не
//     зависел от наличия проекта на диске тестовой машины.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Routine, RoutineParseError, parseRoutineSource } from '../src/routines/parser.js';
import {
  RoutineRegistryError,
  getEnabledRoutines,
  getRoutine,
  getRoutinesByCron,
  listRoutines,
} from '../src/routines/registry.js';

// ---------------------------------------------------------------------------
// Fixture helpers — изолированный tmpdir на каждый тест.
// ---------------------------------------------------------------------------

interface Fixture {
  cwd: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const cwd = mkdtempSync(join(tmpdir(), 'routines-test-'));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function writeFile(cwd: string, relPath: string, content: string): void {
  const full = join(cwd, relPath);
  const dir = full.replace(/\/[^/]+$/, '');
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content, 'utf8');
}

const FAKE_PROJECT_PATH = '/fixture/example-project';
const PROJECTS_REGISTRY = `## example-project

- name: Acme Academy
- path: ${FAKE_PROJECT_PATH}
- enabled: true
- mapPath: projects/example-project/map.md
- routinesGlob: routines/example-project-*.md
`;

function makeRoutineSource(overrides: Partial<Record<string, string>> = {}): string {
  const fields: Record<string, string> = {
    id: 'example-noop',
    projectId: 'example-project',
    enabled: 'true',
    trigger: 'manual',
    tools: '[]',
    model: 'claude-sonnet-4-6',
    maxTokens: '100000',
    timeoutMs: '300000',
    outputType: 'journal-only',
    description: 'Пустая routine для тестов',
    ...overrides,
  };
  const lines = [
    '---',
    ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`),
    '---',
    '',
    '# Промт',
    '',
    'Ты — пустая routine. Верни `ok`.',
  ];
  return lines.join('\n');
}

// pathExists-стаб для projects-registry: считает все переданные пути существующими.
function makePathExists(existing: Set<string>) {
  return async (p: string) => existing.has(p);
}

// ---------------------------------------------------------------------------
// parser: happy path.
// ---------------------------------------------------------------------------

describe('parseRoutineSource — happy path', () => {
  it('парсит валидный routine целиком', () => {
    const src = makeRoutineSource();
    const r: Routine = parseRoutineSource('/abs/routines/x.md', src);

    expect(r).toMatchObject({
      id: 'example-noop',
      projectId: 'example-project',
      enabled: true,
      trigger: 'manual',
      tools: [],
      model: 'claude-sonnet-4-6',
      maxTokens: 100000,
      timeoutMs: 300000,
      outputType: 'journal-only',
      description: 'Пустая routine для тестов',
      filePath: '/abs/routines/x.md',
    });
    expect(r.prompt).toMatch(/Ты — пустая routine/);
  });

  it('парсит cron-trigger и непустой tools-массив', () => {
    const src = makeRoutineSource({
      trigger: '0 7 * * *',
      tools: '[project.read, project.grep]',
      outputType: 'telegram-thread',
    });
    const r = parseRoutineSource('/abs/routines/y.md', src);
    expect(r.trigger).toBe('0 7 * * *');
    expect(r.tools).toEqual(['project.read', 'project.grep']);
    expect(r.outputType).toBe('telegram-thread');
  });

  it('парсит 6-полевой cron (с секундами)', () => {
    const src = makeRoutineSource({ trigger: '*/30 * * * * *' });
    const r = parseRoutineSource('/abs/routines/z.md', src);
    expect(r.trigger).toBe('*/30 * * * * *');
  });

  it('парсит опциональные UI-поля (role/avatar/color), если они есть', () => {
    const src = makeRoutineSource({
      role: 'Утренний детектив',
      avatar: '🕵️',
      color: '#a8e063',
    });
    const r = parseRoutineSource('/abs/routines/x.md', src);
    expect(r.role).toBe('Утренний детектив');
    expect(r.avatar).toBe('🕵️');
    expect(r.color).toBe('#a8e063');
  });

  it('routine без UI-полей парсится как раньше (поля undefined)', () => {
    const src = makeRoutineSource();
    const r = parseRoutineSource('/abs/routines/x.md', src);
    expect(r.role).toBeUndefined();
    expect(r.avatar).toBeUndefined();
    expect(r.color).toBeUndefined();
  });

  it('парсит bashWhitelist если задан', () => {
    const src = makeRoutineSource({
      tools: '[project.bash]',
      bashWhitelist: '["pnpm publish vc", "pnpm publish dzen"]',
    });
    const r = parseRoutineSource('/abs/routines/x.md', src);
    expect(r.bashWhitelist).toEqual(['pnpm publish vc', 'pnpm publish dzen']);
  });

  it('routine без bashWhitelist → поле undefined (бэкомпат)', () => {
    const src = makeRoutineSource();
    const r = parseRoutineSource('/abs/routines/x.md', src);
    expect(r.bashWhitelist).toBeUndefined();
  });

  it('bashWhitelist=[] парсится в пустой массив (но runtime трактует как «не задано»)', () => {
    const src = makeRoutineSource({ bashWhitelist: '[]' });
    const r = parseRoutineSource('/abs/routines/x.md', src);
    expect(r.bashWhitelist).toEqual([]);
  });

  // Фаза 2 плана 2026-05-21-skills-architecture-v3 — skills + forceLoad поля.
  it('парсит skills + forceLoad если заданы', () => {
    const src = makeRoutineSource({
      skills: '[vc-publishing, browser-control]',
      forceLoad: '[vc-publishing]',
    });
    const r = parseRoutineSource('/abs/routines/x.md', src);
    expect(r.skills).toEqual(['vc-publishing', 'browser-control']);
    expect(r.forceLoad).toEqual(['vc-publishing']);
  });

  it('routine без skills/forceLoad → поля undefined (бэкомпат)', () => {
    const src = makeRoutineSource();
    const r = parseRoutineSource('/abs/routines/x.md', src);
    expect(r.skills).toBeUndefined();
    expect(r.forceLoad).toBeUndefined();
  });

  it('skills=[] парсится в пустой массив (отличается от undefined)', () => {
    const src = makeRoutineSource({ skills: '[]' });
    const r = parseRoutineSource('/abs/routines/x.md', src);
    expect(r.skills).toEqual([]);
  });

  it('skills с пробелом в имени → RoutineParseError', () => {
    const src = makeRoutineSource({ skills: '[good, "bad name"]' });
    expect(() => parseRoutineSource('/abs/x.md', src)).toThrow(/'skills'.*'bad name'/);
  });

  it('forceLoad с пустым элементом → RoutineParseError', () => {
    const src = makeRoutineSource({ forceLoad: '[good, ""]' });
    expect(() => parseRoutineSource('/abs/x.md', src)).toThrow(/'forceLoad'/);
  });
});

// ---------------------------------------------------------------------------
// parser: validation errors.
// ---------------------------------------------------------------------------

describe('parseRoutineSource — ошибки валидации', () => {
  it('файл без frontmatter delimiter → ошибка', () => {
    expect(() => parseRoutineSource('/abs/x.md', 'no frontmatter here\n# body')).toThrow(
      RoutineParseError,
    );
  });

  it('frontmatter без закрывающего --- → ошибка', () => {
    expect(() => parseRoutineSource('/abs/x.md', '---\nid: x\n# no close')).toThrow(
      /не найден закрывающий/,
    );
  });

  it('кривая строка во frontmatter (без двоеточия) → ошибка', () => {
    const src = '---\nid: x\nbroken-line\n---\n\nbody\n';
    expect(() => parseRoutineSource('/abs/x.md', src)).toThrow(/ожидалось 'ключ: значение'/);
  });

  it('отсутствует обязательное поле id → ошибка с указанием поля', () => {
    const src = makeRoutineSource({ id: undefined as unknown as string });
    // Удаляем id явно — overrides не позволяет, делаем вручную.
    const noId = src.replace(/^id: .*\n/m, '');
    expect(() => parseRoutineSource('/abs/x.md', noId)).toThrow(/обязательное поле 'id'/);
  });

  it('отсутствует tools → ошибка', () => {
    const src = makeRoutineSource();
    const noTools = src.replace(/^tools: .*\n/m, '');
    expect(() => parseRoutineSource('/abs/x.md', noTools)).toThrow(/обязательное поле 'tools'/);
  });

  it('invalid outputType → RoutineParseError с указанием поля', () => {
    const src = makeRoutineSource({ outputType: 'something-weird' });
    expect(() => parseRoutineSource('/abs/x.md', src)).toThrow(/'outputType'/);
  });

  it('invalid trigger (не manual и не cron) → ошибка с упоминанием cron-parser', () => {
    const src = makeRoutineSource({ trigger: 'every-day-please' });
    expect(() => parseRoutineSource('/abs/x.md', src)).toThrow(
      /'trigger'.*manual.*cron-expression/,
    );
  });

  it('пустой body → ошибка', () => {
    const src = [
      '---',
      ...Object.entries({
        id: 'x',
        projectId: 'example-project',
        enabled: 'true',
        trigger: 'manual',
        tools: '[]',
        model: 'claude-sonnet-4-6',
        maxTokens: '100',
        timeoutMs: '1000',
        outputType: 'journal-only',
        description: 'd',
      }).map(([k, v]) => `${k}: ${v}`),
      '---',
      '',
      '',
    ].join('\n');
    expect(() => parseRoutineSource('/abs/x.md', src)).toThrow(
      /body \(промт\) не должен быть пустым/,
    );
  });

  it('enabled со странным значением → ошибка', () => {
    const src = makeRoutineSource({ enabled: 'maybe' });
    expect(() => parseRoutineSource('/abs/x.md', src)).toThrow(/'enabled'.*'true' или 'false'/);
  });

  it('maxTokens не положительное число → ошибка', () => {
    const src = makeRoutineSource({ maxTokens: '0' });
    expect(() => parseRoutineSource('/abs/x.md', src)).toThrow(/'maxTokens'.*положительным/);
  });

  it('model без поддерживаемого префикса → ошибка', () => {
    const src = makeRoutineSource({ model: 'gpt-4o' });
    expect(() => parseRoutineSource('/abs/x.md', src)).toThrow(/'model'.*'claude-' или 'voyage-'/);
  });

  it('tools с пробелом в имени → ошибка', () => {
    const src = makeRoutineSource({ tools: '[good, "bad name"]' });
    expect(() => parseRoutineSource('/abs/x.md', src)).toThrow(/имя tool 'bad name'/);
  });
});

// ---------------------------------------------------------------------------
// registry: listRoutines / getRoutine.
// ---------------------------------------------------------------------------

describe('listRoutines + getRoutine', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
    writeFile(fx.cwd, 'config/projects.md', PROJECTS_REGISTRY);
  });

  afterEach(() => fx.cleanup());

  it('возвращает массив с одной routine, parsed корректно', async () => {
    writeFile(fx.cwd, 'routines/example-project-example-noop.md', makeRoutineSource());

    const list = await listRoutines({
      cwd: fx.cwd,
      projectRegistryOptions: {
        cwd: fx.cwd,
        pathExists: makePathExists(new Set([FAKE_PROJECT_PATH])),
      },
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('example-noop');
    expect(list[0]?.filePath).toMatch(/routines\/example-project-example-noop\.md$/);
  });

  it('getRoutine возвращает null для неизвестного id', async () => {
    writeFile(fx.cwd, 'routines/example-project-example-noop.md', makeRoutineSource());
    const r = await getRoutine('nope', {
      cwd: fx.cwd,
      projectRegistryOptions: {
        cwd: fx.cwd,
        pathExists: makePathExists(new Set([FAKE_PROJECT_PATH])),
      },
    });
    expect(r).toBeNull();
  });

  it('дубль routine.id → RoutineRegistryError', async () => {
    writeFile(fx.cwd, 'routines/example-project-a.md', makeRoutineSource({ id: 'dup' }));
    writeFile(fx.cwd, 'routines/example-project-b.md', makeRoutineSource({ id: 'dup' }));
    await expect(
      listRoutines({
        cwd: fx.cwd,
        projectRegistryOptions: {
          cwd: fx.cwd,
          pathExists: makePathExists(new Set([FAKE_PROJECT_PATH])),
        },
      }),
    ).rejects.toBeInstanceOf(RoutineRegistryError);
  });

  it('routine с projectId, не совпадающим с проектом-владельцем → RoutineRegistryError', async () => {
    // Файл лежит в glob-папке example-project, но projectId='unknown'.
    writeFile(
      fx.cwd,
      'routines/example-project-stray.md',
      makeRoutineSource({ projectId: 'unknown' }),
    );
    await expect(
      listRoutines({
        cwd: fx.cwd,
        projectRegistryOptions: {
          cwd: fx.cwd,
          pathExists: makePathExists(new Set([FAKE_PROJECT_PATH])),
        },
      }),
    ).rejects.toThrow(/projectId='unknown'/);
  });
});

// ---------------------------------------------------------------------------
// registry: getEnabledRoutines.
// ---------------------------------------------------------------------------

describe('getEnabledRoutines', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
    writeFile(fx.cwd, 'config/projects.md', PROJECTS_REGISTRY);
  });

  afterEach(() => fx.cleanup());

  it('исключает routine.enabled=false', async () => {
    writeFile(fx.cwd, 'routines/example-project-on.md', makeRoutineSource({ id: 'on' }));
    writeFile(
      fx.cwd,
      'routines/example-project-off.md',
      makeRoutineSource({ id: 'off', enabled: 'false' }),
    );
    const list = await getEnabledRoutines({
      cwd: fx.cwd,
      projectRegistryOptions: {
        cwd: fx.cwd,
        pathExists: makePathExists(new Set([FAKE_PROJECT_PATH])),
      },
    });
    expect(list.map((r) => r.id)).toEqual(['on']);
  });

  it('исключает routine, чей проект динамически disabled (нет path)', async () => {
    writeFile(fx.cwd, 'routines/example-project-on.md', makeRoutineSource({ id: 'on' }));
    const list = await getEnabledRoutines({
      cwd: fx.cwd,
      projectRegistryOptions: {
        cwd: fx.cwd,
        pathExists: makePathExists(new Set()), // path не существует → enabled=false
        warn: () => {}, // подавить warning в тесте
      },
    });
    expect(list).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// registry: getRoutinesByCron.
// ---------------------------------------------------------------------------

describe('getRoutinesByCron', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
    writeFile(fx.cwd, 'config/projects.md', PROJECTS_REGISTRY);
  });

  afterEach(() => fx.cleanup());

  it('возвращает только cron-trigger routines из enabled-набора', async () => {
    writeFile(
      fx.cwd,
      'routines/example-project-manual.md',
      makeRoutineSource({ id: 'manual-r', trigger: 'manual' }),
    );
    writeFile(
      fx.cwd,
      'routines/example-project-cron.md',
      makeRoutineSource({ id: 'cron-r', trigger: '0 7 * * *' }),
    );
    writeFile(
      fx.cwd,
      'routines/example-project-cron-disabled.md',
      makeRoutineSource({
        id: 'cron-disabled',
        trigger: '0 8 * * *',
        enabled: 'false',
      }),
    );

    const list = await getRoutinesByCron({
      cwd: fx.cwd,
      projectRegistryOptions: {
        cwd: fx.cwd,
        pathExists: makePathExists(new Set([FAKE_PROJECT_PATH])),
      },
    });
    expect(list.map((r) => r.id)).toEqual(['cron-r']);
  });
});
