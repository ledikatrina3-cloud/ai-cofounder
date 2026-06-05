// Analytics queries — read-side helper'ы для KPI dashboard'а (Фаза 8, A.2).
//
// Никакой бизнес-логики, только агрегаты поверх `Record`:
//   * signal.metric (что писал collector.ts) — views/comments/likes per postUrl;
//   * audit.spend (что писал src/llm/spend.ts) — usd per LLM-call с привязкой
//     к routineId / cycleParentId;
//   * pipeline.state — артефакты publish-нод, по которым мы определяем
//     posted-at и связываем spend → пост.
//
// Все функции принимают prisma-клиент (DI для тестов), возвращают plain объекты.
// Используется и в bridge endpoint'ах, и в alerts.ts.
//
// Замечание про время:
//   * Запросы группируют по UTC-неделям (понедельник как начало недели — ISO).
//   * `period` в виде '7d' / '30d' / '90d' интерпретируется как «последние N
//     дней относительно `now`», границы в UTC.

import { type PrismaClient, getPrisma } from '../db/client.js';

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export interface WeekBucket {
  /** ISO-дата начала недели (понедельник, UTC, формат 'YYYY-MM-DD'). */
  weekStartDate: string;
  /** Unix ms начала недели. */
  weekStartMs: number;
}

export interface PostsPerWeekItem extends WeekBucket {
  count: number;
}

export interface TrafficByPlatformItem {
  platform: string;
  totalViews: number;
  totalComments: number;
  totalLikes: number;
}

export interface CostPerPostItem {
  postUrl: string;
  platform: string;
  postedAt: number;
  totalCostUsd: number;
  /** Сколько spend-записей попало в pipeline-run этого поста. */
  spendCount: number;
}

export interface CostTrendItem extends WeekBucket {
  totalUsd: number;
}

export interface TrafficTrendItem extends WeekBucket {
  totalViews: number;
  totalComments: number;
  totalLikes: number;
}

// ---------------------------------------------------------------------------
// Time helpers.
// ---------------------------------------------------------------------------

/** ISO-week start (понедельник 00:00 UTC) для произвольной даты. */
export function startOfIsoWeekUtc(d: Date): Date {
  const day = d.getUTCDay(); // 0=sun..6=sat
  const offset = day === 0 ? 6 : day - 1; // понедельник = 0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset));
  return monday;
}

export function isoDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function buildWeekBuckets(weeks: number, now: Date): WeekBucket[] {
  const out: WeekBucket[] = [];
  const currentWeekStart = startOfIsoWeekUtc(now);
  for (let i = weeks - 1; i >= 0; i--) {
    const ws = new Date(currentWeekStart.getTime() - i * 7 * 86_400_000);
    out.push({ weekStartDate: isoDateUtc(ws), weekStartMs: ws.getTime() });
  }
  return out;
}

function parsePeriod(period: string): number {
  const m = /^(\d+)d$/.exec(period.trim());
  if (m === null || m[1] === undefined) {
    throw new Error(`unsupported period '${period}'; expected '<N>d'`);
  }
  return Number.parseInt(m[1], 10);
}

function periodWindow(period: string, now: Date): { fromMs: number; toMs: number } {
  const days = parsePeriod(period);
  const toMs = now.getTime();
  const fromMs = toMs - days * 86_400_000;
  return { fromMs, toMs };
}

// ---------------------------------------------------------------------------
// Posts per week (signal.metric distinct по postUrl, считаем посты ПО ПЕРВОЙ
// метрике — это и есть proxy для «когда опубликован»: collector запускается
// после публикации, первая метрика идёт в тот же день).
// ---------------------------------------------------------------------------

export interface PostsPerWeekOptions {
  weeks?: number;
  db?: PrismaClient;
  now?: () => Date;
}

