// Тесты org-knowledge injection в routine runtime (Фаза 3 плана
// 2026-05-21-skills-architecture-v3).
//
// Стратегия:
//   * Мокаем executeRoutine через DI: resolveSkillDeps возвращает фейковые
//     Skill[], getOrg возвращает фейковый OrgKnowledge.
//   * Проверяем system prompt, который executeRoutine передаёт в runSubagent.
//
// Покрываем:
//   1. Skill категории writing → блок «## Org knowledge» в prompt.
//   2. Skill категории publishing → блок НЕ инжектируется (не подходит категория).
//   3. org/ отсутствует (getOrg бросает) → silently skip, прогон без падения.
//   4. Несколько скиллов разных категорий — блок инжектируется один раз.
//   5. product-knowledge + examples упоминаются в блоке, если есть.
//   6. buildOrgKnowledgeSection — unit-тест pure-функции.

import { describe, expect, it, vi } from 'vitest';
import type { SubagentRunResult } from '../src/llm/subagent.js';
import { OrgParseError } from '../src/org/parser.js';
import type { OrgKnowledge } from '../src/org/types.js';
import type { ProjectMap } from '../src/projects/map.js';
import type { ProjectMeta } from '../src/projects/registry.js';
import type { Routine } from '../src/routines/parser.js';
import type { ExecRoutineDeps } from '../src/routines/runtime.js';
import {
  buildOrgKnowledgeSection,
  executeRoutine,
  loadOrgIfNeeded,
} from '../src/routines/runtime.js';
import type { Skill } from '../src/skills/types.js';

// Мокаем observe/bridge как в skills-injection.test.ts — emit не должен
// падать без поднятого bridge.
vi.mock('../src/observe/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/observe/bridge.js')>();
  return {
    ...actual,
    emit: vi.fn().mockResolvedValue(undefined),
  };
});

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'demo-routine',
    projectId: 'example-project',
    enabled: true,
    trigger: 'manual',
    tools: ['project.read'],
    model: 'claude-sonnet-4-6',
    maxTokens: 4000,
    timeoutMs: 60_000,
    outputType: 'journal-only',
    description: 'Demo для org-injection',
    prompt: 'Сделай работу.',
    filePath: '/tmp/demo.md',
    ...overrides,
  };
}

function makeProject(): ProjectMeta {
  return {
    id: 'example-project',
    name: 'Acme Academy',
    path: '/tmp/proj',
    enabled: true,
    mapPath: 'projects/example-project/map.md',
    routinesGlob: 'routines/example-project-*.md',
  };
}

function makeProjectMap(): ProjectMap {
  return {
    description: 'тест',
    keyDirectories: [],
    keyFiles: [],
    dbConnections: [],
    telegramChannels: [],
    metricsEndpoints: [],
    notes: '',
  };
}

