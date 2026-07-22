import { describe, expect, it, vi } from 'vitest';
import { type BridgeEventInput, emit } from '../src/observe/bridge.js';

// Контракт фазы 1.5b (план):
//   * Bridge выключен → emit не падает, не блокирует.
//   * timeout 50мс через AbortSignal.timeout — emit возвращает Promise<void>
//     даже если sink не отвечает.
//   * redaction применяется до POST.
// Тесты подменяют fetch через DI (EmitOptions.fetchImpl), чтобы не делать
// сетевых вызовов в Vitest single-fork (vitest.config.ts).

const sampleEvent: BridgeEventInput = {
  type: 'event.trigger',
  recordId: '01TESTRECORDIDXXXXXXXXXX',
  triggerSource: 'cron',
  idempotencyKey: 'morning-detective:2026-04-30',
};

describe('observe/bridge.emit — fail-soft', () => {
  it('Bridge выключен (ECONNREFUSED) → emit не падает', async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    await expect(emit(sampleEvent, { fetchImpl })).resolves.toBeUndefined();
  });

  it('timeout 50мс — emit возвращает void даже если sink молчит', async () => {
    // Эмулируем sink, который никогда не отвечает: fetchImpl возвращает promise
    // на >100мс, но AbortSignal.timeout(50) внутри emit() прервёт его.
    // Зависимость от реального таймера: vitest по умолчанию не fake'ает таймеры,
    // 50мс приемлемо для CI-прогонов.
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }
        // never resolve
      });

    const start = Date.now();
    await emit(sampleEvent, { fetchImpl });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500); // 50мс timeout + запас
  });

  it('успешный POST — fetchImpl получает url, method, JSON-тело', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await emit(sampleEvent, { fetchImpl, baseUrl: 'http://127.0.0.1:9999' });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('http://127.0.0.1:9999/event/event.trigger');
    expect(call.init?.method).toBe('POST');
    expect(typeof call.init?.body).toBe('string');
    const body = JSON.parse(call.init!.body as string) as Record<string, unknown>;
    expect(body.type).toBe('event.trigger');
    expect(body.recordId).toBe(sampleEvent.recordId);
    expect(typeof body.ts).toBe('number');
    expect(body.source).toBe('cofounder');
  });

  it('redaction применяется к телу POST до отправки', async () => {
    const calls: Array<{ body: string }> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls.push({ body: String(init?.body ?? '') });
      return new Response('{"ok":true}', { status: 200 });
    };

    await emit(
      {
        type: 'tool.start',
        toolId: 't1',
        name: 'Bash',
        input: {
          cmd: 'curl https://api.x/y -H "Authorization: Bearer sk-totally-fake-67890abcdef"',
        },
      },
      { fetchImpl },
    );

    expect(calls).toHaveLength(1);
    const sent = calls[0]!.body;
    expect(sent).not.toContain('sk-totally-fake-67890abcdef');
    expect(sent).toContain('***');
  });

  it("500 от Bridge — emit не throw'ит", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('{"error":"x"}', {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    await expect(emit(sampleEvent, { fetchImpl })).resolves.toBeUndefined();
  });

  it('exception внутри fetchImpl не пробрасывается наружу', async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error('synchronous boom');
    });
    await expect(
      emit(sampleEvent, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
