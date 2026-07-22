// Analytics collector — собирает публичные метрики (views/comments/likes) для
// уже опубликованных постов и пишет результаты в журнал как `signal.metric`
// Records.
//
// Контракт (Фаза 8 плана 2026-05-21-skills-architecture-v3, раздел A.1):
//   * collectAnalyticsForPublished(opts) — точка входа. Находит опубликованные
//     посты (по умолчанию — через pipeline.state Records с nodeStatuses
//     publish='ok' + artifact-файлы с published_url во frontmatter), вызывает
//     `skills/analytics-traffic/scripts/collect.ts` через child_process для
//     каждой платформы, и записывает результат как `signal.metric` Record'ы.
//   * Дедупликация per (postUrl, collectedAt-day): если для этого URL уже есть
//     signal.metric за сегодня (UTC) — не пишем дубль.
//
// Хранимый формат properties для signal.metric:
//   {
//     platform: 'vc' | 'dzen' | 'tg',
//     postUrl: string,
//     views: number,
//     comments: number,
//     likes: number,
//     collectedAt: ISO-8601 string,
//     source: 'analytics-traffic',
//     error?: string  // если collect.ts вернул error для этого URL
//   }
//
// Дизайн-решения:
//   * Запускаем collect.ts через spawn — никакого статического импорта из
//     skill-папки (скиллы — data, см. anti-goal #1). Скрипт уже умеет
//     возвращать JSON последней строкой stdout.
//   * Source-of-truth для URL'ов — артефакты в content/published/<platform>/
//     (frontmatter `published_url`). Это конвенция publisher-скилла.
//     Альтернатива (Records `pipeline.state` artifacts publish-нод) пока не
//     используется как primary — мы трактуем её как fallback, потому что
//     pipeline-state не гарантирует, что URL опубликованного поста сохранён
//     внутри artifact'а (executor пишет файл, но published_url в нём появляется
//     только если publisher-скилл его туда положил).
//   * LLM-вызовы запрещены (anti-goal #5). Тут — child_process + DB.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ulid } from 'ulid';
import { type PrismaClient, getPrisma } from '../db/client.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export type Platform = 'vc' | 'dzen' | 'tg';

export interface CollectorPostInput {
  platform: Platform;
  url: string;
}

export interface CollectorMetricResult {
  platform: Platform;
  postUrl: string;
  views: number;
  comments: number;
  likes: number;
  collectedAt: string;
  source: 'analytics-traffic';
  error?: string;
}

export interface CollectorRunSummary {
  /** Сколько метрик мы новых записали в журнал (после дедупа). */
  inserted: number;
  /** Сколько было дедуплицировано (уже есть signal.metric за этот же UTC-день). */
  deduplicated: number;
  /** Сколько URL'ов прошли через collect.ts (включая те, что вернули error). */
  fetched: number;
  /** Полный список метрик, что вернул collect.ts (включая error'ы). */
  metrics: CollectorMetricResult[];
}

// ---------------------------------------------------------------------------
// Скрипт-runner (выделен под DI для тестов).
// ---------------------------------------------------------------------------

export interface RunSkillScriptArgs {
  platform: Platform;
  urls: string[];
  scriptPath: string;
  cwd: string;
  timeoutMs?: number;
}

export interface RunSkillScriptResult {
  /** Stdout последней строки — структурированный JSON. */
  json: unknown;
  exitCode: number | null;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

async function defaultRunSkillScript(args: RunSkillScriptArgs): Promise<RunSkillScriptResult> {
  return new Promise((resolveProm) => {
    const child = spawn(
      'pnpm',
      ['exec', 'tsx', args.scriptPath, '--platform', args.platform, '--urls', args.urls.join(',')],
      {
        cwd: args.cwd,
        env: process.env,
        shell: false,
      },
    );

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, args.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      stderr += `\n[spawn error] ${err.message}`;
      resolveProm({ json: null, exitCode: null, stderr });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const json = parseLastJsonLine(stdout);
      resolveProm({ json, exitCode: code, stderr });
    });
  });
}

