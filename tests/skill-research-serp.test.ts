// Тесты для skills/research-serp/scripts/search.ts.
//
// Стратегия:
//   * `parseSerpHtml` — pure-функция, тестируется на fixture HTML.
//   * `fetchSerp` — мокаем fetch (нет реальных сетевых вызовов в тестах).

import { describe, expect, it, vi } from 'vitest';
import { fetchSerp, parseSerpHtml } from '../skills/research-serp/scripts/search.js';

// Минимальный DDG HTML-фрагмент — два result-блока. Реальный HTML гораздо
// объёмнее, но эти структуры — то, что мы парсим.
const FIXTURE_HTML = `
<html><body>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">First &amp; Best</a>
    <a class="result__snippet" href="https://example.com/a">Snippet text with &lt;tag&gt; and &nbsp; spaces.</a>
  </div>
  <div class="result">
    <a class="result__a" href="https://second.example/b">Second result</a>
    <a class="result__snippet" href="https://second.example/b">Another snippet here.</a>
  </div>
</body></html>
`;

describe('parseSerpHtml', () => {
  it('извлекает title, url, snippet из двух результатов', () => {
    const out = parseSerpHtml(FIXTURE_HTML, 10);
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({
      title: 'First & Best',
      url: 'https://example.com/a',
      snippet: 'Snippet text with <tag> and spaces.',
    });
    expect(out[1]).toEqual({
      title: 'Second result',
      url: 'https://second.example/b',
      snippet: 'Another snippet here.',
    });
  });

  it('обрезает по limit', () => {
    const out = parseSerpHtml(FIXTURE_HTML, 1);
    expect(out.length).toBe(1);
  });

  it('возвращает пустой массив для не-DDG HTML', () => {
    const out = parseSerpHtml('<html>no results</html>', 10);
    expect(out).toEqual([]);
  });
});

describe('fetchSerp (с моком fetch)', () => {
  it('возвращает results если fetch отдал валидный HTML', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => FIXTURE_HTML,
    })) as unknown as typeof fetch;
    const out = await fetchSerp('test topic', { fetcher });
    expect(out.errors).toEqual([]);
    expect(out.results.length).toBe(2);
    expect(out.topic).toBe('test topic');
  });

  it('возвращает error если fetch вернул non-200', async () => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => '',
    })) as unknown as typeof fetch;
    const out = await fetchSerp('test', { fetcher });
    expect(out.results).toEqual([]);
    expect(out.errors[0]).toMatch(/429/);
  });

  it('возвращает error если HTML без результатов', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '<html>empty</html>',
    })) as unknown as typeof fetch;
    const out = await fetchSerp('test', { fetcher });
    expect(out.results).toEqual([]);
    expect(out.errors[0]).toMatch(/капча|пуст|не вернул/i);
  });

  it('обрабатывает throw из fetch (network error)', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const out = await fetchSerp('test', { fetcher });
    expect(out.errors[0]).toMatch(/ECONNREFUSED/);
  });
});
