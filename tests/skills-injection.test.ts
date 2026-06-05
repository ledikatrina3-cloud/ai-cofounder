// Тесты skill-integration в routine runtime (Фаза 2 плана
// 2026-05-21-skills-architecture-v3).
//
// Стратегия:
//   * resolveSkillDeps замокан через ExecRoutineDeps.resolveSkillDeps —
//     никакого реального glob по skills/ + парсера. Тесты собирают
//     in-memory Skill[].
//   * runSubagent замокан — никакого реального SDK-вызова.
//   * loadProjectMap замокан — никакого FS.
//   * vi.mock на src/observe/bridge.js — проверяем emit'ы skill.loaded.
//
// Проверяем:
//   1. system prompt содержит discovery layer для каждого скилла.
//   2. body SKILL.md инжектится только для forceLoad-скиллов.
//   3. bashWhitelist объединяется (routine + skills).
//   4. extraSdkTools (Bash) добавляются если скилл требует.
//   5. maxStepsPerInvocation берёт минимум.
//   6. skill.loaded эмитится для каждого скилла с правильным mode.
//   7. forceLoad с именем не из skills → ошибка.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentRunResult } from '../src/llm/subagent.js';
import type { ProjectMap } from '../src/projects/map.js';
import type { ProjectMeta } from '../src/projects/registry.js';
import type { Routine } from '../src/routines/parser.js';
import type { ExecRoutineDeps } from '../src/routines/runtime.js';
import { executeRoutine, resolveRoutineSkills } from '../src/routines/runtime.js';
import type { Skill } from '../src/skills/types.js';

vi.mock('../src/observe/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/observe/bridge.js')>();
  return {
    ...actual,
    emit: vi.fn().mockResolvedValue(undefined),
  };
});

import { emit } from '../src/observe/bridge.js';

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
    description: 'Demo с скиллами',
    prompt: 'Сделай что-то.',
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

function makeSubagentResult(overrides: Partial<SubagentRunResult> = {}): SubagentRunResult {
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
    ...overrides,
  };
}

