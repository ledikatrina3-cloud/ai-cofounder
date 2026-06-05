// Тесты для src/skills/health-store.ts (Фаза 7).
//
// Стратегия — изолированный prisma per-test (как остальные DB-тесты).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getAllLatestHealth,
  getLatestHealth,
  saveHealthCheck,
} from '../src/skills/health-store.js';
import type { HealthCheckResult } from '../src/skills/health.js';
import {
  type IsolatedDb,
  type TemplateHandle,
  createIsolatedDb,
  setupTemplateDb,
} from './fixtures/isolated-db.js';

let template: TemplateHandle;

beforeAll(() => {
  template = setupTemplateDb();
}, 90_000);

afterAll(() => {
  template.dispose();
});

let db: IsolatedDb;

beforeEach(async () => {
  db = await createIsolatedDb(template);
});

afterEach(async () => {
  await db.dispose();
});

function makeResult(opts: Partial<HealthCheckResult> & { skillName: string }): HealthCheckResult {
  return {
    status: 'ok',
    durationMs: 100,
    timestamp: Date.now(),
    ...opts,
  };
}

describe('saveHealthCheck + getLatestHealth', () => {
  it('saveHealthCheck возвращает id и пишет в Record', async () => {
    const id = await saveHealthCheck(makeResult({ skillName: 'foo' }), db.prisma);
    expect(typeof id).toBe('string');
    expect(id.length).toBe(26); // ULID

    const rows = await db.prisma.$queryRawUnsafe<{ type: string }[]>(
      `SELECT type FROM "Record" WHERE id = ?`,
      id,
    );
    expect(rows[0]?.type).toBe('skill.health.check');
  });

  it('getLatestHealth возвращает null если нет записей', async () => {
    const latest = await getLatestHealth('nothing', db.prisma);
    expect(latest).toBeNull();
  });

  it('getLatestHealth возвращает самую свежую запись по skillName', async () => {
    const t1 = Date.now() - 2000;
    const t2 = Date.now();
    await saveHealthCheck(
      makeResult({ skillName: 'foo', timestamp: t1, status: 'failed', error: 'old' }),
      db.prisma,
    );
    // Маленькая задержка, чтобы createdAt отличался.
    await new Promise((r) => setTimeout(r, 5));
    await saveHealthCheck(makeResult({ skillName: 'foo', timestamp: t2, status: 'ok' }), db.prisma);

    const latest = await getLatestHealth('foo', db.prisma);
    expect(latest?.status).toBe('ok');
    expect(latest?.skillName).toBe('foo');
  });
});

describe('getAllLatestHealth', () => {
  it('возвращает по одной (самой свежей) записи на скилл', async () => {
    await saveHealthCheck(
      makeResult({ skillName: 'foo', status: 'failed', error: 'first' }),
      db.prisma,
    );
    await new Promise((r) => setTimeout(r, 5));
    await saveHealthCheck(makeResult({ skillName: 'foo', status: 'ok' }), db.prisma);
    await new Promise((r) => setTimeout(r, 5));
    await saveHealthCheck(
      makeResult({ skillName: 'bar', status: 'skipped', reason: 'no health-check' }),
      db.prisma,
    );

    const all = await getAllLatestHealth(db.prisma);
    expect(all.length).toBe(2);
    const byName = new Map(all.map((e) => [e.skillName, e]));
    expect(byName.get('foo')?.status).toBe('ok');
    expect(byName.get('bar')?.status).toBe('skipped');
    expect(byName.get('bar')?.reason).toBe('no health-check');
  });

  it('пишет и читает output/error/reason без потерь', async () => {
    await saveHealthCheck(
      makeResult({
        skillName: 'foo',
        status: 'failed',
        error: 'boom',
        output: { status: 'failed', some: 1 },
      }),
      db.prisma,
    );
    const latest = await getLatestHealth('foo', db.prisma);
    expect(latest?.error).toBe('boom');
    expect(latest?.output).toEqual({ status: 'failed', some: 1 });
  });
});
