// Proof-тест engine/user split (OSS v1.0, инвариант §2.4): обновление движка
// (git pull) НЕ трогает пользовательский слой. Механизм — ОТСУТСТВИЕ файлов в
// upstream-трекинге (а не merge-драйвер): ни один файл под agents/ org/ ai-clone/
// content/ + пользовательскими config/*.md не должен быть в git, и все они должны
// быть покрыты .gitignore. Если кто-то случайно `git add -f` пользовательский
// файл — этот тест падает. См. docs/UPDATING.md + engine-manifest.json.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function git(args: string): string {
  return execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8' }).trim();
}
function isIgnored(path: string): boolean {
  try {
    execSync(`git check-ignore -q "${path}"`, { cwd: ROOT });
    return true;
  } catch {
    return false;
  }
}

const USER_DIRS = ['agents', 'org', 'ai-clone', 'content'];
const USER_CONFIG = [
  'config/projects.md',
  'config/allowlist.md',
  'config/budget.md',
  'config/support-source.md',
];

describe('engine/user split — git pull движка не затирает пользовательский слой', () => {
  it('ни один файл пользовательского слоя не в git-трекинге (absence mechanism)', () => {
    for (const d of USER_DIRS) {
      expect(`${d}: ${git(`ls-files ${d}`)}`).toBe(`${d}: `);
    }
    for (const f of USER_CONFIG) {
      expect(`${f}: ${git(`ls-files ${f}`)}`).toBe(`${f}: `);
    }
  });

  it('.gitignore покрывает все пользовательские пути', () => {
    expect(isIgnored('org/INDEX.md')).toBe(true);
    expect(isIgnored('ai-clone/INDEX.md')).toBe(true);
    expect(isIgnored('agents/whatever/AGENT.md')).toBe(true);
    expect(isIgnored('content/draft.md')).toBe(true);
    for (const f of USER_CONFIG) expect(isIgnored(f)).toBe(true);
  });

  it('engine-файлы наоборот в трекинге (движок поставляется через upstream)', () => {
    // Файлы, существовавшие до OSS-рефактора — гарантированно tracked.
    expect(git('ls-files src/routines/parser.ts')).not.toBe('');
    expect(git('ls-files config/pricing.md')).not.toBe(''); // engine-tuning config остаётся tracked
    expect(git('ls-files package.json')).not.toBe('');
  });

  it('engine config-tuning файлы НЕ игнорируются (обновляются на git pull)', () => {
    expect(isIgnored('config/pricing.md')).toBe(false);
    expect(isIgnored('config/triage.md')).toBe(false);
  });

  it('engine-manifest: user[] и engine[] не пересекаются, user-config в .gitignore', () => {
    const manifest = JSON.parse(readFileSync(resolve(ROOT, 'engine-manifest.json'), 'utf8')) as {
      engine: string[];
      user: string[];
    };
    const eng = new Set(manifest.engine);
    for (const u of manifest.user) expect(eng.has(u)).toBe(false);
    // Каждый user-config из манифеста реально игнорируется.
    for (const f of USER_CONFIG) expect(manifest.user).toContain(f);
  });
});
