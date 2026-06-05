// Тесты для реестра скиллов (Фаза 1 — Skill foundation).
//
// Стратегия:
//   * listSkills/getSkill/resolveDeps — в tmpdir с настоящими файлами +
//     fast-glob (как в tests/routines.test.ts). Это проверяет реальный
//     resolve путей.
//   * resolveDeps также гоняем через DI-overrides для edge-кейсов
//     (циклы, missing deps) — там удобнее in-memory.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillRegistryError, getSkill, listSkills, resolveDeps } from '../src/skills/registry.js';

// ---------------------------------------------------------------------------
// Fixture helpers.
// ---------------------------------------------------------------------------

interface Fixture {
  cwd: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const cwd = mkdtempSync(join(tmpdir(), 'skills-registry-test-'));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function writeFile(cwd: string, relPath: string, content: string): void {
  const full = join(cwd, relPath);
  const dir = full.replace(/\/[^/]+$/, '');
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function makeSkillMd(
  name: string,
  opts: { description?: string; dependsOn?: string[] } = {},
): string {
  const fields: Record<string, string> = {
    name,
    description: opts.description ?? `Скилл ${name}.`,
  };
  if (opts.dependsOn !== undefined && opts.dependsOn.length > 0) {
    fields.dependsOn = `[${opts.dependsOn.join(', ')}]`;
  }
  const lines = [
    '---',
    ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`),
    '---',
    '',
    `Промт для ${name}.`,
  ];
  return lines.join('\n');
}

function placeSkill(
  cwd: string,
  name: string,
  opts: { description?: string; dependsOn?: string[] } = {},
): void {
  writeFile(cwd, `skills/${name}/SKILL.md`, makeSkillMd(name, opts));
}

// ---------------------------------------------------------------------------
// listSkills / getSkill.
// ---------------------------------------------------------------------------

describe('listSkills + getSkill', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fx.cleanup());

  it('listSkills возвращает все найденные скиллы', async () => {
    placeSkill(fx.cwd, 'vc-publishing');
    placeSkill(fx.cwd, 'browser-control');

    const list = await listSkills({ cwd: fx.cwd });
    expect(list.map((s) => s.name).sort()).toEqual(['browser-control', 'vc-publishing']);
  });

  it('getSkill возвращает скилл по имени', async () => {
    placeSkill(fx.cwd, 'vc-publishing');

    const s = await getSkill('vc-publishing', { cwd: fx.cwd });
    expect(s?.name).toBe('vc-publishing');
    expect(s?.description).toBe('Скилл vc-publishing.');
  });

  it('getSkill возвращает null для неизвестного имени', async () => {
    placeSkill(fx.cwd, 'vc-publishing');

    const s = await getSkill('nope', { cwd: fx.cwd });
    expect(s).toBeNull();
  });

  it('дубликаты name → SkillRegistryError', async () => {
    // Чтобы дойти до проверки уникальности в registry, обходим parser-фильтр
    // (он требует name == basename) через кастомный glob+read+fileExists:
    // glob возвращает два пути с разным basename, read для каждого SKILL.md
    // отдаёт name совпадающий с basename, permissions.md помечен как
    // несуществующий (дефолты).
    await expect(
      listSkills({
        cwd: fx.cwd,
        glob: async () => [join(fx.cwd, 'skills/a/SKILL.md'), join(fx.cwd, 'skills/b/SKILL.md')],
        read: async (p: string) => {
          // Оба «реальных» SKILL.md задекларируют name='dup' — но parseSkill
          // валидирует name против basename. Чтобы получить именно дубль
          // ПОСЛЕ парсинга, отдаём для каждого пути SKILL.md с name равным
          // basename — но в registry мы потом подменим name… Нет, проще:
          // сделаем оба скилла одноимёнными физически через glob, который
          // вернёт два одинаковых пути.
          if (p.endsWith('skills/a/SKILL.md')) return makeSkillMd('a');
          if (p.endsWith('skills/b/SKILL.md')) return makeSkillMd('b');
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        fileExists: async (p: string) => !p.endsWith('permissions.md'),
        // Теперь два разных name — это НЕ дубль. Перегружаем сценарий:
        // ниже — отдельный честный дубль через два пути с одинаковым именем
        // (имитируем glob, отдавший один и тот же скилл дважды — что в
        // реальности случается, если у пользователя кривая структура).
      }),
    ).resolves.toBeDefined();

    // Истинный сценарий дубля: glob возвращает два пути с одинаковым basename.
    await expect(
      listSkills({
        cwd: fx.cwd,
        glob: async () => [
          join(fx.cwd, 'skills/dup/SKILL.md'),
          join(fx.cwd, 'other-root/skills/dup/SKILL.md'),
        ],
        read: async (p: string) => {
          if (p.endsWith('SKILL.md')) return makeSkillMd('dup');
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        fileExists: async (p: string) => !p.endsWith('permissions.md'),
      }),
    ).rejects.toThrow(SkillRegistryError);
  });
});

// ---------------------------------------------------------------------------
// resolveDeps.
// ---------------------------------------------------------------------------

describe('resolveDeps', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fx.cleanup());

  it('сортирует A → B → C так, что зависимости идут раньше зависимых', async () => {
    // a зависит от b, b зависит от c. Ожидаемый порядок: c, b, a.
    placeSkill(fx.cwd, 'a', { dependsOn: ['b'] });
    placeSkill(fx.cwd, 'b', { dependsOn: ['c'] });
    placeSkill(fx.cwd, 'c');

    const order = await resolveDeps(['a'], { cwd: fx.cwd });
    expect(order.map((s) => s.name)).toEqual(['c', 'b', 'a']);
  });

  it('подтягивает все транзитивные зависимости даже если запрошен только корневой', async () => {
    placeSkill(fx.cwd, 'top', { dependsOn: ['mid'] });
    placeSkill(fx.cwd, 'mid', { dependsOn: ['leaf'] });
    placeSkill(fx.cwd, 'leaf');

    const order = await resolveDeps(['top'], { cwd: fx.cwd });
    expect(order.map((s) => s.name)).toEqual(['leaf', 'mid', 'top']);
  });

  it('детектит прямой цикл a → b → a', async () => {
    placeSkill(fx.cwd, 'a', { dependsOn: ['b'] });
    placeSkill(fx.cwd, 'b', { dependsOn: ['a'] });

    await expect(resolveDeps(['a'], { cwd: fx.cwd })).rejects.toThrow(SkillRegistryError);
    await expect(resolveDeps(['a'], { cwd: fx.cwd })).rejects.toThrow(/cycle in dependsOn/);
  });

  it('детектит цикл из 3-х узлов a → b → c → a', async () => {
    placeSkill(fx.cwd, 'a', { dependsOn: ['b'] });
    placeSkill(fx.cwd, 'b', { dependsOn: ['c'] });
    placeSkill(fx.cwd, 'c', { dependsOn: ['a'] });

    await expect(resolveDeps(['a'], { cwd: fx.cwd })).rejects.toThrow(/cycle in dependsOn/);
  });

  it('падает на missing dep', async () => {
    placeSkill(fx.cwd, 'a', { dependsOn: ['ghost'] });

    await expect(resolveDeps(['a'], { cwd: fx.cwd })).rejects.toThrow(SkillRegistryError);
    await expect(resolveDeps(['a'], { cwd: fx.cwd })).rejects.toThrow(/ghost/);
  });

  it('падает если запрошен неизвестный скилл', async () => {
    placeSkill(fx.cwd, 'a');

    await expect(resolveDeps(['nope'], { cwd: fx.cwd })).rejects.toThrow(/'nope' не найден/);
  });

  it('независимые скиллы сортируются детерминированно по имени', async () => {
    placeSkill(fx.cwd, 'zeta');
    placeSkill(fx.cwd, 'alpha');

    const order = await resolveDeps(['zeta', 'alpha'], { cwd: fx.cwd });
    expect(order.map((s) => s.name)).toEqual(['alpha', 'zeta']);
  });
});
