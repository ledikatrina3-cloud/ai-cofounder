import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function writeArticle(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'article-writing-tools-'));
  const file = join(dir, 'candidate.md');
  writeFileSync(file, body);
  return file;
}

function runStructureCheck(file: string) {
  return spawnSync('python3', ['tools/article-writing/structure-check.py', file], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('article-writing transferred tools', () => {
  it('accepts a public article without sources or unverified internal links', () => {
    const candidate = writeArticle(
      [
        '# Заявки теряются до первого ответа',
        '',
        'Клиент написал утром, а руководитель увидел проблему вечером.',
        '',
        '## Где теряется обещание клиенту',
        '',
        'Команда видит задержку только после второго напоминания.',
        '',
        '## Что проверить за неделю',
        '',
        'Начните с проверки первого ответа клиенту.',
      ].join('\n'),
    );

    const result = runStructureCheck(candidate);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK');
  });

  it('flags a public sources section', () => {
    const candidate = writeArticle(
      [
        '# Заявки теряются до первого ответа',
        '',
        'Клиент написал утром, а руководитель увидел проблему вечером.',
        '',
        '## Где теряется обещание клиенту',
        '',
        'Команда видит задержку только после второго напоминания.',
        '',
        '## Что проверить за неделю',
        '',
        'Начните с проверки первого ответа клиенту.',
        '',
        '## Источники',
        '',
        '- Внутренний разбор последней статьи.',
      ].join('\n'),
    );

    const result = runStructureCheck(candidate);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('служебный раздел');
  });

  it('converts verified https links to anchors in paste-ready HTML', () => {
    const candidate = writeArticle(
      '# Тест\n\nСмотрите [опубликованную статью](https://example.ru/blog/test).\n',
    );
    const output = `${candidate}.html`;
    const result = spawnSync(
      'node',
      ['scripts/article-markdown-to-html.mjs', candidate, output],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain(
      '<a href="https://example.ru/blog/test">опубликованную статью</a>',
    );
  });
});
