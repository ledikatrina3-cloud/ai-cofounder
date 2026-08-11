import { spawnSync } from 'node:child_process';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';

type Fingerprint = {
  h1Formula: string;
  questionH2Ratio: number;
  questionSpine: boolean;
  sceneType: string;
  narrativeForm: string;
  practicalBlock: string;
  finalMove: string;
  compositionSequence: string[];
};

type CliResult = {
  status: number | null;
  json: {
    pass: boolean;
    candidate: { path: string; fingerprint: Fingerprint };
    recent: Array<{ path: string; fingerprint: Fingerprint }>;
    issues: Array<{ code: string }>;
  };
};

function writeMarkdown(dir: string, name: string, markdown: string): string {
  const path = join(dir, name);
  writeFileSync(path, markdown, 'utf8');
  return path;
}

function runCli(candidate: string, contentDir: string, recent = 5): CliResult {
  const result = spawnSync(
    'node',
    [
      'scripts/article-editorial-context.mjs',
      candidate,
      '--content-dir',
      contentDir,
      '--recent',
      String(recent),
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );

  expect(result.stderr).toBe('');
  return { status: result.status, json: JSON.parse(result.stdout) };
}

function questionArticle(title: string, nouns: string[]): string {
  return [
    `# ${title}`,
    `В кабинете обсуждают ${nouns[0]}, пока обычная заявка ждет решения.`,
    `## Почему ${nouns[0]} снова не сходится?`,
    `## Кто отвечает за ${nouns[1]}?`,
    `## Что проверить до ${nouns[2]}?`,
    '## Практика: разберите один случай по шагам',
    'Возьмите один документ и запишите владельца каждого шага.',
    '## С чего начать завтра?',
    'Выберите один участок и договоритесь о следующем действии.',
  ].join('\n\n');
}

describe('article editorial context CLI', () => {
  it('extracts the complete deterministic editorial fingerprint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'editorial-context-'));
    const candidate = writeMarkdown(
      dir,
      'candidate.md',
      [
        '# Автоматизация начинается с ясного правила',
        'Утром руководитель открывает чат: «Кто обещал позвонить клиенту?»',
        'Так начинается разбор одного рабочего эпизода.',
        '## Где потерялось обещание?',
        '## Кто должен сделать следующий шаг?',
        '## Почему напоминание не помогло?',
        '## Практика: карта одного обещания',
        'Возьмите одну заявку и запишите четыре передачи по шагам.',
        '## Решение на завтра',
        'Начните с одной передачи, где уже понятен владелец.',
      ].join('\n\n'),
    );

    const first = runCli(candidate, dir);
    const second = runCli(candidate, dir);

    expect(first.status).toBe(0);
    expect(first.json).toEqual(second.json);
    expect(first.json.candidate.fingerprint).toEqual({
      h1Formula: 'x начинается с y',
      questionH2Ratio: 0.6,
      questionSpine: true,
      sceneType: 'workplace_scene',
      narrativeForm: 'scene_to_explanation',
      practicalBlock: 'single_case_map',
      finalMove: 'next_action',
      compositionSequence: ['workplace_scene', 'question_spine', 'single_case_map', 'next_action'],
    });
  });

  it.each([
    ['Контроль начинается с одного владельца', 'x начинается с y'],
    ['Спокойный отчет скрывает сорванные сроки', 'x скрывает y'],
  ])('normalizes H1 formula %s', (title, formula) => {
    const dir = mkdtempSync(join(tmpdir(), 'editorial-context-'));
    const candidate = writeMarkdown(
      dir,
      'candidate.md',
      `# ${title}\n\n## Что делать дальше\n\nПодведите итог.`,
    );

    const result = runCli(candidate, dir);

    expect(result.json.candidate.fingerprint.h1Formula).toBe(formula);
  });

  it('hard-fails when the candidate repeats the dominant H1 formula', () => {
    const dir = mkdtempSync(join(tmpdir(), 'editorial-context-'));
    writeMarkdown(
      dir,
      '01.md',
      questionArticle('Продажа начинается с точного обещания', ['воронка', 'звонок', 'оплата']),
    );
    writeMarkdown(
      dir,
      '02.md',
      questionArticle('Найм начинается с ясной роли', ['вакансия', 'интервью', 'оффер']),
    );
    writeMarkdown(
      dir,
      '03.md',
      questionArticle('Закупка начинается с лимита', ['остаток', 'заказ', 'поставка']),
    );
    const candidate = writeMarkdown(
      dir,
      'candidate.md',
      '# Поддержка начинается с понятного ответа\n\n## Один пример\n\nСравните два письма и завершите выводом.',
    );

    const result = runCli(candidate, dir);

    expect(result.status).toBe(1);
    expect(result.json.pass).toBe(false);
    expect(result.json.issues.map(({ code }) => code)).toContain('dominant_h1_formula');
  });

  it('hard-fails for every tied dominant H1 formula', () => {
    const dir = mkdtempSync(join(tmpdir(), 'editorial-context-'));
    writeMarkdown(dir, '01.md', '# Почему заявки теряются\n\n## Наблюдение\n\nТекст.');
    writeMarkdown(dir, '02.md', '# Почему сроки срываются\n\n## Наблюдение\n\nТекст.');
    writeMarkdown(dir, '03.md', '# Как проверить отчет\n\n## Наблюдение\n\nТекст.');
    writeMarkdown(dir, '04.md', '# Как найти владельца\n\n## Наблюдение\n\nТекст.');
    const candidate = writeMarkdown(
      dir,
      'candidate.md',
      '# Почему автоматизация не помогает\n\n## Вывод\n\nТекст.',
    );

    const result = runCli(candidate, dir, 4);

    expect(result.status).toBe(1);
    expect(result.json.issues.map(({ code }) => code)).toContain('dominant_h1_formula');
  });

  it('selects recent articles by stable frontmatter publication date instead of mtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'editorial-context-'));
    const oldest = writeMarkdown(
      dir,
      'oldest.md',
      '---\ndate: 2026-06-01\n---\n\n# Старая статья\n\n## Вывод\n\nТекст.',
    );
    const middle = writeMarkdown(
      dir,
      'middle.md',
      '---\npublication_date: 2026-07-01\n---\n\n# Средняя статья\n\n## Вывод\n\nТекст.',
    );
    const newest = writeMarkdown(
      dir,
      'newest.md',
      '---\npublished_at: 2026-08-01T09:00:00Z\n---\n\n# Новая статья\n\n## Вывод\n\nТекст.',
    );
    const candidate = writeMarkdown(dir, 'candidate.md', '# Кандидат\n\n## Вывод\n\nТекст.');
    const now = new Date('2026-08-10T12:00:00Z');
    utimesSync(oldest, now, now);
    utimesSync(middle, new Date('2026-08-09T12:00:00Z'), new Date('2026-08-09T12:00:00Z'));
    utimesSync(newest, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

    const result = runCli(candidate, dir, 2);

    expect(result.json.recent.map(({ path }) => basename(path))).toEqual([
      'newest.md',
      'middle.md',
    ]);
  });

  it('uses a deterministic filename fallback when publication dates are absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'editorial-context-'));
    const alpha = writeMarkdown(dir, 'alpha.md', '# Альфа\n\n## Вывод\n\nТекст.');
    const beta = writeMarkdown(dir, 'beta.md', '# Бета\n\n## Вывод\n\nТекст.');
    const candidate = writeMarkdown(dir, 'candidate.md', '# Кандидат\n\n## Вывод\n\nТекст.');
    const now = new Date('2026-08-10T12:00:00Z');
    utimesSync(alpha, now, now);
    utimesSync(beta, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

    const result = runCli(candidate, dir, 2);

    expect(result.json.recent.map(({ path }) => basename(path))).toEqual(['beta.md', 'alpha.md']);
  });

  it('does not treat unrelated unclassified titles as one dominant formula', () => {
    const dir = mkdtempSync(join(tmpdir(), 'editorial-context-'));
    writeMarkdown(dir, '01.md', '# Потерянная заявка в отделе продаж\n\n## Наблюдение\n\nТекст.');
    writeMarkdown(dir, '02.md', '# Пять сигналов перегруженной команды\n\n## Наблюдение\n\nТекст.');
    const candidate = writeMarkdown(
      dir,
      'candidate.md',
      '# Разговор о сроках без взаимных обвинений\n\n## Вывод\n\nТекст.',
    );

    const result = runCli(candidate, dir, 2);

    expect(result.status).toBe(0);
    expect(result.json.issues.map(({ code }) => code)).not.toContain('dominant_h1_formula');
  });

  it('hard-fails on a repeated composition despite low lexical overlap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'editorial-context-'));
    writeMarkdown(
      dir,
      'a.md',
      questionArticle('Тихая таблица скрывает возвраты', ['склад', 'курьер', 'приемка']),
    );
    writeMarkdown(
      dir,
      'b.md',
      questionArticle('Вежливый календарь скрывает перегрузку', [
        'встреча',
        'менеджер',
        'планирование',
      ]),
    );
    const candidate = writeMarkdown(
      dir,
      'candidate.md',
      questionArticle('Красивый дашборд скрывает кассовый разрыв', [
        'платеж',
        'финансист',
        'бюджет',
      ]),
    );

    const result = runCli(candidate, dir, 2);

    expect(result.status).toBe(1);
    expect(result.json.issues.map(({ code }) => code)).toContain('repeated_composition');
    expect(result.json.recent).toHaveLength(2);
  });

  it('excludes research, checklist, QA, plan and service markdown files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'editorial-context-'));
    writeMarkdown(dir, 'article.md', '# Обычная статья\n\n## Наблюдение\n\nТекст.');
    for (const name of [
      'topic.research.md',
      'topic.checklist.md',
      'topic.qa.md',
      'topic.plan.md',
      'topic.service.md',
    ]) {
      writeMarkdown(dir, name, '# Служебный файл\n\n## Вопрос?\n\nНе статья.');
    }
    const candidate = writeMarkdown(
      dir,
      'candidate.md',
      '# Другой материал\n\n## Вывод\n\nГотово.',
    );

    const result = runCli(candidate, dir);

    expect(result.json.recent.map(({ path }) => basename(path))).toEqual(['article.md']);
  });
});
