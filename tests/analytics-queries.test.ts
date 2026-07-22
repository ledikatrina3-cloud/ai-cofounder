// Тесты для src/analytics/queries.ts.
//
// Стратегия: заливаем фикстуры (signal.metric + audit.spend) с заранее
// рассчитанными createdAt'ами относительно фиксированной `now`, проверяем
// агрегаты.

import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getAnalyticsSummary,
  getCostPerPost,
  getCostTrend,
  getPostsList,
  getPostsPerWeek,
  getTrafficByPlatform,
  getTrafficTrend,
  startOfIsoWeekUtc,
} from '../src/analytics/queries.js';
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
const NOW = new Date('2026-05-21T08:00:00Z');

beforeEach(async () => {
  db = await createIsolatedDb(template);
});

afterEach(async () => {
  await db.dispose();
});

interface MetricFixture {
  platform: 'vc' | 'dzen' | 'tg';
  postUrl: string;
  views: number;
  comments: number;
  likes: number;
  /** Сколько дней назад от NOW. */
  daysAgo: number;
}

async function insertSignalMetric(m: MetricFixture): Promise<void> {
  const id = ulid();
  const createdAt = NOW.getTime() - m.daysAgo * 86_400_000;
  const props = JSON.stringify({
    platform: m.platform,
    postUrl: m.postUrl,
    views: m.views,
    comments: m.comments,
    likes: m.likes,
    source: 'analytics-traffic',
    collectedAt: new Date(createdAt).toISOString(),
  });
  await db.prisma.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'signal.metric', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    props,
    createdAt,
    createdAt,
  );
}

async function insertSpend(usd: number, daysAgo: number): Promise<void> {
  const id = ulid();
  const createdAt = NOW.getTime() - daysAgo * 86_400_000;
  const props = JSON.stringify({
    promptId: 'test:p',
    model: 'claude-sonnet-4-6',
    modelRequested: 'claude-sonnet-4-6',
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    usd,
    pricingAsOf: createdAt,
  });
  await db.prisma.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.spend', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    props,
    createdAt,
    createdAt,
  );
}

describe('startOfIsoWeekUtc', () => {
  it('понедельник как начало', () => {
    // 2026-05-21 — четверг (UTC). Понедельник той же недели — 2026-05-18.
    const w = startOfIsoWeekUtc(new Date('2026-05-21T12:00:00Z'));
    expect(w.toISOString().slice(0, 10)).toBe('2026-05-18');
  });
});

describe('getTrafficByPlatform', () => {
  it('берёт latest метрику per (postUrl, platform), суммирует по платформе', async () => {
    // Один и тот же URL: первое измерение 100, второе 200 — берём 200.
    await insertSignalMetric({
      platform: 'vc',
      postUrl: 'https://vc.ru/u/a',
      views: 100,
      comments: 1,
      likes: 1,
      daysAgo: 2,
    });
    await insertSignalMetric({
      platform: 'vc',
      postUrl: 'https://vc.ru/u/a',
      views: 200,
      comments: 5,
      likes: 3,
      daysAgo: 1,
    });
    // Второй URL: 50
    await insertSignalMetric({
      platform: 'vc',
      postUrl: 'https://vc.ru/u/b',
      views: 50,
      comments: 0,
      likes: 0,
      daysAgo: 1,
    });
    // Другая платформа
    await insertSignalMetric({
      platform: 'dzen',
      postUrl: 'https://dzen.ru/x',
      views: 10,
      comments: 0,
      likes: 0,
      daysAgo: 1,
    });

    const r = await getTrafficByPlatform({ period: '7d', db: db.prisma, now: () => NOW });
    expect(r.find((x) => x.platform === 'vc')?.totalViews).toBe(250);
    expect(r.find((x) => x.platform === 'dzen')?.totalViews).toBe(10);
  });
});

describe('getPostsPerWeek', () => {
  it('считает уникальные posts (firstSeen) per ISO-week', async () => {
    // Post A — впервые 10 дней назад → предыдущая неделя
    await insertSignalMetric({
      platform: 'vc',
      postUrl: 'https://vc.ru/a',
      views: 1,
      comments: 0,
      likes: 0,
      daysAgo: 10,
    });
    // Post B — впервые 2 дня назад → текущая неделя
    await insertSignalMetric({
      platform: 'vc',
      postUrl: 'https://vc.ru/b',
      views: 1,
      comments: 0,
      likes: 0,
      daysAgo: 2,
    });

    const r = await getPostsPerWeek({ weeks: 4, db: db.prisma, now: () => NOW });
    expect(r).toHaveLength(4);
    // Последняя bucket — текущая неделя, должна быть >=1.
    const current = r[r.length - 1];
    expect(current?.count).toBeGreaterThanOrEqual(1);
  });
});

