// Тесты dual-loader registry (OSS v1.0): agents/<id>/ грузятся рядом с legacy
// routines/*.md, ПОБЕЖДАЮТ при коллизии id, дубли внутри agents всё равно throw'ят.
//
// Изоляция: реальный tmpdir-cwd с fixture-файлами (как routines.test.ts) — glob
// настоящий fast-glob, pathExists прокинут чтобы не зависеть от диска.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoutineRegistryError, listRoutines } from '../../src/routines/registry.js';

interface Fixture {
  cwd: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const cwd = mkdtempSync(join(tmpdir(), 'agents-win-test-'));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function writeFile(cwd: string, relPath: string, content: string): void {
  const full = join(cwd, relPath);
  const dir = full.replace(/\/[^/]+$/, '');
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content, 'utf8');
}

const PROJECTS_REGISTRY = `## example-project

- name: Acme Academy
- path: /fixture/example-project
- enabled: true
- mapPath: projects/example-project/map.md
- routinesGlob: routines/example-project-*.md
`;

function legacyRoutine(id: string): string {
  return [
    '---',
    `id: ${id}`,
    'projectId: example-project',
    'enabled: true',
    'trigger: manual',
    'tools: []',
    'model: claude-sonnet-4-6',
    'maxTokens: 100000',
    'timeoutMs: 300000',
    'outputType: journal-only',
    'description: Legacy routine',
    '---',
    '',
    'Я legacy routine.',
  ].join('\n');
}

function agentMd(id: string): string {
  return [
    '---',
    `id: ${id}`,
    'displayName: Агент',
    'model: sonnet',
    'enabled: true',
    'schedule: manual',
    'output: journal',
    '---',
    '',
    'Краткое описание агента.',
  ].join('\n');
}

const opts = (cwd: string) => ({
  cwd,
  projectRegistryOptions: { cwd, pathExists: async () => true },
});

describe('registry dual-loader — agents-win', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fx.cleanup());

  it('agents/<id>/ побеждает legacy routine с тем же id (legacy молча отброшен)', async () => {
    writeFile(fx.cwd, 'config/projects.md', PROJECTS_REGISTRY);
    // legacy routines/example-project-dup.md (id=dup) И agents/dup/ (id=dup).
    writeFile(fx.cwd, 'routines/example-project-dup.md', legacyRoutine('dup'));
    writeFile(fx.cwd, 'agents/dup/AGENT.md', agentMd('dup'));
    writeFile(fx.cwd, 'agents/dup/prompt.md', 'Я агент, не legacy.');

    const list = await listRoutines(opts(fx.cwd));
    const dups = list.filter((r) => r.id === 'dup');
    expect(dups).toHaveLength(1); // НЕ throw — legacy тихо отброшен
    expect(dups[0]?.agentDir).toBeDefined(); // победил агент
    expect(dups[0]?.prompt).toBe('Я агент, не legacy.');
    expect(dups[0]?.projectId).toBe('self');
  });

  it('legacy и agent с РАЗНЫМИ id — оба видны', async () => {
    writeFile(fx.cwd, 'config/projects.md', PROJECTS_REGISTRY);
    writeFile(fx.cwd, 'routines/example-project-legacy.md', legacyRoutine('legacy-one'));
    writeFile(fx.cwd, 'agents/agent-one/AGENT.md', agentMd('agent-one'));
    writeFile(fx.cwd, 'agents/agent-one/prompt.md', 'p');

    const list = await listRoutines(opts(fx.cwd));
    const ids = list.map((r) => r.id).sort();
    expect(ids).toContain('legacy-one');
    expect(ids).toContain('agent-one');
  });

  it('агент с id ≠ имя папки → битая папка скипается (инвариант folder===id)', async () => {
    writeFile(fx.cwd, 'config/projects.md', PROJECTS_REGISTRY);
    // папка 'mismatch', а frontmatter id='other' — рассинхрон, parseAgentFolder
    // throw'ает, registry скипает папку (не валит весь реестр).
    writeFile(fx.cwd, 'agents/mismatch/AGENT.md', agentMd('other'));
    writeFile(fx.cwd, 'agents/mismatch/prompt.md', 'p');
    // плюс здоровый агент — он обязан остаться.
    writeFile(fx.cwd, 'agents/healthy/AGENT.md', agentMd('healthy'));
    writeFile(fx.cwd, 'agents/healthy/prompt.md', 'p');

    const list = await listRoutines(opts(fx.cwd));
    const ids = list.map((r) => r.id);
    expect(ids).toContain('healthy');
    expect(ids).not.toContain('other');
    expect(ids).not.toContain('mismatch');
  });

  it('два LEGACY routine с одинаковым id → RoutineRegistryError (глобальная уникальность)', async () => {
    writeFile(fx.cwd, 'config/projects.md', PROJECTS_REGISTRY);
    writeFile(fx.cwd, 'routines/example-project-x.md', legacyRoutine('dup'));
    writeFile(fx.cwd, 'routines/example-project-y.md', legacyRoutine('dup'));

    await expect(listRoutines(opts(fx.cwd))).rejects.toThrow(RoutineRegistryError);
  });

  it('одна битая папка агента НЕ валит весь реестр — здоровые грузятся', async () => {
    writeFile(fx.cwd, 'config/projects.md', PROJECTS_REGISTRY);
    writeFile(fx.cwd, 'agents/ok-one/AGENT.md', agentMd('ok-one'));
    writeFile(fx.cwd, 'agents/ok-one/prompt.md', 'p');
    writeFile(fx.cwd, 'agents/ok-two/AGENT.md', agentMd('ok-two'));
    writeFile(fx.cwd, 'agents/ok-two/prompt.md', 'p');
    // битая папка: невалидная модель (алиас не резолвится) → parseAgentFolder throw.
    writeFile(
      fx.cwd,
      'agents/broken/AGENT.md',
      agentMd('broken').replace('model: sonnet', 'model: gpt-4'),
    );
    writeFile(fx.cwd, 'agents/broken/prompt.md', 'p');

    // НЕ throw — битая папка скипается с warn, остальные видны.
    const list = await listRoutines(opts(fx.cwd));
    const ids = list.map((r) => r.id).sort();
    expect(ids).toContain('ok-one');
    expect(ids).toContain('ok-two');
    expect(ids).not.toContain('broken');
  });

  it('чистый self-contained: только agents/, без legacy routines', async () => {
    writeFile(fx.cwd, 'config/projects.md', PROJECTS_REGISTRY);
    writeFile(fx.cwd, 'agents/solo/AGENT.md', agentMd('solo'));
    writeFile(fx.cwd, 'agents/solo/prompt.md', 'Соло-агент.');

    const list = await listRoutines(opts(fx.cwd));
    expect(list.map((r) => r.id)).toEqual(['solo']);
    expect(list[0]?.projectId).toBe('self');
  });
});
