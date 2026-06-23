// Тесты bridge/agents-write.ts (create/update/delete agents/<id>/) на DI —
// без dist и реального FS. serializer и parseAgentFolder берём настоящие из src,
// fs подменяем in-memory: проверяем и контракт записи, и сквозную валидацию.

import { describe, expect, it } from 'vitest';
import {
  type AgentCreateInput,
  type AgentWriteDeps,
  AgentWriteError,
  createAgent,
  deleteAgent,
  updateAgent,
} from '../bridge/agents-write.js';
import { parseAgentFolder } from '../src/routines/agent-loader.js';
import {
  applyAgentMdPatch,
  serializeAgentMd,
  serializePermissions,
} from '../src/routines/agent-serializer.js';

const AGENTS_ROOT = '/repo/agents';

function baseDeps(
  over: Partial<AgentWriteDeps> = {},
): AgentWriteDeps & { fs: Record<string, string> } {
  const fs: Record<string, string> = {};
  const deps: AgentWriteDeps = {
    cwd: '/repo',
    agentsRoot: AGENTS_ROOT,
    serializeAgentMd: serializeAgentMd as unknown as AgentWriteDeps['serializeAgentMd'],
    applyAgentMdPatch: applyAgentMdPatch as unknown as AgentWriteDeps['applyAgentMdPatch'],
    serializePermissions: serializePermissions as unknown as AgentWriteDeps['serializePermissions'],
    parseAgentFolder: parseAgentFolder as unknown as AgentWriteDeps['parseAgentFolder'],
    getRoutine: async () => null,
    dirExists: async () => false,
    fileExists: async (p: string) => fs[p] !== undefined,
    readFileFn: async (p: string) => {
      if (fs[p] === undefined) throw new Error(`ENOENT ${p}`);
      return fs[p];
    },
    writeFileAtomic: async (p: string, c: string) => {
      fs[p] = c;
    },
    mkdirp: async () => {},
    rmrf: async (p: string) => {
      for (const k of Object.keys(fs)) if (k === p || k.startsWith(`${p}/`)) delete fs[k];
    },
    ...over,
  };
  return Object.assign(deps, { fs });
}

const CREATE: AgentCreateInput = {
  id: 'seo-analyst',
  displayName: 'SEO Analyst',
  description: 'Анализирует выдачу и предлагает темы.',
  prompt: 'Сделай SEO-аудит сайта и предложи 10 тем.',
  model: 'claude-haiku-4-5',
  enabled: false,
  trigger: 'manual',
  outputType: 'journal-only',
  maxTokens: 8000,
  timeoutMs: 600000,
};

describe('createAgent', () => {
  it('пишет AGENT.md + prompt.md, агент парсится обратно', async () => {
    const deps = baseDeps();
    const res = await createAgent(CREATE, deps);
    expect(res.ok).toBe(true);
    expect(res.agentDir).toBe(`${AGENTS_ROOT}/seo-analyst`);
    expect(deps.fs[`${AGENTS_ROOT}/seo-analyst/AGENT.md`]).toMatch(/displayName: SEO Analyst/);
    expect(deps.fs[`${AGENTS_ROOT}/seo-analyst/prompt.md`]).toMatch(/SEO-аудит/);
    expect(deps.fs[`${AGENTS_ROOT}/seo-analyst/permissions.yml`]).toBeUndefined();
  });

  it('tools → permissions.yml', async () => {
    const deps = baseDeps();
    await createAgent({ ...CREATE, tools: ['project.read'], bashWhitelist: ['git log'] }, deps);
    const perms = deps.fs[`${AGENTS_ROOT}/seo-analyst/permissions.yml`];
    expect(perms).toMatch(/tools:/);
    expect(perms).toMatch(/project\.read/);
    expect(perms).toMatch(/bash:/);
  });

  it('невалидный id → 400', async () => {
    await expect(createAgent({ ...CREATE, id: 'SEO_Analyst' }, baseDeps())).rejects.toMatchObject({
      status: 400,
    });
  });

  it('дубль id (getRoutine не null) → 409', async () => {
    const deps = baseDeps({
      getRoutine: async () => ({ id: 'seo-analyst', filePath: '/x', agentDir: '/x' }),
    });
    await expect(createAgent(CREATE, deps)).rejects.toMatchObject({ status: 409 });
  });

  it('папка уже есть → 409', async () => {
    const deps = baseDeps({ dirExists: async () => true });
    await expect(createAgent(CREATE, deps)).rejects.toMatchObject({ status: 409 });
  });

  it('пустой prompt → валидация 400 (parseAgentFolder отвергает)', async () => {
    await expect(createAgent({ ...CREATE, prompt: '   ' }, baseDeps())).rejects.toBeInstanceOf(
      AgentWriteError,
    );
  });
});

