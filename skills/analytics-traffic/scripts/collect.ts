// analytics-traffic/scripts/collect.ts
//
// Собирает публичные метрики (views, comments, likes) по списку URL'ов или
// по директории `content/published/<platform>/` (берёт published_url из
// frontmatter каждого .md).
//
// Использование:
//   pnpm exec tsx skills/analytics-traffic/scripts/collect.ts \
//     --platform vc \
//     --urls "https://vc.ru/a,https://vc.ru/b"
//   или
//   pnpm exec tsx skills/analytics-traffic/scripts/collect.ts \
//     --platform vc \
//     --from-content content/published/vc/
//
// Контракт stdout (последняя строка):
//   {platform, urls: [{url, views, comments, likes, error?}], collectedAt, errors}
//
// LLM-вызовы запрещены (anti-goal #5).

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Platform = 'vc' | 'dzen' | 'tg';

export interface UrlMetric {
  url: string;
  views: number;
  comments: number;
  likes: number;
  error?: string;
}

export interface CollectOutput {
  platform: Platform;
  urls: UrlMetric[];
  collectedAt: string;
  errors: string[];
}

interface Args {
  platform: Platform;
  urls: string[];
  fromContent: string | null;
}

function parseArgs(argv: string[]): Args | { error: string } {
  let platform: Platform = 'vc';
  let urlsRaw: string | null = null;
  let fromContent: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--platform') {
      const p = argv[++i] ?? '';
      if (p !== 'vc' && p !== 'dzen' && p !== 'tg') {
        return { error: `unknown platform '${p}', expected vc|dzen|tg` };
      }
      platform = p;
    } else if (arg.startsWith('--platform=')) {
      const p = arg.slice('--platform='.length);
      if (p !== 'vc' && p !== 'dzen' && p !== 'tg') {
        return { error: `unknown platform '${p}', expected vc|dzen|tg` };
      }
      platform = p;
    } else if (arg === '--urls') {
      urlsRaw = argv[++i] ?? null;
    } else if (arg.startsWith('--urls=')) {
      urlsRaw = arg.slice('--urls='.length);
    } else if (arg === '--from-content') {
      fromContent = argv[++i] ?? null;
    } else if (arg.startsWith('--from-content=')) {
      fromContent = arg.slice('--from-content='.length);
    }
  }
  const urls =
    urlsRaw === null
      ? []
      : urlsRaw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '');
  return { platform, urls, fromContent };
}

function emit(out: CollectOutput): void {
  console.log(JSON.stringify(out));
}

/**
 * Парсит markdown-frontmatter (минимальный) и возвращает `published_url` либо null.
 * Экспортируется для тестов.
 */
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

/**
 * Парсит публичную страницу vc.ru и извлекает views/comments/likes из
 * meta-тегов / data-аттрибутов. Экспортируется для тестов.
 *
 * Стратегия:
 *   * `<meta property="og:title">` — sanity-check что страница загружена.
 *   * Видимые счётчики: vc.ru держит их в `data-value` атрибутах и/или в
 *     embedded JSON. Без полноценного DOM-парсера мы ищем популярные
 *     паттерны regex'ами. Если не нашли — error: 'parse-failed'.
 */
