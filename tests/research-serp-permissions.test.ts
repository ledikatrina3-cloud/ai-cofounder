import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSkillSources } from '../src/skills/parser.js';

describe('research-serp permissions contract', () => {
  it('is accepted by the runtime parser and exposes both scripts', () => {
    const skillDir = resolve(process.cwd(), 'skills/research-serp');
    const skill = parseSkillSources(
      skillDir,
      readFileSync(resolve(skillDir, 'SKILL.md'), 'utf8'),
      readFileSync(resolve(skillDir, 'permissions.md'), 'utf8').replace(/\r?\n/g, '\r\n'),
    );

    expect(skill.permissions.bashWhitelist).toEqual([
      'pnpm exec tsx skills/research-serp/scripts/search.ts',
      'pnpm exec tsx skills/research-serp/scripts/reference-blogs.ts',
    ]);
  });
});