function makeSkill(name: string, overrides: Partial<Skill> = {}): Skill {
  return {
    name,
    description: `Skill ${name} description.`,
    prompt: `Body of ${name} skill (полная инструкция).`,
    filePath: `/abs/skills/${name}`,
    permissions: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveRoutineSkills — unit-тесты (без executeRoutine).
// ---------------------------------------------------------------------------

describe('resolveRoutineSkills', () => {
  it('skills=undefined → пустой результат', async () => {
    const routine = makeRoutine();
    const res = await resolveRoutineSkills(routine, async () => []);
    expect(res.resolvedSkills).toEqual([]);
    expect(res.bashWhitelistUnion).toBeNull();
    expect(res.extraSdkTools).toEqual([]);
    expect(res.maxSteps).toBeUndefined();
  });

  it('skills=[] → пустой результат (как undefined)', async () => {
    const routine = makeRoutine({ skills: [] });
    const res = await resolveRoutineSkills(routine, async () => []);
    expect(res.resolvedSkills).toEqual([]);
  });

  it('bashWhitelist union: routine + skills, дедуплицировано', async () => {
    const skillA = makeSkill('vc-publishing', {
      permissions: {
        bashWhitelist: ['pnpm exec tsx skills/vc-publishing/scripts/publish.ts'],
      },
    });
    const skillB = makeSkill('browser-control', {
      permissions: {
        bashWhitelist: ['pnpm exec tsx skills/browser-control/scripts/healthcheck.ts'],
      },
    });
    const routine = makeRoutine({
      skills: ['vc-publishing'],
      bashWhitelist: ['pnpm publish vc'],
    });
    const res = await resolveRoutineSkills(routine, async () => [skillB, skillA]);
    expect(res.bashWhitelistUnion).toEqual([
      'pnpm publish vc',
      'pnpm exec tsx skills/browser-control/scripts/healthcheck.ts',
      'pnpm exec tsx skills/vc-publishing/scripts/publish.ts',
    ]);
  });

  it('maxSteps: берёт минимум по всем скиллам', async () => {
    const skillA = makeSkill('a', { permissions: { maxStepsPerInvocation: 20 } });
    const skillB = makeSkill('b', { permissions: { maxStepsPerInvocation: 10 } });
    const skillC = makeSkill('c', { permissions: {} }); // не задан — не участвует в min
    const routine = makeRoutine({ skills: ['a', 'b', 'c'] });
    const res = await resolveRoutineSkills(routine, async () => [skillA, skillB, skillC]);
    expect(res.maxSteps).toBe(10);
  });

  it('maxSteps: ни один скилл не задал → undefined', async () => {
    const skill = makeSkill('a', { permissions: {} });
    const routine = makeRoutine({ skills: ['a'] });
    const res = await resolveRoutineSkills(routine, async () => [skill]);
    expect(res.maxSteps).toBeUndefined();
  });

  it('extraSdkTools: добавляет Bash если скилл требует, дедуплицировано', async () => {
    const skill = makeSkill('vc-publishing', {
      permissions: { requiredSdkTools: ['Bash', 'Read'] },
    });
    const routine = makeRoutine({ skills: ['vc-publishing'] });
    const res = await resolveRoutineSkills(routine, async () => [skill]);
    expect(res.extraSdkTools).toEqual(['Bash', 'Read']);
  });

  it('forceLoad с именем не из skills (после deps-резолва) → Error', async () => {
    const skill = makeSkill('vc-publishing');
    const routine = makeRoutine({
      skills: ['vc-publishing'],
      forceLoad: ['ghost-skill'],
    });
    await expect(resolveRoutineSkills(routine, async () => [skill])).rejects.toThrow(
      /forceLoad содержит 'ghost-skill'/,
    );
  });
});

// ---------------------------------------------------------------------------
// executeRoutine — integration с скиллами.
// ---------------------------------------------------------------------------

describe('executeRoutine — skill integration', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(emit).mockClear();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('discovery prompt содержит ## Skill: <name> для каждого скилла', async () => {
    const skillA = makeSkill('vc-publishing', { displayName: 'vc.ru Publisher', icon: '📝' });
    const skillB = makeSkill('browser-control', { displayName: 'Browser', icon: '🌐' });
    const mockRunSubagent = vi.fn().mockResolvedValue(makeSubagentResult());
    const deps: ExecRoutineDeps = {
      runSubagent: mockRunSubagent,
      loadProjectMap: async () => makeProjectMap(),
      resolveSkillDeps: async () => [skillB, skillA],
    };

    await executeRoutine(
      makeRoutine({ skills: ['vc-publishing'] }),
      makeProject(),
      '2026-05-21',
      deps,
    );

    const sp = mockRunSubagent.mock.calls[0]?.[0]?.systemPrompt as string;
    expect(sp).toContain('## Skill:');
    expect(sp).toContain('vc-publishing');
    expect(sp).toContain('browser-control');
    expect(sp).toContain('vc.ru Publisher');
    expect(sp).toContain('📝');
  });

  it('body SKILL.md (полная инструкция) только для forceLoad-скиллов', async () => {
    const skillA = makeSkill('vc-publishing');
    const skillB = makeSkill('browser-control');
    const mockRunSubagent = vi.fn().mockResolvedValue(makeSubagentResult());
    const deps: ExecRoutineDeps = {
      runSubagent: mockRunSubagent,
      loadProjectMap: async () => makeProjectMap(),
      resolveSkillDeps: async () => [skillB, skillA],
    };

    await executeRoutine(
      makeRoutine({ skills: ['vc-publishing'], forceLoad: ['vc-publishing'] }),
      makeProject(),
      '2026-05-21',
      deps,
    );

    const sp = mockRunSubagent.mock.calls[0]?.[0]?.systemPrompt as string;
    // forceLoad body — должен быть.
    expect(sp).toContain('Body of vc-publishing skill');
    // browser-control НЕ в forceLoad — body НЕ должен.
    expect(sp).not.toContain('Body of browser-control skill');
    // Discovery layer для обоих остаётся.
    expect(sp).toContain('## Skill:');
    expect(sp).toContain('browser-control');
  });

  it('bashWhitelist объединяется и используется в canUseTool', async () => {
    const skill = makeSkill('vc-publishing', {
      permissions: {
        bashWhitelist: ['pnpm exec tsx skills/vc-publishing/scripts/publish.ts'],
      },
    });
    const mockRunSubagent = vi.fn().mockResolvedValue(makeSubagentResult());
    const deps: ExecRoutineDeps = {
      runSubagent: mockRunSubagent,
      loadProjectMap: async () => makeProjectMap(),
      resolveSkillDeps: async () => [skill],
    };

    await executeRoutine(
      makeRoutine({
        tools: ['project.bash'],
        skills: ['vc-publishing'],
      }),
      makeProject(),
      '2026-05-21',
      deps,
    );

    const callOpts = mockRunSubagent.mock.calls[0]?.[0];
    expect(callOpts?.canUseTool).toBeDefined();
    // canUseTool должен пропускать skill-команду.
    const decision = await callOpts.canUseTool(
      'Bash',
      { command: 'pnpm exec tsx skills/vc-publishing/scripts/publish.ts foo --yes' },
      {},
    );
    expect(decision.behavior).toBe('allow');
    // А произвольную команду — не должна.
    const denyDecision = await callOpts.canUseTool('Bash', { command: 'rm -rf /' }, {});
    expect(denyDecision.behavior).toBe('deny');
  });

  it('maxStepsPerInvocation: минимум попадает в SubagentRunOptions.maxTurns', async () => {
    const skillA = makeSkill('a', { permissions: { maxStepsPerInvocation: 20 } });
    const skillB = makeSkill('b', { permissions: { maxStepsPerInvocation: 7 } });
    const mockRunSubagent = vi.fn().mockResolvedValue(makeSubagentResult());
    const deps: ExecRoutineDeps = {
      runSubagent: mockRunSubagent,
      loadProjectMap: async () => makeProjectMap(),
      resolveSkillDeps: async () => [skillA, skillB],
    };

    await executeRoutine(makeRoutine({ skills: ['a', 'b'] }), makeProject(), '2026-05-21', deps);

    expect(mockRunSubagent.mock.calls[0]?.[0]?.maxTurns).toBe(7);
  });

  it('maxStepsPerInvocation не задан → maxTurns=50 (default)', async () => {
    const skill = makeSkill('a', { permissions: {} });
    const mockRunSubagent = vi.fn().mockResolvedValue(makeSubagentResult());
    const deps: ExecRoutineDeps = {
      runSubagent: mockRunSubagent,
      loadProjectMap: async () => makeProjectMap(),
      resolveSkillDeps: async () => [skill],
    };

    await executeRoutine(makeRoutine({ skills: ['a'] }), makeProject(), '2026-05-21', deps);
    expect(mockRunSubagent.mock.calls[0]?.[0]?.maxTurns).toBe(50);
  });

  it('extraSdkTools: Bash добавляется автоматически, warning логируется', async () => {
    const skill = makeSkill('vc-publishing', {
      permissions: { requiredSdkTools: ['Bash'] },
    });
    const mockRunSubagent = vi.fn().mockResolvedValue(makeSubagentResult());
    const deps: ExecRoutineDeps = {
      runSubagent: mockRunSubagent,
      loadProjectMap: async () => makeProjectMap(),
      resolveSkillDeps: async () => [skill],
    };

    // routine.tools = [project.read] (нет project.bash).
    await executeRoutine(
      makeRoutine({ tools: ['project.read'], skills: ['vc-publishing'] }),
      makeProject(),
      '2026-05-21',
      deps,
    );

    const callOpts = mockRunSubagent.mock.calls[0]?.[0];
    expect(callOpts?.allowedTools).toContain('Read');
    expect(callOpts?.allowedTools).toContain('Bash');
    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnMessages).toContain('Bash');
  });

  it('эмитит skill.loaded для каждого резолвнутого скилла с правильным mode', async () => {
    const skillA = makeSkill('vc-publishing', { displayName: 'vc Publisher', icon: '📝' });
    const skillB = makeSkill('browser-control', { displayName: 'Browser', icon: '🌐' });
    const deps: ExecRoutineDeps = {
      runSubagent: vi.fn().mockResolvedValue(makeSubagentResult()),
      loadProjectMap: async () => makeProjectMap(),
      resolveSkillDeps: async () => [skillB, skillA],
    };

    await executeRoutine(
      makeRoutine({ skills: ['vc-publishing'], forceLoad: ['vc-publishing'] }),
      makeProject(),
      '2026-05-21',
      deps,
    );

    const skillLoadedCalls = vi
      .mocked(emit)
      .mock.calls.map(([ev]) => ev)
      .filter((e) => e.type === 'skill.loaded');
    expect(skillLoadedCalls).toHaveLength(2);
    const vcCall = skillLoadedCalls.find(
      (e) => e.type === 'skill.loaded' && e.skillName === 'vc-publishing',
    );
    const browserCall = skillLoadedCalls.find(
      (e) => e.type === 'skill.loaded' && e.skillName === 'browser-control',
    );
    expect(vcCall).toBeDefined();
    expect(browserCall).toBeDefined();
    if (vcCall?.type === 'skill.loaded') {
      expect(vcCall.mode).toBe('forceLoad');
      expect(vcCall.displayName).toBe('vc Publisher');
      expect(vcCall.icon).toBe('📝');
    }
    if (browserCall?.type === 'skill.loaded') {
      expect(browserCall.mode).toBe('discovery');
    }
  });

  it('routine без skills → нет skill.loaded и discovery-секции в prompt', async () => {
    const mockRunSubagent = vi.fn().mockResolvedValue(makeSubagentResult());
    const deps: ExecRoutineDeps = {
      runSubagent: mockRunSubagent,
      loadProjectMap: async () => makeProjectMap(),
    };

    await executeRoutine(makeRoutine(), makeProject(), '2026-05-21', deps);

    const skillLoadedCalls = vi
      .mocked(emit)
      .mock.calls.map(([ev]) => ev)
      .filter((e) => e.type === 'skill.loaded');
    expect(skillLoadedCalls).toHaveLength(0);
    const sp = mockRunSubagent.mock.calls[0]?.[0]?.systemPrompt as string;
    expect(sp).not.toContain('## Skill:');
    expect(sp).not.toContain('Доступные скиллы');
  });
});

