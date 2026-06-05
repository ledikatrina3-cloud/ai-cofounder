// Тесты для парсера скиллов (Фаза 1 — Skill foundation).
//
// Стратегия:
//   * Парсер тестируется через `parseSkillSources(skillDir, skill, perms?)`
//     — без I/O, чисто на строках. Так же, как `parseRoutineSource` в
//     tests/routines.test.ts.
//   * Хелпер `makeSkillSource` собирает валидный SKILL.md frontmatter,
//     отдельные тесты перегружают поля для негативных кейсов.

import { describe, expect, it } from 'vitest';
import { SkillParseError, parseSkill, parseSkillSources } from '../src/skills/parser.js';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const SKILL_DIR = '/abs/repo/skills/vc-publishing';

function makeSkillSource(
  overrides: Partial<Record<string, string>> = {},
  body = 'Пуш-промт скилла.',
): string {
  const fields: Record<string, string> = {
    name: 'vc-publishing',
    description: 'Публикация черновика на vc.ru.',
    ...overrides,
  };
  // Удаляем undefined из overrides (нужно для тестов «нет поля»).
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) delete fields[k];
  }
  const lines = ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', '', body];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Happy path.
// ---------------------------------------------------------------------------

describe('parseSkillSources — happy path', () => {
  it('парсит минимальный валидный SKILL.md (только name + description)', () => {
    const src = makeSkillSource();
    const skill = parseSkillSources(SKILL_DIR, src, null);

    expect(skill).toMatchObject({
      name: 'vc-publishing',
      description: 'Публикация черновика на vc.ru.',
      filePath: SKILL_DIR,
      permissions: {},
    });
    expect(skill.prompt).toBe('Пуш-промт скилла.');
    expect(skill.version).toBeUndefined();
    expect(skill.category).toBeUndefined();
  });

  it('парсит все опциональные поля верхнего уровня', () => {
    const src = makeSkillSource({
      version: '1.0.0',
      category: 'publishing',
      displayName: 'vc.ru Publisher',
      icon: '📝',
      color: '#FF8800',
      dependsOn: '[browser-control, fs-utils]',
      requiresScopes: '[vc.publish]',
    });
    // compatibleWith требует nested-mapping — добавим вручную.
    const withNested = src.replace(
      '---\n\nПуш',
      ['compatibleWith:', '  runtime: ">=1.0.0 <2.0.0"', '---', '', 'Пуш'].join('\n'),
    );
    const skill = parseSkillSources(SKILL_DIR, withNested, null);

    expect(skill.version).toBe('1.0.0');
    expect(skill.category).toBe('publishing');
    expect(skill.displayName).toBe('vc.ru Publisher');
    expect(skill.icon).toBe('📝');
    expect(skill.color).toBe('#FF8800');
    expect(skill.dependsOn).toEqual(['browser-control', 'fs-utils']);
    expect(skill.requiresScopes).toEqual(['vc.publish']);
    expect(skill.compatibleWith).toEqual({ runtime: '>=1.0.0 <2.0.0' });
  });

  it('парсит permissions.md с bashWhitelist + requiresApproval + healthCheck', () => {
    const src = makeSkillSource();
    const perms = [
      'bashWhitelist: ["pnpm exec tsx skills/vc-publishing/scripts/publish.ts", "pnpm exec tsx skills/vc-publishing/scripts/tag.ts"]',
      'requiredSdkTools: [Read, Bash]',
      'maxStepsPerInvocation: 20',
      'requiresApproval: [{action: publish, via: telegram}]',
      'healthCheck:',
      '  script: scripts/health-check.ts',
      '  schedule: "0 7 * * *"',
    ].join('\n');

    const skill = parseSkillSources(SKILL_DIR, src, perms);

    expect(skill.permissions.bashWhitelist).toEqual([
      'pnpm exec tsx skills/vc-publishing/scripts/publish.ts',
      'pnpm exec tsx skills/vc-publishing/scripts/tag.ts',
    ]);
    expect(skill.permissions.requiredSdkTools).toEqual(['Read', 'Bash']);
    expect(skill.permissions.maxStepsPerInvocation).toBe(20);
    expect(skill.permissions.requiresApproval).toEqual([{ action: 'publish', via: 'telegram' }]);
    expect(skill.permissions.healthCheck).toEqual({
      script: 'scripts/health-check.ts',
      schedule: '0 7 * * *',
    });
  });

  it('permissions.md отсутствует → permissions = {} (дефолт)', () => {
    const skill = parseSkillSources(SKILL_DIR, makeSkillSource(), null);
    expect(skill.permissions).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Validation errors — frontmatter SKILL.md.
// ---------------------------------------------------------------------------

describe('parseSkillSources — обязательные поля', () => {
  it('SKILL.md без name → SkillParseError', () => {
    const src = makeSkillSource({ name: undefined as unknown as string });
    expect(() => parseSkillSources(SKILL_DIR, src, null)).toThrow(SkillParseError);
    expect(() => parseSkillSources(SKILL_DIR, src, null)).toThrow(/обязательное поле 'name'/);
  });

  it('SKILL.md без description → SkillParseError', () => {
    const src = makeSkillSource({ description: undefined as unknown as string });
    expect(() => parseSkillSources(SKILL_DIR, src, null)).toThrow(
      /обязательное поле 'description'/,
    );
  });

  it('description пустой → ошибка', () => {
    const src = makeSkillSource({ description: '' });
    // Пустое значение тоже падает как «обязательное поле».
    expect(() => parseSkillSources(SKILL_DIR, src, null)).toThrow(/'description'/);
  });
});

describe('parseSkillSources — валидация name', () => {
  it('name не kebab-case → ошибка', () => {
    const src = makeSkillSource({ name: 'VcPublishing' });
    expect(() => parseSkillSources(SKILL_DIR, src, null)).toThrow(/kebab-case/);
  });

  it('name содержит подчёркивание → ошибка', () => {
    const src = makeSkillSource({ name: 'vc_publishing' });
    expect(() => parseSkillSources(SKILL_DIR, src, null)).toThrow(/kebab-case/);
  });

  it('name не равен basename директории → ошибка', () => {
    const src = makeSkillSource({ name: 'other-skill' });
    expect(() => parseSkillSources(SKILL_DIR, src, null)).toThrow(/не совпадает с basename/);
  });
});

describe('parseSkillSources — валидация category', () => {
  it('категория вне enum → ошибка', () => {
    const src = makeSkillSource({ category: 'marketing' });
    expect(() => parseSkillSources(SKILL_DIR, src, null)).toThrow(/'category'/);
  });

  it('категория internal допустима', () => {
    const src = makeSkillSource({ category: 'internal' });
    const skill = parseSkillSources(SKILL_DIR, src, null);
    expect(skill.category).toBe('internal');
  });
});

describe('parseSkillSources — валидация version', () => {
  it('неверный semver → ошибка', () => {
    const src = makeSkillSource({ version: '1.0' });
    expect(() => parseSkillSources(SKILL_DIR, src, null)).toThrow(/semver/);
  });

  it('semver с pre-release → ошибка (фаза 1 простой regex)', () => {
    const src = makeSkillSource({ version: '1.0.0-beta' });
    expect(() => parseSkillSources(SKILL_DIR, src, null)).toThrow(/semver/);
  });

  it('валидный semver принимается', () => {
    const src = makeSkillSource({ version: '2.10.3' });
    const skill = parseSkillSources(SKILL_DIR, src, null);
    expect(skill.version).toBe('2.10.3');
  });
});

describe('parseSkillSources — валидация color', () => {
  it('color без `#` → ошибка', () => {
    const src = makeSkillSource({ color: 'FF8800' });
    expect(() => parseSkillSources(SKILL_DIR, src, null)).toThrow(/'color'/);
  });
});

describe('parseSkillSources — валидация compatibleWith', () => {
  it('compatibleWith без runtime → ошибка', () => {
    const src = makeSkillSource();
    const broken = src.replace(
      '---\n\nПуш',
      ['compatibleWith:', '  someKey: value', '---', '', 'Пуш'].join('\n'),
    );
    expect(() => parseSkillSources(SKILL_DIR, broken, null)).toThrow(/compatibleWith\.runtime/);
  });
});

// ---------------------------------------------------------------------------
// Validation errors — permissions.md.
// ---------------------------------------------------------------------------

describe('parseSkillSources — permissions.md валидация', () => {
  it('bashWhitelist не из `pnpm exec tsx skills/<name>/scripts/` → ошибка', () => {
    const src = makeSkillSource();
    const perms = 'bashWhitelist: ["rm -rf /"]';
    expect(() => parseSkillSources(SKILL_DIR, src, perms)).toThrow(/должен начинаться с/);
  });

  it('bashWhitelist для другого скилла → ошибка', () => {
    const src = makeSkillSource();
    const perms = 'bashWhitelist: ["pnpm exec tsx skills/OTHER/scripts/x.ts"]';
    expect(() => parseSkillSources(SKILL_DIR, src, perms)).toThrow(
      /pnpm exec tsx skills\/vc-publishing\/scripts\//,
    );
  });

  it('bashWhitelist для нашего скилла принимается', () => {
    const src = makeSkillSource();
    const perms = 'bashWhitelist: ["pnpm exec tsx skills/vc-publishing/scripts/publish.ts"]';
    const skill = parseSkillSources(SKILL_DIR, src, perms);
    expect(skill.permissions.bashWhitelist).toEqual([
      'pnpm exec tsx skills/vc-publishing/scripts/publish.ts',
    ]);
  });

  it('permissions.md с block-array (`- item`) → понятная ошибка', () => {
    const src = makeSkillSource();
    const perms = [
      'bashWhitelist:',
      '  - "pnpm exec tsx skills/vc-publishing/scripts/publish.ts"',
    ].join('\n');
    expect(() => parseSkillSources(SKILL_DIR, src, perms)).toThrow(/block-array/);
  });

  it('requiresApproval без action → ошибка', () => {
    const src = makeSkillSource();
    const perms = 'requiresApproval: [{via: telegram}]';
    expect(() => parseSkillSources(SKILL_DIR, src, perms)).toThrow(/'action' обязателен/);
  });

  it('healthCheck без script → ошибка', () => {
    const src = makeSkillSource();
    const perms = ['healthCheck:', '  schedule: "0 7 * * *"'].join('\n');
    expect(() => parseSkillSources(SKILL_DIR, src, perms)).toThrow(/healthCheck\.script/);
  });

  it('maxStepsPerInvocation не положительное → ошибка', () => {
    const src = makeSkillSource();
    const perms = 'maxStepsPerInvocation: 0';
    expect(() => parseSkillSources(SKILL_DIR, src, perms)).toThrow(/положительным/);
  });
});

// ---------------------------------------------------------------------------
// parseSkill (с I/O) — DI-режим.
// ---------------------------------------------------------------------------

describe('parseSkill — c DI', () => {
  it('читает SKILL.md, fileExists=false для permissions → дефолт {}', async () => {
    const fakeRead = async (p: string) => {
      if (p.endsWith('SKILL.md')) return makeSkillSource();
      throw new Error(`unexpected read: ${p}`);
    };
    const fileExists = async (p: string) => !p.endsWith('permissions.md');

    const skill = await parseSkill('/abs/repo/skills/vc-publishing', {
      read: fakeRead,
      fileExists,
    });
    expect(skill.permissions).toEqual({});
  });

  it('читает оба файла когда permissions.md существует', async () => {
    const fakeRead = async (p: string) => {
      if (p.endsWith('SKILL.md')) return makeSkillSource();
      if (p.endsWith('permissions.md')) return 'maxStepsPerInvocation: 5';
      throw new Error(`unexpected read: ${p}`);
    };
    const fileExists = async () => true;

    const skill = await parseSkill('/abs/repo/skills/vc-publishing', {
      read: fakeRead,
      fileExists,
    });
    expect(skill.permissions.maxStepsPerInvocation).toBe(5);
  });
});
