// Тесты резолва persistent-profile директорий.
//
// Не тестируем сам patchright — это интеграционный layer и требует
// chromium-binary'я. Тут только: правильно ли резолвится путь, кидает ли
// ошибки на невалидные id, создаётся ли директория с правами 0o700.

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { profilesRoot, resolveProfile } from '../src/browser/profiles.js';

describe('browser/profiles', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'browser-profiles-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('profilesRoot', () => {
    it('возвращает override rootDir когда передан', () => {
      const r = profilesRoot({ rootDir: '/tmp/custom' });
      expect(r).toBe('/tmp/custom');
    });

    it('возвращает абсолютный путь даже для относительного rootDir', () => {
      const r = profilesRoot({ rootDir: 'relative/path' });
      expect(r.startsWith('/')).toBe(true);
    });

    it('без override использует platform-specific корень', () => {
      const r = profilesRoot();
      expect(r.includes('ai-cofounder') || r.includes('AI-Cofounder')).toBe(true);
    });
  });

  describe('resolveProfile', () => {
    it('создаёт директорию <platform>-<account> внутри rootDir', async () => {
      const loc = await resolveProfile('vc', 'main', { rootDir: root });
      expect(loc.path).toBe(join(root, 'vc-main'));
      expect(loc.preexisted).toBe(false);
      expect(existsSync(loc.path)).toBe(true);
    });

    it('preexisted=true для уже существующей директории', async () => {
      const path = join(root, 'reddit-test');
      await mkdir(path, { recursive: true });
      const loc = await resolveProfile('reddit', 'test', { rootDir: root });
      expect(loc.preexisted).toBe(true);
      expect(loc.path).toBe(path);
    });

    it('директория создаётся с правами 0o700', async () => {
      const loc = await resolveProfile('vc', 'main', { rootDir: root });
      const mode = statSync(loc.path).mode & 0o777;
      // На некоторых tmpfs umask может «съесть» биты, но 0o700 — это потолок.
      expect(mode & 0o077).toBe(0); // group+other = 0
    });

    it('кидает на пустой platform id', async () => {
      await expect(resolveProfile('', 'main', { rootDir: root })).rejects.toThrow(/platform/);
    });

    it('кидает на пустой account id', async () => {
      await expect(resolveProfile('vc', '', { rootDir: root })).rejects.toThrow(/account/);
    });

    it('кидает на path-traversal попытку в platform', async () => {
      await expect(resolveProfile('../etc', 'main', { rootDir: root })).rejects.toThrow(/platform/);
    });

    it('кидает на path-traversal попытку в account', async () => {
      await expect(resolveProfile('vc', '../../etc', { rootDir: root })).rejects.toThrow(/account/);
    });

    it('кидает на слишком длинный id (>64 символа)', async () => {
      const longId = 'a'.repeat(65);
      await expect(resolveProfile('vc', longId, { rootDir: root })).rejects.toThrow(/account/);
    });

    it('разрешает символы [a-z0-9_-]', async () => {
      const loc = await resolveProfile('linked-in', 'acct_2', { rootDir: root });
      expect(loc.path).toBe(join(root, 'linked-in-acct_2'));
    });

    it('запрещает заглавные буквы (нормализация на ввод)', async () => {
      await expect(resolveProfile('VC', 'main', { rootDir: root })).rejects.toThrow(/platform/);
    });
  });
});