describe('updateAgent', () => {
  async function seeded(): Promise<AgentWriteDeps & { fs: Record<string, string> }> {
    const deps = baseDeps(); // getRoutine→null, чтобы create прошёл
    await createAgent(CREATE, deps); // заполнит fs
    // После создания агент «существует» — update/delete должны его находить.
    deps.getRoutine = async (id: string) => ({
      id,
      filePath: `${AGENTS_ROOT}/${id}/AGENT.md`,
      agentDir: `${AGENTS_ROOT}/${id}`,
    });
    return deps;
  }

  it('меняет model/enabled, AGENT.md переписан', async () => {
    const deps = await seeded();
    await updateAgent('seo-analyst', { model: 'claude-opus-4-8', enabled: true }, deps);
    const md = deps.fs[`${AGENTS_ROOT}/seo-analyst/AGENT.md`];
    expect(md).toMatch(/model: claude-opus-4-8/);
    expect(md).toMatch(/enabled: true/);
  });

  it('patch.prompt переписывает prompt.md', async () => {
    const deps = await seeded();
    await updateAgent('seo-analyst', { prompt: 'Новая инструкция агента.' }, deps);
    expect(deps.fs[`${AGENTS_ROOT}/seo-analyst/prompt.md`]).toMatch(/Новая инструкция/);
  });

  it('tools добавляет permissions.yml; пустой массив удаляет', async () => {
    const deps = await seeded();
    await updateAgent('seo-analyst', { tools: ['project.grep'] }, deps);
    expect(deps.fs[`${AGENTS_ROOT}/seo-analyst/permissions.yml`]).toMatch(/project\.grep/);
    await updateAgent('seo-analyst', { tools: [] }, deps);
    expect(deps.fs[`${AGENTS_ROOT}/seo-analyst/permissions.yml`]).toBeUndefined();
  });

  it('частичный сбой записи откатывает к оригиналу [D1-1]', async () => {
    const deps = await seeded();
    const origMd = deps.fs[`${AGENTS_ROOT}/seo-analyst/AGENT.md`];
    const origPrompt = deps.fs[`${AGENTS_ROOT}/seo-analyst/prompt.md`];
    // Падаем на записи prompt.md (второй файл) — AGENT.md уже записан, должен откатиться.
    deps.writeFileAtomic = async (p: string, c: string) => {
      if (p.endsWith('prompt.md')) throw new Error('disk full');
      deps.fs[p] = c;
    };
    await expect(
      updateAgent('seo-analyst', { displayName: 'Новое', prompt: 'новый промпт' }, deps),
    ).rejects.toMatchObject({ status: 400 });
    expect(deps.fs[`${AGENTS_ROOT}/seo-analyst/AGENT.md`]).toBe(origMd);
    expect(deps.fs[`${AGENTS_ROOT}/seo-analyst/prompt.md`]).toBe(origPrompt);
  });

  it('не найден → 404', async () => {
    await expect(updateAgent('nope', { enabled: true }, baseDeps())).rejects.toMatchObject({
      status: 404,
    });
  });

  it('legacy routine (без agentDir) → 400', async () => {
    const deps = baseDeps({
      getRoutine: async (id: string) => ({ id, filePath: `/repo/routines/${id}.md` }),
    });
    await expect(updateAgent('x', { enabled: true }, deps)).rejects.toMatchObject({ status: 400 });
  });
});

describe('deleteAgent', () => {
  it('сносит папку', async () => {
    const deps = baseDeps(); // getRoutine→null для create
    await createAgent(CREATE, deps);
    expect(deps.fs[`${AGENTS_ROOT}/seo-analyst/AGENT.md`]).toBeDefined();
    deps.getRoutine = async (id: string) => ({
      id,
      filePath: `${AGENTS_ROOT}/${id}/AGENT.md`,
      agentDir: `${AGENTS_ROOT}/${id}`,
    });
    await deleteAgent('seo-analyst', deps);
    expect(deps.fs[`${AGENTS_ROOT}/seo-analyst/AGENT.md`]).toBeUndefined();
  });

  it('legacy routine → 400', async () => {
    const deps = baseDeps({
      getRoutine: async (id: string) => ({ id, filePath: `/repo/routines/${id}.md` }),
    });
    await expect(deleteAgent('x', deps)).rejects.toMatchObject({ status: 400 });
  });
});
