// Тест redaction в pipeline SSE Bridge.
//
// Архитектура redaction:
//   1. AI-Cofounder path: src/observe/bridge.ts emit() → redactSecrets() → POST /event/:kind
//      → bus.publish() → SSE. Секреты замаскированы ДО попадания в bus.
//   2. claude-code-hooks path: raw POST /event/:kind → bridge/server.ts redactSecrets()
//      → bus.publish() → SSE. Секреты замаскированы ВНУТРИ сервера перед publish.
//
// Этот тест проверяет кейс #2: события от claude-code-hooks (source='claude-code-hooks')
// с секретом в строковом поле — секрет должен быть замаскирован в bus перед SSE.
//
// Более простой unit-тест redactSecrets уже есть в tests/bridge-redaction.test.ts.

import { describe, expect, it } from 'vitest';
import { getBridgeBus } from '../bridge/event-bus.js';
import type { BridgeEvent } from '../bridge/events.js';
import { startBridgeServer } from '../bridge/server.js';

function mockSession() {
  return {
    sessionId: 'test-session-redaction-sse',
    filePath: '/tmp/test-redaction-sse.jsonl',
    write: async (_: BridgeEvent): Promise<void> => {},
  };
}

describe('SSE redaction pipeline', () => {
  it('redactSecrets маскирует секрет ДО publish в bus (прямая проверка редакции)', async () => {
    // Используем redactSecrets напрямую для верификации логики bridge/redaction.ts
    const { redactSecrets } = await import('../bridge/redaction.js');

    const input = 'API_KEY=sk-super-secret-123 result output';
    const out = redactSecrets(input);
    expect(out).not.toContain('sk-super-secret');
    expect(out).toContain('API_KEY=***');
  });

  it('POST /event/:kind от claude-code-hooks с секретом → event в bus замаскирован', async () => {
    const { close, port } = await startBridgeServer({ port: 0, session: mockSession() });

    const bus = getBridgeBus();
    const collected: BridgeEvent[] = [];
    const handler = (ev: BridgeEvent): void => {
      collected.push(ev);
    };
    bus.on('event', handler);

    try {
      // Имитируем claude-code-hooks: POST с секретом в поле
      await fetch(`http://127.0.0.1:${port}/event/tool.end`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'tool.end',
          toolId: 'hook-test-1',
          output: 'result: API_KEY=sk-super-secret-hook-123 done',
          durationMs: 50,
          ts: Date.now(),
          source: 'claude-code-hooks',
        }),
      });

      // Небольшая пауза: сервер обрабатывает запрос async
      await new Promise<void>((r) => setTimeout(r, 50));

      expect(collected.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(collected[0]);
      expect(serialized).not.toContain('sk-super-secret-hook-123');
      expect(serialized).toContain('API_KEY=***');
    } finally {
      bus.off('event', handler);
      await close();
    }
  });

  it('AI-Cofounder path: emit() с секретом → bridge/server.ts получает уже чистый JSON', async () => {
    // Проверяем src/observe/bridge.ts emit() — redactSecrets вызывается ДО POST.
    // Тестируем через unit-импорт: не нужен реальный сервер.
    const { redactSecrets } = await import('../bridge/redaction.js');

    // Симулируем то, что делает emit() в src/observe/bridge.ts:
    const enriched = {
      type: 'tool.end' as const,
      toolId: 'cofounder-test',
      output: 'TOKEN=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA done',
      durationMs: 100,
      ts: Date.now(),
      source: 'cofounder' as const,
    };
    const raw = JSON.stringify(enriched);
    const redacted = redactSecrets(raw);

    expect(redacted).not.toContain('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(redacted).toContain('TOKEN=***');
    // Структура JSON остаётся корректной после редакции
    expect(() => JSON.parse(redacted)).not.toThrow();
  });
});
