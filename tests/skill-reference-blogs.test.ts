// Тесты для skills/research-serp/scripts/reference-blogs.ts.
//
// Стратегия:
//   * без реальных сетевых вызовов;
//   * проверяем парсинг списка блогов, SSRF-защиту и обход внутренних ссылок.

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  collectReferenceBlogs,
  extractPageSummary,
  parseBlogList,
  validateReferenceUrl,
} from '../skills/research-serp/scripts/reference-blogs.js';

const INDEX_HTML = `
<html>
  <head>
    <title>Гайды по автоматизации</title>
    <meta name="description" content="Материалы про автоматизацию малого бизнеса.">
  </head>
  <body>
    <h1>Гайды</h1>
    <a href="/guides/zayavki">Заявки и автоматизация отдела продаж</a>
    <a href="https://example.com/guides/hr">HR документы</a>
    <a href="https://outside.example/article">Внешний материал</a>
  </body>
</html>
`;

const ARTICLE_HTML = `
<html>
  <head><title>Заявки без ручной рутины</title></head>
  <body>
    <h1>Как убрать ручные заявки</h1>
    <h2>Где владелец теряет время</h2>
    <p>Автоматизация помогает не переписывать заявки между таблицами.</p>
  </body>
</html>
`;

describe('parseBlogList', () => {
  it('достает уникальные https URL из markdown', () => {
    expect(
      parseBlogList(`
- https://example.com/guides
- https://example.com/guides
- http://not-used.example
- https://second.example/blog.
`),
    ).toEqual(['https://example.com/guides', 'https://second.example/blog']);
  });
});

describe('validateReferenceUrl', () => {
  it('запрещает localhost и приватные адреса', () => {
    expect(validateReferenceUrl('https://localhost/admin').ok).toBe(false);
    expect(validateReferenceUrl('https://127.0.0.1/admin').ok).toBe(false);
    expect(validateReferenceUrl('https://192.168.1.10/admin').ok).toBe(false);
  });

  it('разрешает публичный https URL', () => {
    expect(validateReferenceUrl('https://example.com/guides').ok).toBe(true);
  });
});

describe('extractPageSummary', () => {
  it('вытаскивает title, description, headings и matchedTerms', () => {
    const page = extractPageSummary('https://example.com/guides', INDEX_HTML, [
      'автоматизация',
      'заявки',
    ]);
    expect(page.title).toBe('Гайды по автоматизации');
    expect(page.description).toBe('Материалы про автоматизацию малого бизнеса.');
    expect(page.headings).toEqual(['Гайды']);
    expect(page.matchedTerms).toEqual(['автоматизация', 'заявки']);
  });
});

describe('collectReferenceBlogs', () => {
  it('открывает blog URL и релевантную внутреннюю страницу', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reference-blogs-'));
    const blogsFile = join(dir, 'reference-blogs.md');
    await writeFile(blogsFile, '- https://example.com/guides\n', 'utf8');

    const fetchedUrls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const currentUrl = String(url);
      fetchedUrls.push(currentUrl);
      return {
        ok: true,
        status: 200,
        text: async () => (currentUrl.endsWith('/guides/zayavki') ? ARTICLE_HTML : INDEX_HTML),
      };
    }) as unknown as typeof fetch;

    const out = await collectReferenceBlogs('автоматизация заявок', {
      blogsFile,
      fetcher,
      maxPagesPerBlog: 2,
    });

    expect(out.status).toBe('pass');
    expect(out.blogs[0]?.pages.map((page) => page.url)).toEqual([
      'https://example.com/guides',
      'https://example.com/guides/zayavki',
    ]);
    expect(fetchedUrls).toEqual([
      'https://example.com/guides',
      'https://example.com/guides/zayavki',
    ]);
  });
});
