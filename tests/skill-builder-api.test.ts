// Тесты для bridge/skill-builder.ts saveNewSkill (Фаза 7, пункт C).
//
// Стратегия:
//   * saveNewSkill пишет файлы в реальную FS — используем tmpdir + process.chdir,
//     чтобы skills/<name>/ лежало внутри tmpdir и не загрязняло проект.
//   * После теста — process.chdir обратно + rm -rf.
//   * handleSkillBuilderMessage не тестируем end-to-end (это означало бы
//     поднимать dist/ + реально дёргать Sonnet — запрет «не дёргать LLM в
//     тестах»). Тестируем только саму POST /skills логику через прямой вызов
//     saveNewSkill.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveNewSkill } from '../bridge/skill-builder.js';
import { parseSkillSources } from '../src/skills/parser.js';

// Тесты НЕ требуют скомпилированного dist/ — пробрасываем parseSkillSources
// через DI. В проде bridge/skill-builder загрузит его из dist/src/.
const deps = { parseSkillSources };

let prevCwd: string;
let workDir: string;

beforeEach(() => {
  prevCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), 'skill-builder-test-'));
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(workDir, { recursive: true, force: true });
});

const VALID_SKILL_MD = `---
name: my-new-skill
description: Тестовый скилл для unit-тестов.
version: 1.0.0
category: automation
---

# Тело
Делает что-то полезное.`;

const VALID_PERMISSIONS_MD = `bashWhitelist: ["pnpm exec tsx skills/my-new-skill/scripts/run.ts"]
maxStepsPerInvocation: 10
`;

describe('saveNewSkill — happy path', () => {
  it('создаёт skills/<name>/SKILL.md + permissions.md + scripts/', async () => {
    const res = await saveNewSkill(
      {
        name: 'my-new-skill',
        skillMd: VALID_SKILL_MD,
        permissionsMd: VALID_PERMISSIONS_MD,
      },
      deps,
    );
    expect(res.name).toBe('my-new-skill');
    // /var → /private/var на macOS, поэтому endsWith не toBe.
    expect(res.filePath.endsWith(join('skills', 'my-new-skill'))).toBe(true);
    expect(existsSync(join(res.filePath, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(res.filePath, 'permissions.md'))).toBe(true);
    expect(existsSync(join(res.filePath, 'scripts'))).toBe(true);

    const skill = readFileSync(join(res.filePath, 'SKILL.md'), 'utf8');
    expect(skill).toBe(VALID_SKILL_MD);
  });

  it('без permissions.md — файл не создаётся, но scripts/ существует', async () => {
    const res = await saveNewSkill(
      {
        name: 'no-perms',
        skillMd: `---
name: no-perms
description: ok
---
body`,
        permissionsMd: '',
      },
      deps,
    );
    expect(existsSync(join(res.filePath, 'permissions.md'))).toBe(false);
    expect(existsSync(join(res.filePath, 'scripts'))).toBe(true);
  });
});

describe('saveNewSkill — validation errors', () => {
  it('отвергает имя не в kebab-case', async () => {
    await expect(
      saveNewSkill(
        {
          name: 'My_Bad_Name',
          skillMd: VALID_SKILL_MD,
          permissionsMd: '',
        },
        deps,
      ),
    ).rejects.toThrow(/kebab-case/);
  });

  it('отвергает path-traversal в имени', async () => {
    await expect(
      saveNewSkill(
        {
          name: '../etc',
          skillMd: VALID_SKILL_MD,
          permissionsMd: '',
        },
        deps,
      ),
    ).rejects.toThrow(/kebab-case/);
  });

  it('отвергает пустой SKILL.md', async () => {
    await expect(
      saveNewSkill(
        {
          name: 'empty',
          skillMd: '',
          permissionsMd: '',
        },
        deps,
      ),
    ).rejects.toThrow(/SKILL\.md/);
  });

  it('отвергает невалидный frontmatter SKILL.md', async () => {
    await expect(
      saveNewSkill(
        {
          name: 'broken',
          skillMd: 'no frontmatter here at all',
          permissionsMd: '',
        },
        deps,
      ),
    ).rejects.toThrow();
  });

  it('отвергает SKILL.md если name внутри не совпадает с req.name', async () => {
    await expect(
      saveNewSkill(
        {
          name: 'expected-name',
          skillMd: `---
name: different-name
description: x
---
body`,
          permissionsMd: '',
        },
        deps,
      ),
    ).rejects.toThrow(/совпада|name/i);
  });

  it('отвергает повторное создание того же скилла', async () => {
    await saveNewSkill(
      {
        name: 'dup',
        skillMd: `---
name: dup
description: x
---
body`,
        permissionsMd: '',
      },
      deps,
    );
    await expect(
      saveNewSkill(
        {
          name: 'dup',
          skillMd: `---
name: dup
description: y
---
body`,
          permissionsMd: '',
        },
        deps,
      ),
    ).rejects.toThrow(/уже существует/);
  });
});