function makeSubagentResult(): SubagentRunResult {
  return {
    messages: [
      {
        type: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
      } as unknown as SubagentRunResult['messages'][number],
    ],
    result: {
      type: 'result',
      subtype: 'success',
      duration_ms: 10,
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0.001,
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    spendRecordId: 'sp',
    durationMs: 10,
    timedOut: false,
  };
}

function makeSkill(name: string, overrides: Partial<Skill> = {}): Skill {
  return {
    name,
    description: `Skill ${name} description.`,
    prompt: `Body of ${name} skill.`,
    filePath: `/abs/skills/${name}`,
    permissions: {},
    ...overrides,
  };
}

function makeOrg(overrides: Partial<OrgKnowledge> = {}): OrgKnowledge {
  return {
    identity: '# Кто мы\n\nМы строим X.',
    brandVoice: '# Тон\n\nПрямо и без воды.',
    audience: '# Аудитория\n\nСоло-фаундеры.',
    productKnowledge: '# Продукт\n\nLocal-first.',
    examplesDir: '/abs/org/examples',
    filePath: '/abs/org',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildOrgKnowledgeSection — pure unit-тесты.
// ---------------------------------------------------------------------------

describe('buildOrgKnowledgeSection', () => {
  it('skills включает writing → возвращает блок «## Org knowledge»', () => {
    const skills = [makeSkill('article-writing', { category: 'writing' })];
    const section = buildOrgKnowledgeSection(skills, makeOrg());
    expect(section).not.toBeNull();
    expect(section).toContain('## Org knowledge');
    expect(section).toContain('### Кто мы');
    expect(section).toContain('Мы строим X');
    expect(section).toContain('### Как мы звучим');
    expect(section).toContain('Прямо и без воды');
    expect(section).toContain('### Аудитория');
    expect(section).toContain('Соло-фаундеры');
  });

  it('skills включает research → возвращает блок', () => {
    const skills = [makeSkill('serp-research', { category: 'research' })];
    const section = buildOrgKnowledgeSection(skills, makeOrg());
    expect(section).not.toBeNull();
    expect(section).toContain('## Org knowledge');
  });

  it('skills только publishing → возвращает null (категория не подходит)', () => {
    const skills = [makeSkill('vc-publishing', { category: 'publishing' })];
    const section = buildOrgKnowledgeSection(skills, makeOrg());
    expect(section).toBeNull();
  });

  it('skills без category → возвращает null (не подходит)', () => {
    const skills = [makeSkill('mystery-skill')];
    const section = buildOrgKnowledgeSection(skills, makeOrg());
    expect(section).toBeNull();
  });

  it('product-knowledge=null → блок без упоминания product-knowledge.md', () => {
    const skills = [makeSkill('article-writing', { category: 'writing' })];
    const section = buildOrgKnowledgeSection(skills, makeOrg({ productKnowledge: null }));
    expect(section).not.toBeNull();
    expect(section).not.toContain('product-knowledge.md');
  });

  it('product-knowledge present → блок упоминает org/product-knowledge.md', () => {
    const skills = [makeSkill('article-writing', { category: 'writing' })];
    const section = buildOrgKnowledgeSection(skills, makeOrg());
    expect(section).toContain('org/product-knowledge.md');
  });

  it('examplesDir present → блок упоминает org/examples/', () => {
    const skills = [makeSkill('article-writing', { category: 'writing' })];
    const section = buildOrgKnowledgeSection(skills, makeOrg());
    expect(section).toContain('org/examples/');
  });

  it('examplesDir=null → блок без упоминания examples/', () => {
    const skills = [makeSkill('article-writing', { category: 'writing' })];
    const section = buildOrgKnowledgeSection(skills, makeOrg({ examplesDir: null }));
    expect(section).not.toContain('org/examples/');
  });

  it('mixed skills: writing + publishing → блок инжектируется один раз', () => {
    const skills = [
      makeSkill('vc-publishing', { category: 'publishing' }),
      makeSkill('article-writing', { category: 'writing' }),
    ];
    const section = buildOrgKnowledgeSection(skills, makeOrg());
    expect(section).not.toBeNull();
    // «## Org knowledge» встречается только один раз.
    const matches = (section ?? '').match(/## Org knowledge/g);
    expect(matches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// loadOrgIfNeeded — silently skip при ошибке getOrg.
// ---------------------------------------------------------------------------

describe('loadOrgIfNeeded', () => {
  it('нет writing/research скиллов → null без вызова getOrg', async () => {
    const getOrg = vi.fn();
    const result = await loadOrgIfNeeded(
      [makeSkill('vc-publishing', { category: 'publishing' })],
      getOrg,
    );
    expect(result).toBeNull();
    expect(getOrg).not.toHaveBeenCalled();
  });

  it('есть writing-скилл → вызывает getOrg, возвращает результат', async () => {
    const org = makeOrg();
    const getOrg = vi.fn().mockResolvedValue(org);
    const result = await loadOrgIfNeeded(
      [makeSkill('article-writing', { category: 'writing' })],
      getOrg,
    );
    expect(result).toBe(org);
    expect(getOrg).toHaveBeenCalledTimes(1);
  });

  it('getOrg бросает OrgParseError → null, warning в console', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const getOrg = vi.fn().mockRejectedValue(new OrgParseError('org/identity.md не найден'));
    const result = await loadOrgIfNeeded(
      [makeSkill('article-writing', { category: 'writing' })],
      getOrg,
    );
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// executeRoutine integration — org injects into system prompt.
// ---------------------------------------------------------------------------

describe('executeRoutine — org-knowledge integration', () => {
  it('skill категории writing → блок «## Org knowledge» в system prompt', async () => {
    const skill = makeSkill('article-writing', { category: 'writing' });
    const mockRunSubagent = vi.fn().mockResolvedValue(makeSubagentResult());
    const deps: ExecRoutineDeps = {
      runSubagent: mockRunSubagent,
      loadProjectMap: async () => makeProjectMap(),
      resolveSkillDeps: async () => [skill],
      getOrg: async () => makeOrg(),
    };

    await executeRoutine(
      makeRoutine({ skills: ['article-writing'] }),
      makeProject(),
      '2026-05-21',
      deps,
    );

    const sp = mockRunSubagent.mock.calls[0]?.[0]?.systemPrompt as string;
    expect(sp).toContain('## Org knowledge');
    expect(sp).toContain('Мы строим X');
    expect(sp).toContain('Соло-фаундеры');
  });

  it('skill категории publishing → блок НЕ инжектируется', async () => {
    const skill = makeSkill('vc-publishing', { category: 'publishing' });
    const mockRunSubagent = vi.fn().mockResolvedValue(makeSubagentResult());
    const getOrg = vi.fn().mockResolvedValue(makeOrg());
    const deps: ExecRoutineDeps = {
      runSubagent: mockRunSubagent,
      loadProjectMap: async () => makeProjectMap(),
      resolveSkillDeps: async () => [skill],
      getOrg,
    };

    await executeRoutine(
      makeRoutine({ skills: ['vc-publishing'] }),
      makeProject(),
      '2026-05-21',
      deps,
    );

    const sp = mockRunSubagent.mock.calls[0]?.[0]?.systemPrompt as string;
    expect(sp).not.toContain('## Org knowledge');
    // И getOrg не должен был вызываться — экономим IO.
    expect(getOrg).not.toHaveBeenCalled();
  });

  it('org/ отсутствует (getOrg бросает) → silently skip без падения', async () => {
    const skill = makeSkill('article-writing', { category: 'writing' });
    const mockRunSubagent = vi.fn().mockResolvedValue(makeSubagentResult());
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps: ExecRoutineDeps = {
      runSubagent: mockRunSubagent,
      loadProjectMap: async () => makeProjectMap(),
      resolveSkillDeps: async () => [skill],
      getOrg: async () => {
        throw new OrgParseError('org/ не найден');
      },
    };

    await expect(
      executeRoutine(
        makeRoutine({ skills: ['article-writing'] }),
        makeProject(),
        '2026-05-21',
        deps,
      ),
    ).resolves.toBeDefined();

    const sp = mockRunSubagent.mock.calls[0]?.[0]?.systemPrompt as string;
    expect(sp).not.toContain('## Org knowledge');
    warnSpy.mockRestore();
  });

  it('несколько скиллов разных категорий — блок один раз', async () => {
    const skills = [
      makeSkill('vc-publishing', { category: 'publishing' }),
      makeSkill('article-writing', { category: 'writing' }),
      makeSkill('serp-research', { category: 'research' }),
    ];
    const mockRunSubagent = vi.fn().mockResolvedValue(makeSubagentResult());
    const deps: ExecRoutineDeps = {
      runSubagent: mockRunSubagent,
      loadProjectMap: async () => makeProjectMap(),
      resolveSkillDeps: async () => skills,
      getOrg: async () => makeOrg(),
    };

    await executeRoutine(
      makeRoutine({ skills: ['vc-publishing', 'article-writing', 'serp-research'] }),
      makeProject(),
      '2026-05-21',
      deps,
    );

    const sp = mockRunSubagent.mock.calls[0]?.[0]?.systemPrompt as string;
    const matches = sp.match(/## Org knowledge/g);
    expect(matches).toHaveLength(1);
  });

  it('routine без skills → блок НЕ инжектируется', async () => {
    const mockRunSubagent = vi.fn().mockResolvedValue(makeSubagentResult());
    const getOrg = vi.fn().mockResolvedValue(makeOrg());
    const deps: ExecRoutineDeps = {
      runSubagent: mockRunSubagent,
      loadProjectMap: async () => makeProjectMap(),
      getOrg,
    };

    await executeRoutine(makeRoutine(), makeProject(), '2026-05-21', deps);

    const sp = mockRunSubagent.mock.calls[0]?.[0]?.systemPrompt as string;
    expect(sp).not.toContain('## Org knowledge');
    expect(getOrg).not.toHaveBeenCalled();
  });
});
