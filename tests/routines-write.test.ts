// Тесты bridge/routines-write.ts — CRUD-фасад routine'ов.
//
// DI: реальные serialize/parse из src/, in-memory fs/registry. dist не нужен.

import { describe, expect, it } from 'vitest';
import {
  type ProjectMetaLike,
  type RoutineCreateInput,
  type RoutineLike,
  type RoutineWriteDeps,
  createRoutine,
  deleteRoutine,
  globToRegExp,
  updateRoutine,
} from '../bridge/routines-write.js';
import { parseRoutineSource } from '../src/routines/parser.js';
import { applyRoutinePatch, serializeRoutine } from '../src/routines/serializer.js';

// serializeRoutine ждёт src-тип Routine (outputType сужен до union); в тестах
// удобнее RoutineLike — каст один раз.
const ser = serializeRoutine as unknown as (r: RoutineLike) => string;

const ROOT = '/repo';
const ROUTINES_ROOT = `${ROOT}/routines`;

const PROJECTS: ProjectMetaLike[] = [
  { id: 'example-project', routinesGlob: 'routines/example-project-*.md' },
  { id: 'content-team', routinesGlob: 'routines/content-team-*.md' },
];

function makeDeps(opts: {
  files?: Record<string, string>;
  routines?: RoutineLike[];
  projects?: ProjectMetaLike[];
}): { deps: RoutineWriteDeps; files: Record<string, string> } {
  const files: Record<string, string> = { ...(opts.files ?? {}) };
  const routines = opts.routines ?? [];
  const deps: RoutineWriteDeps = {
    cwd: ROOT,
    routinesRoot: ROUTINES_ROOT,
    serializeRoutine: serializeRoutine as (r: RoutineLike) => string,
    applyRoutinePatch,
    parseRoutineSource: parseRoutineSource as (f: string, s: string) => RoutineLike,
    listProjects: async () => opts.projects ?? PROJECTS,
    getRoutine: async (id) => routines.find((r) => r.id === id) ?? null,
    fileExists: async (p) => p in files,
    readFileFn: async (p) => {
      if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[p] as string;
    },
    writeFileAtomic: async (p, c) => {
      files[p] = c;
    },
    unlinkFn: async (p) => {
      delete files[p];
    },
  };
  return { deps, files };
}

const VALID_INPUT: RoutineCreateInput = {
  id: 'content-team-newbie',
  projectId: 'content-team',
  enabled: false,
  trigger: 'manual',
  tools: ['project.read'],
  model: 'claude-haiku-4-5',
  maxTokens: 4000,
  timeoutMs: 60000,
  outputType: 'journal-only',
  description: 'новый агент',
  prompt: 'Ты делаешь X.',
  skills: ['article-writing'],
};

