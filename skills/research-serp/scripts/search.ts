// research-serp/scripts/search.ts
//
// Бесплатный SERP через DuckDuckGo HTML endpoint (https://html.duckduckgo.com/html/).
// Возвращает топ-10 результатов как JSON.
//
// Использование:
//   pnpm exec tsx skills/research-serp/scripts/search.ts "<topic>" [--limit N]
//
// Контракт stdout:
//   {topic, results: [{title, url, snippet}], errors: []}
//
// LLM-вызовы внутри запрещены (anti-goal #5 из плана).
//
// Парсинг: regex по `<a class="result__a"` / `<a class="result__snippet"`.
// DDG HTML стабилен достаточно для MVP. Если поменяется — алёрт от
// health-check (Фаза 7).

import { fileURLToPath } from 'node:url';

export interface SerpResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SerpOutput {
  topic: string;
  results: SerpResult[];
  errors: string[];
}

const DEFAULT_LIMIT = 10;
const DDG_URL = 'https://html.duckduckgo.com/html/';

function parseArgs(argv: string[]): { topic: string | null; limit: number } {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flags = argv.filter((a) => a.startsWith('--'));
  const topic = positional[0] ?? null;
  let limit = DEFAULT_LIMIT;
  for (const f of flags) {
    if (f.startsWith('--limit=')) {
      const v = Number.parseInt(f.slice('--limit='.length), 10);
      if (Number.isFinite(v) && v > 0) limit = v;
    }
  }
  return { topic, limit };
}

function emit(out: SerpOutput): void {
  console.log(JSON.stringify(out));
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').trim();
}

/**
 * Декодирует «redirect-URL» DDG: `//duckduckgo.com/l/?uddg=ENCODED&...`.
 * Если не совпадает — возвращает исходную строку.
 */
function unwrapDdgRedirect(href: string): string {
  // DDG возвращает либо абсолютную ссылку, либо обёртку через /l/?uddg=...
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m !== null && m[1] !== undefined) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return href;
    }
  }
  if (href.startsWith('//')) return `https:${href}`;
  return href;
}

/**
 * Парсит HTML DDG-результатов в массив SerpResult. Экспортируется для
 * unit-тестов (без сетевых вызовов).
 */
export function parseSerpHtml(html: string, limit: number): SerpResult[] {
  const results: SerpResult[] = [];
  // Каждый результат у DDG — блок `<div class="result ...">` с внутри
  // <a class="result__a" href="...">TITLE</a>, <a class="result__snippet">SNIPPET</a>.
  // Мы идём по `result__a` как якорю, затем ищем ближайший snippet после него.
  const resultAnchorRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: classic regex iterate loop
  while ((m = resultAnchorRe.exec(html)) !== null) {
    if (results.length >= limit) break;
    const href = m[1];
    const titleRaw = m[2];
    if (href === undefined || titleRaw === undefined) continue;
    const url = unwrapDdgRedirect(href);
    const title = decodeHtmlEntities(stripTags(titleRaw));
    // Ищем следующий result__snippet после позиции m.index.
    const tail = html.slice(m.index);
    const snipMatch = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(tail);
    let snippet = '';
    if (snipMatch !== null && snipMatch[1] !== undefined) {
      snippet = decodeHtmlEntities(stripTags(snipMatch[1])).replace(/\s+/g, ' ').trim();
    }
    if (title === '' || url === '') continue;
    results.push({ title, url, snippet });
  }
  return results;
}

export interface FetchSerpOptions {
  /** DI для тестов: подменить fetch. */
  fetcher?: typeof fetch;
  limit?: number;
}

/**
 * Делает запрос к DDG и парсит ответ. Экспортируется отдельно от main()
 * для тестов.
 */
export async function fetchSerp(
  topic: string,
  options: FetchSerpOptions = {},
): Promise<SerpOutput> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const f = options.fetcher ?? fetch;
  const body = new URLSearchParams({ q: topic }).toString();
  try {
    const resp = await f(DDG_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // DDG требует User-Agent. Маскируемся под обычный браузер.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'text/html',
      },
      body,
    });
    if (!resp.ok) {
      return {
        topic,
        results: [],
        errors: [`DDG returned status ${resp.status}`],
      };
    }
    const html = await resp.text();
    const results = parseSerpHtml(html, limit);
    if (results.length === 0) {
      return {
        topic,
        results: [],
        errors: ['DDG не вернул результатов (возможно, капча или rate-limit)'],
      };
    }
    return { topic, results, errors: [] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { topic, results: [], errors: [`fetch error: ${msg}`] };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.topic === null || args.topic.trim() === '') {
    emit({ topic: '', results: [], errors: ['нет аргумента <topic>'] });
    process.exit(1);
  }
  const topic = (args.topic as string).trim();
  const out = await fetchSerp(topic, { limit: args.limit });
  emit(out);
}

const isMainEntry = fileURLToPath(import.meta.url) === process.argv[1];
if (isMainEntry) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    emit({ topic: '', results: [], errors: [`uncaught: ${msg}`] });
    process.exit(1);
  });
}
