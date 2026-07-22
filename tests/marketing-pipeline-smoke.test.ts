// Smoke-тест для marketing-content pipeline (Фаза 6).
//
// Цель: проверить, что шаблон templates/departments/marketing-content/
//   1. парсится без ошибок (DEPARTMENT.md + pipeline.yml)
//   2. employees/*.md — валидные routine-файлы
//   3. через executePipeline с замокнутыми runRoutine + requestApproval
//      проходит до конца (success)
//
// НЕ запускает реальные LLM-вызовы, не публикует, не ходит в сеть.

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDepartmentSources } from '../src/departments/parser.js';
import { executePipeline } from '../src/pipelines/executor.js';
import { parseRoutineSource } from '../src/routines/parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TEMPLATE_DIR = join(REPO_ROOT, 'templates', 'departments', 'marketing-content');

describe('marketing-content pipeline smoke', () => {
  it('шаблон marketing-content парсится', async () => {
    const deptMd = await readFile(join(TEMPLATE_DIR, 'DEPARTMENT.md'), 'utf8');
    const pipelineYml = await readFile(join(TEMPLATE_DIR, 'pipeline.yml'), 'utf8');
    const dept = parseDepartmentSources({
      deptDir: TEMPLATE_DIR,
      departmentSource: deptMd,
      pipelineSource: pipelineYml,
      departmentMdPath: join(TEMPLATE_DIR, 'DEPARTMENT.md'),
      pipelinePath: join(TEMPLATE_DIR, 'pipeline.yml'),
      sharedDir: join(TEMPLATE_DIR, 'shared'),
    });
    expect(dept.id).toBe('marketing-content');
    expect(dept.pipeline.nodes.length).toBeGreaterThan(5);
  });

  it('все employees/*.md — валидные routine-файлы', async () => {
    const employeesDir = join(TEMPLATE_DIR, 'employees');
    const files = await readdir(employeesDir);
    const mdFiles = files.filter((f) => f.endsWith('.md'));
    expect(mdFiles.length).toBeGreaterThanOrEqual(7); // researcher, writer-editor, seo-auditor, cover-designer, vc/dzen/tg publishers, analytics
    for (const f of mdFiles) {
      const src = await readFile(join(employeesDir, f), 'utf8');
      const routine = parseRoutineSource(join(employeesDir, f), src);
      expect(routine.id).toMatch(/^marketing-content-/);
      expect(routine.departmentId).toBe('marketing-content');
    }
  });

  it('executePipeline проходит до конца с замокнутыми deps', async () => {
    const deptMd = await readFile(join(TEMPLATE_DIR, 'DEPARTMENT.md'), 'utf8');
    const pipelineYml = await readFile(join(TEMPLATE_DIR, 'pipeline.yml'), 'utf8');
    const dept = parseDepartmentSources({
      deptDir: TEMPLATE_DIR,
      departmentSource: deptMd,
      pipelineSource: pipelineYml,
      departmentMdPath: join(TEMPLATE_DIR, 'DEPARTMENT.md'),
      pipelinePath: join(TEMPLATE_DIR, 'pipeline.yml'),
      sharedDir: join(TEMPLATE_DIR, 'shared'),
    });

    const calls: string[] = [];
    const result = await executePipeline(dept, 'smoke-run-1', {
      // Все employees успешны.
      runRoutine: async (employee) => {
        calls.push(employee);
        return { status: 'ok', output: `# stub for ${employee}\n` };
      },
      // Все human-gate'ы approve.
      requestApproval: async () => 'approved',
      // Артефакты не пишем (in-memory).
      writeArtifact: async () => undefined,
      artifactExists: async () => false,
      skipPersist: true,
      cwd: '/cwd',
    });

    // Pipeline должен пройти до конца. Status может быть 'success' или
    // 'failed' если parallel branches failed (но мы их все мокнули как ok).
    expect(result.status).toBe('success');

    // Должны быть вызваны все ключевые employees:
    expect(calls).toContain('marketing-content-researcher');
    expect(calls).toContain('marketing-content-writer-editor');
    expect(calls).toContain('marketing-content-seo-auditor');
    expect(calls).toContain('marketing-content-cover-designer');
    expect(calls).toContain('marketing-content-vc-publisher');
    expect(calls).toContain('marketing-content-dzen-publisher');
    expect(calls).toContain('marketing-content-tg-publisher');
    expect(calls).toContain('marketing-content-analytics');
  });
});
