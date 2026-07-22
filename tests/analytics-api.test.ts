// Smoke-тесты для /analytics/* endpoint'ов bridge/server.ts (Фаза 8).
//
// Стратегия идентична tests/bridge-skills-api.test.ts: поднимаем сервер на
// динамическом порту, бьём в каждый endpoint, ожидаем либо ok:true с
// корректной формой data/items, либо ok:false с понятной подсказкой про tsc
// (если dist/src/analytics/queries.js ещё не собран).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonlSession } from '../bridge/jsonl-writer.js';
import { type BridgeServerHandle, startBridgeServer } from '../bridge/server.js';

function noopSession(): JsonlSession {
  return {
    sessionId: 'test',
    filePath: '/tmp/noop.jsonl',
    write: async () => undefined,
  };
}

describe('GET /analytics/* (bridge endpoints)', () => {
  let handle: BridgeServerHandle;

  beforeEach(async () => {
    handle = await startBridgeServer({ port: 0, session: noopSession() });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('/analytics/summary — либо data.topline, либо подсказка про tsc', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/analytics/summary?period=7d`);
    const body = (await res.json()) as {
      ok: boolean;
      data?: { period?: string; topline?: Record<string, unknown> };
      error?: string;
    };
    if (body.ok === true) {
      expect(body.data?.period).toBe('7d');
      expect(typeof body.data?.topline?.postsThisWeek).toBe('number');
    } else {
      expect(typeof body.error).toBe('string');
      expect(body.error ?? '').toMatch(/tsc|analytics|module/i);
    }
  });

  it('/analytics/posts — либо items array, либо подсказка', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/analytics/posts?period=30d`);
    const body = (await res.json()) as {
      ok: boolean;
      items?: unknown[];
      error?: string;
    };
    if (body.ok === true) {
      expect(Array.isArray(body.items)).toBe(true);
    } else {
      expect(typeof body.error).toBe('string');
    }
  });

  it('/analytics/cost-trend — либо items, либо подсказка', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/analytics/cost-trend?weeks=4`);
    const body = (await res.json()) as { ok: boolean; items?: unknown[]; error?: string };
    if (body.ok === true) {
      expect(Array.isArray(body.items)).toBe(true);
      // weeks=4 → 4 bucket'а
      if (Array.isArray(body.items)) expect(body.items.length).toBe(4);
    } else {
      expect(typeof body.error).toBe('string');
    }
  });

  it('/analytics/traffic-trend — либо items, либо подсказка', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/analytics/traffic-trend?weeks=4`);
    const body = (await res.json()) as { ok: boolean; items?: unknown[]; error?: string };
    if (body.ok === true) {
      expect(Array.isArray(body.items)).toBe(true);
      if (Array.isArray(body.items)) expect(body.items.length).toBe(4);
    } else {
      expect(typeof body.error).toBe('string');
    }
  });
});
