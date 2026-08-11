import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const playbookPath = 'org/article-editorial-playbook.md';
const entryPointPaths = [
  'agents/article-writer/prompt.md',
  'article-writer-prompt.md',
  'examples/agents/article-writer/prompt.md',
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
    requiredFeatures: [
      /(?:разговорн[а-яё\s-]+интонац|жив[а-яё\s-]+разговорн[а-яё\s-]+подач)/i,
      /(?:тепл[а-яё]*|эмпатичн[а-яё]*)/i,
      /(?:юмор[а-яё]*|самоирон[а-яё]*)/i,
      /психологическ[а-яё\s-]+точност/i,
      /(?:не\s+(?:имитир|копир)|без\s+(?:имитац|копир))/i,
    ],
    duplicationSignals: [
      /(?:голос|voice|tone)/i,
      /Татьян[а-яё\s]+Мужицк/i,
      /(?:разговорн[а-яё\s-]+интонац|жив[а-яё\s-]+подач)/i,
      /(?:тепл[а-яё]*|эмпатичн[а-яё]*)/i,
      /(?:юмор[а-яё]*|самоирон[а-яё]*)/i,
      /психологическ[а-яё\s-]+точност/i,
      /(?:бытов|жизненн)[а-яё\s-]+сцен/i,
      /(?:не\s+(?:имитир|копир)|авторск[а-яё\s-]+голос)/i,
    ],
  },
  {
    concern: 'mastery application',
    anchor: '<!-- editorial-policy:mastery -->',
    requiredFeatures: [
      /mastery\//i,
      /(?:выб(?:рать|ери|ира)|подобр)[а-яё\s-]+(?:метод|при[её]м)/i,
      /(?:примен|использ)[а-яё\s-]+(?:метод|при[её]м)[а-яё\s-]+(?:текст|стат|черновик)/i,
      /(?:доказательств|свидетельств|конкретн[а-яё\s-]+изменен|до\s*\/\s*после)/i,
    ],
    duplicationSignals: [
      /mastery\//i,
      /(?:профильн|релевантн)[а-яё\s-]+mastery/i,
      /(?:метод|при[её]м)[а-яё\s-]+(?:выб|примен|использ)/i,
      /(?:до|после)[а-яё\s-]+(?:драфт|черновик)/i,
      /(?:доказательств|конкретн[а-яё\s-]+изменен)/i,
    ],
  },
  {
    concern: 'reference patterns',
    anchor: '<!-- editorial-policy:references -->',
    requiredFeatures: [
      /org\/reference-blogs\.md/i,
      /(?:паттерн|при[её]м|угол|ракурс)[а-яё\s-]+(?:вопрос|тем|материал|подач)/i,
      /(?:(?:вопрос|тем|угол|ракурс)[а-яё\s-]+(?:извлеч|собер|зафиксир|выбер)|(?:извлеч|собер|зафиксир|выбер)[а-яё\s-]+(?:вопрос|тем|угол|ракурс))/i,
      /(?:(?:ссылк|источник|evidence|доказательств)[а-яё\s-]+(?:зафиксир|укаж|сохран)|(?:зафиксир|укаж|сохран)[а-яё\s-]+(?:ссылк|источник|evidence|доказательств))/i,
    ],
    duplicationSignals: [
      /(?:референс|reference)/i,
      /org\/reference-blogs\.md/i,
      /(?:блог|канал|источник)[а-яё\s-]+(?:открой|прочитай|проверь|проанализир)/i,
      /(?:паттерн|при[её]м|угол|ракурс)[а-яё\s-]+(?:вопрос|тем|подач)/i,
      /(?:ссылк|источник|доказательств)[а-яё\s-]+(?:зафиксир|укаж|сохран)/i,
    ],
  },
  {
    concern: 'structural diversity',
    anchor: '<!-- editorial-policy:structure -->',
    requiredFeatures: [
      /(?:последн|недавн)[а-яё\s-]+стат/i,
      /(?:сравн|сопостав|проверь)[а-яё\s-]+(?:структур|композиц|драматург)/i,
      /(?:начал|заголов|H2|композиц|финал)[а-яё\s,/-]+(?:начал|заголов|H2|композиц|финал)/i,
      /(?:выб(?:рать|ери)|зафиксир)[а-яё\s-]+(?:нов|отличающ)[а-яё\s-]+(?:структур|композиц|форм)/i,
    ],
    duplicationSignals: [
      /(?:структурн[а-яё\s-]+разнообраз|structural[\s-]+diversity)/i,
      /(?:последн|недавн)[а-яё\s-]+стат/i,
      /(?:сравн|сопостав)[а-яё\s-]+(?:структур|композиц|драматург)/i,
      /(?:заголов|начал|H2|финал)[а-яё\s,/-]+(?:заголов|начал|H2|финал)/i,
      /(?:нов|отличающ)[а-яё\s-]+(?:структур|композиц|форм)/i,
    ],
  },
] as const;