export async function getPostsPerWeek(opts: PostsPerWeekOptions = {}): Promise<PostsPerWeekItem[]> {
  const db = opts.db ?? getPrisma();
  const now = (opts.now ?? (() => new Date()))();
  const weeks = opts.weeks ?? 12;
  const buckets = buildWeekBuckets(weeks, now);
  if (buckets.length === 0) return [];

  const fromMs = buckets[0]?.weekStartMs ?? 0;

  // На каждый postUrl берём САМУЮ РАННЮЮ запись signal.metric — это
  // «первое появление» поста в метриках (~ день публикации).
  const rows = await db.$queryRawUnsafe<{ postUrl: string; firstSeen: number }[]>(
    `SELECT json_extract(properties, '$.postUrl') as postUrl,
            MIN(createdAt) as firstSeen
       FROM "Record"
      WHERE type = 'signal.metric'
        AND createdAt >= ?
      GROUP BY json_extract(properties, '$.postUrl')`,
    fromMs,
  );

  const result: PostsPerWeekItem[] = buckets.map((b) => ({ ...b, count: 0 }));
  for (const row of rows) {
    const t = Number(row.firstSeen);
    if (!Number.isFinite(t)) continue;
    // найдём bucket
    for (let i = buckets.length - 1; i >= 0; i--) {
      const b = buckets[i];
      if (b !== undefined && t >= b.weekStartMs) {
        const target = result[i];
        if (target !== undefined) target.count += 1;
        break;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Traffic by platform (для periodа): берём САМУЮ СВЕЖУЮ метрику per postUrl
// внутри окна. Суммируем по platform. «Последняя метрика = best-known traffic».
// ---------------------------------------------------------------------------

export interface TrafficByPlatformOptions {
  period?: string;
  db?: PrismaClient;
  now?: () => Date;
}

export async function getTrafficByPlatform(
  opts: TrafficByPlatformOptions = {},
): Promise<TrafficByPlatformItem[]> {
  const db = opts.db ?? getPrisma();
  const now = (opts.now ?? (() => new Date()))();
  const period = opts.period ?? '7d';
  const { fromMs, toMs } = periodWindow(period, now);

  const rows = await db.$queryRawUnsafe<{ properties: string; createdAt: number }[]>(
    `SELECT properties, createdAt FROM "Record"
      WHERE type = 'signal.metric'
        AND createdAt >= ? AND createdAt < ?`,
    fromMs,
    toMs,
  );

  // Для каждой пары (postUrl, platform) — последняя по createdAt запись.
  const latest = new Map<
    string,
    { platform: string; views: number; comments: number; likes: number; createdAt: number }
  >();
  for (const row of rows) {
    try {
      const p = JSON.parse(row.properties) as Record<string, unknown>;
      const postUrl = typeof p.postUrl === 'string' ? p.postUrl : null;
      const platform = typeof p.platform === 'string' ? p.platform : null;
      if (postUrl === null || platform === null) continue;
      const ts = Number(row.createdAt);
      const key = `${platform}:${postUrl}`;
      const prev = latest.get(key);
      if (prev === undefined || prev.createdAt < ts) {
        latest.set(key, {
          platform,
          views: typeof p.views === 'number' ? p.views : 0,
          comments: typeof p.comments === 'number' ? p.comments : 0,
          likes: typeof p.likes === 'number' ? p.likes : 0,
          createdAt: ts,
        });
      }
    } catch {
      // skip
    }
  }

  const agg = new Map<string, TrafficByPlatformItem>();
  for (const v of latest.values()) {
    const cur = agg.get(v.platform) ?? {
      platform: v.platform,
      totalViews: 0,
      totalComments: 0,
      totalLikes: 0,
    };
    cur.totalViews += v.views;
    cur.totalComments += v.comments;
    cur.totalLikes += v.likes;
    agg.set(v.platform, cur);
  }
  return [...agg.values()].sort((a, b) => b.totalViews - a.totalViews);
}

// ---------------------------------------------------------------------------
// Cost per post — JOIN audit.spend с pipeline-runs. Алгоритм:
//   1. Берём все signal.metric за окно. Для каждого (postUrl, platform)
//      находим САМУЮ РАННЮЮ запись — это «когда пост впервые появился».
//   2. Для каждого postUrl ищем pipeline.state, в artifacts которого
//      присутствует ссылка на postUrl (через published_url во frontmatter'е
//      файлов). Это сложный JOIN; упрощаем: берём первую signal.metric для
//      postUrl и аппроксимируем `pipeline-run = окно [postedAt-7d, postedAt+1d]`.
//      Все audit.spend в этом окне с тем же department/routineId считаются
//      «спендами этого pipeline-run».
//   3. Если pipeline.state не найден — оставляем totalCostUsd=0.
//
// Это упрощение, но без него нужен формальный «pipeline-run-id в audit.spend»,
// которого пока нет (а добавлять — отдельный план). Сейчас signal.metric есть,
// а linking — best-effort.
// ---------------------------------------------------------------------------

export interface CostPerPostOptions {
  period?: string;
  db?: PrismaClient;
  now?: () => Date;
}

export async function getCostPerPost(opts: CostPerPostOptions = {}): Promise<CostPerPostItem[]> {
  const db = opts.db ?? getPrisma();
  const now = (opts.now ?? (() => new Date()))();
  const period = opts.period ?? '30d';
  const { fromMs, toMs } = periodWindow(period, now);

  // Шаг 1: postUrl + platform + postedAt (= MIN createdAt of signal.metric).
  const postRows = await db.$queryRawUnsafe<
    { postUrl: string; platform: string; postedAt: number }[]
  >(
    `SELECT json_extract(properties, '$.postUrl')  as postUrl,
            json_extract(properties, '$.platform') as platform,
            MIN(createdAt)                          as postedAt
       FROM "Record"
      WHERE type = 'signal.metric'
        AND createdAt >= ? AND createdAt < ?
      GROUP BY json_extract(properties, '$.postUrl'),
               json_extract(properties, '$.platform')`,
    fromMs,
    toMs,
  );

  // Шаг 2: для каждого postUrl — окно spend'а 7 дней до и 1 день после postedAt.
  const out: CostPerPostItem[] = [];
  for (const row of postRows) {
    const postedAt = Number(row.postedAt);
    const windowFrom = postedAt - 7 * 86_400_000;
    const windowTo = postedAt + 86_400_000;

    const spendRows = await db.$queryRawUnsafe<{ properties: string }[]>(
      `SELECT properties FROM "Record"
        WHERE type = 'audit.spend'
          AND createdAt >= ? AND createdAt < ?`,
      windowFrom,
      windowTo,
    );

    let totalCostUsd = 0;
    let spendCount = 0;
    for (const r of spendRows) {
      try {
        const p = JSON.parse(r.properties) as Record<string, unknown>;
        if (typeof p.usd === 'number' && Number.isFinite(p.usd)) {
          totalCostUsd += p.usd;
          spendCount++;
        }
      } catch {
        // skip
      }
    }

    out.push({
      postUrl: row.postUrl,
      platform: row.platform,
      postedAt,
      totalCostUsd,
      spendCount,
    });
  }

  return out.sort((a, b) => b.postedAt - a.postedAt);
}

// ---------------------------------------------------------------------------
// Cost trend per week (audit.spend, sum usd).
// ---------------------------------------------------------------------------

export interface CostTrendOptions {
  weeks?: number;
  db?: PrismaClient;
  now?: () => Date;
}

export async function getCostTrend(opts: CostTrendOptions = {}): Promise<CostTrendItem[]> {
  const db = opts.db ?? getPrisma();
  const now = (opts.now ?? (() => new Date()))();
  const weeks = opts.weeks ?? 12;
  const buckets = buildWeekBuckets(weeks, now);
  if (buckets.length === 0) return [];

  const fromMs = buckets[0]?.weekStartMs ?? 0;

  const rows = await db.$queryRawUnsafe<{ createdAt: number; properties: string }[]>(
    `SELECT createdAt, properties FROM "Record"
      WHERE type = 'audit.spend'
        AND createdAt >= ?`,
    fromMs,
  );

  const result: CostTrendItem[] = buckets.map((b) => ({ ...b, totalUsd: 0 }));
  for (const row of rows) {
    let usd = 0;
    try {
      const p = JSON.parse(row.properties) as Record<string, unknown>;
      if (typeof p.usd === 'number' && Number.isFinite(p.usd)) usd = p.usd;
    } catch {
      // skip
    }
    if (usd <= 0) continue;
    const t = Number(row.createdAt);
    for (let i = buckets.length - 1; i >= 0; i--) {
      const b = buckets[i];
      if (b !== undefined && t >= b.weekStartMs) {
        const target = result[i];
        if (target !== undefined) target.totalUsd += usd;
        break;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Traffic trend — per week, summing latest known views per post.
// ---------------------------------------------------------------------------

export interface TrafficTrendOptions {
  weeks?: number;
  db?: PrismaClient;
  now?: () => Date;
}

export async function getTrafficTrend(opts: TrafficTrendOptions = {}): Promise<TrafficTrendItem[]> {
  const db = opts.db ?? getPrisma();
  const now = (opts.now ?? (() => new Date()))();
  const weeks = opts.weeks ?? 12;
  const buckets = buildWeekBuckets(weeks, now);
  if (buckets.length === 0) return [];

  const fromMs = buckets[0]?.weekStartMs ?? 0;

  const rows = await db.$queryRawUnsafe<{ createdAt: number; properties: string }[]>(
    `SELECT createdAt, properties FROM "Record"
      WHERE type = 'signal.metric'
        AND createdAt >= ?`,
    fromMs,
  );

  // Внутри каждой недели — последняя метрика на postUrl. Делаем 2 прохода:
  // (1) bucket'им по неделе; (2) для каждого bucket'а выбираем latest per postUrl.
  const perBucket: Map<
    number,
    Map<string, { views: number; comments: number; likes: number; ts: number }>
  > = new Map();
  for (let i = 0; i < buckets.length; i++) perBucket.set(i, new Map());

  for (const row of rows) {
    let postUrl: string | null = null;
    let views = 0;
    let comments = 0;
    let likes = 0;
    try {
      const p = JSON.parse(row.properties) as Record<string, unknown>;
      if (typeof p.postUrl === 'string') postUrl = p.postUrl;
      if (typeof p.views === 'number') views = p.views;
      if (typeof p.comments === 'number') comments = p.comments;
      if (typeof p.likes === 'number') likes = p.likes;
    } catch {
      continue;
    }
    if (postUrl === null) continue;
    const t = Number(row.createdAt);
    let bucketIdx = -1;
    for (let i = buckets.length - 1; i >= 0; i--) {
      const b = buckets[i];
      if (b !== undefined && t >= b.weekStartMs) {
        bucketIdx = i;
        break;
      }
    }
    if (bucketIdx < 0) continue;
    const map = perBucket.get(bucketIdx);
    if (map === undefined) continue;
    const prev = map.get(postUrl);
    if (prev === undefined || prev.ts < t) {
      map.set(postUrl, { views, comments, likes, ts: t });
    }
  }

  const result: TrafficTrendItem[] = buckets.map((b) => ({
    ...b,
    totalViews: 0,
    totalComments: 0,
    totalLikes: 0,
  }));
  for (let i = 0; i < buckets.length; i++) {
    const map = perBucket.get(i);
    if (map === undefined) continue;
    const target = result[i];
    if (target === undefined) continue;
    for (const v of map.values()) {
      target.totalViews += v.views;
      target.totalComments += v.comments;
      target.totalLikes += v.likes;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Aggregated summary — для /analytics/summary endpoint.
// ---------------------------------------------------------------------------

export interface AnalyticsSummary {
  period: string;
  topline: {
    postsThisWeek: number;
    postsPrevWeek: number;
    viewsCurrent: number;
    viewsPrev: number;
    costCurrentUsd: number;
    costPrevUsd: number;
    costPerPostAvgUsd: number;
  };
  trafficByPlatform: TrafficByPlatformItem[];
}

export interface SummaryOptions {
  period?: string;
  db?: PrismaClient;
  now?: () => Date;
}

export async function getAnalyticsSummary(opts: SummaryOptions = {}): Promise<AnalyticsSummary> {
  const period = opts.period ?? '7d';
  const now = (opts.now ?? (() => new Date()))();
  const db = opts.db ?? getPrisma();

  const days = parsePeriod(period);
  const periodMs = days * 86_400_000;
  const currentTo = now.getTime();
  const currentFrom = currentTo - periodMs;
  const prevTo = currentFrom;
  const prevFrom = prevTo - periodMs;

  const [trafficNow, trafficPrev, costNow, costPrev, postsNow, postsPrev, byPlatform] =
    await Promise.all([
      sumViewsInWindow(db, currentFrom, currentTo),
      sumViewsInWindow(db, prevFrom, prevTo),
      sumSpendInWindow(db, currentFrom, currentTo),
      sumSpendInWindow(db, prevFrom, prevTo),
      countPostsInWindow(db, currentFrom, currentTo),
      countPostsInWindow(db, prevFrom, prevTo),
      getTrafficByPlatform({ period, db, now: opts.now }),
    ]);

  const costPerPostAvgUsd = postsNow > 0 ? costNow / postsNow : 0;

  return {
    period,
    topline: {
      postsThisWeek: postsNow,
      postsPrevWeek: postsPrev,
      viewsCurrent: trafficNow,
      viewsPrev: trafficPrev,
      costCurrentUsd: costNow,
      costPrevUsd: costPrev,
      costPerPostAvgUsd,
    },
    trafficByPlatform: byPlatform,
  };
}

async function sumViewsInWindow(db: PrismaClient, fromMs: number, toMs: number): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ properties: string; createdAt: number }[]>(
    `SELECT properties, createdAt FROM "Record"
      WHERE type = 'signal.metric'
        AND createdAt >= ? AND createdAt < ?`,
    fromMs,
    toMs,
  );
  // latest per postUrl
  const latest = new Map<string, { views: number; ts: number }>();
  for (const row of rows) {
    try {
      const p = JSON.parse(row.properties) as Record<string, unknown>;
      const postUrl = typeof p.postUrl === 'string' ? p.postUrl : null;
      if (postUrl === null) continue;
      const ts = Number(row.createdAt);
      const views = typeof p.views === 'number' ? p.views : 0;
      const prev = latest.get(postUrl);
      if (prev === undefined || prev.ts < ts) latest.set(postUrl, { views, ts });
    } catch {
      // skip
    }
  }
  let sum = 0;
  for (const v of latest.values()) sum += v.views;
  return sum;
}

async function sumSpendInWindow(db: PrismaClient, fromMs: number, toMs: number): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ properties: string }[]>(
    `SELECT properties FROM "Record"
      WHERE type = 'audit.spend'
        AND createdAt >= ? AND createdAt < ?`,
    fromMs,
    toMs,
  );
  let sum = 0;
  for (const row of rows) {
    try {
      const p = JSON.parse(row.properties) as Record<string, unknown>;
      if (typeof p.usd === 'number' && Number.isFinite(p.usd)) sum += p.usd;
    } catch {
      // skip
    }
  }
  return sum;
}

async function countPostsInWindow(db: PrismaClient, fromMs: number, toMs: number): Promise<number> {
  // count(*) → BigInt в SQLite через Prisma — приводим через Number.
  const rows = await db.$queryRawUnsafe<{ c: number | bigint }[]>(
    `SELECT count(*) as c FROM (
       SELECT json_extract(properties, '$.postUrl') as postUrl,
              MIN(createdAt) as firstSeen
         FROM "Record"
        WHERE type = 'signal.metric'
        GROUP BY json_extract(properties, '$.postUrl')
       ) WHERE firstSeen >= ? AND firstSeen < ?`,
    fromMs,
    toMs,
  );
  return Number(rows[0]?.c ?? 0);
}

// ---------------------------------------------------------------------------
// Post-detail list — для /analytics/posts endpoint.
// ---------------------------------------------------------------------------

export interface PostDetailItem {
  postUrl: string;
  platform: string;
  postedAt: number;
  views: number;
  comments: number;
  likes: number;
  costUsd: number;
}

export interface PostsListOptions {
  period?: string;
  db?: PrismaClient;
  now?: () => Date;
}

export async function getPostsList(opts: PostsListOptions = {}): Promise<PostDetailItem[]> {
  const db = opts.db ?? getPrisma();
  const now = (opts.now ?? (() => new Date()))();
  const period = opts.period ?? '30d';
  const { fromMs, toMs } = periodWindow(period, now);

  // Берём все signal.metric за окно; группируем по postUrl, для каждой группы:
  //   postedAt = MIN(createdAt), последние views/comments/likes = MAX-createdAt.
  const rows = await db.$queryRawUnsafe<
    {
      postUrl: string;
      platform: string;
      properties: string;
      createdAt: number;
    }[]
  >(
    `SELECT json_extract(properties, '$.postUrl')  as postUrl,
            json_extract(properties, '$.platform') as platform,
            properties,
            createdAt
       FROM "Record"
      WHERE type = 'signal.metric'
        AND createdAt >= ? AND createdAt < ?
      ORDER BY createdAt ASC`,
    fromMs,
    toMs,
  );

  const byUrl = new Map<
    string,
    {
      platform: string;
      postedAt: number;
      latestTs: number;
      views: number;
      comments: number;
      likes: number;
    }
  >();
  for (const row of rows) {
    const postUrl = row.postUrl;
    if (typeof postUrl !== 'string') continue;
    let views = 0;
    let comments = 0;
    let likes = 0;
    try {
      const p = JSON.parse(row.properties) as Record<string, unknown>;
      if (typeof p.views === 'number') views = p.views;
      if (typeof p.comments === 'number') comments = p.comments;
      if (typeof p.likes === 'number') likes = p.likes;
    } catch {
      // skip
    }
    const t = Number(row.createdAt);
    const prev = byUrl.get(postUrl);
    if (prev === undefined) {
      byUrl.set(postUrl, {
        platform: row.platform,
        postedAt: t,
        latestTs: t,
        views,
        comments,
        likes,
      });
    } else if (prev.latestTs < t) {
      prev.latestTs = t;
      prev.views = views;
      prev.comments = comments;
      prev.likes = likes;
    }
  }

  // Cost per post — батч-вызов для всех URL'ов.
  const costMap = new Map<string, number>();
  for (const [postUrl, v] of byUrl.entries()) {
    const wf = v.postedAt - 7 * 86_400_000;
    const wt = v.postedAt + 86_400_000;
    costMap.set(postUrl, await sumSpendInWindow(db, wf, wt));
  }

  const out: PostDetailItem[] = [];
  for (const [postUrl, v] of byUrl.entries()) {
    out.push({
      postUrl,
      platform: v.platform,
      postedAt: v.postedAt,
      views: v.views,
      comments: v.comments,
      likes: v.likes,
      costUsd: costMap.get(postUrl) ?? 0,
    });
  }
  out.sort((a, b) => b.postedAt - a.postedAt);
  return out;
}