function parseLastJsonLine(stdout: string): unknown {
  const lines = stdout.split('\n').map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || line === '') continue;
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// extractPublishedUrl — повторяем мини-парсер frontmatter здесь, чтобы не
// тащить skill-only зависимость в src/. Если frontmatter-парсинг разойдётся,
// сравним unit-тестом (см. analytics-collector.test).
// ---------------------------------------------------------------------------

export function extractPublishedUrl(source: string): string | null {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) return null;
  const end = source.indexOf('\n---', 4);
  if (end === -1) return null;
  const fm = source.slice(4, end);
  for (const ln of fm.split('\n')) {
    const m = /^published_url\s*:\s*(.+)$/.exec(ln.trim());
    if (m !== null && m[1] !== undefined) {
      let v = m[1].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (v !== '') return v;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Discover-режимы: где брать URL'ы опубликованных постов.
// ---------------------------------------------------------------------------

interface DiscoverPostsArgs {
  cwd: string;
  /** Список конвенциональных платформ-директорий внутри `content/published/`. */
  platforms: Platform[];
  /** DI для тестов: подмена readdirSync/readFileSync/existsSync. */
  readDirFn?: (path: string) => string[];
  readFileFn?: (path: string) => string;
  existsFn?: (path: string) => boolean;
}

export function discoverPublishedPostsFromContent(args: DiscoverPostsArgs): CollectorPostInput[] {
  const rd = args.readDirFn ?? ((p) => readdirSync(p));
  const rf = args.readFileFn ?? ((p) => readFileSync(p, 'utf8'));
  const ex = args.existsFn ?? ((p) => existsSync(p));

  const out: CollectorPostInput[] = [];
  for (const platform of args.platforms) {
    const dir = resolve(args.cwd, 'content', 'published', platform);
    if (!ex(dir)) continue;
    let files: string[];
    try {
      files = rd(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      try {
        const src = rf(resolve(dir, f));
        const url = extractPublishedUrl(src);
        if (url !== null) out.push({ platform, url });
      } catch {
        // best-effort: один битый файл не должен ломать сбор
      }
    }
  }
  return out;
}

/**
 * Discover-режим из pipeline.state Records: для каждой запуск-сессии, где
 * nodeStatuses.publish === 'ok', собираем artifact-пути и пробуем достать
 * published_url из их frontmatter'а. Используем как fallback к content/.
 */
export async function discoverPublishedPostsFromRecords(
  db: PrismaClient,
  args: { readFileFn?: (path: string) => string; existsFn?: (path: string) => boolean } = {},
): Promise<CollectorPostInput[]> {
  const rf = args.readFileFn ?? ((p) => readFileSync(p, 'utf8'));
  const ex = args.existsFn ?? ((p) => existsSync(p));

  // Берём ПОСЛЕДНЮЮ pipeline.state-запись на каждый runId.
  const rows = await db.$queryRawUnsafe<{ properties: string }[]>(
    `SELECT properties FROM "Record"
      WHERE type = 'pipeline.state'
        AND createdAt = (
          SELECT MAX(createdAt) FROM "Record" r2
           WHERE r2.type = 'pipeline.state'
             AND json_extract(r2.properties, '$.runId')
                  = json_extract("Record".properties, '$.runId')
        )`,
  );

  const out: CollectorPostInput[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    try {
      const state = JSON.parse(row.properties) as {
        nodeStatuses?: Record<string, string>;
        artifacts?: Record<string, string>;
      };
      const ns = state.nodeStatuses ?? {};
      // публикация: ищем любые ноды, чьё имя начинается с 'publish' и status='ok'.
      for (const [nodeId, status] of Object.entries(ns)) {
        if (status !== 'ok') continue;
        if (!nodeId.startsWith('publish')) continue;
        const artifactPath = state.artifacts?.[nodeId];
        if (artifactPath === undefined || !ex(artifactPath)) continue;
        let src: string;
        try {
          src = rf(artifactPath);
        } catch {
          continue;
        }
        const url = extractPublishedUrl(src);
        if (url === null) continue;
        const platform = guessPlatformFromPathOrId(artifactPath, nodeId);
        if (platform === null) continue;
        const key = `${platform}:${url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ platform, url });
      }
    } catch {
      // битый JSON или необычный shape — пропускаем
    }
  }
  return out;
}

function guessPlatformFromPathOrId(path: string, nodeId: string): Platform | null {
  const lower = `${path} ${nodeId}`.toLowerCase();
  if (lower.includes('/vc/') || lower.includes('vc-') || lower.includes('-vc.')) return 'vc';
  if (lower.includes('/dzen/') || lower.includes('dzen-') || lower.includes('-dzen.'))
    return 'dzen';
  if (lower.includes('/tg/') || lower.includes('tg-') || lower.includes('-tg.')) return 'tg';
  return null;
}

// ---------------------------------------------------------------------------
// Основная функция.
// ---------------------------------------------------------------------------

export interface CollectAnalyticsOptions {
  /** Override: явный список постов. Если задан — discover-режимы не запускаются. */
  posts?: CollectorPostInput[];
  /** Корень проекта (для резолва путей). По умолчанию — process.cwd(). */
  cwd?: string;
  /** Список платформ, по которым искать в `content/published/*`. */
  platforms?: Platform[];
  /** Использовать ли fallback discover из pipeline.state Records. По умолчанию — true. */
  useRecordsFallback?: boolean;
  /** DI для тестов: подмена spawn'а. */
  runSkillScript?: typeof defaultRunSkillScript;
  /** DI для тестов: подмена БД. */
  db?: PrismaClient;
  /** DI: текущая дата (для тестов). */
  now?: () => Date;
}

const DEFAULT_PLATFORMS: Platform[] = ['vc', 'dzen', 'tg'];
const ANALYTICS_SCRIPT_REL = 'skills/analytics-traffic/scripts/collect.ts';

export async function collectAnalyticsForPublished(
  opts: CollectAnalyticsOptions = {},
): Promise<CollectorRunSummary> {
  const cwd = opts.cwd ?? process.cwd();
  const db = opts.db ?? getPrisma();
  const runScript = opts.runSkillScript ?? defaultRunSkillScript;
  const now = opts.now ?? (() => new Date());
  const platforms = opts.platforms ?? DEFAULT_PLATFORMS;

  // 1. Резолвим список постов.
  let posts: CollectorPostInput[];
  if (opts.posts !== undefined) {
    posts = opts.posts;
  } else {
    posts = discoverPublishedPostsFromContent({ cwd, platforms });
    if (posts.length === 0 && opts.useRecordsFallback !== false) {
      posts = await discoverPublishedPostsFromRecords(db);
    }
  }

  if (posts.length === 0) {
    return { inserted: 0, deduplicated: 0, fetched: 0, metrics: [] };
  }

  // 2. Группируем по платформе.
  const byPlatform = new Map<Platform, string[]>();
  for (const p of posts) {
    const list = byPlatform.get(p.platform) ?? [];
    list.push(p.url);
    byPlatform.set(p.platform, list);
  }

  const scriptPath = resolve(cwd, ANALYTICS_SCRIPT_REL);
  const collectedAt = now().toISOString();
  const allMetrics: CollectorMetricResult[] = [];

  // 3. Вызываем collect.ts на каждую платформу один раз (батч URL'ов).
  for (const [platform, urls] of byPlatform.entries()) {
    if (urls.length === 0) continue;
    const result = await runScript({
      platform,
      urls,
      scriptPath,
      cwd,
    });

    const parsed = parseCollectOutput(result.json);
    if (parsed === null) {
      // Скрипт не вернул валидный JSON — фиксируем для всех URL ошибку
      // 'collect-script-failed', чтобы хотя бы видеть в журнале факт попытки.
      for (const url of urls) {
        allMetrics.push({
          platform,
          postUrl: url,
          views: 0,
          comments: 0,
          likes: 0,
          collectedAt,
          source: 'analytics-traffic',
          error: `collect.ts: invalid output (exit=${result.exitCode}, stderr=${truncate(result.stderr, 200)})`,
        });
      }
      continue;
    }

    for (const u of parsed.urls) {
      const m: CollectorMetricResult = {
        platform,
        postUrl: u.url,
        views: u.views ?? 0,
        comments: u.comments ?? 0,
        likes: u.likes ?? 0,
        collectedAt: parsed.collectedAt ?? collectedAt,
        source: 'analytics-traffic',
      };
      if (u.error !== undefined && u.error !== null && u.error !== '') {
        m.error = u.error;
      }
      allMetrics.push(m);
    }
  }

  // 4. Дедуп per (postUrl, UTC-день) — пишем только новые.
  const dayStartMs = startOfUtcDay(now());
  const dayEndMs = dayStartMs + 86_400_000;
  let inserted = 0;
  let deduplicated = 0;
  for (const metric of allMetrics) {
    const dup = await hasMetricForDay(db, metric.postUrl, dayStartMs, dayEndMs);
    if (dup) {
      deduplicated++;
      continue;
    }
    await insertSignalMetric(db, metric);
    inserted++;
  }

  return {
    inserted,
    deduplicated,
    fetched: allMetrics.length,
    metrics: allMetrics,
  };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

interface CollectScriptOutput {
  platform: Platform;
  urls: {
    url: string;
    views?: number;
    comments?: number;
    likes?: number;
    error?: string | null;
  }[];
  collectedAt?: string;
  errors?: string[];
}

function parseCollectOutput(json: unknown): CollectScriptOutput | null {
  if (typeof json !== 'object' || json === null) return null;
  const obj = json as Record<string, unknown>;
  if (typeof obj.platform !== 'string') return null;
  if (!Array.isArray(obj.urls)) return null;
  const urls: CollectScriptOutput['urls'] = [];
  for (const u of obj.urls as unknown[]) {
    if (typeof u !== 'object' || u === null) continue;
    const item = u as Record<string, unknown>;
    if (typeof item.url !== 'string') continue;
    urls.push({
      url: item.url,
      views: typeof item.views === 'number' ? item.views : 0,
      comments: typeof item.comments === 'number' ? item.comments : 0,
      likes: typeof item.likes === 'number' ? item.likes : 0,
      error: typeof item.error === 'string' ? item.error : null,
    });
  }
  return {
    platform: obj.platform as Platform,
    urls,
    collectedAt: typeof obj.collectedAt === 'string' ? obj.collectedAt : undefined,
  };
}

async function hasMetricForDay(
  db: PrismaClient,
  postUrl: string,
  dayStartMs: number,
  dayEndMs: number,
): Promise<boolean> {
  // count(*) в SQLite через Prisma $queryRawUnsafe возвращается как BigInt —
  // безопасный Number() покрывает оба случая.
  const rows = await db.$queryRawUnsafe<{ c: number | bigint }[]>(
    `SELECT count(*) as c FROM "Record"
      WHERE type = 'signal.metric'
        AND createdAt >= ? AND createdAt < ?
        AND json_extract(properties, '$.postUrl') = ?`,
    dayStartMs,
    dayEndMs,
    postUrl,
  );
  const c = Number(rows[0]?.c ?? 0);
  return Number.isFinite(c) && c > 0;
}

async function insertSignalMetric(db: PrismaClient, metric: CollectorMetricResult): Promise<void> {
  const id = ulid();
  const now = Date.now();
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'signal.metric', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    JSON.stringify(metric),
    now,
    now,
  );
}

function startOfUtcDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

// ---------------------------------------------------------------------------
// CLI entry — используется через `scripts/analytics-collect.ts`.
// ---------------------------------------------------------------------------

async function maybeMain(): Promise<void> {
  const isMainEntry = fileURLToPath(import.meta.url) === process.argv[1];
  if (!isMainEntry) return;
  const summary = await collectAnalyticsForPublished();
  console.log(JSON.stringify(summary));
}

maybeMain().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