describe('createRoutine', () => {
  it('создаёт валидный routine-файл, который парсится обратно', async () => {
    const { deps, files } = makeDeps({});
    const res = await createRoutine(VALID_INPUT, deps);
    expect(res.ok).toBe(true);
    expect(res.filePath).toBe(`${ROUTINES_ROOT}/content-team-newbie.md`);
    const written = files[res.filePath];
    expect(written).toBeDefined();
    const parsed = parseRoutineSource(res.filePath, written as string);
    expect(parsed.id).toBe('content-team-newbie');
    expect(parsed.projectId).toBe('content-team');
    expect(parsed.skills).toEqual(['article-writing']);
    expect(parsed.prompt).toBe('Ты делаешь X.');
  });

  it('отвергает не-kebab id', async () => {
    const { deps } = makeDeps({});
    await expect(createRoutine({ ...VALID_INPUT, id: 'Bad_Id' }, deps)).rejects.toThrow(/kebab/);
  });

  it('отвергает дубль id (409)', async () => {
    const existing = { ...VALID_INPUT, filePath: 'x' } as unknown as RoutineLike;
    const { deps } = makeDeps({ routines: [existing] });
    await expect(createRoutine(VALID_INPUT, deps)).rejects.toMatchObject({ status: 409 });
  });

  it('отвергает id, не матчащий ни один проектный glob', async () => {
    const { deps } = makeDeps({});
    await expect(
      createRoutine({ ...VALID_INPUT, id: 'orphan-agent', projectId: 'content-team' }, deps),
    ).rejects.toThrow(/невидим/);
  });

  it('отвергает projectId, не совпадающий с проектом по имени файла', async () => {
    const { deps } = makeDeps({});
    await expect(
      createRoutine({ ...VALID_INPUT, projectId: 'example-project' }, deps),
    ).rejects.toThrow(/должны совпадать/);
  });

  it('отвергает id, матчащий несколько проектов (ambiguous)', async () => {
    const ambiguous: ProjectMetaLike[] = [
      { id: 'foo', routinesGlob: 'routines/foo-*.md' },
      { id: 'foo-bar', routinesGlob: 'routines/foo-bar-*.md' },
    ];
    const { deps } = makeDeps({ projects: ambiguous });
    await expect(
      createRoutine({ ...VALID_INPUT, id: 'foo-bar-x', projectId: 'foo-bar' }, deps),
    ).rejects.toThrow(/несколько проектов/);
  });

  it('отвергает overwrite существующего файла (409)', async () => {
    const path = `${ROUTINES_ROOT}/content-team-newbie.md`;
    const { deps } = makeDeps({ files: { [path]: 'старое содержимое' } });
    await expect(createRoutine(VALID_INPUT, deps)).rejects.toMatchObject({ status: 409 });
  });

  it('отвергает невалидный cron (через parser-валидацию)', async () => {
    const { deps } = makeDeps({});
    await expect(
      createRoutine({ ...VALID_INPUT, trigger: 'каждый вторник' }, deps),
    ).rejects.toThrow(/валидация/);
  });
});

describe('updateRoutine', () => {
  function seedExisting(): { deps: RoutineWriteDeps; files: Record<string, string>; path: string } {
    const path = `${ROUTINES_ROOT}/content-team-newbie.md`;
    const source = ser({ ...VALID_INPUT, filePath: path } as RoutineLike);
    const routine = parseRoutineSource(path, source) as RoutineLike;
    const { deps, files } = makeDeps({ files: { [path]: source }, routines: [routine] });
    return { deps, files, path };
  }

  it('применяет патч и сохраняет валидным', async () => {
    const { deps, files, path } = seedExisting();
    const res = await updateRoutine(
      'content-team-newbie',
      { enabled: true, trigger: '0 9 * * *', model: 'claude-opus-4-7' },
      deps,
    );
    expect(res.ok).toBe(true);
    const parsed = parseRoutineSource(path, files[path] as string);
    expect(parsed.enabled).toBe(true);
    expect(parsed.trigger).toBe('0 9 * * *');
    expect(parsed.model).toBe('claude-opus-4-7');
    // Неизменённое сохранилось.
    expect(parsed.description).toBe('новый агент');
  });

  it('404 для несуществующего', async () => {
    const { deps } = makeDeps({});
    await expect(updateRoutine('nope', { enabled: true }, deps)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('отвергает патч с невалидным outputType', async () => {
    const { deps } = seedExisting();
    await expect(
      updateRoutine('content-team-newbie', { outputType: 'нет-такого' }, deps),
    ).rejects.toThrow(/валидация/);
  });
});

describe('deleteRoutine', () => {
  it('удаляет файл существующего routine', async () => {
    const path = `${ROUTINES_ROOT}/content-team-newbie.md`;
    const source = ser({ ...VALID_INPUT, filePath: path } as RoutineLike);
    const routine = parseRoutineSource(path, source) as RoutineLike;
    const { deps, files } = makeDeps({ files: { [path]: source }, routines: [routine] });
    const res = await deleteRoutine('content-team-newbie', deps);
    expect(res.ok).toBe(true);
    expect(path in files).toBe(false);
  });

  it('404 для несуществующего', async () => {
    const { deps } = makeDeps({});
    await expect(deleteRoutine('nope', deps)).rejects.toMatchObject({ status: 404 });
  });
});

describe('globToRegExp', () => {
  it('матчит проектный glob корректно', () => {
    const re = globToRegExp('routines/content-team-*.md');
    expect(re.test('routines/content-team-vc.md')).toBe(true);
    expect(re.test('routines/example-project-x.md')).toBe(false);
    expect(re.test('routines/content-team-a/b.md')).toBe(true); // * жадная — ок для нашего кейса
  });
});
