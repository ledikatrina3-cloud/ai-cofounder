// Тесты для skills/seo-audit/scripts/audit.ts.
//
// Стратегия: `auditMarkdown` — pure-функция, тесты по фикстурам.

import { describe, expect, it } from 'vitest';
import { auditMarkdown } from '../skills/seo-audit/scripts/audit.js';

function makeArticle(opts: {
  title?: string;
  description?: string;
  h1?: string;
  h1Count?: number;
  h2Count?: number;
  lead?: string;
  body?: string;
  withLink?: boolean;
}): string {
  const fm: string[] = ['---'];
  if (opts.title !== undefined) fm.push(`title: ${opts.title}`);
  if (opts.description !== undefined) fm.push(`description: ${opts.description}`);
  fm.push('---', '');

  const parts: string[] = [];
  const h1Count = opts.h1Count ?? 1;
  for (let i = 0; i < h1Count; i++) {
    parts.push(`# ${opts.h1 ?? 'Главный заголовок'} ${i === 0 ? '' : `(${i})`}`.trim());
  }
  parts.push('');
  if (opts.lead !== undefined) {
    parts.push(opts.lead);
    parts.push('');
  }
  const h2Count = opts.h2Count ?? 2;
  for (let i = 0; i < h2Count; i++) {
    parts.push(`## H2 заголовок ${i + 1}`);
    parts.push('Тело секции. Здесь много текста для наполнения.');
    parts.push('');
  }
  if (opts.withLink === true) {
    parts.push('Смотри [статью](https://example.com/x) для подробностей.');
  }
  if (opts.body !== undefined) parts.push(opts.body);
  return [...fm, ...parts].join('\n');
}

describe('auditMarkdown', () => {
  it('happy path: чистый draft даёт высокий score', () => {
    const src = makeArticle({
      title: 'Skills-архитектура: как декомпозировать большие промпты',
      lead: 'Когда промпт перерастает 500 строк, AI-агент теряется. Я разнёс свой по references/ и сэкономил 5x токенов на простых задачах.',
      withLink: true,
    });
    const out = auditMarkdown(src, '/x.md');
    expect(out.score).toBeGreaterThanOrEqual(85);
    const errors = out.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('error: нет H1', () => {
    const src = makeArticle({ h1Count: 0, lead: 'Lead'.padEnd(150, ' и текст') });
    const out = auditMarkdown(src, '/x.md');
    expect(out.issues.some((i) => i.rule === 'h1-count' && i.severity === 'error')).toBe(true);
  });

  it('error: два H1', () => {
    const src = makeArticle({ h1Count: 2, lead: 'Lead'.padEnd(150, ' и текст') });
    const out = auditMarkdown(src, '/x.md');
    expect(out.issues.some((i) => i.rule === 'h1-count' && i.severity === 'error')).toBe(true);
  });

  it('warning: мало H2', () => {
    const src = makeArticle({ h2Count: 1, lead: 'Lead'.padEnd(150, ' и текст') });
    const out = auditMarkdown(src, '/x.md');
    expect(out.issues.some((i) => i.rule === 'h2-count' && i.severity === 'warning')).toBe(true);
  });

  it('warning: lead слишком короткий', () => {
    const src = makeArticle({ lead: 'Короткий.' });
    const out = auditMarkdown(src, '/x.md');
    expect(out.issues.some((i) => i.rule === 'lead-length')).toBe(true);
  });

  it('warning: нет ссылок', () => {
    const src = makeArticle({
      lead: 'Длинный lead'.padEnd(150, ' и текст с подробностями'),
      withLink: false,
    });
    const out = auditMarkdown(src, '/x.md');
    expect(out.issues.some((i) => i.rule === 'internal-links')).toBe(true);
  });

  it('warning: title слишком короткий', () => {
    const src = makeArticle({
      title: 'Short',
      lead: 'Длинный lead'.padEnd(150, ' и текст с подробностями'),
    });
    const out = auditMarkdown(src, '/x.md');
    expect(out.issues.some((i) => i.rule === 'title-length')).toBe(true);
  });

  it('возвращает frontmatter в output', () => {
    const src = makeArticle({
      title: 'Skills-архитектура: как декомпозировать большие промпты',
      description:
        'Описание для meta-тега длинное чтобы попало в диапазон 140-160 символов точно ну вот примерно столько чтобы не упало и не предупредило',
      lead: 'Длинный lead'.padEnd(150, ' и текст с подробностями'),
    });
    const out = auditMarkdown(src, '/x.md');
    expect(out.frontmatter.title).toBeDefined();
    expect(out.frontmatter.description).toBeDefined();
  });

  it('score 0–100 (clamp)', () => {
    const src = makeArticle({
      h1Count: 0,
      h2Count: 0,
      lead: '',
      withLink: false,
      title: 'X',
    });
    const out = auditMarkdown(src, '/x.md');
    expect(out.score).toBeGreaterThanOrEqual(0);
    expect(out.score).toBeLessThanOrEqual(100);
  });
});
