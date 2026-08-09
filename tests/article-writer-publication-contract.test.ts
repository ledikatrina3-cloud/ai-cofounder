import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

describe('article writer mastery and publication contract', () => {
  const prompt = read('agents/article-writer/prompt.md');
  const skill = read('skills/article-writing/SKILL.md');
  const rules = read('agents/article-writer/rules.md');

  it('continues from a complete local brief when public SERP is unavailable', () => {
    expect(prompt).toContain('SERP unavailable не останавливает локально подтверждённую статью');
    expect(prompt).toContain('не используй внешние факты, цифры, цитаты');
    expect(prompt).toContain('продолжай по brief, локальному контексту и mastery');
  });

  it('requires topical mastery before drafting and redaktor mastery after drafting', () => {
    for (const contract of [prompt, skill, rules]) {
      expect(contract).toContain('mastery/redaktor/INDEX.md');
      expect(contract).toMatch(/точн[^\n]*пут/i);
      expect(contract).toMatch(/примен[её]н[^\n]*метод/i);
    }
  });

  it('requires Ledohovsky writing mastery before the first full draft', () => {
    for (const contract of [prompt, skill, rules]) {
      expect(contract).toContain('mastery/copywriting/INDEX.md');
      expect(contract).toContain('mastery/copywriting/igor-ledohovsky.md');
      expect(contract).toMatch(/до (первого полного )?(драфта|черновика)/i);
      expect(contract).toMatch(/примен[её]н[^\n]*метод/i);
    }
  });

  it('requires natural business language instead of decorative metaphors', () => {
    for (const contract of [prompt, skill, rules]) {
      expect(contract).toContain('рабочей встрече');
      expect(contract).toContain('самая частая жалоба');
      expect(contract).toMatch(/метафор/i);
    }
  });

  it('allows article links only from the website publication registry', () => {
    for (const contract of [prompt, skill, rules]) {
      expect(contract).toContain('content/published-articles.json');
      expect(contract).toContain('status: published');
      expect(contract).toMatch(/явн[^\n]*(https:\/\/|публичн[^\n]*URL)/i);
      expect(contract).toMatch(/ready[^\n]*не[^\n]*published/i);
    }
  });

  it('starts with an empty publication registry', () => {
    const registry = JSON.parse(read('content/published-articles.json')) as { articles?: unknown[] };
    expect(registry).toEqual({ articles: [] });
  });

  it('keeps source evidence out of public markdown', () => {
    for (const contract of [prompt, skill, rules]) {
      expect(contract).toContain('## Источники');
      expect(contract).toMatch(/запрещ|не должен|не добав/i);
    }
    const article = read('content/kontrol-schetov-oplat-aktov.md');
    expect(article).not.toMatch(/^## Источники\s*$/m);
    expect(article).not.toMatch(/\]\(\/(ruchnoy-vvod|poteryannye-zayavki-do-pervogo-otveta)\)/);
  });
});
