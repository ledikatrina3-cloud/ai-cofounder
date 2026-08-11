import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('article writer orchestration contract', () => {
  const runtimePrompt = read('agents/article-writer/prompt.md');
  const rootPrompt = read('article-writer-prompt.md');
  const examplePrompt = read('examples/agents/article-writer/prompt.md');
  const rules = read('agents/article-writer/rules.md');
  const skill = read('skills/article-writing/SKILL.md');

  it('keeps all distributed prompt copies identical', () => {
    expect(rootPrompt).toBe(runtimePrompt);
    expect(examplePrompt).toBe(runtimePrompt);
  });

  it('orchestrates the complete article run through concrete artifacts', () => {
    for (const marker of [
      'content/briefs/article-brief-latest.md',
      'topics/article-writer-next.md',
      'content/<slug>.checklist.md',
      'content/<slug>.editorial-context.json',
      'scripts/article-editorial-context.mjs',
      '--validate-evidence',
      'content/<slug>.md',
      'content/<slug>.html',
      'content/<slug>.qa/',
      'tools/article-writing/ai-cadence-check.py',
      'tools/article-writing/read-aloud-check.py',
      'tools/article-writing/structure-check.py',
      'scripts/article-business-readability-check.mjs',
    ]) {
      expect(runtimePrompt).toContain(marker);
    }
  });

  it('requires Telegram attachment paths in every completion report', () => {
    expect(runtimePrompt).toContain('Artifacts:');
    expect(runtimePrompt).toContain('article: content/<slug>.md');
    expect(runtimePrompt).toContain('html: content/<slug>.html');
    expect(runtimePrompt).toContain('cover: content/<slug>-cover.png');
    expect(runtimePrompt).toContain('cover: content/<slug>-cover.svg');
    expect(runtimePrompt).toMatch(/draft[\s\S]+Artifacts:/i);
  });

  it('keeps business framing and research fallback in orchestration', () => {
    expect(runtimePrompt).toContain('умного владельца бизнеса без технического бэкграунда');
    expect(runtimePrompt).toContain('SERP unavailable');
    expect(runtimePrompt).toMatch(/не\s+используй\s+внешние\s+факты,\s+цифры\s+или\s+цитаты/i);
    expect(runtimePrompt).toContain('needs_human_review');
  });

  it('keeps immutable publication and privacy constraints in rules', () => {
    for (const marker of [
      'content/published-articles.json',
      'status: published',
      'status: ready',
      '## Источники',
      'Внешняя публикация',
      'Конфиденциальность',
      'Не выдумывай',
    ]) {
      expect(rules).toContain(marker);
    }
  });

  it('keeps the skill as a thin invocation guide', () => {
    expect(skill).toContain('agents/article-writer/prompt.md');
    expect(skill).toContain('content/<slug>.checklist.md');
    expect(skill).toContain('content/<slug>.editorial-context.json');
    expect(skill).toContain('scripts/article-editorial-context.mjs');
    expect(skill).not.toContain('Татьяны Мужицкой');
    expect(skill.length).toBeLessThan(4000);
  });
});
