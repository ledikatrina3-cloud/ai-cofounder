// Vitest тесты для src/routines/cron.ts
//
// Без реального launchctl и без I/O (только парсинг и генерация XML).
//
// Покрываем:
//   * cronToStartCalendarInterval — 5 кейсов:
//       1. '0 7 * * *'     → {Minute: 0, Hour: 7}
//       2. '*/30 * * * *'  → [{Minute: 0}, {Minute: 30}]
//       3. '0 9 * * 1'     → {Minute: 0, Hour: 9, Weekday: 1}
//       4. '0 9 * * 0,6'   → [{Minute: 0, Hour: 9, Weekday: 0}, {Minute: 0, Hour: 9, Weekday: 6}]
//       5. '* * * * *'     → {}
//   * generateRoutinePlistXml — 3 кейса:
//       6. trigger='0 7 * * *' → plist содержит нужные строки
//       7. trigger='*/30 * * * *' → plist содержит '<array>'
//       8. trigger='manual' → throws

import { describe, expect, it } from 'vitest';
import { cronToStartCalendarInterval, generateRoutinePlistXml } from '../src/routines/cron.js';
import type { Routine } from '../src/routines/parser.js';

// ---------------------------------------------------------------------------
// Вспомогательная фабрика routine (без реального файла на диске).
// ---------------------------------------------------------------------------

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'test-id',
    projectId: 'test-project',
    enabled: true,
    trigger: '0 7 * * *',
    tools: [],
    model: 'claude-sonnet-4-5',
    maxTokens: 4096,
    timeoutMs: 60000,
    outputType: 'journal-only',
    description: 'Test routine',
    prompt: 'Do something.',
    filePath: '/fake/routines/test-id.md',
    ...overrides,
  };
}

const FAKE_PATHS = {
  node: '/Users/founder/.nvm/versions/node/v22.22.2/bin/node',
  tsxCli: '/Users/founder/ai-cofounder/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs',
  pathEnv: '/usr/local/bin:/usr/bin:/bin',
  repoRoot: '/Users/founder/ai-cofounder',
};

// ---------------------------------------------------------------------------
// cronToStartCalendarInterval
// ---------------------------------------------------------------------------

describe('cronToStartCalendarInterval', () => {
  it('0 7 * * * → single dict {Minute: 0, Hour: 7}', () => {
    const result = cronToStartCalendarInterval('0 7 * * *');
    expect(Array.isArray(result)).toBe(false);
    expect(result).toEqual({ Minute: 0, Hour: 7 });
  });

  it('*/30 * * * * → array of 2 dicts [{Minute: 0}, {Minute: 30}]', () => {
    const result = cronToStartCalendarInterval('*/30 * * * *');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([{ Minute: 0 }, { Minute: 30 }]);
  });

  it('0 9 * * 1 → single dict {Minute: 0, Hour: 9, Weekday: 1}', () => {
    const result = cronToStartCalendarInterval('0 9 * * 1');
    expect(Array.isArray(result)).toBe(false);
    expect(result).toEqual({ Minute: 0, Hour: 9, Weekday: 1 });
  });

  it('0 9 * * 0,6 → array [{Minute: 0, Hour: 9, Weekday: 0}, {Minute: 0, Hour: 9, Weekday: 6}]', () => {
    const result = cronToStartCalendarInterval('0 9 * * 0,6');
    expect(Array.isArray(result)).toBe(true);
    // Порядок важен: Weekday 0 (воскресенье) < Weekday 6 (суббота)
    expect(result).toEqual([
      { Minute: 0, Hour: 9, Weekday: 0 },
      { Minute: 0, Hour: 9, Weekday: 6 },
    ]);
  });

  it('* * * * * → empty dict {} (every minute)', () => {
    const result = cronToStartCalendarInterval('* * * * *');
    expect(Array.isArray(result)).toBe(false);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// generateRoutinePlistXml
// ---------------------------------------------------------------------------

describe('generateRoutinePlistXml', () => {
  it('routine с trigger=0 7 * * * → plist содержит label, tsx + cron-run-routine.ts, routine-id, Hour и Minute', () => {
    const routine = makeRoutine({ id: 'test-id', trigger: '0 7 * * *' });
    const xml = generateRoutinePlistXml(routine, FAKE_PATHS);

    expect(xml).toContain('com.ai-cofounder.routine-test-id');
    expect(xml).toContain(FAKE_PATHS.node);
    expect(xml).toContain(FAKE_PATHS.tsxCli);
    expect(xml).toContain('scripts/cron-run-routine.ts');
    expect(xml).toContain('test-id');
    expect(xml).toContain('<integer>7</integer>');
    expect(xml).toContain('<integer>0</integer>');
    expect(xml).toContain('<key>Hour</key>');
    expect(xml).toContain('<key>Minute</key>');
    // Проверяем структуру plist.
    expect(xml).toContain('<key>StartCalendarInterval</key>');
    // StartCalendarInterval должен быть одним <dict>, а не <array>.
    // Проверяем, что за ключом идёт сразу <dict>, без <array>.
    expect(xml).toMatch(/<key>StartCalendarInterval<\/key>\s*\n\s*<dict>/);
  });

  it('routine с trigger=*/30 * * * * → plist содержит <array> (multiple entries)', () => {
    const routine = makeRoutine({ id: 'test-id', trigger: '*/30 * * * *' });
    const xml = generateRoutinePlistXml(routine, FAKE_PATHS);

    expect(xml).toContain('<array>');
    expect(xml).toContain('<key>StartCalendarInterval</key>');
    // Два dict'а — по одному на каждую минуту (0 и 30).
    const dictCount = (xml.match(/<dict>/g) ?? []).length;
    // Один верхнеуровневый <dict> plist + два вложенных <dict> в <array>.
    expect(dictCount).toBeGreaterThanOrEqual(3);
  });

  it('routine с trigger=manual → throws ошибку', () => {
    const routine = makeRoutine({ trigger: 'manual' });
    expect(() => generateRoutinePlistXml(routine, FAKE_PATHS)).toThrow(/trigger='manual'/);
  });
});
