// Тесты для scripts/dept-instantiate.ts (Фаза 5).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeptInstantiateError, instantiateDepartment } from '../scripts/dept-instantiate.js';

interface Fixture {
  cwd: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const cwd = mkdtempSync(join(tmpdir(), 'dept-instantiate-'));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function placeTemplate(cwd: string, id: string): void {
  const tdir = join(cwd, 'templates', 'departments', id);
  mkdirSync(join(tdir, 'shared'), { recursive: true });
  mkdirSync(join(tdir, 'employees'), { recursive: true });
  writeFileSync(join(tdir, 'DEPARTMENT.md'), '---\nname: T\ndescription: t\n---\nbody', 'utf8');
  writeFileSync(
    join(tdir, 'pipeline.yml'),
    `nodes:\n  - id: a\n    employee: ${id}-w\n    output: out.md\n`,
    'utf8',
  );
  writeFileSync(join(tdir, 'shared', 'topics-backlog.md'), '# topics\n', 'utf8');
  writeFileSync(
    join(tdir, 'employees', 'researcher.md'),
    `---\nid: ${id}-researcher\nprojectId: p\nenabled: false\ntrigger: manual\ntools: []\nmodel: claude-sonnet-4-6\nmaxTokens: 1000\ntimeoutMs: 60000\noutputType: journal-only\ndescription: r\n---\nbody`,
    'utf8',
  );
}

describe('instantiateDepartment', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fx.cleanup());

  it('копирует шаблон в departments/<id>/ и routines/', async () => {
    placeTemplate(fx.cwd, 'marketing-content');
    const created = await instantiateDepartment({
      templateId: 'marketing-content',
      cwd: fx.cwd,
    });
    expect(created.length).toBeGreaterThan(0);
    // DEPARTMENT.md
    expect(existsSync(join(fx.cwd, 'departments', 'marketing-content', 'DEPARTMENT.md'))).toBe(
      true,
    );
    // pipeline.yml
    expect(existsSync(join(fx.cwd, 'departments', 'marketing-content', 'pipeline.yml'))).toBe(true);
    // shared/
    expect(
      existsSync(join(fx.cwd, 'departments', 'marketing-content', 'shared', 'topics-backlog.md')),
    ).toBe(true);
    // routines/<dept-id>-<basename>.md
    expect(existsSync(join(fx.cwd, 'routines', 'marketing-content-researcher.md'))).toBe(true);
    // содержимое routine — корректный id
    const content = readFileSync(
      join(fx.cwd, 'routines', 'marketing-content-researcher.md'),
      'utf8',
    );
    expect(content).toMatch(/id: marketing-content-researcher/);
  });

  it('отказывается если department уже существует', async () => {
    placeTemplate(fx.cwd, 'marketing-content');
    await instantiateDepartment({ templateId: 'marketing-content', cwd: fx.cwd });
    await expect(
      instantiateDepartment({ templateId: 'marketing-content', cwd: fx.cwd }),
    ).rejects.toThrow(DeptInstantiateError);
  });

  it('ошибка для неизвестного template', async () => {
    await expect(instantiateDepartment({ templateId: 'nope', cwd: fx.cwd })).rejects.toThrow(
      /не найден/,
    );
  });
});
