// Тесты для skills/analytics-traffic/scripts/collect.ts.
//
// Стратегия:
//   * `parseVcPage`, `extractPublishedUrl` — pure-функции на фикстурах.
//   * `collectMetrics` — мокаем fetcher и readDir/readFile.

import { describe, expect, it, vi } from 'vitest';
import {
  collectMetrics,
  extractPublishedUrl,
  parseVcPage,
  validateMetricUrl,
} from '../skills/analytics-traffic/scripts/collect.js';

describe('extractPublishedUrl', () => {
  it('извлекает published_url из frontmatter', () => {
    const src = `---
title: x
published_url: https://vc.ru/u/123-foo
---
body`;
    expect(extractPublishedUrl(src)).toBe('https://vc.ru/u/123-foo');
  });

  it('с кавычками', () => {
    const src = `---
published_url: "https://vc.ru/x"
---
body`;
    expect(extractPublishedUrl(src)).toBe('https://vc.ru/x');
  });

  it('null если нет frontmatter', () => {
    expect(extractPublishedUrl('no frontmatter')).toBeNull();
  });

  it('null если нет поля', () => {
    expect(extractPublishedUrl('---\ntitle: x\n---\nbody')).toBeNull();
  });
});

describe('parseVcPage', () => {
  it('извлекает метрики из JSON-фрагментов', () => {
    const html = `<html><script>{"hits":234,"commentsCount":12,"likes":{"summ":7}}</script></html>`;
    expect(parseVcPage(html)).toEqual({ views: 234, comments: 12, likes: 7 });
  });

  it('извлекает метрики из data-атрибутов', () => {
    const html = `<div data-counter-hits="100" data-comments-count="5" data-likes="2"></div>`;
    expect(parseVcPage(html)).toEqual({ views: 100, comments: 5, likes: 2 });
  });

  it('возвращает 0 для отсутствующих метрик', () => {
    expect(parseVcPage('<html></html>')).toEqual({ views: 0, comments: 0, likes: 0 });
  });
});

describe('collectMetrics (с моком fetch)', () => {
  it("vc: собирает метрики для URL'ов", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        `<meta property="og:title" content="test"/><script>{"hits":42,"commentsCount":3,"likes":{"summ":1}}</script> vc.ru`,
    })) as unknown as typeof fetch;
    const out = await collectMetrics({
      platform: 'vc',
      urls: ['https://vc.ru/u/1', 'https://vc.ru/u/2'],
      fetcher,
    });
    expect(out.platform).toBe('vc');
    expect(out.urls.length).toBe(2);
    expect(out.urls[0]?.views).toBe(42);
    expect(out.urls[0]?.error).toBeUndefined();
  });

  it('dzen: возвращает not-implemented для каждого URL', async () => {
    const out = await collectMetrics({
      platform: 'dzen',
      urls: ['https://dzen.ru/x'],
    });
    expect(out.urls[0]?.error).toMatch(/not-implemented/);
  });

  it('tg: возвращает not-implemented', async () => {
    const out = await collectMetrics({
      platform: 'tg',
      urls: ['https://t.me/x'],
    });
    expect(out.urls[0]?.error).toMatch(/not-implemented/);
  });

  it('vc: error при non-200', async () => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => '',
    })) as unknown as typeof fetch;
    const out = await collectMetrics({
      platform: 'vc',
      urls: ['https://vc.ru/missing'],
      fetcher,
    });
    expect(out.urls[0]?.error).toMatch(/404/);
  });

  it("fromContent: собирает URL'ы из frontmatter", async () => {
    type FsReaddir = typeof import('node:fs/promises').readdir;
    type FsReadFile = typeof import('node:fs/promises').readFile;
    const readDirFn = (async () => ['a.md', 'b.md', 'README.txt']) as unknown as FsReaddir;
    const readFileFn = (async (path: string) => {
      if (path.endsWith('a.md')) {
        return '---\npublished_url: https://vc.ru/a\n---\n';
      }
      if (path.endsWith('b.md')) {
        return '---\npublished_url: https://vc.ru/b\n---\n';
      }
      return '';
    }) as unknown as FsReadFile;
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        `vc.ru og: <script>{"hits":1,"commentsCount":0,"likes":{"summ":0}}</script>`,
    })) as unknown as typeof fetch;
    const out = await collectMetrics({
      platform: 'vc',
      urls: [],
      fromContent: 'content/published/vc',
      fetcher,
      readDirFn,
      readFileFn,
    });
    expect(out.urls.length).toBe(2);
    expect(out.urls.some((u) => u.url === 'https://vc.ru/a')).toBe(true);
    expect(out.urls.some((u) => u.url === 'https://vc.ru/b')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SSRF protection (Phase 8 security review). collect.ts получает URL через
// arg-line; LLM/state-corruption мог бы передать metadata-endpoint или
// internal-сервис. validateMetricUrl должен блокировать всё что не vc.ru
// (для platform=vc) и любые приватные диапазоны.
// ---------------------------------------------------------------------------

describe('validateMetricUrl (SSRF guard)', () => {
  it('allow обычный https://vc.ru/...', () => {
    const r = validateMetricUrl('https://vc.ru/u/123-foo', 'vc');
    expect(r.ok).toBe(true);
  });
  it('block AWS metadata 169.254.169.254', () => {
    const r = validateMetricUrl('http://169.254.169.254/latest/meta-data/', 'vc');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/private|internal/i);
  });
  it('block localhost', () => {
    expect(validateMetricUrl('http://localhost:5432/', 'vc').ok).toBe(false);
    expect(validateMetricUrl('http://127.0.0.1/', 'vc').ok).toBe(false);
  });
  it('block private RFC1918 — 10.0.0.0/8, 192.168.0.0/16, 172.16-31', () => {
    expect(validateMetricUrl('http://10.0.0.1/', 'vc').ok).toBe(false);
    expect(validateMetricUrl('http://192.168.1.1/', 'vc').ok).toBe(false);
    expect(validateMetricUrl('http://172.16.0.1/', 'vc').ok).toBe(false);
    expect(validateMetricUrl('http://172.31.255.254/', 'vc').ok).toBe(false);
  });
  it('block file:// и другие non-http протоколы', () => {
    expect(validateMetricUrl('file:///etc/passwd', 'vc').ok).toBe(false);
    expect(validateMetricUrl('ftp://example.com/', 'vc').ok).toBe(false);
    expect(validateMetricUrl('gopher://example.com/', 'vc').ok).toBe(false);
  });
  it('block subdomain-spoofing: evil-vc.ru.attacker.com', () => {
    const r = validateMetricUrl('https://evil-vc.ru.attacker.com/path', 'vc');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/whitelist/i);
  });
  it('block чужие платформы: dzen URL для platform=vc', () => {
    expect(validateMetricUrl('https://dzen.ru/foo', 'vc').ok).toBe(false);
  });
  it('block invalid URL', () => {
    expect(validateMetricUrl('not a url', 'vc').ok).toBe(false);
  });
});
