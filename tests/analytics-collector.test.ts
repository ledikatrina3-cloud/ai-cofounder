// Тесты для src/analytics/collector.ts.
//
// Стратегия:
//   * Мокаем `runSkillScript` (spawn child_process) — никаких реальных tsx-запусков.
//   * Изолированная БД на тест (template + per-test copy) — пишем signal.metric
//     и проверяем дедупликацию.
//   * Discover-режим content/published/* мокаем через `posts` override.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collectAnalyticsForPublished, extractPublishedUrl } from '../src/analytics/collector.js';
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

describe('extractPublishedUrl', () => {
  it('тащит published_url из frontmatter', () => {
    const src = `---
title: x
published_url: https://vc.ru/u/123-foo
---
body`;
    expect(extractPublishedUrl(src)).toBe('https://vc.ru/u/123-foo');
  });

  it('null если нет фронтматтера', () => {
    expect(extractPublishedUrl('hello')).toBeNull();
  });
});

describe('collectAnalyticsForPublished', () => {
  it('пишет signal.metric Records для каждого URL и батчит вызов collect.ts per platform', async () => {
    const callLog: { platform: string; urls: string[] }[] = [];
    const runSkillScript = async (args: { platform: string; urls: string[] }) => {
      callLog.push({ platform: args.platform, urls: args.urls });
      return {
        json: {
          platform: args.platform,
          urls: args.urls.map((url) => ({ url, views: 100, comments: 5, likes: 2 })),
          collectedAt: '2026-05-21T08:00:00Z',
          errors: [],
        },
        exitCode: 0,
        stderr: '',
      };
    };

    const result = await collectAnalyticsForPublished({
      posts: [
        { platform: 'vc', url: 'https://vc.ru/u/1' },
        { platform: 'vc', url: 'https://vc.ru/u/2' },
        { platform: 'dzen', url: 'https://dzen.ru/x' },
      ],
      runSkillScript,
      db: db.prisma,
    });

    expect(result.inserted).toBe(3);
    expect(result.fetched).toBe(3);
    expect(result.deduplicated).toBe(0);
    expect(callLog).toHaveLength(2);
    expect(callLog.find((c) => c.platform === 'vc')?.urls).toEqual([
      'https://vc.ru/u/1',
      'https://vc.ru/u/2',
    ]);
    expect(callLog.find((c) => c.platform === 'dzen')?.urls).toEqual(['https://dzen.ru/x']);

    // Проверим, что записи реально лежат как signal.metric.
    const rows = await db.prisma.$queryRawUnsafe<{ properties: string }[]>(
      `SELECT properties FROM "Record" WHERE type = 'signal.metric'`,
    );
    expect(rows).toHaveLength(3);
    const props = rows.map((r) => JSON.parse(r.properties) as Record<string, unknown>);
    expect(props.every((p) => p.source === 'analytics-traffic')).toBe(true);
    expect(props.every((p) => typeof p.postUrl === 'string')).toBe(true);
  });

  it('дедуплицирует per (postUrl, UTC-день): повторный вызов в тот же день не пишет дубль', async () => {
    const runSkillScript = async (args: { platform: string; urls: string[] }) => ({
      json: {
        platform: args.platform,
        urls: args.urls.map((url) => ({ url, views: 10, comments: 0, likes: 0 })),
        collectedAt: new Date().toISOString(),
        errors: [],
      },
      exitCode: 0,
      stderr: '',
    });

    const first = await collectAnalyticsForPublished({
      posts: [{ platform: 'vc', url: 'https://vc.ru/u/dup' }],
      runSkillScript,
      db: db.prisma,
    });
    expect(first.inserted).toBe(1);

    const second = await collectAnalyticsForPublished({
      posts: [{ platform: 'vc', url: 'https://vc.ru/u/dup' }],
      runSkillScript,
      db: db.prisma,
    });
    expect(second.inserted).toBe(0);
    expect(second.deduplicated).toBe(1);

    // В БД ровно 1 signal.metric.
    const rows = await db.prisma.$queryRawUnsafe<{ c: number }[]>(
      `SELECT count(*) as c FROM "Record" WHERE type = 'signal.metric'`,
    );
    expect(Number(rows[0]?.c ?? 0)).toBe(1);
  });

  it('сохраняет error от collect.ts в properties (для проверки в UI)', async () => {
    const runSkillScript = async (args: { platform: string; urls: string[] }) => ({
      json: {
        platform: args.platform,
        urls: args.urls.map((url) => ({
          url,
          views: 0,
          comments: 0,
          likes: 0,
          error: 'status 404',
        })),
        errors: [],
      },
      exitCode: 0,
      stderr: '',
    });
    await collectAnalyticsForPublished({
      posts: [{ platform: 'vc', url: 'https://vc.ru/missing' }],
      runSkillScript,
      db: db.prisma,
    });
    const rows = await db.prisma.$queryRawUnsafe<{ properties: string }[]>(
      `SELECT properties FROM "Record" WHERE type = 'signal.metric'`,
    );
    const p = JSON.parse(rows[0]?.properties ?? '{}') as Record<string, unknown>;
    expect(p.error).toBe('status 404');
  });

  it('пустой список постов → 0 inserted, 0 fetched, не падает', async () => {
    const result = await collectAnalyticsForPublished({
      posts: [],
      runSkillScript: async () => ({ json: null, exitCode: 0, stderr: '' }),
      db: db.prisma,
    });
    expect(result.inserted).toBe(0);
    expect(result.fetched).toBe(0);
  });

  it('если collect.ts вернул битый JSON — пишем error для всех URL платформы', async () => {
    const runSkillScript = async () => ({
      json: null,
      exitCode: 1,
      stderr: 'boom',
    });
    const result = await collectAnalyticsForPublished({
      posts: [{ platform: 'vc', url: 'https://vc.ru/u/1' }],
      runSkillScript,
      db: db.prisma,
    });
    expect(result.fetched).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.metrics[0]?.error).toMatch(/collect\.ts: invalid output/);
  });
});
