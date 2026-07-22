// Тесты routine runtime (фаза 3.1).
//
// Стратегия:
//   * runSubagent — DI через deps.runSubagent. Нет реального SDK-вызова.
//   * loadProjectMap — DI через deps.loadProjectMap. Нет FS-операций.
//   * db — DI через deps.db. Нет реальной БД (runSubagent замокан до того,
//     как используется db).
//   * resolveToolMappings — тестируется напрямую без DI (чистая функция).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentRunResult } from '../src/llm/subagent.js';
import type { ProjectMap } from '../src/projects/map.js';
import type { ProjectMeta } from '../src/projects/registry.js';
import type { Routine } from '../src/routines/parser.js';
import type { ExecRoutineDeps, RoutineResult } from '../src/routines/runtime.js';
import { executeRoutine } from '../src/routines/runtime.js';
import { resolveToolMappings } from '../src/routines/tool-registry.js';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'example-read-readme',
    projectId: 'example-project',
    enabled: true,
    trigger: 'manual',
    tools: ['project.read'],
    model: 'claude-sonnet-4-6',
    maxTokens: 4000,
    timeoutMs: 60_000,
    outputType: 'journal-only',
    description: 'Читает README.md проекта.',
    prompt: 'Прочитай README.md и верни первые 100 символов.',
    filePath: '/tmp/example-read-readme.md',
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectMeta> = {}): ProjectMeta {
  return {
    id: 'example-project',
    name: 'Acme Academy',
    path: '/tmp/fake-project',
    enabled: true,
    mapPath: 'projects/example-project/map.md',
    routinesGlob: 'routines/example-project-*.md',
    ...overrides,
  };
}

function makeProjectMap(overrides: Partial<ProjectMap> = {}): ProjectMap {
  return {
    description: 'Тестовый проект',
    keyDirectories: [{ path: 'src', note: 'исходники' }],
    keyFiles: [{ path: 'README.md', note: 'описание' }],
    dbConnections: [],
    telegramChannels: [],
    metricsEndpoints: [],
    notes: '',
    ...overrides,
  };
}

