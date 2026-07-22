// Тесты agent-loader (OSS v1.0): parseAgentFolder + resolveRuleInclude.
//
// Изоляция: in-memory файловая карта через read/fileExists DI — без диска.
// Пути синтетические (/Users/founder/...), реально не читаются.

import { describe, expect, it } from 'vitest';
import { parseAgentFolder, resolveRuleInclude } from '../../src/routines/agent-loader.js';
import { RoutineParseError } from '../../src/routines/parser.js';

const DIR = '/Users/founder/repo/agents/db-triage';

function makeFs(files: Record<string, string>): {
  read: (p: string) => Promise<string>;
  fileExists: (p: string) => Promise<boolean>;
} {
  return {
    read: async (p: string) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT (test fs): ${p}`);
      return v;
    },
    fileExists: async (p: string) => p in files,
  };
}

const FULL_AGENT_MD = `---
displayName: Финансист
role: Daily revenue analyst
avatar: 💰
color: emerald-400
model: sonnet
enabled: true
schedule: manual
output: telegram
maxTokens: 4096
department: analytics
skills:
  - article-writing
  - research-serp
---

Читает вчерашние покупки и присылает фаундеру выручку за день.`;

describe('parseAgentFolder — happy path', () => {
  it('собирает Routine из полной папки агента (все файлы)', async () => {
    const { read, fileExists } = makeFs({
      [`${DIR}/AGENT.md`]: FULL_AGENT_MD,
      [`${DIR}/prompt.md`]: '# Задача\n\nПосчитай выручку и пришли отчёт.',
      [`${DIR}/permissions.yml`]: [
        'tools:',
        '  - db.query',
        '  - report.send',
        'bash:',
        '  - git log',
        'dbScopes:',
        '  read: [purchases]',
        '  write: []',
        'secrets:',
        '  - GEMINI_API_KEY',
        'budget:',
        '  perRunUsd: 0.25',
      ].join('\n'),
      [`${DIR}/target.yml`]: [
        'cwd: /Users/founder/other-repo',
        'skills:',
        '  - build-spoke',
        'syncEnv:',
        '  - GEMINI_API_KEY',
      ].join('\n'),
      [`${DIR}/rules.md`]: 'Только read-only. Не пиши в прод.',
      [`${DIR}/report.md`]: 'Отчёт: {{output}}',
    });

    const r = await parseAgentFolder(DIR, { read, fileExists });

    expect(r).toMatchObject({
      id: 'db-triage', // basename папки (frontmatter id отсутствует)
      projectId: 'self',
      enabled: true,
      trigger: 'manual',
      tools: ['db.query', 'report.send'],
      model: 'claude-sonnet-4-6', // алиас sonnet резолвнут
      maxTokens: 4096,
      outputType: 'telegram-thread', // алиас telegram резолвнут
      role: 'Финансист', // displayName → role
      avatar: '💰',
      color: 'emerald-400',
      departmentId: 'analytics',
      bashWhitelist: ['git log'],
      skills: ['article-writing', 'research-serp'],
      secrets: ['GEMINI_API_KEY'],
      targetCwd: '/Users/founder/other-repo',
      allowedTargetSkills: ['build-spoke'],
      syncEnv: ['GEMINI_API_KEY'],
      rules: 'Только read-only. Не пиши в прод.',
      filePath: `${DIR}/AGENT.md`,
      agentDir: DIR,
      reportTemplatePath: `${DIR}/report.md`,
    });
    expect(r.description).toBe('Читает вчерашние покупки и присылает фаундеру выручку за день.');
    expect(r.prompt).toBe('# Задача\n\nПосчитай выручку и пришли отчёт.');
    expect(r.timeoutMs).toBe(600000); // дефолт
    // targetProject у агентов не выставляется — cross-project через targetCwd.
    expect(r.targetProject).toBeUndefined();
  });

  it('минимальный агент: только AGENT.md + prompt.md (silence = safe)', async () => {
    const dir = '/Users/founder/repo/agents/minimal';
    const { read, fileExists } = makeFs({
      [`${dir}/AGENT.md`]: [
        '---',
        'displayName: Минимал',
        'model: haiku',
        'enabled: false',
        'schedule: manual',
        'output: journal',
        '---',
        '',
        'Короткое описание.',
      ].join('\n'),
      [`${dir}/prompt.md`]: 'Сделай что-нибудь полезное.',
    });
    const r = await parseAgentFolder(dir, { read, fileExists });
    expect(r.id).toBe('minimal');
    expect(r.enabled).toBe(false);
    expect(r.model).toBe('claude-haiku-4-5');
    expect(r.outputType).toBe('journal-only');
    expect(r.tools).toEqual([]); // нет permissions.yml → ноль tools
    expect(r.bashWhitelist).toBeUndefined();
    expect(r.secrets).toBeUndefined();
    expect(r.targetCwd).toBeUndefined();
    expect(r.rules).toBeUndefined();
    expect(r.reportTemplatePath).toBeUndefined();
  });

  it('frontmatter id, совпадающий с basename (избыточно), + алиасы opus/both', async () => {
    const dir = '/Users/founder/repo/agents/folder-name';
    const { read, fileExists } = makeFs({
      [`${dir}/AGENT.md`]: [
        '---',
        'id: folder-name', // == basename: допустимо как избыточное подтверждение
        'displayName: X',
        'model: opus',
        'enabled: true',
        'schedule: manual',
        'output: both',
        '---',
        '',
        'desc',
      ].join('\n'),
      [`${dir}/prompt.md`]: 'p',
    });
    const r = await parseAgentFolder(dir, { read, fileExists });
    expect(r.id).toBe('folder-name');
    expect(r.model).toBe('claude-opus-4-7');
    expect(r.outputType).toBe('both');
  });
});

describe('parseAgentFolder — алиасы моделей и output', () => {
  const base = (model: string, output: string) =>
    [
      '---',
      'displayName: A',
      `model: ${model}`,
      'enabled: true',
      'schedule: manual',
      `output: ${output}`,
      '---',
      '',
      'd',
    ].join('\n');
  const dir = '/Users/founder/repo/agents/a';

  it.each([
    ['opus', 'claude-opus-4-7'],
    ['sonnet', 'claude-sonnet-4-6'],
    ['haiku', 'claude-haiku-4-5'],
    ['claude-opus-4-7', 'claude-opus-4-7'], // полный id проходит как есть
  ])('model alias %s → %s', async (input, expected) => {
    const { read, fileExists } = makeFs({
      [`${dir}/AGENT.md`]: base(input, 'telegram'),
      [`${dir}/prompt.md`]: 'p',
    });
    const r = await parseAgentFolder(dir, { read, fileExists });
    expect(r.model).toBe(expected);
  });

  it.each([
    ['telegram', 'telegram-thread'],
    ['journal', 'journal-only'],
    ['both', 'both'],
    ['telegram-thread', 'telegram-thread'], // каноническое значение тоже ок
  ])('output alias %s → %s', async (input, expected) => {
    const { read, fileExists } = makeFs({
      [`${dir}/AGENT.md`]: base('sonnet', input),
      [`${dir}/prompt.md`]: 'p',
    });
    const r = await parseAgentFolder(dir, { read, fileExists });
    expect(r.outputType).toBe(expected);
  });

  it('невалидная модель (не алиас, не claude-*/voyage-*) → RoutineParseError', async () => {
    const { read, fileExists } = makeFs({
      [`${dir}/AGENT.md`]: base('gpt-4', 'telegram'),
      [`${dir}/prompt.md`]: 'p',
    });
    await expect(parseAgentFolder(dir, { read, fileExists })).rejects.toThrow(RoutineParseError);
  });

  it('невалидный output → RoutineParseError', async () => {
    const { read, fileExists } = makeFs({
      [`${dir}/AGENT.md`]: base('sonnet', 'slack'),
      [`${dir}/prompt.md`]: 'p',
    });
    await expect(parseAgentFolder(dir, { read, fileExists })).rejects.toThrow(RoutineParseError);
  });
});

describe('parseAgentFolder — обязательные поля и валидация', () => {
  const dir = '/Users/founder/repo/agents/a';
  const goodAgentMd = [
    '---',
    'displayName: A',
    'model: sonnet',
    'enabled: true',
    'schedule: manual',
    'output: telegram',
    '---',
    '',
    'd',
  ].join('\n');

  it('отсутствует prompt.md → RoutineParseError', async () => {
    const { read, fileExists } = makeFs({ [`${dir}/AGENT.md`]: goodAgentMd });
    await expect(parseAgentFolder(dir, { read, fileExists })).rejects.toThrow(/prompt\.md/);
  });

  it('пустой prompt.md → RoutineParseError', async () => {
    const { read, fileExists } = makeFs({
      [`${dir}/AGENT.md`]: goodAgentMd,
      [`${dir}/prompt.md`]: '   ',
    });
    await expect(parseAgentFolder(dir, { read, fileExists })).rejects.toThrow(/prompt\.md/);
  });

  it('отсутствует displayName → RoutineParseError', async () => {
    const md = [
      '---',
      'model: sonnet',
      'enabled: true',
      'schedule: manual',
      'output: telegram',
      '---',
      '',
      'd',
    ].join('\n');
    const { read, fileExists } = makeFs({ [`${dir}/AGENT.md`]: md, [`${dir}/prompt.md`]: 'p' });
    await expect(parseAgentFolder(dir, { read, fileExists })).rejects.toThrow(/displayName/);
  });

  it('target.yml без cwd → RoutineParseError', async () => {
    const { read, fileExists } = makeFs({
      [`${dir}/AGENT.md`]: goodAgentMd,
      [`${dir}/prompt.md`]: 'p',
      [`${dir}/target.yml`]: 'host: marketing\nskills:\n  - x',
    });
    await expect(parseAgentFolder(dir, { read, fileExists })).rejects.toThrow(/cwd/);
  });

  it('target.yml с относительным cwd → RoutineParseError', async () => {
    const { read, fileExists } = makeFs({
      [`${dir}/AGENT.md`]: goodAgentMd,
      [`${dir}/prompt.md`]: 'p',
      [`${dir}/target.yml`]: 'cwd: ./relative/path',
    });
    await expect(parseAgentFolder(dir, { read, fileExists })).rejects.toThrow(/абсолютным/);
  });

  it('требует абсолютный путь к папке агента', async () => {
    const { read, fileExists } = makeFs({});
    await expect(parseAgentFolder('relative/agents/x', { read, fileExists })).rejects.toThrow(
      /абсолютный/,
    );
  });
});

describe('resolveRuleInclude — guard от path-traversal', () => {
  const dir = '/Users/founder/repo/agents/x';

  it('разрешает include внутри папки агента', () => {
    expect(resolveRuleInclude(dir, 'fragments/safe.md')).toBe(`${dir}/fragments/safe.md`);
  });

  it('отвергает ../ traversal', () => {
    expect(() => resolveRuleInclude(dir, '../secrets.md')).toThrow(RoutineParseError);
  });

  it('отвергает вложенный ../../ traversal', () => {
    expect(() => resolveRuleInclude(dir, 'a/../../etc/passwd')).toThrow(RoutineParseError);
  });

  it('отвергает абсолютный путь наружу', () => {
    expect(() => resolveRuleInclude(dir, '/etc/passwd')).toThrow(RoutineParseError);
  });
});

describe('parseAgentFolder — инвариант folder-basename === id', () => {
  it('frontmatter id ≠ имя папки → RoutineParseError (имя папки авторитетно)', async () => {
    const { read, fileExists } = makeFs({
      [`${DIR}/AGENT.md`]: [
        '---',
        'displayName: X',
        'model: sonnet',
        'enabled: true',
        'schedule: manual',
        'output: journal',
        'id: not-db-triage', // ≠ basename 'db-triage'
        '---',
        '',
        'Описание.',
      ].join('\n'),
      [`${DIR}/prompt.md`]: 'p',
    });
    await expect(parseAgentFolder(DIR, { read, fileExists })).rejects.toThrow(RoutineParseError);
  });

  it('frontmatter id === имя папки → OK (избыточное подтверждение)', async () => {
    const { read, fileExists } = makeFs({
      [`${DIR}/AGENT.md`]: [
        '---',
        'displayName: X',
        'model: sonnet',
        'enabled: true',
        'schedule: manual',
        'output: journal',
        'id: db-triage', // === basename
        '---',
        '',
        'Описание.',
      ].join('\n'),
      [`${DIR}/prompt.md`]: 'p',
    });
    const r = await parseAgentFolder(DIR, { read, fileExists });
    expect(r.id).toBe('db-triage');
  });
});

describe('parseAgentFolder — заморозка контракта (schemaVersion + неизвестные ключи)', () => {
  const dir = '/Users/founder/repo/agents/frozen';
  // good(extra) — валидный AGENT.md с доп. строками frontmatter.
  const good = (extra: string[] = []): string =>
    [
      '---',
      'displayName: A',
      'model: sonnet',
      'enabled: true',
      'schedule: manual',
      'output: telegram',
      ...extra,
      '---',
      '',
      'd',
    ].join('\n');

  it('неизвестный ключ frontmatter (опечатка) → RoutineParseError', async () => {
    const { read, fileExists } = makeFs({
      [`${dir}/AGENT.md`]: good(['maxtoken: 100']), // опечатка вместо maxTokens
      [`${dir}/prompt.md`]: 'p',
    });
    await expect(parseAgentFolder(dir, { read, fileExists })).rejects.toThrow(/неизвестное поле/);
  });

  it('schemaVersion как голый YAML-номер → RoutineParseError (требуй кавычки)', async () => {
    const { read, fileExists } = makeFs({
      [`${dir}/AGENT.md`]: good(['schemaVersion: 1.10']), // без кавычек → число 1.1
      [`${dir}/prompt.md`]: 'p',
    });
    await expect(parseAgentFolder(dir, { read, fileExists })).rejects.toThrow(/кавычк/);
  });

  it('schemaVersion новее движка → RoutineParseError (обнови движок)', async () => {
    const { read, fileExists } = makeFs({
      [`${dir}/AGENT.md`]: good(['schemaVersion: "99.0"']),
      [`${dir}/prompt.md`]: 'p',
    });
    await expect(parseAgentFolder(dir, { read, fileExists })).rejects.toThrow(/обнови движок/i);
  });

  it('schemaVersion равна текущей → OK и проставляется в Routine', async () => {
    const { read, fileExists } = makeFs({
      [`${dir}/AGENT.md`]: good(['schemaVersion: "1.0"']),
      [`${dir}/prompt.md`]: 'p',
    });
    const r = await parseAgentFolder(dir, { read, fileExists });
    expect(r.schemaVersion).toBe('1.0');
  });

  it('schemaVersion отсутствует → дефолт = текущая версия', async () => {
    const { read, fileExists } = makeFs({
      [`${dir}/AGENT.md`]: good(),
      [`${dir}/prompt.md`]: 'p',
    });
    const r = await parseAgentFolder(dir, { read, fileExists });
    expect(r.schemaVersion).toBe('1.0');
  });

  it('неизвестный ключ permissions.yml → RoutineParseError', async () => {
    const { read, fileExists } = makeFs({
      [`${dir}/AGENT.md`]: good(),
      [`${dir}/prompt.md`]: 'p',
      [`${dir}/permissions.yml`]: 'toolz:\n  - report.send', // опечатка вместо tools
    });
    await expect(parseAgentFolder(dir, { read, fileExists })).rejects.toThrow(/permissions\.yml/);
  });

  it('неизвестный ключ target.yml → RoutineParseError', async () => {
    const { read, fileExists } = makeFs({
      [`${dir}/AGENT.md`]: good(),
      [`${dir}/prompt.md`]: 'p',
      [`${dir}/target.yml`]: 'cwd: /Users/founder/x\nbogus: 1',
    });
    await expect(parseAgentFolder(dir, { read, fileExists })).rejects.toThrow(/target\.yml/);
  });
});
