// Org registry — единственная точка резолва каталога `org/`.
//
// Контракт фазы 3:
//   * getOrg(opts?) — читает корневой `org/` из cwd (по умолчанию process.cwd()).
//     Single-org для MVP. Multi-user (`users/<userId>/org/`) — будущее, см.
//     план 2026-05-21-skills-architecture-v3, раздел «Multi-user future».
//
// DI как в src/routines/registry.ts: `{cwd, read, exists}` — опциональные
// перегрузки для тестов.
//
// Если `org/` отсутствует — функция кидает OrgParseError (см. parser).
// Вызывающий код в runtime.ts ловит и просто пропускает инжекцию
// org-knowledge (нет org = нет блока в system prompt).

import { resolve } from 'node:path';
import { parseOrg } from './parser.js';
import type { OrgKnowledge } from './types.js';

export interface OrgRegistryOptions {
  /** Корень репозитория. По умолчанию process.cwd(). */
  cwd?: string;
  /** DI: подменить чтение файлов (передаётся в parseOrg). */
  read?: (path: string) => Promise<string>;
  /** DI: подменить проверку существования (передаётся в parseOrg). */
  exists?: (path: string) => Promise<boolean>;
  /**
   * Имя директории org/ относительно cwd. По умолчанию `org`. Параметризуем
   * для тестов (можно скармливать tmpdir/fake-org).
   */
  orgDir?: string;
}

const DEFAULT_ORG_DIR = 'org';

export async function getOrg(options: OrgRegistryOptions = {}): Promise<OrgKnowledge> {
  const cwd = options.cwd ?? process.cwd();
  const orgDir = resolve(cwd, options.orgDir ?? DEFAULT_ORG_DIR);

  const parseOptions: Parameters<typeof parseOrg>[1] = {};
  if (options.read !== undefined) parseOptions.read = options.read;
  if (options.exists !== undefined) parseOptions.exists = options.exists;

  return parseOrg(orgDir, parseOptions);
}
