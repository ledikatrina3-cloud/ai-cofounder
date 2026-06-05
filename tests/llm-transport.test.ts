// Тесты транспортного слоя (фаза 2 плана 2026-05-17). Стратегия:
//   * Каждый тест мутирует process.env (LLM_TRANSPORT/LLM_GATEWAY_URL/...)
//     и вызывает resetTransportForTests() для сброса memo.
//   * Восстанавливаем env в afterEach, чтобы остальные тесты не подхватили
//     наш LLM_TRANSPORT=apikey.
//   * verifyGatewayReady проверяем через DI fetchImpl (моки), без сетевых
//     hop'ов на реальный gateway.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GatewayUnreachableError,
  TransportConfigError,
  getTransport,
  isOauthMode,
  resetTransportForTests,
  verifyGatewayReady,
} from '../src/llm/transport.js';

const ENV_KEYS = ['LLM_TRANSPORT', 'LLM_GATEWAY_URL', 'CLAUDE_CLI_PATH', 'ANTHROPIC_API_KEY'];

describe('transport — config', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    resetTransportForTests();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    resetTransportForTests();
  });

  it('дефолт — apikey (через ANTHROPIC_API_KEY)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-default';
    const t = getTransport();
    expect(t.mode).toBe('apikey');
    expect(t.baseURL).toBeUndefined();
    expect(t.apiKey).toBe('sk-ant-default');
    expect(isOauthMode()).toBe(false);
  });

  it('oauth (явно) — дефолтный baseURL и dummy apiKey', () => {
    process.env.LLM_TRANSPORT = 'oauth';
    const t = getTransport();
    expect(t.mode).toBe('oauth');
    expect(t.baseURL).toBe('http://127.0.0.1:8787');
    expect(t.apiKey).toBe('sk-dummy-oauth-route');
    expect(t.claudeCliPath).toBe('claude');
    expect(isOauthMode()).toBe(true);
  });

  it('LLM_GATEWAY_URL override применяется (oauth)', () => {
    process.env.LLM_TRANSPORT = 'oauth';
    process.env.LLM_GATEWAY_URL = 'http://127.0.0.1:9999';
    const t = getTransport();
    expect(t.baseURL).toBe('http://127.0.0.1:9999');
  });

  it('CLAUDE_CLI_PATH override применяется (oauth)', () => {
    process.env.LLM_TRANSPORT = 'oauth';
    process.env.CLAUDE_CLI_PATH = '/opt/claude/bin/claude';
    const t = getTransport();
    expect(t.claudeCliPath).toBe('/opt/claude/bin/claude');
  });

  it('LLM_TRANSPORT=apikey с ANTHROPIC_API_KEY → apikey config', () => {
    process.env.LLM_TRANSPORT = 'apikey';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real-key';
    const t = getTransport();
    expect(t.mode).toBe('apikey');
    expect(t.baseURL).toBeUndefined();
    expect(t.apiKey).toBe('sk-ant-real-key');
    expect(t.claudeCliPath).toBeUndefined();
    expect(isOauthMode()).toBe(false);
  });

  it('LLM_TRANSPORT=apikey без ANTHROPIC_API_KEY → TransportConfigError', () => {
    process.env.LLM_TRANSPORT = 'apikey';
    expect(() => getTransport()).toThrowError(TransportConfigError);
    // И сообщение должно мягко указывать на .env.local/Keychain.
    expect(() => getTransport()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('LLM_TRANSPORT=garbage → TransportConfigError с подсказкой', () => {
    process.env.LLM_TRANSPORT = 'garbage';
    expect(() => getTransport()).toThrowError(TransportConfigError);
    expect(() => getTransport()).toThrow(/oauth|apikey/);
  });

  it('memo: повторный getTransport возвращает тот же объект', () => {
    process.env.LLM_TRANSPORT = 'oauth'; // транспорт-агностично; oauth не требует ключа
    const first = getTransport();
    const second = getTransport();
    expect(second).toBe(first);
  });

  it('resetTransportForTests сбрасывает memo', () => {
    process.env.LLM_TRANSPORT = 'oauth';
    const first = getTransport();
    expect(first.mode).toBe('oauth');
    process.env.LLM_TRANSPORT = 'apikey';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
    // Без reset — старый кэш.
    expect(getTransport().mode).toBe('oauth');
    resetTransportForTests();
    expect(getTransport().mode).toBe('apikey');
  });
});

describe('transport — verifyGatewayReady', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    resetTransportForTests();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    resetTransportForTests();
  });

  it('в apikey-режиме — no-op (не дёргает fetch)', async () => {
    process.env.LLM_TRANSPORT = 'apikey';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response('', { status: 200 });
    }) as typeof fetch;
    await expect(verifyGatewayReady(fakeFetch)).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  it('в oauth-режиме при 200 OK — успех + кэшируется', async () => {
    process.env.LLM_TRANSPORT = 'oauth';
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    await expect(verifyGatewayReady(fakeFetch)).resolves.toBeUndefined();
    expect(calls).toBe(1);
    // Повторный вызов не должен делать fetch — health-check кэшируется.
    await verifyGatewayReady(fakeFetch);
    expect(calls).toBe(1);
  });

  it('в oauth-режиме при 500 → GatewayUnreachableError', async () => {
    process.env.LLM_TRANSPORT = 'oauth';
    const fakeFetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    await expect(verifyGatewayReady(fakeFetch)).rejects.toBeInstanceOf(GatewayUnreachableError);
  });

  it('в oauth-режиме при network error → GatewayUnreachableError с подсказкой', async () => {
    process.env.LLM_TRANSPORT = 'oauth';
    const fakeFetch = (async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:8787');
    }) as typeof fetch;
    await expect(verifyGatewayReady(fakeFetch)).rejects.toBeInstanceOf(GatewayUnreachableError);
    await expect(verifyGatewayReady(fakeFetch)).rejects.toThrow(/launchctl|LLM_TRANSPORT=apikey/);
  });
});
