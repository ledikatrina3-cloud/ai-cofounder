import { describe, expect, it } from 'vitest';
import { parseSkill } from '../src/skills/parser.js';

describe('research-serp runtime permissions', () => {
  it('loads through the same parser used by routine skill resolution', async () => {
    const skill = await parseSkill('skills/research-serp');

    expect(skill.permissions.bashWhitelist).toContain(
      'pnpm exec tsx skills/research-serp/scripts/search.ts',
    );
  });
});
