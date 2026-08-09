// research-serp/scripts/reference-blogs.ts
//
// Открывает явно заданные reference-блоги и несколько внутренних страниц,
// чтобы topic scout / brief researcher сверяли не только SERP snippets.
//
// Использование:
//   pnpm exec tsx skills/research-serp/scripts/reference-blogs.ts --topic "<topic>" --blogs-file org/reference-blogs.md
//
// Контракт stdout:
//   {topic, status, blogs: [{url, status, pages: [...]}], errors: []}
//
// LLM-вызовы внутри запрещены. Куки, токены и .env не читаются.

import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

export interface ReferenceBlogPage {
  url: string;
  status: 'pass' | 'failed';
  title: string;
  description: string;
  headings: string[];
  matchedTerms: string[];
  snippet: string;
  error?: string;
}

export interface ReferenceBlogResult {
  url: string;
  status: 'pass' | 'failed' | 'invalid';
  pages: ReferenceBlogPage[];
  errors: string[];
}

export interface ReferenceBlogsOutput {
  topic: string;
  blogsFile: string;
  status: 'pass' | 'missing_blogs_file' | 'empty' | 'failed';
  blogs: ReferenceBlogResult[];
  errors: string[];
}

export interface CollectReferenceBlogsOptions {
  blogsFile?: string;
  fetcher?: typeof fetch;
  maxPagesPerBlog?: number;
  timeoutMs?: number;
}

interface CliArgs {
  topic: string | null;
  blogsFile: string;
  maxPagesPerBlog: number;
}

interface LinkCandidate {
  url: string;
  text: string;
  score: number;
}

const DEFAULT_BLOGS_FILE = 'org/reference-blogs.md';
const DEFAULT_MAX_PAGES_PER_BLOG = 3;
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_HTML_CHARS = 260_000;
const MAX_SNIPPET_CHARS = 900;
const MAX_LINKS_TO_SCORE = 80;

function parseArgs(argv: string[]): CliArgs {
  let topic: string | null = null;
  let blogsFile = DEFAULT_BLOGS_FILE;
  let maxPagesPerBlog = DEFAULT_MAX_PAGES_PER_BLOG;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '--topic') {
      topic = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg.startsWith('--topic=')) {
      topic = arg.slice('--topic='.length);
      continue;
    }
    if (arg === '--blogs-file') {
      blogsFile = argv[i + 1] ?? blogsFile;
      i += 1;
      continue;
    }
    if (arg.startsWith('--blogs-file=')) {
      blogsFile = arg.slice('--blogs-file='.length);
      continue;
    }
    if (arg === '--max-pages') {
      maxPagesPerBlog = parsePositiveInt(argv[i + 1], maxPagesPerBlog);
      i += 1;
      continue;
    }
    if (arg.startsWith('--max-pages=')) {
      maxPagesPerBlog = parsePositiveInt(arg.slice('--max-pages='.length), maxPagesPerBlog);
      continue;
    }
    if (!arg.startsWith('--') && topic === null) {
      topic = arg;
    }
  }

  return { topic, blogsFile, maxPagesPerBlog };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function emit(out: ReferenceBlogsOutput): void {
  console.log(JSON.stringify(out));
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ');
}

function cleanText(s: string): string {
  return decodeHtmlEntities(stripTags(s)).replace(/\s+/g, ' ').trim();
}

function extractAttr(tag: string, attr: string): string | null {
  const re = new RegExp(`${attr}\\s*=\\s*(["'])(.*?)\\1`, 'i');
  const match = re.exec(tag);
  return match?.[2] ?? null;
}

export function parseBlogList(markdown: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const re = /https:\/\/[^\s<>)\]]+/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: classic regex iterate loop
  while ((match = re.exec(markdown)) !== null) {
    const raw = match[0]?.replace(/[.,;:]+$/g, '') ?? '';
    if (raw === '' || seen.has(raw)) continue;
    seen.add(raw);
    urls.push(raw);
  }
  return urls;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (!host.includes('.') && isIP(host) === 0) return true;

  const ipKind = isIP(host);
  if (ipKind === 4) {
    const parts = host.split('.').map((part) => Number.parseInt(part, 10));
    const [a, b] = parts;
    if (a === undefined || b === undefined) return true;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }

  if (ipKind === 6) {
    return (
      host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')
    );
  }

  return false;
}

