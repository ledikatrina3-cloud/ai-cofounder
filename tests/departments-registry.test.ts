// Тесты для department registry (Фаза 5).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DepartmentRegistryError,
  getDepartment,
  listDepartments,
} from '../src/departments/registry.js';

interface Fixture {
  cwd: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const cwd = mkdtempSync(join(tmpdir(), 'depts-registry-'));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function placeDept(cwd: string, id: string, name = id): void {
  const dir = join(cwd, 'departments', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'DEPARTMENT.md'),
    `---\nname: ${name}\ndescription: x.\n---\nbody`,
    'utf8',
  );
  writeFileSync(
    join(dir, 'pipeline.yml'),
    `nodes:\n  - id: a\n    employee: ${id}-worker\n    output: out.md\n`,
    'utf8',
  );
}

describe('listDepartments + getDepartment', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fx.cleanup());

  it('listDepartments — несколько отделов', async () => {
    placeDept(fx.cwd, 'marketing-content');
    placeDept(fx.cwd, 'support');

    const list = await listDepartments({ cwd: fx.cwd });
    expect(list.map((d) => d.id).sort()).toEqual(['marketing-content', 'support']);
  });

  it('getDepartment — null для неизвестного', async () => {
    placeDept(fx.cwd, 'marketing-content');
    const d = await getDepartment('nope', { cwd: fx.cwd });
    expect(d).toBeNull();
  });

  it('getDepartment возвращает по id', async () => {
    placeDept(fx.cwd, 'marketing-content');
    const d = await getDepartment('marketing-content', { cwd: fx.cwd });
    expect(d?.id).toBe('marketing-content');
    expect(d?.pipeline.nodes).toHaveLength(1);
  });

  it('пустой список — пустой массив', async () => {
    const list = await listDepartments({ cwd: fx.cwd });
    expect(list).toEqual([]);
  });

  it('дубликаты id — ошибка', async () => {
    // создаём вручную два глоб-найденных файла под одним basename
    placeDept(fx.cwd, 'marketing-content');
    // через DI подменим glob чтобы вернуть тот же файл дважды
    const glob = async (): Promise<string[]> => [
      join(fx.cwd, 'departments', 'marketing-content', 'DEPARTMENT.md'),
      join(fx.cwd, 'departments', 'marketing-content', 'DEPARTMENT.md'),
    ];
    await expect(listDepartments({ cwd: fx.cwd, glob })).rejects.toThrow(DepartmentRegistryError);
  });
});
