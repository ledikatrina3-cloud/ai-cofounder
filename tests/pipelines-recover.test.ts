// Тесты для recoverPipelines (Фаза 5).

import { describe, expect, it, vi } from 'vitest';
import type { Department } from '../src/departments/types.js';
import { recoverPipelines } from '../src/pipelines/recover.js';
import type { PipelineState } from '../src/pipelines/state.js';

function makeDept(): Department {
  return {
    id: 'dept-1',
    name: 'D',
    description: 'd',
    body: '',
    filePath: '/abs/d.md',
    pipelinePath: '/abs/p.yml',
    sharedDir: '/abs/s',
    pipeline: {
      nodes: [
        { kind: 'employee', id: 'a', employee: 'x', inputs: [], output: 'a.md' },
        {
          kind: 'human-gate',
          id: 'g',
          via: 'telegram',
          timeoutMs: 1000,
          onTimeout: 'halt',
          inputs: ['a'],
        },
      ],
    },
  };
}

function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    pipelineId: 'dept-1',
    runId: 'r-1',
    currentNode: 'a',
    nodeStatuses: {},
    artifacts: {},
    startedAt: 1,
    waitingForApproval: null,
    ...overrides,
  };
}

describe('recoverPipelines', () => {
  it('пустой список — ничего не делает', async () => {
    const result = await recoverPipelines({
      findStatesFn: async () => [],
      listDepartmentsFn: async () => [],
    });
    expect(result).toEqual({ recovered: 0, reprompted: 0, reExecuted: 0, skipped: 0 });
  });

  it('running state → re-execute', async () => {
    const dept = makeDept();
    const state = makeState({ currentNode: 'a' });
    const executePipelineFn = vi.fn(async () => ({
      runId: 'r-1',
      pipelineId: 'dept-1',
      status: 'success' as const,
      artifacts: {},
      nodeStatuses: {},
      startedAt: 0,
      endedAt: 0,
    }));
    const result = await recoverPipelines({
      findStatesFn: async () => [state],
      listDepartmentsFn: async () => [dept],
      executePipelineFn,
    });
    expect(executePipelineFn).toHaveBeenCalledWith(dept, 'r-1');
    expect(result.reExecuted).toBe(1);
  });

  it('waiting-for-approval state → re-prompt', async () => {
    const dept = makeDept();
    const state = makeState({ currentNode: 'g', waitingForApproval: 'g' });
    const requestApprovalFn = vi.fn(async () => 'timeout' as const);
    const result = await recoverPipelines({
      findStatesFn: async () => [state],
      listDepartmentsFn: async () => [dept],
      requestApprovalFn,
      executePipelineFn: async () => ({
        runId: '',
        pipelineId: '',
        status: 'success' as const,
        artifacts: {},
        nodeStatuses: {},
        startedAt: 0,
        endedAt: 0,
      }),
    });
    expect(result.reprompted).toBe(1);
  });

  it('unknown department → skip', async () => {
    const state = makeState({ pipelineId: 'unknown' });
    const result = await recoverPipelines({
      findStatesFn: async () => [state],
      listDepartmentsFn: async () => [makeDept()],
    });
    expect(result.skipped).toBe(1);
  });
});
