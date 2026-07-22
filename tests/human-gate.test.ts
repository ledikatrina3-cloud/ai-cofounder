// Тесты для human-gate (Фаза 5).

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  emitApprovalCallback,
  parseCallbackData,
  requestApproval,
} from '../src/pipelines/human-gate.js';
import { handlePipelineCallback } from '../src/telegram/pipeline-callbacks.js';

describe('parseCallbackData', () => {
  it('парсит approve', () => {
    expect(parseCallbackData('pipe:r-1:approve-theme:approve')).toEqual({
      runId: 'r-1',
      nodeId: 'approve-theme',
      action: 'approve',
    });
  });
  it('парсит reject', () => {
    expect(parseCallbackData('pipe:r-1:n:reject')).toEqual({
      runId: 'r-1',
      nodeId: 'n',
      action: 'reject',
    });
  });
  it('null на чужой callback', () => {
    expect(parseCallbackData('cmd:foo')).toBeNull();
  });
  it('null на неизвестный action', () => {
    expect(parseCallbackData('pipe:r:n:detonate')).toBeNull();
  });
});

describe('requestApproval', () => {
  it('резолвится approved когда приходит callback', async () => {
    const bus = new EventEmitter();
    const sendMessage = vi.fn(async () => {});
    const promise = requestApproval({
      pipelineId: 'dept-1',
      runId: 'r-1',
      nodeId: 'g',
      message: 'm',
      timeoutMs: 10_000,
      sendMessage,
      bus,
      db: makeMockDb(),
    });
    // даём микротик, чтобы listener зарегистрировался
    await new Promise((r) => setImmediate(r));
    emitApprovalCallback({ runId: 'r-1', nodeId: 'g', action: 'approve' }, bus);
    expect(await promise).toBe('approved');
    expect(sendMessage).toHaveBeenCalled();
  });

  it('резолвится timeout если callback не пришёл', async () => {
    const bus = new EventEmitter();
    const promise = requestApproval({
      pipelineId: 'dept-1',
      runId: 'r-2',
      nodeId: 'g',
      message: 'm',
      timeoutMs: 30,
      sendMessage: async () => {},
      bus,
      db: makeMockDb(),
    });
    expect(await promise).toBe('timeout');
  });

  it('резолвится edited когда action=edit', async () => {
    const bus = new EventEmitter();
    const promise = requestApproval({
      pipelineId: 'dept-1',
      runId: 'r-3',
      nodeId: 'g',
      message: 'm',
      timeoutMs: 10_000,
      sendMessage: async () => {},
      bus,
      db: makeMockDb(),
    });
    await new Promise((r) => setImmediate(r));
    emitApprovalCallback({ runId: 'r-3', nodeId: 'g', action: 'edit' }, bus);
    expect(await promise).toBe('edited');
  });
});

describe('handlePipelineCallback', () => {
  it('обрабатывает наш callback', async () => {
    const bus = new EventEmitter();
    // Заранее подпишемся, чтобы убедиться что emit прошёл.
    const seen: unknown[] = [];
    bus.on('callback', (payload) => seen.push(payload));
    const answer = vi.fn(async () => {});
    // Подменим global approvalBus — handlePipelineCallback использует глобальный
    // через emitApprovalCallback(payload) без bus параметра. Поэтому здесь
    // просто проверим что answer вызвался; глобальный bus всё равно проэмитит.
    const handled = await handlePipelineCallback({
      data: 'pipe:r:g:approve',
      chatId: 123,
      answer,
    });
    expect(handled).toBe(true);
    expect(answer).toHaveBeenCalledWith('✅ Одобрено');
  });

  it('возвращает false для чужого callback', async () => {
    const handled = await handlePipelineCallback({
      data: 'other:thing',
      answer: async () => {},
    });
    expect(handled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Минимальный mock Prisma — requestApproval делает loadPipelineState +
// clearWaitingApproval. Для теста нам надо что эти вызовы не падают.
// ---------------------------------------------------------------------------

function makeMockDb(): never {
  // Возвращаем заглушку, которая на все методы $queryRawUnsafe / $executeRawUnsafe
  // отвечает []/0. Тип PrismaClient — большой; cast через unknown как never.
  return {
    $queryRawUnsafe: async () => [],
    $executeRawUnsafe: async () => 0,
  } as unknown as never;
}