const markdownPolicyBlocks = (content: string): string[] =>
  content
    .replace(/```[\s\S]*?```/g, '')
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .filter((block) => {
      const prose = block
        .split(/\r?\n/)
        .filter((line) => !/^\s*#{1,6}\s/.test(line))
        .join('\n')
        .trim();
      const instructions = prose.match(/(?:^|\n)\s*(?:[-*]|\d+\.)\s+|[.!?](?:\s|$)/g) ?? [];

      return prose.length >= 220 && instructions.length >= 3;
    });

describe('article editorial architecture', () => {
  it.each(entryPointPaths)('has the required writer entry point %s', (path) => {
    expect(pathExists(path)).toBe(true);
  });

  it('has one canonical editorial playbook', () => {
    expect(existsSync(new URL(playbookPath, root))).toBe(true);

    for (const { concern, anchor, requiredFeatures } of policyContracts) {
      const occurrences = playbook.split(anchor).length - 1;
      expect(occurrences, `missing or duplicated ${concern} policy anchor`).toBe(1);

      const sectionStart = playbook.indexOf(anchor) + anchor.length;
      const nextSectionStarts = policyContracts
        .map((contract) => playbook.indexOf(contract.anchor, sectionStart))
        .filter((position) => position >= sectionStart);
      const sectionEnd =
        nextSectionStarts.length > 0 ? Math.min(...nextSectionStarts) : playbook.length;
      const sectionBody = playbook.slice(sectionStart, sectionEnd).trim();

      for (const feature of requiredFeatures) {
        expect
          .soft(
            feature.test(sectionBody),
            `${concern} policy section misses required feature: ${feature.source}`,
          )
          .toBe(true);
      }
    }
  });

  it.each(entryPoints)('$path references the canonical playbook exactly once', ({ content }) => {
    const references = content.match(/org\/article-editorial-playbook\.md/g) ?? [];

    expect(references).toHaveLength(1);
  });

  it('allows a short stage command with its tool path', () => {
    const command =
      'На этапе reference patterns используй org/reference-blogs.md и переходи к черновику.';

    expect(markdownPolicyBlocks(command)).toEqual([]);
  });

  it('recognizes a long multi-rule Markdown policy block', () => {
    const policyBlock = `
- Сначала открой референсные блоги и проанализируй их перед выбором темы.
- Затем извлеки паттерны вопросов и новые тематические углы, а не повторяй прежние вопросы.
- Для каждого выбранного приема укажи источник и сохрани ссылку как доказательство.
- Если подходящего материала нет, зафиксируй это явно и не выдумывай результаты анализа.
`;

    expect(markdownPolicyBlocks(policyBlock)).toHaveLength(1);
  });

  it('keeps detailed editorial policy out of writer entry points', () => {
    for (const { path, content } of entryPoints) {
      for (const block of markdownPolicyBlocks(content)) {
        for (const { concern, duplicationSignals } of policyContracts) {
          const matchedSignals = duplicationSignals
            .filter((signature) => signature.test(block))
            .map((signature) => signature.source);

          expect
            .soft(
              matchedSignals.length,
              `${concern} policy is duplicated in a detailed block of ${path}: ${matchedSignals.join(', ')}`,
            )
            .toBeLessThan(3);
        }
      }
    }
  });
});
