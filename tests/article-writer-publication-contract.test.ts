import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

describe('article writer policy ownership and publication contract', () => {
  const playbook = read('org/article-editorial-playbook.md');
  const prompt = read('agents/article-writer/prompt.md');
  const skill = read('skills/article-writing/SKILL.md');
  const rules = read('agents/article-writer/rules.md');

  it('owns voice, mastery, references and structural diversity in the playbook', () => {
    for (const marker of [
      'Татьяны Мужицкой',
      'mastery/copywriting',
      'mastery/redaktor',
      'org/reference-blogs.md',
      'Структурное отличие статьи',
    ]) {
      expect(playbook).toContain(marker);
    }
    for (const entryPoint of [prompt, skill, rules]) {
      expect(entryPoint).not.toContain('Татьяны Мужицкой');
      expect(entryPoint).not.toContain('mastery/copywriting/igor-ledohovsky.md');
    }
  });

  it('allows links only for confirmed website publications', () => {
    expect(rules).toContain('content/published-articles.json');
    expect(rules).toContain('status: published');
    expect(rules).toMatch(/явн[\s\S]{0,80}(https:\/\/|публичн[\s\S]{0,40}URL)/i);
    expect(rules).toMatch(/ready[^\n]*не[^\n]*published/i);
  });

  it('starts with an empty publication registry', () => {
    expect(JSON.parse(read('content/published-articles.json'))).toEqual({ articles: [] });
  });

  it('keeps source evidence out of public markdown', () => {
    expect(rules).toContain('## Источники');
    expect(rules).toMatch(/запрещ|не добав/i);
    const article = read('content/kontrol-schetov-oplat-aktov.md');
    expect(article).not.toMatch(/^## Источники\s*$/m);
  });
});
