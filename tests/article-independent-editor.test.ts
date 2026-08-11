import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

describe('independent article editor contract', () => {
  const prompt = read('agents/article-writer/prompt.md');
  const playbook = read('org/article-editorial-playbook.md');

  it('requires a separate clean-context run without writer self-assessment', () => {
    expect(prompt).toMatch(/отдельн[^\n]*запуск[^\n]*редактор/i);
    expect(prompt).toMatch(/чист[^\n]*контекст/i);
    expect(prompt).toContain('writer_self_assessment_included');
    expect(prompt).toContain('false');
    expect(prompt).toContain('review_run_id');
  });

  it('requires a structured review instead of an empty PASS', () => {
    for (const field of [
      'issues',
      'revisions',
      'checked_risks',
      'voice',
      'naturalSpeech',
      'compositionDifference',
      'masteryEvidence',
      'referenceInfluence',
    ]) {
      expect(playbook).toContain(`"${field}"`);
    }
    expect(playbook).toContain('Пустой `PASS`');
    expect(playbook).toMatch(/before[\s\S]{0,300}after/i);
  });

  it('allows only one rewrite loop and reruns deterministic checks', () => {
    expect(prompt).toMatch(/один ограниченный\s+цикл/i);
    expect(prompt).toMatch(/повтори (?:детерминированный )?QA/i);
    expect(prompt).toMatch(/повторн[^\n]*провал[^\n]*не готов/i);
  });
});
