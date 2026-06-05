// Guard: каждый поставляемый пример-агент examples/agents/<id>/ обязан валидно
// парситься через parseAgentFolder. Ломаный пример не должен попасть в релиз.
// Это и round-trip-проверка кодмода scripts/migrate-routines.ts.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAgentFolder } from '../../src/routines/agent-loader.js';

const EXAMPLES_DIR = resolve(process.cwd(), 'examples/agents');

function exampleAgentDirs(): string[] {
  if (!existsSync(EXAMPLES_DIR)) return [];
  return readdirSync(EXAMPLES_DIR).filter((name) =>
    statSync(resolve(EXAMPLES_DIR, name)).isDirectory(),
  );
}

describe('examples/agents/* — все примеры валидны', () => {
  const dirs = exampleAgentDirs();

  it('есть хотя бы один пример-агент', () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  it.each(dirs)('пример %s парсится в валидный Routine', async (id) => {
    const r = await parseAgentFolder(resolve(EXAMPLES_DIR, id));
    expect(r.id).toBeTruthy();
    expect(r.id).toBe(id); // инвариант: id === имя папки (load-bearing для launchd)
    expect(r.projectId).toBe('self');
    expect(r.model).toMatch(/^(claude|voyage)-/); // алиас уже резолвнут
    expect(r.prompt.length).toBeGreaterThan(0);
    expect(['telegram-thread', 'journal-only', 'both']).toContain(r.outputType);
    expect(r.trigger === 'manual' || r.trigger.length > 0).toBe(true);
  });
});
