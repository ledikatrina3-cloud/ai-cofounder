import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('article-writer prompt audience framing', () => {
  function readFirstExisting(paths: string[]) {
    const found = paths
      .map((path) => resolve(process.cwd(), path))
      .find((path) => existsSync(path));
    if (!found) {
      throw new Error(`Missing expected prompt file. Tried: ${paths.join(', ')}`);
    }
    return readFileSync(found, 'utf8');
  }

  const rootPrompt = readFileSync(resolve(process.cwd(), 'article-writer-prompt.md'), 'utf8');
  const prompt = readFirstExisting([
    'agents/article-writer/prompt.md',
    'examples/agents/article-writer/prompt.md',
  ]);
  const examplePrompt = readFileSync(
    resolve(process.cwd(), 'examples/agents/article-writer/prompt.md'),
    'utf8',
  );
  const rules = readFirstExisting([
    'agents/article-writer/rules.md',
    'examples/agents/article-writer/rules.md',
  ]);
  const skill = readFileSync(resolve(process.cwd(), 'skills/article-writing/SKILL.md'), 'utf8');
  const promptVariants = [prompt, rootPrompt, examplePrompt];
  const normalizedPrompt = prompt.toLowerCase();
  const normalizedRootPrompt = rootPrompt.toLowerCase();
  const normalizedExamplePrompt = examplePrompt.toLowerCase();
  const compactPrompt = prompt.replace(/\s+/g, ' ');
  const compactRootPrompt = rootPrompt.replace(/\s+/g, ' ');
  const compactExamplePrompt = examplePrompt.replace(/\s+/g, ' ');
  const normalizedRules = rules.toLowerCase();

  it('writes for business owners who are not automation insiders yet', () => {
    expect(prompt).toContain('умного владельца бизнеса без технического бэкграунда');
    expect(prompt).toContain('сначала узнаваемая бизнес-боль');
    expect(prompt).toContain('термины объясняй человеческим переводом');
    expect(prompt).toContain('маленький следующий шаг');
  });

  it('forces editorial variety instead of reusing the same article skeleton', () => {
    for (const promptVariant of promptVariants) {
      const normalizedPromptVariant = promptVariant.toLowerCase();

      expect(normalizedPromptVariant).toContain('анти-повтор последних статей');
      expect(normalizedPromptVariant).toContain('структурный скелет');
      expect(normalizedPromptVariant).toContain('structural diversity hard-gate');
      expect(promptVariant).toContain('scripts/article-diversity-check.mjs');
      expect(promptVariant).toContain('content/<slug>.diversity.json');
      expect(promptVariant).toContain('НЕ готова');
      expect(promptVariant).not.toContain('Одна из H2 несёт «правду, которая режет»');
    }
  });

  it('forces business-first readability before technical explanation', () => {
    for (const promptVariant of promptVariants) {
      const normalizedPromptVariant = promptVariant.toLowerCase();

      expect(normalizedPromptVariant).toContain('business readability hard-gate');
      expect(promptVariant).toContain('scripts/article-business-readability-check.mjs');
      expect(promptVariant).toContain('content/<slug>.business-readability.json');
      expect(promptVariant).toContain('первые 1500 символов');
      expect(promptVariant).toContain('деньги, клиенты, сроки, продажи, оплата, доверие');
      expect(promptVariant).toContain('технический позвоночник H2');
      expect(promptVariant).toContain('НЕ готова');
    }
  });

  it('forbids tool-agency wording such as "CRM умеет"', () => {
    for (const promptVariant of promptVariants) {
      expect(promptVariant).toContain('CRM умеет собрать обращения');
      expect(promptVariant).toContain('неодушевлённый инструмент');
      expect(promptVariant).toContain('в CRM можно собрать обращения');
      expect(promptVariant).toContain('настройка позволяет');
      expect(promptVariant).toContain('tool_agency_phrasing');
    }
  });

  it('does not treat an empty SERP response as completed research', () => {
    for (const promptVariant of promptVariants) {
      const normalizedPromptVariant = promptVariant.toLowerCase();

      expect(normalizedPromptVariant).toContain('serp hard-gate');
      expect(promptVariant).toContain('results.length === 0');
      expect(promptVariant).toContain('не закрывай SERP');
      expect(promptVariant).toContain('минимум 3 релевантных результата');
      expect(promptVariant).toContain('3 переформулированных запроса');
      expect(promptVariant).toContain('пустой SERP не считается research');
    }
  });

  it('prevents repetitive headline formulas', () => {
    for (const promptVariant of promptVariants) {
      expect(promptVariant).toContain('Сгенерируй 7 кандидатов H1 минимум по 5 разным форматам');
      expect(promptVariant).toContain('CORE-KEYWORD обязателен, но не обязан стоять первым словом');
      expect(promptVariant).toContain('не должен повторять шаблон `почему N`');
      expect(promptVariant).not.toContain('Три кандидата H1 по 3 из 5 канонических формул');
      expect(promptVariant).not.toContain('структура «тема - крючок»');
    }

    expect(compactPrompt).toContain('Число используй только если оно усиливает смысл');
    expect(compactRootPrompt).toContain('Число используй только если оно усиливает смысл');
    expect(compactExamplePrompt).toContain('Число используй только если оно усиливает смысл');

    expect(rules).toContain('Числа не обязательны');
    expect(rules).toContain('H1 не обязан начинаться с него');
    expect(rules).toContain('для 7 кандидатов бери минимум 5 разных');
    expect(normalizedRules).toContain('антисовет');
    expect(normalizedRules).toContain('спорный тезис');

    expect(rules).not.toContain('1-3 числа в заголовке');
    expect(rules).not.toContain('Пять канонических формул');
    expect(normalizedRules).not.toContain('до/после');
    expect(normalizedPrompt).not.toContain('до/после');
    expect(normalizedRootPrompt).not.toContain('до/после');
    expect(normalizedExamplePrompt).not.toContain('до/после');
  });

  it('does not force plastic viral-gate tokens into the lead', () => {
    for (const promptVariant of promptVariants) {
      const compactPromptVariant = promptVariant.toLowerCase().replace(/\s+/g, ' ');

      expect(promptVariant).not.toContain('>= 2 числа в lead');
      expect(promptVariant).not.toContain('запланировано 3-5 скриншотов');
      expect(promptVariant).not.toContain('6. визионерский тезис');
      expect(promptVariant).not.toContain('8. мемная фраза');
      expect(compactPromptVariant).toContain(
        'число допускается только если оно подтверждает смысл',
      );
      expect(promptVariant).toContain('цитируемая человеческая формулировка без служебных слов');
    }
  });

  it('requires deterministic article-writing tools before humanization can pass', () => {
    for (const promptVariant of promptVariants) {
      expect(promptVariant).toContain('tools/article-writing/ai-cadence-check.py');
      expect(promptVariant).toContain('tools/article-writing/read-aloud-check.py');
      expect(promptVariant).toContain('tools/article-writing/structure-check.py');
      expect(promptVariant).toContain('content/<slug>.qa/ai-cadence.json');
      expect(promptVariant).toContain('content/<slug>.qa/read-aloud.json');
      expect(promptVariant).toContain('content/<slug>.qa/structure.txt');
      expect(promptVariant).toContain('пустой `{pass: true, issues: []}` без этих файлов запрещён');
    }
  });

  it('does not inject the old placeholder article-writing skill', () => {
    const normalizedSkill = skill.toLowerCase();

    expect(skill).not.toContain('TODO');
    expect(normalizedSkill).not.toContain('generic placeholder');
    expect(skill).toContain('agents/article-writer/prompt.md');
    expect(skill).toContain('examples/agents/article-writer/prompt.md');
    expect(skill).toContain('tools/article-writing/ai-cadence-check.py');
    expect(skill).toContain('content/<slug>.checklist.md');
  });
});
