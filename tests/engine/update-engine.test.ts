// Proof-тест механизма обновления движка (OSS v1.0, §4/§5 спеки).
//
// Строит ДВА настоящих git-репо во временной папке: `upstream` (движок, который
// апдейтится) и `fork` (пользовательский форк). Делает в upstream полный набор
// изменений по engine-путям — ADD / MODIFY / DELETE / RENAME — плюс adversarial
// попытку добавить файл по USER-пути (agents/). Затем прогоняет реальный
// scripts/update-engine.sh (с UPDATE_ENGINE_SKIP_GATE=1, чтобы не звать
// install/build/test) и доказывает:
//   (a) upstream ADD приземлился;
//   (b) MODIFY применился;
//   (c) DELETE удалил локальный файл;
//   (d) RENAME применился (новый есть, старого нет);
//   (e) пользовательский файл agents/foo/AGENT.md байт-в-байт цел;
//   (f) adversarial agents/evil/AGENT.md НЕ приземлился (user-путь не в engine[]);
//   (g) нет conflict-маркеров.
//
// Это регрессионный страж против двух проваленных аудитом дефектов скрипта:
// инвертированного направления `git diff` и bash-4-only `mapfile`.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(process.cwd(), 'scripts/update-engine.sh');
const MANIFEST = JSON.stringify({ engine: ['src'], user: ['agents'] });

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(full.replace(/\/[^/]+$/, ''), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

describe('update-engine.sh — proof апдейт не трогает user-слой и корректно применяет diff', () => {
  let dir: string;
  let upstream: string;
  let fork: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'update-engine-test-'));
    upstream = join(dir, 'upstream');
    fork = join(dir, 'fork');

    // --- upstream (база) ---
    mkdirSync(upstream, { recursive: true });
    git(upstream, ['init', '-q', '-b', 'main']);
    write(upstream, 'engine-manifest.json', MANIFEST);
    write(upstream, 'src/keep.ts', 'export const keep = 1;\n');
    write(upstream, 'src/mod.ts', 'export const v = "orig";\n');
    write(upstream, 'src/del.ts', 'export const del = true;\n');
    write(upstream, 'src/old.ts', 'export const renameMe = "stable contents";\n');
    git(upstream, ['add', '-A']);
    git(upstream, ['commit', '-qm', 'base']);

    // --- fork (на той же базе) + локальный user-файл ---
    mkdirSync(fork, { recursive: true });
    git(fork, ['init', '-q', '-b', 'main']);
    write(fork, 'engine-manifest.json', MANIFEST);
    write(fork, 'src/keep.ts', 'export const keep = 1;\n');
    write(fork, 'src/mod.ts', 'export const v = "orig";\n');
    write(fork, 'src/del.ts', 'export const del = true;\n');
    write(fork, 'src/old.ts', 'export const renameMe = "stable contents";\n');
    write(fork, 'agents/foo/AGENT.md', 'USER CONTENT — must survive byte-for-byte\n');
    git(fork, ['add', '-A']);
    git(fork, ['commit', '-qm', 'fork base + user agent']);
    git(fork, ['remote', 'add', 'upstream', upstream]);

    // --- upstream релиз: ADD / MODIFY / DELETE / RENAME + adversarial user-add ---
    write(upstream, 'src/added.ts', 'export const added = true;\n');
    write(upstream, 'src/mod.ts', 'export const v = "modified";\n');
    git(upstream, ['rm', '-q', 'src/del.ts']);
    git(upstream, ['mv', 'src/old.ts', 'src/new.ts']);
    write(upstream, 'agents/evil/AGENT.md', 'INJECTED — must NOT land in the fork\n');
    git(upstream, ['add', '-A']);
    git(upstream, ['commit', '-qm', 'release']);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('применяет ADD/MODIFY/DELETE/RENAME движка и не трогает user-слой', () => {
    execFileSync('bash', [SCRIPT, 'main'], {
      cwd: fork,
      encoding: 'utf8',
      env: { ...process.env, UPDATE_ENGINE_SKIP_GATE: '1' },
    });

    // (a) ADD
    expect(existsSync(join(fork, 'src/added.ts'))).toBe(true);
    // (b) MODIFY
    expect(readFileSync(join(fork, 'src/mod.ts'), 'utf8')).toContain('modified');
    // (c) DELETE
    expect(existsSync(join(fork, 'src/del.ts'))).toBe(false);
    // (d) RENAME (новый есть, старого нет — независимо от R vs A+D)
    expect(existsSync(join(fork, 'src/new.ts'))).toBe(true);
    expect(existsSync(join(fork, 'src/old.ts'))).toBe(false);
    // (e) user-файл цел байт-в-байт
    expect(readFileSync(join(fork, 'agents/foo/AGENT.md'), 'utf8')).toBe(
      'USER CONTENT — must survive byte-for-byte\n',
    );
    // (f) adversarial user-add НЕ приземлился (agents/ не в engine[])
    expect(existsSync(join(fork, 'agents/evil/AGENT.md'))).toBe(false);
    // (g) нет conflict-маркеров
    const keep = readFileSync(join(fork, 'src/keep.ts'), 'utf8');
    expect(keep).not.toContain('<<<<<<<');
  });
});