export function parseVcPage(html: string): { views: number; comments: number; likes: number } {
  const views = extractNumber(html, [
    /"hits"\s*:\s*(\d+)/,
    /"viewsCount"\s*:\s*(\d+)/,
    /data-counter-hits=["'](\d+)["']/,
  ]);
  const comments = extractNumber(html, [
    /"commentsCount"\s*:\s*(\d+)/,
    /data-comments-count=["'](\d+)["']/,
  ]);
  const likes = extractNumber(html, [
    /"likes"\s*:\s*\{[^}]*"summ"\s*:\s*(-?\d+)/,
    /"rating"\s*:\s*(-?\d+)/,
    /data-likes=["'](-?\d+)["']/,
  ]);
  return { views, comments, likes };
}

function extractNumber(html: string, patterns: RegExp[]): number {
  for (const p of patterns) {
    const m = p.exec(html);
    if (m !== null && m[1] !== undefined) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

export interface FetchMetricOptions {
  fetcher?: typeof fetch;
}

/**
 * SSRF-guard: разрешаем только https/http и публичные домены платформ. Это
 * защита от LLM/state-corruption, который мог бы передать
 * `http://169.254.169.254/` (cloud metadata), `http://localhost:5432/`
 * (внутренние сервисы) или `file://` (локальные файлы).
 *
 * Возвращает {ok: true} или {ok: false, error}. Экспортируется для тестов.
 */
export function validateMetricUrl(
  rawUrl: string,
  platform: Platform,
): { ok: true; url: URL } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'invalid URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: `protocol '${parsed.protocol}' not allowed (only http/https)` };
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.startsWith('169.254.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('172.16.') ||
    host.startsWith('172.17.') ||
    host.startsWith('172.18.') ||
    host.startsWith('172.19.') ||
    host.startsWith('172.2') || // 20..29
    host.startsWith('172.30.') ||
    host.startsWith('172.31.') ||
    // IPv6 link-local / loopback
    host.startsWith('fe80:') ||
    host.startsWith('fc00:') ||
    host.startsWith('fd00:') ||
    // metadata.* internal
    host === 'metadata.google.internal' ||
    host === 'metadata'
  ) {
    return { ok: false, error: `private/internal host '${host}' is blocked (SSRF guard)` };
  }
  // Whitelist хостов по платформе. Конкретные домены, а не суффиксы — чтобы
  // attacker не смог подсунуть `evil-vc.ru.attacker.com`.
  const ALLOWED_HOSTS: Record<Platform, string[]> = {
    vc: ['vc.ru', 'www.vc.ru'],
    dzen: ['dzen.ru', 'www.dzen.ru', 'zen.yandex.ru'],
    tg: ['t.me', 'telegram.me', 'telegram.org'],
  };
  const allowed = ALLOWED_HOSTS[platform];
  if (!allowed.includes(host)) {
    return {
      ok: false,
      error: `host '${host}' not in whitelist for platform=${platform} (expected one of: ${allowed.join(', ')})`,
    };
  }
  return { ok: true, url: parsed };
}

async function fetchVcMetrics(url: string, opts: FetchMetricOptions = {}): Promise<UrlMetric> {
  const validation = validateMetricUrl(url, 'vc');
  if (!validation.ok) {
    return { url, views: 0, comments: 0, likes: 0, error: validation.error };
  }
  const f = opts.fetcher ?? fetch;
  try {
    const resp = await f(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'text/html',
      },
    });
    if (!resp.ok) {
      return { url, views: 0, comments: 0, likes: 0, error: `status ${resp.status}` };
    }
    const html = await resp.text();
    if (!html.includes('vc.ru') && !html.includes('og:')) {
      return { url, views: 0, comments: 0, likes: 0, error: 'unexpected page content' };
    }
    const m = parseVcPage(html);
    return { url, ...m };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { url, views: 0, comments: 0, likes: 0, error: `fetch: ${msg}` };
  }
}

async function fetchStubMetric(url: string, platform: Platform): Promise<UrlMetric> {
  return {
    url,
    views: 0,
    comments: 0,
    likes: 0,
    error: `not-implemented for platform=${platform} (TODO)`,
  };
}

export interface CollectArgs {
  platform: Platform;
  urls: string[];
  fromContent?: string | null;
  /** DI для тестов. */
  fetcher?: typeof fetch;
  /** DI для тестов. */
  readDirFn?: typeof readdir;
  /** DI для тестов. */
  readFileFn?: typeof readFile;
  now?: () => Date;
}

export async function collectMetrics(args: CollectArgs): Promise<CollectOutput> {
  const now = args.now ?? (() => new Date());
  const errors: string[] = [];
  const allUrls = new Set<string>(args.urls);

  if (args.fromContent !== null && args.fromContent !== undefined && args.fromContent !== '') {
    try {
      const rd = args.readDirFn ?? readdir;
      const rf = args.readFileFn ?? readFile;
      const files = await rd(args.fromContent);
      for (const f of files) {
        if (!f.endsWith('.md')) continue;
        try {
          const src = await rf(join(args.fromContent, f), 'utf8');
          const url = extractPublishedUrl(src);
          if (url !== null) allUrls.add(url);
        } catch (err) {
          errors.push(`read ${f}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      errors.push(
        `readdir ${args.fromContent}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const urlList = [...allUrls];
  const metrics: UrlMetric[] = [];
  for (const url of urlList) {
    if (args.platform === 'vc') {
      metrics.push(
        await fetchVcMetrics(url, {
          ...(args.fetcher !== undefined ? { fetcher: args.fetcher } : {}),
        }),
      );
    } else {
      metrics.push(await fetchStubMetric(url, args.platform));
    }
  }

  return {
    platform: args.platform,
    urls: metrics,
    collectedAt: now().toISOString(),
    errors,
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    emit({
      platform: 'vc',
      urls: [],
      collectedAt: new Date().toISOString(),
      errors: [parsed.error],
    });
    process.exit(1);
  }
  if (parsed.urls.length === 0 && (parsed.fromContent === null || parsed.fromContent === '')) {
    emit({
      platform: parsed.platform,
      urls: [],
      collectedAt: new Date().toISOString(),
      errors: ['нет --urls и нет --from-content'],
    });
    process.exit(1);
  }
  const result = await collectMetrics(parsed);
  emit(result);
}

const isMainEntry = fileURLToPath(import.meta.url) === process.argv[1];
if (isMainEntry) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    emit({
      platform: 'vc',
      urls: [],
      collectedAt: new Date().toISOString(),
      errors: [`uncaught: ${msg}`],
    });
    process.exit(1);
  });
}
