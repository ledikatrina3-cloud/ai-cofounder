// LLM-транспорт: единая точка переключения между API-key и (опционально)
// gateway-маршрутом. См. src/llm/transport.ts.
//
// Два режима, один env-флаг `LLM_TRANSPORT`:
//
//   * `apikey` (ДЕФОЛТ, рекомендуемый, поддерживаемый): inference через
//     @anthropic-ai/sdk с реальным ANTHROPIC_API_KEY (кладётся в .env.local).
//     ─ `call.ts` → Anthropic SDK с дефолтным baseURL.
//     ─ `subagent.ts` → @anthropic-ai/claude-agent-sdk через `query()`.
//     `audit.spend.properties.usd` = реальный USD из computeUsd / SDK.
//
//   * `oauth` (ЭКСПЕРИМЕНТАЛЬНО, НЕ endorsed, на свой риск): маршрут через
//     ЛОКАЛЬНЫЙ gateway по LLM_GATEWAY_URL, который пользователь поднимает
//     САМ — в OSS-сборку сам gateway НЕ входит. Может конфликтовать с Условиями
//     использования LLM-провайдера; используешь под свою ответственность.
//     ─ `call.ts` → Anthropic SDK с baseURL=LLM_GATEWAY_URL.
//     ─ `subagent.ts` → spawn('claude', [...]) subprocess (свой логин CLI).
//     `audit.spend.properties.usd` = 0 (биллинг вне токенов).
//
// Контракт: getTransport() читает env один раз и мемоизирует. Тесты сбрасывают
// memo через resetTransportForTests(). verifyGatewayReady() — опциональный
// health-check gateway, НЕ подключён к горячему пути (см. его комментарий).

import { loadEnv } from '../env.js';

export type TransportMode = 'oauth' | 'apikey';

export interface TransportConfig {
  mode: TransportMode;
  // Для Anthropic SDK direct (call.ts):
  baseURL?: string; // oauth: 'http://127.0.0.1:8787', apikey: undefined
  apiKey: string; // oauth: dummy, apikey: real ANTHROPIC_API_KEY
  // Для subagent.ts subprocess-пути:
  claudeCliPath?: string; // oauth: путь к 'claude' (resolve через PATH либо абсолютный)
}

export class TransportConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportConfigError';
  }
}

export class GatewayUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayUnreachableError';
  }
}

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8787';
// Dummy-ключ: gateway игнорирует x-api-key (он сам подставляет OAuth
// Bearer). Но Anthropic SDK требует непустую строку.
const OAUTH_DUMMY_KEY = 'sk-dummy-oauth-route';

let cached: TransportConfig | null = null;
let gatewayVerified = false;

export function getTransport(): TransportConfig {
  if (cached !== null) return cached;
  loadEnv();

  const raw = process.env.LLM_TRANSPORT ?? 'apikey';
  if (raw !== 'oauth' && raw !== 'apikey') {
    throw new TransportConfigError(
      `LLM_TRANSPORT="${raw}" не распознан. Допустимые значения: "apikey" (дефолт, рекомендуемый — через ANTHROPIC_API_KEY) или "oauth" (экспериментальный, НЕ endorsed — маршрут через ваш локальный gateway по LLM_GATEWAY_URL).`,
    );
  }
  const mode: TransportMode = raw;

  if (mode === 'oauth') {
    const baseURL = process.env.LLM_GATEWAY_URL ?? DEFAULT_GATEWAY_URL;
    const claudeCliPath = process.env.CLAUDE_CLI_PATH ?? 'claude';
    cached = {
      mode,
      baseURL,
      apiKey: OAUTH_DUMMY_KEY,
      claudeCliPath,
    };
    return cached;
  }

  // mode === 'apikey'
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new TransportConfigError(
      'ANTHROPIC_API_KEY не выставлен. Положи ключ в .env.local, либо в Keychain (когда Keychain-адаптер появится в фазе 2.x).',
    );
  }
  cached = {
    mode,
    baseURL: undefined,
    apiKey,
    claudeCliPath: undefined,
  };
  return cached;
}

export function isOauthMode(): boolean {
  return getTransport().mode === 'oauth';
}

// Для тестов: сбрасывает мемоизацию и кэш health-check'а.
// В проде не зови — потеряешь консистентность между call.ts и subagent.ts.
export function resetTransportForTests(): void {
  cached = null;
  gatewayVerified = false;
}

// Опциональный health-check gateway (в apikey-режиме — no-op). В v1.0 НЕ
// подключён к горячему пути: вызови его сам перед первым gateway-маршрутизируемым
// запросом, если хочешь дружелюбную ошибку вместо сырого ECONNREFUSED. Замечание:
// subagent-cli.ts спавнит нативный `claude` со СВОИМ логином (мимо gateway), так
// что для CLI-пути этот чек неактуален — он про call.ts (прямой SDK → gateway).
export async function verifyGatewayReady(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const transport = getTransport();
  if (transport.mode !== 'oauth') return;
  if (gatewayVerified) return;
  const url = `${transport.baseURL}/v1/health`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(1_000),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new GatewayUnreachableError(
      `gateway не отвечает на ${url}: ${reason}. Проверь launchctl list | grep gateway или установи LLM_TRANSPORT=apikey для отката на API-key.`,
    );
  }
  if (!res.ok) {
    throw new GatewayUnreachableError(
      `gateway вернул статус ${res.status} на ${url}. Проверь логи launchd (dist/launchd.gateway.err) или установи LLM_TRANSPORT=apikey.`,
    );
  }
  gatewayVerified = true;
}
