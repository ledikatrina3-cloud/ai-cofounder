import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const registryUrl = new URL('../org/reference-blogs.md', import.meta.url);

describe('article reference registry', () => {
  it('contains exactly five unique reference rows with a purpose', () => {
    expect(existsSync(registryUrl)).toBe(true);

    const registry = readFileSync(registryUrl, 'utf8');
    const requiredUrls = [
      'https://smyslokod.ru/guides',
      'https://pimenov.ru/',
      'https://pimenov.ai/articles/kak-my-perenosili-pimenov-ru-s-tildy-na-svoyu-sistemu/',
      'https://pimenov.ai/cases/pimenov-ru-tilda-migration/',
      'https://t.me/s/findir_pro',
    ];

    const rows = registry
      .split(/\r?\n/)
      .map((line) => line.match(/^\|\s*(https:\/\/[^|\s]+)\s*\|\s*([^|]+?)\s*\|$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => ({ url: match[1], purpose: match[2]?.trim() ?? '' }));

    expect(rows).toHaveLength(5);
    expect(rows.map(({ url }) => url).sort()).toEqual([...requiredUrls].sort());
    expect(new Set(rows.map(({ url }) => url)).size).toBe(rows.length);
    for (const row of rows) expect(row.purpose.length).toBeGreaterThan(0);

    const telegram = rows.find(({ url }) => url === 'https://t.me/s/findir_pro');
    expect(telegram?.purpose).toMatch(/Telegram preview/i);
    expect(telegram?.purpose).toMatch(/(?:тематическ|вопрос|ракурс|противореч)/i);
  });
});
