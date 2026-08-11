import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const registryUrl = new URL('../org/reference-blogs.md', import.meta.url);

describe('article reference registry', () => {
  it('keeps existing references and the public thematic Telegram preview', () => {
    expect(existsSync(registryUrl)).toBe(true);

    const registry = readFileSync(registryUrl, 'utf8');
    const requiredUrls = [
      'https://smyslokod.ru/guides',
      'https://pimenov.ru/',
      'https://pimenov.ai/articles/kak-my-perenosili-pimenov-ru-s-tildy-na-svoyu-sistemu/',
      'https://pimenov.ai/cases/pimenov-ru-tilda-migration/',
      'https://t.me/s/findir_pro',
    ];

    for (const url of requiredUrls) {
      expect(registry).toContain(url);
    }

    expect(registry).toMatch(/Telegram preview/i);
    expect(registry).toMatch(/(?:тематическ|вопрос|ракурс|противореч)/i);
  });
});