// ---------------------------------------------------------------------------
// audit.routine.start.properties.skills — через dispatcher (mock executeRoutine).
// ---------------------------------------------------------------------------

describe('dispatcher → audit.routine.start.skills (Фаза 2 п.5)', () => {
  it('routine с skills → audit.routine.start.properties.skills содержит резолвнутые имена', async () => {
    // Импортируем dispatcher + isolated DB только для этого блока.
    const { runRoutine } = await import('../src/core/dispatcher.js');
    const { triggerManualRoutine } = await import('../src/core/triggers.js');
    const { createIsolatedDb, setupTemplateDb } = await import('./fixtures/isolated-db.js');

    const template = setupTemplateDb();
    const isolated = await createIsolatedDb(template);
    try {
      const skill = makeSkill('vc-publishing');
      const routine = makeRoutine({
        id: 'demo-with-skills',
        skills: ['vc-publishing'],
      });
      const project = makeProject();
      const trigger = triggerManualRoutine(routine.id);

      await runRoutine(routine.id, '2026-05-21', trigger, {
        db: isolated.prisma,
        getRoutine: async (id: string) => (id === routine.id ? routine : null),
        getProject: async (id: string) => (id === project.id ? project : null),
        execRoutineDeps: {
          resolveSkillDeps: async () => [skill],
        },
        executeRoutineImpl: async () => ({
          status: 'ok',
          output: '',
          totalUsd: 0,
          totalTokens: 0,
          durationMs: 1,
          toolCallCount: 0,
          spendRecordId: null,
        }),
      });

      const rows = await isolated.prisma.$queryRawUnsafe<Array<{ properties: string }>>(
        `SELECT properties FROM "Record" WHERE type = 'audit.routine.start'`,
      );
      expect(rows).toHaveLength(1);
      const props = JSON.parse(rows[0]?.properties ?? '{}') as { skills?: string[] };
      expect(props.skills).toEqual(['vc-publishing']);
    } finally {
      await isolated.dispose();
      template.dispose();
    }
  });
});