export function validateReferenceUrl(
  rawUrl: string,
): { ok: true; url: URL } | { ok: false; error: string } {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return { ok: false, error: 'reference URL must be https' };
    if (isPrivateHostname(url.hostname))
      return { ok: false, error: 'reference URL points to private host' };
    return { ok: true, url };
  } catch {
    return { ok: false, error: 'invalid reference URL' };
  }
}

function topicTerms(topic: string): string[] {
  const seen = new Set<string>();
  const terms = topic
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4);

  for (const term of terms) seen.add(term);
  return Array.from(seen);
}

function matchTerms(text: string, terms: string[]): string[] {
  const lower = text.toLowerCase();
  return terms.filter((term) => lower.includes(term));
}

function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1] !== undefined ? cleanText(match[1]) : '';
}

function extractDescription(html: string): string {
  const metaRe = /<meta\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: classic regex iterate loop
  while ((match = metaRe.exec(html)) !== null) {
    const tag = match[0] ?? '';
    const name = extractAttr(tag, 'name')?.toLowerCase();
    const property = extractAttr(tag, 'property')?.toLowerCase();
    if (name !== 'description' && property !== 'og:description') continue;
    return cleanText(extractAttr(tag, 'content') ?? '');
  }
  return '';
}

function extractHeadings(html: string): string[] {
  const headings: string[] = [];
  const re = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: classic regex iterate loop
  while ((match = re.exec(html)) !== null) {
    const text = match[1] !== undefined ? cleanText(match[1]) : '';
    if (text !== '' && !headings.includes(text)) headings.push(text);
    if (headings.length >= 12) break;
  }
  return headings;
}

function extractVisibleText(html: string): string {
  return cleanText(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' '),
  );
}

function extractLinks(html: string, baseUrl: URL, terms: string[]): LinkCandidate[] {
  const links: LinkCandidate[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  // biome-ignore lint/suspicious/noAssignInExpressions: classic regex iterate loop
  while ((match = re.exec(html)) !== null) {
    if (links.length >= MAX_LINKS_TO_SCORE) break;
    const href = match[2];
    const text = match[3] !== undefined ? cleanText(match[3]) : '';
    if (href === undefined || text.length < 3) continue;

    let url: URL;
    try {
      url = new URL(decodeHtmlEntities(href), baseUrl);
    } catch {
      continue;
    }

    url.hash = '';
    if (url.protocol !== 'https:' || url.origin !== baseUrl.origin) continue;
    if (url.pathname === baseUrl.pathname && url.search === baseUrl.search) continue;
    if (seen.has(url.toString())) continue;

    const haystack = `${text} ${url.pathname}`.toLowerCase();
    const matched = matchTerms(haystack, terms);
    const score = matched.length * 10 + (/[а-яa-z0-9]{8,}/i.test(text) ? 1 : 0);
    seen.add(url.toString());
    links.push({ url: url.toString(), text, score });
  }

  return links.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
}

export function extractPageSummary(url: string, html: string, terms: string[]): ReferenceBlogPage {
  const visibleText = extractVisibleText(html);
  const title = extractTitle(html);
  const description = extractDescription(html);
  const headings = extractHeadings(html);
  const snippetSource = description !== '' ? description : visibleText;
  const summaryText = `${title} ${description} ${headings.join(' ')} ${visibleText}`;

  return {
    url,
    status: 'pass',
    title,
    description,
    headings,
    matchedTerms: matchTerms(summaryText, terms),
    snippet: snippetSource.slice(0, MAX_SNIPPET_CHARS),
  };
}

async function fetchHtml(
  url: string,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<{ ok: true; html: string } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetcher(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; AI-Cofounder-Research/1.0; +https://github.com/artemiimillier/ai-cofounder)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7',
      },
    });

    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const html = (await response.text()).slice(0, MAX_HTML_CHARS);
    if (html.trim() === '') return { ok: false, error: 'empty HTML' };
    return { ok: true, html };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function collectOneBlog(
  rawUrl: string,
  topic: string,
  fetcher: typeof fetch,
  maxPagesPerBlog: number,
  timeoutMs: number,
): Promise<ReferenceBlogResult> {
  const validation = validateReferenceUrl(rawUrl);
  if (!validation.ok) {
    return { url: rawUrl, status: 'invalid', pages: [], errors: [validation.error] };
  }

  const baseUrl = validation.url;
  const terms = topicTerms(topic);
  const pages: ReferenceBlogPage[] = [];
  const errors: string[] = [];
  const first = await fetchHtml(baseUrl.toString(), fetcher, timeoutMs);

  if (!first.ok) {
    return { url: baseUrl.toString(), status: 'failed', pages, errors: [first.error] };
  }

  pages.push(extractPageSummary(baseUrl.toString(), first.html, terms));

  const links = extractLinks(first.html, baseUrl, terms).slice(0, Math.max(0, maxPagesPerBlog - 1));
  for (const link of links) {
    const fetched = await fetchHtml(link.url, fetcher, timeoutMs);
    if (!fetched.ok) {
      errors.push(`${link.url}: ${fetched.error}`);
      continue;
    }
    pages.push(extractPageSummary(link.url, fetched.html, terms));
  }

  return {
    url: baseUrl.toString(),
    status: pages.length > 0 ? 'pass' : 'failed',
    pages,
    errors,
  };
}

