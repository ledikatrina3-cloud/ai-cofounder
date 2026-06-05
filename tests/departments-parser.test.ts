// Тесты для department parser'а (Фаза 5).

import { describe, expect, it } from 'vitest';
import { DepartmentParseError, parseDepartmentSources } from '../src/departments/parser.js';

const DEPT_DIR = '/abs/repo/departments/marketing-content';
const DEPT_MD_PATH = '/abs/repo/departments/marketing-content/DEPARTMENT.md';
const PIPELINE_PATH = '/abs/repo/departments/marketing-content/pipeline.yml';
const SHARED_DIR = '/abs/repo/departments/marketing-content/shared';

function makeDepartmentSource(
  overrides: Record<string, string | undefined> = {},
  body = 'Body.',
): string {
  const fields: Record<string, string> = {
    name: 'Marketing Content',
    description: 'Marketing pipeline.',
    ...overrides,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) delete fields[k];
  }
  const lines = ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', '', body];
  return lines.join('\n');
}

const MIN_PIPELINE = `
nodes:
  - id: research
    employee: r
    output: out.md
`;

describe('parseDepartmentSources — happy path', () => {
  it('минимальный валидный department', () => {
    const dept = parseDepartmentSources({
      deptDir: DEPT_DIR,
      departmentSource: makeDepartmentSource(),
      pipelineSource: MIN_PIPELINE,
      departmentMdPath: DEPT_MD_PATH,
      pipelinePath: PIPELINE_PATH,
      sharedDir: SHARED_DIR,
    });
    expect(dept.id).toBe('marketing-content');
    expect(dept.name).toBe('Marketing Content');
    expect(dept.description).toBe('Marketing pipeline.');
    expect(dept.body).toBe('Body.');
    expect(dept.budget).toBeUndefined();
    expect(dept.pipeline.nodes).toHaveLength(1);
  });

  it('с budget', () => {
    const src = `---
name: Marketing Content
description: x.
budget:
  perDayUsd: 5.0
  perRunUsd: 1.0
---
Body.`;
    const dept = parseDepartmentSources({
      deptDir: DEPT_DIR,
      departmentSource: src,
      pipelineSource: MIN_PIPELINE,
      departmentMdPath: DEPT_MD_PATH,
      pipelinePath: PIPELINE_PATH,
      sharedDir: SHARED_DIR,
    });
    expect(dept.budget).toEqual({ perDayUsd: 5, perRunUsd: 1 });
  });
});

describe('parseDepartmentSources — errors', () => {
  it('без name — ошибка', () => {
    const src = `---
description: x.
---
b`;
    expect(() =>
      parseDepartmentSources({
        deptDir: DEPT_DIR,
        departmentSource: src,
        pipelineSource: MIN_PIPELINE,
        departmentMdPath: DEPT_MD_PATH,
        pipelinePath: PIPELINE_PATH,
        sharedDir: SHARED_DIR,
      }),
    ).toThrow(DepartmentParseError);
  });

  it('budget perDayUsd ≤ 0 — ошибка', () => {
    const src = `---
name: x
description: y
budget:
  perDayUsd: 0
  perRunUsd: 1
---
b`;
    expect(() =>
      parseDepartmentSources({
        deptDir: DEPT_DIR,
        departmentSource: src,
        pipelineSource: MIN_PIPELINE,
        departmentMdPath: DEPT_MD_PATH,
        pipelinePath: PIPELINE_PATH,
        sharedDir: SHARED_DIR,
      }),
    ).toThrow(/perDayUsd.+должно быть числом > 0/);
  });

  it('budget строка вместо числа — ошибка', () => {
    const src = `---
name: x
description: y
budget:
  perDayUsd: "5"
  perRunUsd: 1
---
b`;
    expect(() =>
      parseDepartmentSources({
        deptDir: DEPT_DIR,
        departmentSource: src,
        pipelineSource: MIN_PIPELINE,
        departmentMdPath: DEPT_MD_PATH,
        pipelinePath: PIPELINE_PATH,
        sharedDir: SHARED_DIR,
      }),
    ).toThrow();
  });

  it('файл не начинается с ---', () => {
    expect(() =>
      parseDepartmentSources({
        deptDir: DEPT_DIR,
        departmentSource: 'no frontmatter',
        pipelineSource: MIN_PIPELINE,
        departmentMdPath: DEPT_MD_PATH,
        pipelinePath: PIPELINE_PATH,
        sharedDir: SHARED_DIR,
      }),
    ).toThrow(/frontmatter delimiter/);
  });

  it('pipeline.yml невалиден — пробрасывает', () => {
    expect(() =>
      parseDepartmentSources({
        deptDir: DEPT_DIR,
        departmentSource: makeDepartmentSource(),
        pipelineSource: 'nodes: []',
        departmentMdPath: DEPT_MD_PATH,
        pipelinePath: PIPELINE_PATH,
        sharedDir: SHARED_DIR,
      }),
    ).toThrow();
  });
});
