// Единственный источник правды для конфигурации Bridge-процесса.
// CLAUDE.md «не хардкодить динамику»: порт и путь к JSONL — через env с дефолтом,
// не const'ы, размазанные по трём файлам.
//
// Тот же файл читается и из bridge/server.ts, и из bridge/electron/main.ts.
// src/observe/bridge.ts (на стороне AI-Cofounder) читает свой mirror'ный
// src/config/bridge.ts — оба берут BRIDGE_PORT из одной env-переменной,
// дефолт совпадает (мостик.md L132 фиксирует 3737 как канон).

import { homedir } from 'node:os';
import path from 'node:path';

export const BRIDGE_PORT_DEFAULT = 3737;

export function bridgePort(): number {
  const raw = process.env.BRIDGE_PORT;
  if (raw === undefined || raw.trim() === '') return BRIDGE_PORT_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`BRIDGE_PORT='${raw}' — невалидное значение, ожидался номер порта 1..65535`);
  }
  return parsed;
}

// Путь к JSONL-сессиям из мостик.md L262: ~/Library/Application Support/AI-Cofounder/sessions.
// Каждый запуск Bridge генерирует свой sessionUlid → новый файл, старые остаются.
export function sessionsDir(): string {
  const override = process.env.BRIDGE_SESSIONS_DIR;
  if (override !== undefined && override.trim() !== '') return override;
  return path.join(homedir(), 'Library', 'Application Support', 'AI-Cofounder', 'sessions');
}