export async function collectReferenceBlogs(
  topic: string,
  options: CollectReferenceBlogsOptions = {},
): Promise<ReferenceBlogsOutput> {
  const blogsFile = options.blogsFile ?? DEFAULT_BLOGS_FILE;
  const fetcher = options.fetcher ?? fetch;
  const maxPagesPerBlog = options.maxPagesPerBlog ?? DEFAULT_MAX_PAGES_PER_BLOG;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let fileText: string;
  try {
    fileText = await readFile(blogsFile, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      topic,
      blogsFile,
      status: 'missing_blogs_file',
      blogs: [],
      errors: [`cannot read ${blogsFile}: ${msg}`],
    };
  }

  const urls = parseBlogList(fileText);
  if (urls.length === 0) {
    return {
      topic,
      blogsFile,
      status: 'empty',
      blogs: [],
      errors: [`${blogsFile} has no https URLs`],
    };
  }

  const blogs: ReferenceBlogResult[] = [];
  for (const url of urls) {
    blogs.push(await collectOneBlog(url, topic, fetcher, maxPagesPerBlog, timeoutMs));
  }

  const hasPass = blogs.some((blog) => blog.status === 'pass' && blog.pages.length > 0);
  return {
    topic,
    blogsFile,
    status: hasPass ? 'pass' : 'failed',
    blogs,
    errors: blogs.flatMap((blog) => blog.errors.map((error) => `${blog.url}: ${error}`)),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.topic === null || args.topic.trim() === '') {
    emit({
      topic: '',
      blogsFile: args.blogsFile,
      status: 'failed',
      blogs: [],
      errors: ['нет аргумента --topic'],
    });
    process.exit(1);
  }

  const out = await collectReferenceBlogs(args.topic.trim(), {
    blogsFile: args.blogsFile,
    maxPagesPerBlog: args.maxPagesPerBlog,
  });
  emit(out);
}

const isMainEntry = fileURLToPath(import.meta.url) === process.argv[1];
if (isMainEntry) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    emit({
      topic: '',
      blogsFile: DEFAULT_BLOGS_FILE,
      status: 'failed',
      blogs: [],
      errors: [`uncaught: ${msg}`],
    });
    process.exit(1);
  });
}
