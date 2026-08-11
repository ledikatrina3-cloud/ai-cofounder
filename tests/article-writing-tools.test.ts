import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function writeArticle(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'article-writing-tools-'));
  const file = join(dir, 'candidate.md');
  writeFileSync(file, body);
  return file;
}

function runStructureCheck(file: string, config?: string) {
  return spawnSync('python3', ['tools/article-writing/structure-check.py', file, ...(config ? ['--config', config] : [])], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('article-writing transferred tools', () => {
  it('accepts internal CTA links when no config cta.url is set', () => {
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
        'Начните с [разбора первого ответа](/blog/first-response).',
        '',
        '## Источники',
        '',
        '- Внутренний разбор последней статьи.',
      ].join('\n'),
    );

    const result = runStructureCheck(candidate);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK');
  });

  it('does not require public sources or invented internal links by default', () => {
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
        'Начните с [разбора первого ответа](/blog/first-response).',
      ].join('\n'),
    );

    const result = runStructureCheck(candidate);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK');
  });

  it('can require source sections and internal links through config', () => {
    const candidate = writeArticle(
      ['# Заголовок', '', '## Раздел', '', 'Содержимое раздела.'].join('\n'),
    );
    const config = join(candidate, '..', 'config.yaml');
    writeFileSync(
      config,
      ['tools:', '  structure:', '    require_sources: true', '    min_internal_links: 1'].join('\n'),
    );

    const result = runStructureCheck(candidate, config);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('нет раздела');
    expect(result.stdout).toContain('внутренних ссылок 0, минимум 1');
  });
});
