// Регрессионные тесты: article agents должны реально открывать reference-блоги,
// а не ограничиваться SERP snippets.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const topicScoutPrompt = readFileSync('agents/article-topic-scout/prompt.md', 'utf8');
const briefResearcherPrompt = readFileSync('agents/article-brief-researcher/prompt.md', 'utf8');
const researchSerpSkill = readFileSync('skills/research-serp/SKILL.md', 'utf8');
const researchSerpPermissions = readFileSync('skills/research-serp/permissions.md', 'utf8');

describe('article reference-blog research prompts', () => {
  it('topic scout requires real reference-blog page checks', () => {
    expect(topicScoutPrompt).toContain('org/reference-blogs.md');
    expect(topicScoutPrompt).toContain('skills/research-serp/scripts/reference-blogs.ts');
    expect(topicScoutPrompt).toContain('referenceBlogsChecked');
    expect(topicScoutPrompt).toContain(
      'Never write "checked reference blogs" from memory or from SERP snippets only',
    );
  });

  it('brief researcher records opened reference-blog URLs', () => {
    expect(briefResearcherPrompt).toContain('org/reference-blogs.md');
    expect(briefResearcherPrompt).toContain('skills/research-serp/scripts/reference-blogs.ts');
    expect(briefResearcherPrompt).toContain('## 2.1 Reference-блоги');
    expect(briefResearcherPrompt).toContain('блоги проверены, если были только SERP snippets');
  });

  it('research-serp exposes reference-blog script and permission', () => {
    expect(researchSerpSkill).toContain('reference-blogs.ts');
    expect(researchSerpSkill).toContain('Pages opened');
    expect(researchSerpPermissions).toContain('skills/research-serp/scripts/reference-blogs.ts');
  });
});
