// Тесты для scripts/dept-update.ts (Фаза 6).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { instantiateDepartment } from '../scripts/dept-instantiate.js';
import { DeptUpdateError, updateDepartment } from '../scripts/dept-update.js';

interface Fixture {
  cwd: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const cwd = mkdtempSync(join(tmpdir(), 'dept-update-'));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function placeTemplate(cwd: string, id: string, deptBody = 'body'): void {
  const tdir = join(cwd, 'templates', 'departments', id);
  mkdirSync(join(tdir, 'shared'), { recursive: true });
  mkdirSync(join(tdir, 'employees'), { recursive: true });
  writeFileSync(
    join(tdir, 'DEPARTMENT.md'),
    `---\nname: T\ndescription: t\n---\n${deptBody}`,
    'utf8',
  );
  writeFileSync(
    join(tdir, 'pipeline.yml'),
    `nodes:\n  - id: a\n    employee: ${id}-w\n    output: out.md\n`,
    'utf8',
  );
  writeFileSync(join(tdir, 'shared', 'topics-backlog.md'), '# topics v1\n', 'utf8');
  writeFileSync(
    join(tdir, 'employees', 'researcher.md'),
    `---\nid: ${id}-researcher\nprojectId: p\nenabled: false\ntrigger: manual\ntools: []\nmodel: claude-sonnet-4-6\nmaxTokens: 1000\ntimeoutMs: 60000\noutputType: journal-only\ndescription: r\n---\nbody`,
    'utf8',
  );
}

describe('updateDepartment', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fx.cleanup());

  it('обновляет DEPARTMENT.md, pipeline.yml и shared/, не трогая routines', async () => {
    placeTemplate(fx.cwd, 'marketing-content', 'body v1');
    await instantiateDepartment({ templateId: 'marketing-content', cwd: fx.cwd });

    // Меняем шаблон: новый body + новый topics
    placeTemplate(fx.cwd, 'marketing-content', 'body v2');
    writeFileSync(
      join(fx.cwd, 'templates/departments/marketing-content/shared/topics-backlog.md'),
      '# topics v2\n- [ ] new topic\n',
      'utf8',
    );

    // Дописываем что-то в routine — проверим что не затёрто.
    const routinePath = join(fx.cwd, 'routines/marketing-content-researcher.md');
    writeFileSync(routinePath, `${readFileSync(routinePath, 'utf8')}\n\n## CUSTOM ADDITION`);

    const updated = await updateDepartment({ templateId: 'marketing-content', cwd: fx.cwd });
    expect(updated.length).toBeGreaterThan(0);

    const dept = readFileSync(join(fx.cwd, 'departments/marketing-content/DEPARTMENT.md'), 'utf8');
    expect(dept).toContain('body v2');

    const topics = readFileSync(
      join(fx.cwd, 'departments/marketing-content/shared/topics-backlog.md'),
      'utf8',
    );
    expect(topics).toContain('topics v2');
    expect(topics).toContain('new topic');

    // Routine не затёрта.
    const routineAfter = readFileSync(routinePath, 'utf8');
    expect(routineAfter).toContain('## CUSTOM ADDITION');
  });

  it('отказывается если department не инстанцирован', async () => {
    placeTemplate(fx.cwd, 'marketing-content');
    await expect(
      updateDepartment({ templateId: 'marketing-content', cwd: fx.cwd }),
    ).rejects.toThrow(DeptUpdateError);
  });

  it('отказывается если template не найден', async () => {
    await expect(updateDepartment({ templateId: 'nope', cwd: fx.cwd })).rejects.toThrow(
      /не найден/,
    );
  });
});
