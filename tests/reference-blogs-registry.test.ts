import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('reference blog registry', () => {
  it('keeps the founder-provided editorial references', () => {
    const registry = readFileSync('org/reference-blogs.md', 'utf8');

    expect(registry).toContain('https://smyslokod.ru/guides');
    expect(registry).toContain('https://pimenov.ru/');
    expect(registry).toContain(
      'https://pimenov.ai/articles/kak-my-perenosili-pimenov-ru-s-tildy-na-svoyu-sistemu/',
    );
    expect(registry).toContain('https://pimenov.ai/cases/pimenov-ru-tilda-migration/');
  });
});