describe('getCostPerPost', () => {
  it('суммирует spend в окне [postedAt-7d, postedAt+1d] для каждого постa', async () => {
    // Post posted 2 дня назад. Spend $0.20 — 1 день до публикации, должен попасть.
    await insertSignalMetric({
      platform: 'vc',
      postUrl: 'https://vc.ru/u/a',
      views: 10,
      comments: 0,
      likes: 0,
      daysAgo: 2,
    });
    await insertSpend(0.2, 3);
    await insertSpend(0.1, 2.5); // тоже в окне

    const r = await getCostPerPost({ period: '30d', db: db.prisma, now: () => NOW });
    expect(r).toHaveLength(1);
    expect(r[0]?.totalCostUsd).toBeCloseTo(0.3, 4);
    expect(r[0]?.spendCount).toBe(2);
  });
});

describe('getCostTrend', () => {
  it('агрегирует audit.spend per неделю', async () => {
    await insertSpend(0.5, 2); // текущая неделя
    await insertSpend(0.3, 10); // предыдущая неделя
    const r = await getCostTrend({ weeks: 3, db: db.prisma, now: () => NOW });
    expect(r).toHaveLength(3);
    const total = r.reduce((s, x) => s + x.totalUsd, 0);
    expect(total).toBeCloseTo(0.8, 4);
  });
});

describe('getTrafficTrend', () => {
  it('latest views per post in week, summed', async () => {
    await insertSignalMetric({
      platform: 'vc',
      postUrl: 'https://vc.ru/a',
      views: 50,
      comments: 0,
      likes: 0,
      daysAgo: 2,
    });
    await insertSignalMetric({
      platform: 'vc',
      postUrl: 'https://vc.ru/a',
      views: 80,
      comments: 0,
      likes: 0,
      daysAgo: 1,
    });
    const r = await getTrafficTrend({ weeks: 3, db: db.prisma, now: () => NOW });
    const totalViews = r.reduce((s, x) => s + x.totalViews, 0);
    // Латест значение должно быть 80 в одной из недель.
    expect(totalViews).toBeGreaterThanOrEqual(80);
  });
});

describe('getAnalyticsSummary', () => {
  it('топ-линия: posts+views+cost с предыдущим периодом для дельты', async () => {
    // Текущий 7d-период (0..7 дней назад)
    await insertSignalMetric({
      platform: 'vc',
      postUrl: 'https://vc.ru/a',
      views: 100,
      comments: 0,
      likes: 0,
      daysAgo: 2,
    });
    await insertSpend(0.5, 2);
    // Предыдущий 7d-период (7..14 дней назад)
    await insertSignalMetric({
      platform: 'vc',
      postUrl: 'https://vc.ru/b',
      views: 200,
      comments: 0,
      likes: 0,
      daysAgo: 10,
    });
    await insertSpend(0.2, 9);

    const s = await getAnalyticsSummary({ period: '7d', db: db.prisma, now: () => NOW });
    expect(s.topline.postsThisWeek).toBe(1);
    expect(s.topline.postsPrevWeek).toBe(1);
    expect(s.topline.viewsCurrent).toBe(100);
    expect(s.topline.viewsPrev).toBe(200);
    expect(s.topline.costCurrentUsd).toBeCloseTo(0.5, 4);
    expect(s.topline.costPrevUsd).toBeCloseTo(0.2, 4);
    expect(s.topline.costPerPostAvgUsd).toBeCloseTo(0.5, 4);
  });
});

describe('getPostsList', () => {
  it('возвращает по одной строке на postUrl с latest views и спендом', async () => {
    await insertSignalMetric({
      platform: 'vc',
      postUrl: 'https://vc.ru/a',
      views: 10,
      comments: 0,
      likes: 0,
      daysAgo: 2,
    });
    await insertSignalMetric({
      platform: 'vc',
      postUrl: 'https://vc.ru/a',
      views: 25,
      comments: 1,
      likes: 0,
      daysAgo: 1,
    });
    await insertSpend(0.1, 2);

    const r = await getPostsList({ period: '30d', db: db.prisma, now: () => NOW });
    expect(r).toHaveLength(1);
    expect(r[0]?.views).toBe(25);
    expect(r[0]?.costUsd).toBeGreaterThan(0);
  });
});
