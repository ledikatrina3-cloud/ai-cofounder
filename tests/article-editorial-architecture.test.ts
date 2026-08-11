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
const pathExists = (path: string): boolean => existsSync(new URL(path, root));
const entryPoints = entryPointPaths.map((path) => ({
  path,
  content: pathExists(path) ? read(path) : '',
}));
const playbook = existsSync(new URL(playbookPath, root)) ? read(playbookPath) : '';

const policyContracts = [
  {
    concern: 'voice',
    anchor: '<!-- editorial-policy:voice -->',
    signatures: [
      /^#{1,6}\s+.*(?:голос|voice|tone)\b/im,
      /Татьян[а-яё\s]+Мужицк/i,
      /(?:бытов|жизненн)[а-яё\s]+сцен/i,
      /(?:мягк[а-яё\s]+)?самоирон/i,
      /(?:авторск|индивидуальн)[а-яё\s]+голос/i,
      /(?:short|коротк)[а-яё\s]+(?:replicas?|реплик)/i,
    ],
  },
  {
    concern: 'mastery application',
    anchor: '<!-- editorial-policy:mastery -->',
    signatures: [
      /^#{1,6}\s+.*mastery\b/im,
      /mastery\/(?:copywriting|redaktor)\//i,
      /(?:профильн|релевантн)[а-яё\s-]+mastery/i,
      /mastery[\s\S]{0,80}(?:метод|при[её]м)[а-яё\s-]+(?:примен|использ)/i,
      /(?:до|после)[а-яё\s]+(?:драфт|черновик)[\s\S]{0,80}mastery/i,
    ],
  },
  {
    concern: 'reference patterns',
    anchor: '<!-- editorial-policy:references -->',
    signatures: [
      /^#{1,6}\s+.*(?:референс|reference)/im,
      /org\/reference-blogs\.md/i,
      /референсн[а-яё\s-]+(?:блог|источник|паттерн)/i,
      /(?:reference|reference-blog)[\s-]+patterns?/i,
      /(?:открой|прочитай|проверь)[\s\S]{0,60}(?:блог|канал)[а-яё\s]+(?:референс|эталон)/i,
    ],
  },
  {
    concern: 'structural diversity',
    anchor: '<!-- editorial-policy:structure -->',
    signatures: [
      /^#{1,6}\s+.*(?:structural[\s-]+diversity|структурн[а-яё\s-]+разнообраз)/im,
      /структурн[а-яё\s-]+разнообраз/i,
      /(?:последн|недавн)[а-яё\s]+стат[а-яё][\s\S]{0,80}(?:структур|композиц|H2|финал)/i,
    ],
  },
] as const;

describe('article editorial architecture', () => {
  it.each(entryPointPaths)('has the required writer entry point %s', (path) => {
    expect(pathExists(path)).toBe(true);
  });

  it('has one canonical editorial playbook', () => {
    expect(existsSync(new URL(playbookPath, root))).toBe(true);

    for (const { concern, anchor } of policyContracts) {
      const occurrences = playbook.split(anchor).length - 1;
      expect(occurrences, `missing or duplicated ${concern} policy anchor`).toBe(1);

      const sectionStart = playbook.indexOf(anchor) + anchor.length;
      const nextSectionStarts = policyContracts
        .map((contract) => playbook.indexOf(contract.anchor, sectionStart))
        .filter((position) => position >= sectionStart);
      const sectionEnd =
        nextSectionStarts.length > 0 ? Math.min(...nextSectionStarts) : playbook.length;
      const sectionBody = playbook.slice(sectionStart, sectionEnd).trim();

      expect(sectionBody.length, `${concern} policy section is empty`).toBeGreaterThan(100);
    }
  });

  it.each(entryPoints)('$path references the canonical playbook exactly once', ({ content }) => {
    const references = content.match(/org\/article-editorial-playbook\.md/g) ?? [];

    expect(references).toHaveLength(1);
  });

  it('keeps detailed editorial policy out of writer entry points', () => {
    for (const { path, content } of entryPoints) {
      for (const { concern, signatures } of policyContracts) {
        const matchedSignals = signatures
          .filter((signature) => signature.test(content))
          .map((signature) => signature.source);

        expect.soft(
          matchedSignals.length,
          `${concern} policy is duplicated in ${path}: ${matchedSignals.join(', ')}`,
        ).toBeLessThan(2);
      }
    }
  });
});
