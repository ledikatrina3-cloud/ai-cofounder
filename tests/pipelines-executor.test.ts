// Тесты для pipeline executor'а (Фаза 5).
//
// Стратегия:
//   * Мокаем runRoutine, writeArtifact, artifactExists, requestApproval.
//   * Используем skipPersist=true чтобы не дёргать БД.
//   * Топосорт, retry/backoff, halt, parallel, human-gate timeout — все
//     отдельными тестами с минимальными pipelines.

import { describe, expect, it, vi } from 'vitest';
import type { Department } from '../src/departments/types.js';
import { executePipeline, resolveOutputPath, topoSort } from '../src/pipelines/executor.js';
import type { Pipeline, PipelineNode } from '../src/pipelines/types.js';

function makeDept(pipeline: Pipeline): Department {
  return {
    id: 'test-dept',
    name: 'Test',
    description: 'Test dept.',
    body: '',
    filePath: '/abs/DEPARTMENT.md',
    pipelinePath: '/abs/pipeline.yml',
    pipeline,
    sharedDir: '/abs/shared',
  };
}

describe('topoSort', () => {
  it('сортирует A → B → C по inputs', () => {
    const nodes: PipelineNode[] = [
      { kind: 'employee', id: 'b', employee: 'x', inputs: ['a'], output: 'b.md' },
      { kind: 'employee', id: 'a', employee: 'x', inputs: [], output: 'a.md' },
      { kind: 'employee', id: 'c', employee: 'x', inputs: ['b'], output: 'c.md' },
    ];
    expect(topoSort(nodes).map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('бросает на цикле', () => {
    const nodes: PipelineNode[] = [
      { kind: 'employee', id: 'a', employee: 'x', inputs: ['b'], output: 'a.md' },
      { kind: 'employee', id: 'b', employee: 'x', inputs: ['a'], output: 'b.md' },
    ];
    expect(() => topoSort(nodes)).toThrow(/цикл/);
  });
});

describe('resolveOutputPath', () => {
  it('подставляет ${date} и резолвит относительный путь', () => {
    expect(resolveOutputPath('/cwd', 'outputs/r/${date}.md', '2026-05-21')).toBe(
      '/cwd/outputs/r/2026-05-21.md',
    );
  });
  it('абсолютный путь отвергается (path-traversal-prevention)', () => {
    expect(() => resolveOutputPath('/cwd', '/tmp/x.md', '2026-05-21')).toThrow(/абсолютные пути/);
  });
  it('относительный путь с .. выводящий за cwd отвергается', () => {
    expect(() => resolveOutputPath('/cwd', '../../etc/passwd', '2026-05-21')).toThrow(
      /path-traversal/,
    );
  });
  it('относительный путь с .. внутри cwd допускается', () => {
    // 'a/../outputs/x.md' = 'outputs/x.md' остаётся под /cwd
    expect(resolveOutputPath('/cwd', 'a/../outputs/x.md', '2026-05-21')).toBe('/cwd/outputs/x.md');
  });
});

describe('executePipeline', () => {
  it('happy path: одна employee нода', async () => {
    const pipeline: Pipeline = {
      nodes: [{ kind: 'employee', id: 'a', employee: 'a-emp', inputs: [], output: 'a.md' }],
    };
    const dept = makeDept(pipeline);
    const runRoutine = vi.fn(async () => ({ status: 'ok' as const, output: 'hello' }));
    const writeArtifact = vi.fn(async () => {});
    const artifactExists = vi.fn(async () => false);

    const result = await executePipeline(dept, 'run-1', {
      runRoutine,
      writeArtifact,
      artifactExists,
      skipPersist: true,
      cwd: '/cwd',
    });

    expect(result.status).toBe('success');
    expect(runRoutine).toHaveBeenCalledOnce();
    expect(writeArtifact).toHaveBeenCalledWith('/cwd/a.md', 'hello');
    expect(result.nodeStatuses).toEqual({ a: 'ok' });
  });

  it('топосорт прогоняет в правильном порядке', async () => {
    const pipeline: Pipeline = {
      nodes: [
        { kind: 'employee', id: 'b', employee: 'b-emp', inputs: ['a'], output: 'b.md' },
        { kind: 'employee', id: 'a', employee: 'a-emp', inputs: [], output: 'a.md' },
      ],
    };
    const dept = makeDept(pipeline);
    const order: string[] = [];
    const runRoutine = vi.fn(async (id: string) => {
      order.push(id);
      return { status: 'ok' as const };
    });
    const writeArtifact = vi.fn(async () => {});
    const artifactExists = vi.fn(async () => false);

    await executePipeline(dept, 'run-2', {
      runRoutine,
      writeArtifact,
      artifactExists,
      skipPersist: true,
      cwd: '/cwd',
    });
    expect(order).toEqual(['a-emp', 'b-emp']);
  });

  it('retry: routine падает 2 раза, затем ok', async () => {
    const pipeline: Pipeline = {
      nodes: [
        {
          kind: 'employee',
          id: 'a',
          employee: 'x',
          inputs: [],
          output: 'a.md',
          onFail: { retries: 2, then: 'halt' },
        },
      ],
    };
    const dept = makeDept(pipeline);
    let calls = 0;
    const runRoutine = vi.fn(async () => {
      calls++;
      if (calls < 3) return { status: 'failed' as const, reason: `try ${calls}` };
      return { status: 'ok' as const };
    });
    const result = await executePipeline(dept, 'r', {
      runRoutine,
      writeArtifact: async () => {},
      artifactExists: async () => false,
      skipPersist: true,
      cwd: '/cwd',
    });
    expect(calls).toBe(3);
    expect(result.status).toBe('success');
  });

  it('halt: первая нода падает с then=halt → остальные skip', async () => {
    const pipeline: Pipeline = {
      nodes: [
        {
          kind: 'employee',
          id: 'a',
          employee: 'x',
          inputs: [],
          output: 'a.md',
          onFail: { retries: 0, then: 'halt' },
        },
        {
          kind: 'employee',
          id: 'b',
          employee: 'y',
          inputs: ['a'],
          output: 'b.md',
        },
      ],
    };
    const dept = makeDept(pipeline);
    const runRoutine = vi.fn(async (id: string) => {
      if (id === 'x') return { status: 'failed' as const, reason: 'oops' };
      return { status: 'ok' as const };
    });
    const result = await executePipeline(dept, 'r', {
      runRoutine,
      writeArtifact: async () => {},
      artifactExists: async () => false,
      skipPersist: true,
      cwd: '/cwd',
    });
    expect(result.status).toBe('failed');
    expect(result.nodeStatuses.a).toBe('failed');
    expect(result.nodeStatuses.b).toBe('skipped');
    // y не должен быть вызван
    expect(runRoutine.mock.calls.find((c) => c[0] === 'y')).toBeUndefined();
  });

  it('continue: failed нода с then=continue → следующая идёт', async () => {
    const pipeline: Pipeline = {
      nodes: [
        {
          kind: 'employee',
          id: 'a',
          employee: 'x',
          inputs: [],
          output: 'a.md',
          onFail: { retries: 0, then: 'continue' },
        },
        { kind: 'employee', id: 'b', employee: 'y', inputs: ['a'], output: 'b.md' },
      ],
    };
    const dept = makeDept(pipeline);
    const runRoutine = vi.fn(async (id: string) => {
      if (id === 'x') return { status: 'failed' as const, reason: 'oops' };
      return { status: 'ok' as const };
    });
    const result = await executePipeline(dept, 'r', {
      runRoutine,
      writeArtifact: async () => {},
      artifactExists: async () => false,
      skipPersist: true,
      cwd: '/cwd',
    });
    expect(result.nodeStatuses.a).toBe('failed');
    expect(result.nodeStatuses.b).toBe('ok');
    expect(result.status).toBe('success'); // ни одна halt-ветка не сработала
  });

  it('parallel: 3 ветки, все ok', async () => {
    const pipeline: Pipeline = {
      nodes: [
        { kind: 'employee', id: 'd', employee: 'd-emp', inputs: [], output: 'd.md' },
        {
          kind: 'parallel',
          id: 'pub',
          inputs: ['d'],
          branches: [
            { employee: 'vc', input: 'd', output: 'vc.md' },
            { employee: 'dzen', input: 'd', output: 'dzen.md' },
            { employee: 'tg', input: 'd', output: 'tg.md' },
          ],
        },
      ],
    };
    const dept = makeDept(pipeline);
    const runRoutine = vi.fn(async () => ({ status: 'ok' as const }));
    const result = await executePipeline(dept, 'r', {
      runRoutine,
      writeArtifact: async () => {},
      artifactExists: async () => false,
      skipPersist: true,
      cwd: '/cwd',
    });
    expect(result.status).toBe('success');
    // 1 + 3 routine'ы вызваны
    expect(runRoutine.mock.calls).toHaveLength(4);
  });

  it('parallel: одна ветка failed с halt', async () => {
    const pipeline: Pipeline = {
      nodes: [
        {
          kind: 'parallel',
          id: 'pub',
          inputs: [],
          branches: [
            { employee: 'a', output: 'a.md' },
            {
              employee: 'b',
              output: 'b.md',
              onFail: { retries: 0, then: 'halt' },
            },
          ],
        },
      ],
    };
    const dept = makeDept(pipeline);
    const runRoutine = vi.fn(async (id: string) => {
      if (id === 'b') return { status: 'failed' as const, reason: 'oops' };
      return { status: 'ok' as const };
    });
    const result = await executePipeline(dept, 'r', {
      runRoutine,
      writeArtifact: async () => {},
      artifactExists: async () => false,
      skipPersist: true,
      cwd: '/cwd',
    });
    expect(result.status).toBe('failed');
    expect(result.nodeStatuses.pub).toBe('failed');
  });

  it('human-gate: timeout → onTimeout skip-pipeline', async () => {
    const pipeline: Pipeline = {
      nodes: [
        {
          kind: 'human-gate',
          id: 'g',
          via: 'telegram',
          timeoutMs: 100,
          onTimeout: 'skip-pipeline',
          inputs: [],
        },
      ],
    };
    const dept = makeDept(pipeline);
    const requestApproval = vi.fn(async () => 'timeout' as const);

    const result = await executePipeline(dept, 'r', {
      runRoutine: async () => ({ status: 'ok' as const }),
      requestApproval,
      writeArtifact: async () => {},
      artifactExists: async () => false,
      skipPersist: true,
      cwd: '/cwd',
    });
    expect(requestApproval).toHaveBeenCalled();
    expect(result.status).toBe('skipped');
  });

  it('human-gate: approved → продолжает', async () => {
    const pipeline: Pipeline = {
      nodes: [
        {
          kind: 'human-gate',
          id: 'g',
          via: 'telegram',
          timeoutMs: 100,
          onTimeout: 'halt',
          inputs: [],
        },
        { kind: 'employee', id: 'next', employee: 'n', inputs: ['g'], output: 'n.md' },
      ],
    };
    const dept = makeDept(pipeline);
    const requestApproval = vi.fn(async () => 'approved' as const);
    const runRoutine = vi.fn(async () => ({ status: 'ok' as const }));

    const result = await executePipeline(dept, 'r', {
      runRoutine,
      requestApproval,
      writeArtifact: async () => {},
      artifactExists: async () => false,
      skipPersist: true,
      cwd: '/cwd',
    });
    expect(result.status).toBe('success');
    expect(runRoutine).toHaveBeenCalled();
  });

  it('idempotency: existing artifact → skip employee', async () => {
    const pipeline: Pipeline = {
      nodes: [{ kind: 'employee', id: 'a', employee: 'x', inputs: [], output: 'a.md' }],
    };
    const dept = makeDept(pipeline);
    const runRoutine = vi.fn(async () => ({ status: 'ok' as const }));
    const artifactExists = vi.fn(async () => true);
    const writeArtifact = vi.fn(async () => {});

    const result = await executePipeline(dept, 'r', {
      runRoutine,
      artifactExists,
      writeArtifact,
      skipPersist: true,
      cwd: '/cwd',
    });
    expect(runRoutine).not.toHaveBeenCalled();
    expect(writeArtifact).not.toHaveBeenCalled();
    expect(result.status).toBe('success');
  });
});
