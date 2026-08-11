import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const playbookPath = 'org/article-editorial-playbook.md';
const entryPointPaths = [
  'agents/article-writer/prompt.md',
  'agents/article-writer/rules.md',
  'skills/article-writing/SKILL.md',
] as const;

const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const entryPoints = entryPointPaths.map((path) => ({ path, content: read(path) }));
const playbook = existsSync(new URL(playbookPath, root)) ? read(playbookPath) : '';

describe('article editorial architecture', () => {
  it('has one canonical editorial playbook', () => {
    expect(existsSync(new URL(playbookPath, root))).toBe(true);
    expect(playbook).toMatch(/voice/i);
    expect(playbook).toMatch(/mastery application/i);
    expect(playbook).toMatch(/reference patterns/i);
    expect(playbook).toMatch(/structural diversity/i);
  });

  it.each(entryPoints)('$path references the canonical playbook exactly once', ({ content }) => {
    const references = content.match(/org\/article-editorial-playbook\.md/g) ?? [];

    expect(references).toHaveLength(1);
  });

  it('keeps detailed editorial policy out of writer entry points', () => {
    const canonicalOnlyMarkers = [
      { concern: 'voice', pattern: /Татьяны Мужицкой/i },
      { concern: 'mastery application', pattern: /mastery\/copywriting\/igor-ledohovsky\.md/i },
      { concern: 'reference patterns', pattern: /reference[- ]patterns/i },
      { concern: 'structural diversity', pattern: /structural diversity/i },
    ];

    for (const { path, content } of entryPoints) {
      for (const { concern, pattern } of canonicalOnlyMarkers) {
        expect.soft(content, `${concern} policy is duplicated in ${path}`).not.toMatch(pattern);
      }
    }
  });
});
