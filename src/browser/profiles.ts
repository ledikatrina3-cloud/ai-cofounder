// Резолв директории persistent profile для patchright.
//
// Профиль — это весь Chromium-user-data-dir: куки, localStorage, IndexedDB,
// installed extensions. После первого ручного логина профиль остаётся
// залогиненным; следующие запуски открывают браузер уже с активной сессией.
//
// Раздельные профили на (platform, account) — никаких пересечений fingerprint
// между LinkedIn/Reddit/vc и между разными аккаунтами одной соцсети.
//
// Хранение: macOS Application Support — стандартное место для per-user
// мутабельных данных, не попадает в Time Machine cloud-backups по умолчанию.
// Linux/dev fallback: `~/.config/ai-cofounder/profiles/`.
//
// Безопасность: каталог создаётся с правами 0o700 — куки соцсетей это
// фактически пароль, чужому юзеру на той же машине читать их нельзя.

import { existsSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

export interface ProfileLocation {
  /** Абсолютный путь к директории профиля (userDataDir для patchright). */
  path: string;
  /** Существовала ли директория ДО вызова resolveProfile — индикатор «первый запуск». */
  preexisted: boolean;
}

export interface ResolveProfileOptions {
  /** Override корня хранения (для тестов). */
  rootDir?: string;
}

/** Корень всех профилей AI-Cofounder. */
export function profilesRoot(opts: ResolveProfileOptions = {}): string {
  if (opts.rootDir !== undefined) return resolve(opts.rootDir);
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'AI-Cofounder', 'profiles');
  }
  return join(homedir(), '.config', 'ai-cofounder', 'profiles');
}

/** Валидация id — только [a-z0-9-_], чтобы не словить path traversal. */
function assertIdSafe(label: string, value: string): void {
  if (value.length === 0 || value.length > 64) {
    throw new Error(
      `browser:profiles: ${label} должен быть длиной 1-64 символа, получено '${value}'`,
    );
  }
  if (!/^[a-z0-9_-]+$/.test(value)) {
    throw new Error(
      `browser:profiles: ${label} должен матчить /^[a-z0-9_-]+$/, получено '${value}'`,
    );
  }
}

/**
 * Резолвит директорию профиля и создаёт её при необходимости (mode 0o700).
 *
 * Возвращает `preexisted=false` если директория была создана прямо сейчас —
 * вызывающий код использует это чтобы понять, что нужен первичный логин
 * (browser-login wizard).
 */
export async function resolveProfile(
  platformId: string,
  accountId: string,
  opts: ResolveProfileOptions = {},
): Promise<ProfileLocation> {
  assertIdSafe('platform', platformId);
  assertIdSafe('account', accountId);

  const path = join(profilesRoot(opts), `${platformId}-${accountId}`);
  const preexisted = existsSync(path);

  if (!preexisted) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  // Гарантируем 0o700 даже если директория существовала с другими правами.
  await chmod(path, 0o700).catch(() => {
    // Ошибки chmod на macOS/Linux — игнорируем (на тестовых tmpfs может ругаться).
  });

  return { path, preexisted };
}