// Минимальный SubagentRunResult для моков.
function makeSubagentResult(overrides: Partial<SubagentRunResult> = {}): SubagentRunResult {
  return {
    messages: [
      {
        type: 'assistant',
        content: [{ type: 'text', text: 'Hello README' }],
      } as unknown as SubagentRunResult['messages'][number],
    ],
    result: {
      type: 'result',
      subtype: 'success',
      duration_ms: 100,
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0.01,
      usage: { inputTokens: 100, outputTokens: 10 },
    },
    spendRecordId: 'test-spend-id',
    durationMs: 100,
    timedOut: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Тест-кейс 7: resolveToolMappings — чистая функция, тестируем напрямую.
// ---------------------------------------------------------------------------

describe('resolveToolMappings', () => {
  it('project.read → Read, project.grep → Grep, unknown-tool → unsupported', () => {
    const result = resolveToolMappings(['project.read', 'project.grep', 'unknown-tool']);
    expect(result.sdkTools).toEqual(['Read', 'Grep']);
    expect(result.unsupportedTools).toHaveLength(1);
    expect(result.unsupportedTools[0]?.name).toBe('unknown-tool');
    expect(result.unsupportedTools[0]?.reason).toContain("неизвестный tool 'unknown-tool'");
  });

  it('project.db.query → unsupported (MCP reason)', () => {
    const result = resolveToolMappings(['project.db.query']);
    expect(result.sdkTools).toEqual([]);
    expect(result.unsupportedTools).toHaveLength(1);
    expect(result.unsupportedTools[0]?.name).toBe('project.db.query');
    expect(result.unsupportedTools[0]?.reason).toContain('MCP-server');
  });

  it('все SDK tools: project.read, project.grep, project.glob, project.bash', () => {
    const result = resolveToolMappings([
      'project.read',
      'project.grep',
      'project.glob',
      'project.bash',
    ]);
    expect(result.sdkTools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    expect(result.unsupportedTools).toHaveLength(0);
  });

  it('пустой массив → пусто', () => {
    const result = resolveToolMappings([]);
    expect(result.sdkTools).toEqual([]);
    expect(result.unsupportedTools).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Тесты executeRoutine с мокированным runSubagent + loadProjectMap.
// ---------------------------------------------------------------------------

describe('executeRoutine', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // Кейс 1: tools=['project.read'] → allowedTools=['Read'] передаётся в runSubagent.
  // canUseTool всегда определён (фаза 3.2): проверяет набор tools + Bash-whitelist.
  it("tools=['project.read'] → runSubagent вызывается с allowedTools=['Read']", async () => {
    const mockRunSubagent = vi.fn().mockResolvedValue(makeSubagentResult());
    const deps: ExecRoutineDeps = {
      runSubagent: mockRunSubagent,
      loadProjectMap: async () => makeProjectMap(),
    };

    await executeRoutine(
      makeRoutine({ tools: ['project.read'] }),
      makeProject(),
      '2026-05-02',
      deps,
    );

    expect(mockRunSubagent).toHaveBeenCalledOnce();
    const callOpts = mockRunSubagent.mock.calls[0]?.[0];
    expect(callOpts?.allowedTools).toEqual(['Read']);
    // canUseTool теперь всегда определён (фаза 3.2): security check + Bash-whitelist.
    expect(callOpts?.canUseTool).toBeDefined();
  });

  // Кейс 2: tools=['project.bash'] → allowedTools=['Bash'], canUseTool определён.
  it("tools=['project.bash'] → allowedTools=['Bash'], canUseTool определён", async () => {
    const mockRunSubagent = vi.fn().mockResolvedValue(makeSubagentResult());
    const deps: ExecRoutineDeps = {
      runSubagent: mockRunSubagent,
      loadProjectMap: async () => makeProjectMap(),
    };

    await executeRoutine(
      makeRoutine({ tools: ['project.bash'] }),
      makeProject(),
      '2026-05-02',
      deps,
    );

    const callOpts = mockRunSubagent.mock.calls[0]?.[0];
    expect(callOpts?.allowedTools).toEqual(['Bash']);
    expect(callOpts?.canUseTool).toBeDefined();
  });

  // Кейс 3: tools=['project.db.query'] → allowedTools=[], console.warn вызван.
  it("tools=['project.db.query'] → allowedTools=[], console.warn вызван", async () => {
    const mockRunSubagent = vi.fn().mockResolvedValue(makeSubagentResult());
    const deps: ExecRoutineDeps = {
      runSubagent: mockRunSubagent,
      loadProjectMap: async () => makeProjectMap(),
    };

    await executeRoutine(
      makeRoutine({ tools: ['project.db.query'] }),
      makeProject(),
      '2026-05-02',
      deps,
    );

    const callOpts = mockRunSubagent.mock.calls[0]?.[0];
    expect(callOpts?.allowedTools).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnMessages.some((m) => m.includes('project.db.query'))).toBe(true);
  });

  // Кейс 4: tools=['project.read', 'project.bash'] → allowedTools=['Read', 'Bash'].
  it("tools=['project.read', 'project.bash'] → allowedTools=['Read', 'Bash']", async () => {
    const mockRunSubagent = vi.fn().mockResolvedValue(makeSubagentResult());
    const deps: ExecRoutineDeps = {
      runSubagent: mockRunSubagent,
      loadProjectMap: async () => makeProjectMap(),
    };

    await executeRoutine(
      makeRoutine({ tools: ['project.read', 'project.bash'] }),
      makeProject(),
      '2026-05-02',
      deps,
    );

    const callOpts = mockRunSubagent.mock.calls[0]?.[0];
    expect(callOpts?.allowedTools).toEqual(['Read', 'Bash']);
  });

  // Кейс 5: result.is_error=false → RoutineResult.status='ok'.
  it('result.is_error=false → status=ok', async () => {
    const deps: ExecRoutineDeps = {
      runSubagent: vi.fn().mockResolvedValue(makeSubagentResult({ timedOut: false })),
      loadProjectMap: async () => makeProjectMap(),
    };

    const result = await executeRoutine(makeRoutine(), makeProject(), '2026-05-02', deps);
    expect(result.status).toBe('ok');
  });

  // Кейс 6: timedOut=true → RoutineResult.status='timeout'.
  it('timedOut=true → status=timeout', async () => {
    const deps: ExecRoutineDeps = {
      runSubagent: vi.fn().mockResolvedValue(makeSubagentResult({ timedOut: true, result: null })),
      loadProjectMap: async () => makeProjectMap(),
    };

    const result = await executeRoutine(makeRoutine(), makeProject(), '2026-05-02', deps);
    expect(result.status).toBe('timeout');
  });

  // Кейс 7 (часть): is_error=true → status='failed'.
  it('result.is_error=true → status=failed', async () => {
    const deps: ExecRoutineDeps = {
      runSubagent: vi.fn().mockResolvedValue(
        makeSubagentResult({
          result: {
            type: 'result',
            subtype: 'error',
            duration_ms: 100,
            is_error: true,
            num_turns: 1,
            total_cost_usd: 0.001,
            usage: { inputTokens: 10, outputTokens: 5 },
          },
        }),
      ),
      loadProjectMap: async () => makeProjectMap(),
    };

    const result = await executeRoutine(makeRoutine(), makeProject(), '2026-05-02', deps);
    expect(result.status).toBe('failed');
  });

  // Кейс 8: output берётся из последнего assistant message.
  it('output — текст из последнего assistant message', async () => {
    const deps: ExecRoutineDeps = {
      runSubagent: vi.fn().mockResolvedValue(makeSubagentResult()),
      loadProjectMap: async () => makeProjectMap(),
    };

    const result = await executeRoutine(makeRoutine(), makeProject(), '2026-05-02', deps);
    expect(result.output).toBe('Hello README');
  });

  // Кейс: spendRecordId передаётся из subagentResult.
  it('spendRecordId передаётся из subagentResult', async () => {
    const deps: ExecRoutineDeps = {
      runSubagent: vi
        .fn()
        .mockResolvedValue(makeSubagentResult({ spendRecordId: 'test-spend-id' })),
      loadProjectMap: async () => makeProjectMap(),
    };

    const result = await executeRoutine(makeRoutine(), makeProject(), '2026-05-02', deps);
    expect(result.spendRecordId).toBe('test-spend-id');
  });

  // Кейс: toolCallCount — подсчёт tool_use блоков.
  it('toolCallCount — считает tool_use блоки в messages', async () => {
    const messagesWithToolUse = [
      {
        type: 'assistant',
        content: [
          { type: 'tool_use', id: '1', name: 'Read', input: {} },
          { type: 'tool_use', id: '2', name: 'Bash', input: {} },
        ],
      },
      {
        type: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
      },
    ] as unknown as SubagentRunResult['messages'];

    const deps: ExecRoutineDeps = {
      runSubagent: vi.fn().mockResolvedValue(makeSubagentResult({ messages: messagesWithToolUse })),
      loadProjectMap: async () => makeProjectMap(),
    };

    const result = await executeRoutine(makeRoutine(), makeProject(), '2026-05-02', deps);
    expect(result.toolCallCount).toBe(2);
    expect(result.output).toBe('Done');
  });

  // Кейс: system prompt содержит проектные данные.
  it('systemPrompt содержит имя проекта, дату и описание routine', async () => {
    const mockRunSubagent = vi.fn().mockResolvedValue(makeSubagentResult());
    const deps: ExecRoutineDeps = {
      runSubagent: mockRunSubagent,
      loadProjectMap: async () => makeProjectMap(),
    };

    await executeRoutine(
      makeRoutine({ description: 'Тест системного промпта' }),
      makeProject({ name: 'МойПроект' }),
      '2026-05-02',
      deps,
    );

    const callOpts = mockRunSubagent.mock.calls[0]?.[0];
    expect(callOpts?.systemPrompt).toContain('МойПроект');
    expect(callOpts?.systemPrompt).toContain('2026-05-02');
    expect(callOpts?.systemPrompt).toContain('Тест системного промпта');
  });

  // Кейс: routineId передаётся в runSubagent для cost-tracking.
  it('routineId передаётся в runSubagent', async () => {
    const mockRunSubagent = vi.fn().mockResolvedValue(makeSubagentResult());
    const deps: ExecRoutineDeps = {
      runSubagent: mockRunSubagent,
      loadProjectMap: async () => makeProjectMap(),
    };

    await executeRoutine(makeRoutine({ id: 'my-routine-id' }), makeProject(), '2026-05-02', deps);

    const callOpts = mockRunSubagent.mock.calls[0]?.[0];
    expect(callOpts?.routineId).toBe('my-routine-id');
  });

  // Кейс: несколько unsupported tools → warn вызван несколько раз.
  it('несколько unsupported tools → warn содержит все имена', async () => {
    const mockRunSubagent = vi.fn().mockResolvedValue(makeSubagentResult());
    const deps: ExecRoutineDeps = {
      runSubagent: mockRunSubagent,
      loadProjectMap: async () => makeProjectMap(),
    };

    await executeRoutine(
      makeRoutine({ tools: ['project.db.query', 'journal.search', 'report.send'] }),
      makeProject(),
      '2026-05-02',
      deps,
    );

    const allWarnText = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allWarnText).toContain('project.db.query');
    expect(allWarnText).toContain('journal.search');
    expect(allWarnText).toContain('report.send');
  });
});
