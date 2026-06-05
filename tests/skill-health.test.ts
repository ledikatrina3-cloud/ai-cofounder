// Тесты для src/skills/health.ts (Фаза 7).
//
// Стратегия:
//   * runHealthCheck вызывается с DI: listSkills, runScript, emit.
//   * Никаких реальных spawn'ов — runScript мокаем и возвращаем заранее
//     заданный stdout/stderr/exitCode/timedOut.
//   * Никаких реальных bridge-эмитов — emit мокаем (vi.fn).

import { describe, expect, it, vi } from 'vitest';
import { runHealthCheck } from '../src/skills/health.js';
import type { Skill } from '../src/skills/types.js';

const SKILL_DIR = '/tmp/skill-test';

function makeSkill(opts: { name: string; withHealthCheck?: boolean }): Skill {
  const s: Skill = {
    name: opts.name,
    description: 'test',
    prompt: 'body',
    filePath: SKILL_DIR,
    permissions: {},
  };
  if (opts.withHealthCheck === true) {
    s.permissions.healthCheck = {
      script: 'scripts/health-check.ts',
      schedule: '0 7 * * *',
    };
  }
  return s;
}

describe('runHealthCheck', () => {
  it('возвращает status:skipped если у скилла нет healthCheck в permissions', async () => {
    const skill = makeSkill({ name: 'foo' });
    const emit = vi.fn(async () => {});
    const runScript = vi.fn();

    const result = await runHealthCheck('foo', {
      listSkills: async () => [skill],
      emit,
      runScript,
    });

    expect(result.status).toBe('skipped');
    expect(result.skillName).toBe('foo');
    expect(result.reason).toBe('no health-check defined');
    expect(runScript).not.toHaveBeenCalled();
    // skipped не эмитит bridge events.
    expect(emit).not.toHaveBeenCalled();
  });

  it('возвращает status:skipped если скилл не найден в реестре', async () => {
    const emit = vi.fn(async () => {});
    const result = await runHealthCheck('no-such', {
      listSkills: async () => [],
      emit,
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('skill not found');
    expect(emit).not.toHaveBeenCalled();
  });

  it('возвращает status:ok если скрипт вернул JSON со status:ok и exit=0', async () => {
    const skill = makeSkill({ name: 'foo', withHealthCheck: true });
    const emit = vi.fn(async () => {});
    const runScript = vi.fn(async () => ({
      stdout: 'noise line\n{"status": "ok", "extra": "info"}\n',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }));

    const result = await runHealthCheck('foo', {
      listSkills: async () => [skill],
      emit,
      runScript,
    });

    expect(result.status).toBe('ok');
    expect(result.output).toEqual({ status: 'ok', extra: 'info' });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'skill.health.ok', skillName: 'foo' }),
    );
  });

  it('возвращает status:failed если exit != 0', async () => {
    const skill = makeSkill({ name: 'foo', withHealthCheck: true });
    const emit = vi.fn(async () => {});
    const runScript = vi.fn(async () => ({
      stdout: '',
      stderr: 'script crashed',
      exitCode: 1,
      timedOut: false,
    }));

    const result = await runHealthCheck('foo', {
      listSkills: async () => [skill],
      emit,
      runScript,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('exit 1');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'skill.health.failed' }));
  });

  it('возвращает status:failed если JSON невалидный', async () => {
    const skill = makeSkill({ name: 'foo', withHealthCheck: true });
    const emit = vi.fn(async () => {});
    const runScript = vi.fn(async () => ({
      stdout: 'this is not json',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }));

    const result = await runHealthCheck('foo', {
      listSkills: async () => [skill],
      emit,
      runScript,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('did not emit JSON');
  });

  it('возвращает status:failed если timeout', async () => {
    const skill = makeSkill({ name: 'foo', withHealthCheck: true });
    const emit = vi.fn(async () => {});
    const runScript = vi.fn(async () => ({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: true,
    }));

    const result = await runHealthCheck('foo', {
      listSkills: async () => [skill],
      emit,
      runScript,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('timeout');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'skill.health.failed' }));
  });

  it('возвращает status:failed если JSON содержит status:failed (даже при exit=0)', async () => {
    const skill = makeSkill({ name: 'foo', withHealthCheck: true });
    const emit = vi.fn(async () => {});
    const runScript = vi.fn(async () => ({
      stdout: JSON.stringify({ status: 'failed', errors: ['boom'] }),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }));

    const result = await runHealthCheck('foo', {
      listSkills: async () => [skill],
      emit,
      runScript,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('boom');
    expect(result.output).toEqual({ status: 'failed', errors: ['boom'] });
  });

  it('падает с failed (а не throws) если spawn сам бросил', async () => {
    const skill = makeSkill({ name: 'foo', withHealthCheck: true });
    const emit = vi.fn(async () => {});
    const runScript = vi.fn(async () => {
      throw new Error('ENOENT pnpm');
    });

    const result = await runHealthCheck('foo', {
      listSkills: async () => [skill],
      emit,
      runScript,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('spawn failed');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'skill.health.failed' }));
  });

  it('не запускает скрипт если path-traversal через ../', async () => {
    const skill: Skill = {
      name: 'foo',
      description: 'x',
      prompt: '',
      filePath: SKILL_DIR,
      permissions: {
        healthCheck: {
          script: '../../etc/passwd',
          schedule: '0 7 * * *',
        },
      },
    };
    const emit = vi.fn(async () => {});
    const runScript = vi.fn();

    const result = await runHealthCheck('foo', {
      listSkills: async () => [skill],
      emit,
      runScript,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('outside skill dir');
    expect(runScript).not.toHaveBeenCalled();
  });
});
