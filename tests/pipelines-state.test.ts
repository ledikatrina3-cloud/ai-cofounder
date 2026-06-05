// Тесты для pipeline state persistence (Фаза 5).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type PipelineState,
  clearWaitingApproval,
  findRunningStates,
  loadPipelineState,
  savePipelineState,
} from '../src/pipelines/state.js';
import {
  type IsolatedDb,
  type TemplateHandle,
  createIsolatedDb,
  setupTemplateDb,
} from './fixtures/isolated-db.js';

let template: TemplateHandle;

beforeAll(() => {
  template = setupTemplateDb();
});
afterAll(() => template.dispose());

let db: IsolatedDb;
beforeEach(async () => {
  db = await createIsolatedDb(template);
});
afterEach(async () => {
  await db.dispose();
});

function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    pipelineId: 'marketing-content',
    runId: 'run-1',
    currentNode: 'research',
    nodeStatuses: { research: 'running' },
    artifacts: {},
    startedAt: Date.now(),
    waitingForApproval: null,
    ...overrides,
  };
}

describe('savePipelineState + loadPipelineState', () => {
  it('сохраняет и читает state', async () => {
    const state = makeState();
    await savePipelineState(state, { db: db.prisma });
    const loaded = await loadPipelineState('run-1', db.prisma);
    expect(loaded).toMatchObject(state);
  });

  it('save несколько раз — load возвращает САМУЮ свежую', async () => {
    await savePipelineState(makeState({ currentNode: 'a' }), { db: db.prisma });
    // Чтобы createdAt отличался — небольшая задержка через increment now()
    let counter = 1000;
    await savePipelineState(makeState({ currentNode: 'b' }), {
      db: db.prisma,
      now: () => Date.now() + counter++,
    });
    const loaded = await loadPipelineState('run-1', db.prisma);
    expect(loaded?.currentNode).toBe('b');
  });

  it('load возвращает null для неизвестного runId', async () => {
    const loaded = await loadPipelineState('nope', db.prisma);
    expect(loaded).toBeNull();
  });
});

describe('findRunningStates', () => {
  it('возвращает только running state', async () => {
    let now = Date.now();
    await savePipelineState(makeState({ runId: 'a', currentNode: 'x' }), {
      db: db.prisma,
      now: () => now,
    });
    now += 10;
    await savePipelineState(makeState({ runId: 'b', currentNode: null, finalStatus: 'success' }), {
      db: db.prisma,
      now: () => now,
    });
    now += 10;
    await savePipelineState(makeState({ runId: 'c', currentNode: 'y' }), {
      db: db.prisma,
      now: () => now,
    });
    const running = await findRunningStates(db.prisma);
    const ids = running.map((s) => s.runId).sort();
    expect(ids).toEqual(['a', 'c']);
  });

  it('берёт самую свежую запись по каждому runId', async () => {
    let now = Date.now();
    await savePipelineState(makeState({ runId: 'a', currentNode: 'x' }), {
      db: db.prisma,
      now: () => now,
    });
    now += 100;
    await savePipelineState(makeState({ runId: 'a', currentNode: null, finalStatus: 'success' }), {
      db: db.prisma,
      now: () => now,
    });
    const running = await findRunningStates(db.prisma);
    // Самая свежая — closed → не возвращается.
    expect(running.find((s) => s.runId === 'a')).toBeUndefined();
  });
});

describe('clearWaitingApproval', () => {
  it('сбрасывает waitingForApproval в null', async () => {
    await savePipelineState(makeState({ waitingForApproval: 'approve-theme' }), {
      db: db.prisma,
    });
    let counter = 1000;
    await clearWaitingApproval('run-1', {
      db: db.prisma,
      now: () => Date.now() + counter++,
    });
    const loaded = await loadPipelineState('run-1', db.prisma);
    expect(loaded?.waitingForApproval).toBeNull();
  });

  it('idempotent: clear на state без waiting — ничего не происходит', async () => {
    await savePipelineState(makeState({ waitingForApproval: null }), { db: db.prisma });
    await clearWaitingApproval('run-1', { db: db.prisma });
    const loaded = await loadPipelineState('run-1', db.prisma);
    expect(loaded?.waitingForApproval).toBeNull();
  });
});
