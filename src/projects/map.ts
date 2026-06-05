// Project map loader — единственная точка чтения `projects/<id>/map.md`.
//
// Контракт фазы 1.1:
//   * `loadProjectMap(projectId)` — читает карту, валидирует обязательные
//     секции, возвращает типизированный `ProjectMap`.
//   * Обязательные секции: `description`, `key-directories`, `key-files`,
//     `db-connections`, `telegram-channels`. На отсутствие любой —
//     `ProjectMapError`. На отсутствие самого файла — `ProjectMapNotFound`.
//   * Опциональные секции: `metrics-endpoints`, `notes`. Их отсутствие
//     даёт пустой массив / пустую строку (не ошибка).
//
// Карта — НЕ секреты. `dbConnections[].keychainService` — это ИМЯ ключа
// в Keychain (например, `'ai-cofounder.example-project.db'`), а не сам DSN.
// Аналогично `telegramChannels[].botKeychainService`. Чтение Keychain
// придёт в фазе 2.3 (`project.db.query`) и фазе 2.4 (`project.telegram.read`)
// — этот модуль их не дёргает.
//
// `key-directories`, `key-files`, `metrics-endpoints` — простые список-секции
// (по одной строке `- path: note`). `db-connections`, `telegram-channels` —
// object-list-секции (несколько ключей на коннект, разделённых пустой строкой).

import { resolve } from 'node:path';
import {
  type PageReader,
  getSection,
  parseKeyValueLines,
  parseSectionObjectList,
  readPage,
} from '../lib/page-sections.js';
import { type ProjectMeta, getProject } from './registry.js';

export interface KeyFileEntry {
  path: string; // относительный путь внутри проекта
  note: string; // короткое описание зачем агенту знать про этот файл
}

export interface DbConnConfig {
  id: string; // стабильный slug (`example-project-prod`, `example-project-replica`)
  driver: 'postgres' | 'mysql' | 'sqlite';
  keychainService: string; // имя service-key в Keychain (НЕ сам DSN)
  description: string; // что за коннект, что в нём, кому доступен
  allowedTables: string[]; // whitelist таблиц для project.db.query (фаза 2.3)
  queryTimeoutMs: number; // override default; default 10000 если не указан
  rowLimit: number; // override default; default 1000 если не указан
}

export interface TgChannelConfig {
  id: string; // стабильный slug (`support`, `vip-clients`)
  chatId: string; // telegram chat_id; группы — отрицательные
  purpose: string; // что за канал, чьи сообщения, как использовать
  botKeychainService: string; // имя service-key Telegram-бота для этого канала
}

export interface MetricsEndpoint {
  id: string;
  url: string;
  note: string;
}

export interface ProjectMap {
  description: string; // свободный markdown — что это за проект для агента
  keyDirectories: KeyFileEntry[]; // путь + краткая пометка зачем агенту знать
  keyFiles: KeyFileEntry[];
  dbConnections: DbConnConfig[];
  telegramChannels: TgChannelConfig[];
  metricsEndpoints: MetricsEndpoint[]; // опционально
  notes: string; // свободный agent-readme; '' если секция отсутствует
}

export class ProjectMapNotFound extends Error {
  constructor(projectId: string, mapAbsPath: string) {
    super(
      `Карта проекта '${projectId}' не найдена по пути ${mapAbsPath}. Создай файл по шаблону (см. projects/example-project/map.md как пример). Обязательные секции: description, key-directories, key-files, db-connections, telegram-channels.`,
    );
    this.name = 'ProjectMapNotFound';
  }
}

export class ProjectMapError extends Error {
  constructor(projectId: string, message: string) {
    super(`Карта проекта '${projectId}': ${message}`);
    this.name = 'ProjectMapError';
  }
}

const REQUIRED_SECTIONS = [
  'description',
  'key-directories',
  'key-files',
  'db-connections',
  'telegram-channels',
] as const;

const VALID_DB_DRIVERS = new Set(['postgres', 'mysql', 'sqlite']);

export interface MapOptions {
  io?: PageReader;
  cwd?: string;
  // Опционально: явно передать ProjectMeta, чтобы не дёргать registry повторно
  // (например, dispatcher уже загрузил проект). Если не передано — читаем
  // через `getProject(projectId)`.
  meta?: ProjectMeta;
  // Прокидываем те же опции в `getProject` для случая, когда meta не передан
  // — это нужно для тестов с fixture-cwd.
  registryOptions?: Parameters<typeof getProject>[1];
}

export async function loadProjectMap(
  projectId: string,
  options: MapOptions = {},
): Promise<ProjectMap> {
  const cwd = options.cwd ?? process.cwd();
  const io = options.io;

  const meta = options.meta ?? (await getProject(projectId, options.registryOptions ?? { cwd }));
  if (meta === null) {
    throw new ProjectMapError(
      projectId,
      `проект не найден в реестре (config/projects.md). Добавь секцию '## ${projectId}' в реестр или сверь id.`,
    );
  }

  // Mapless-проект (mapPath='') — синтетический 'self', где живут agents/<id>/,
  // а не внешний репо с картой. Возвращаем минимальную карту из meta: digest
  // будет sparse, агент полагается на свой prompt.md/rules.md, а не на ProjectMap.
  if (meta.mapPath === '') {
    return {
      description: meta.name,
      keyDirectories: [],
      keyFiles: [],
      dbConnections: [],
      telegramChannels: [],
      metricsEndpoints: [],
      notes: '',
    };
  }

  const absMapPath = resolve(cwd, meta.mapPath);
  const markdown = await readPage(meta.mapPath, io, cwd);
  if (markdown === null) {
    throw new ProjectMapNotFound(projectId, absMapPath);
  }

  for (const sec of REQUIRED_SECTIONS) {
    if (getSection(markdown, sec) === null) {
      throw new ProjectMapError(
        projectId,
        `отсутствует обязательная секция '## ${sec}' в ${absMapPath}.`,
      );
    }
  }

  return {
    description: parseFreeText(markdown, 'description'),
    keyDirectories: parseKeyFileList(markdown, 'key-directories'),
    keyFiles: parseKeyFileList(markdown, 'key-files'),
    dbConnections: parseDbConnections(projectId, markdown),
    telegramChannels: parseTelegramChannels(projectId, markdown),
    metricsEndpoints: parseMetricsEndpoints(markdown),
    notes: parseFreeText(markdown, 'notes'),
  };
}

// ---------------------------------------------------------------------------
// Секционные парсеры. Каждый — узкая функция «строки секции → доменный тип».
// ---------------------------------------------------------------------------

// Свободный текст: всё тело секции, trim'нуто. Используется для `description`
// и `notes`. Если секция отсутствует (опциональная) — пустая строка.
function parseFreeText(markdown: string, name: string): string {
  const lines = getSection(markdown, name);
  if (lines === null) return '';
  return lines.join('\n').trim();
}

// `- path: note` → KeyFileEntry. Валидация: path не пуст. note может быть
// пустой строкой (`- foo:` — допустимо, агент просто увидит пустую пометку).
function parseKeyFileList(markdown: string, name: string): KeyFileEntry[] {
  const lines = getSection(markdown, name);
  if (lines === null) return [];
  const kv = parseKeyValueLines(lines);
  const out: KeyFileEntry[] = [];
  for (const [path, note] of kv) {
    if (path.length === 0) continue;
    out.push({ path, note });
  }
  return out;
}

// db-connections / telegram-channels — object-list-секции: записи разделены
// пустой строкой, внутри записи — `- key: value`. Пустая секция → [].
function parseDbConnections(projectId: string, markdown: string): DbConnConfig[] {
  const groups = parseSectionObjectList(markdown, 'db-connections') ?? [];
  return groups.map((g) => parseDbConn(projectId, g));
}

function parseDbConn(projectId: string, kv: Map<string, string>): DbConnConfig {
  const required = ['id', 'driver', 'keychainService'] as const;
  for (const f of required) {
    if (!kv.has(f) || (kv.get(f) ?? '').length === 0) {
      throw new ProjectMapError(
        projectId,
        `db-connections: запись без обязательного поля '${f}' (или пустое). Требуются: ${required.join(', ')}.`,
      );
    }
  }

  const driver = kv.get('driver') ?? '';
  if (!VALID_DB_DRIVERS.has(driver)) {
    throw new ProjectMapError(
      projectId,
      `db-connections: driver '${driver}' не поддерживается. Допустимы: ${[...VALID_DB_DRIVERS].join(', ')}.`,
    );
  }

  return {
    id: kv.get('id') ?? '',
    driver: driver as DbConnConfig['driver'],
    keychainService: kv.get('keychainService') ?? '',
    description: kv.get('description') ?? '',
    allowedTables: parseListField(kv.get('allowedTables') ?? '[]'),
    queryTimeoutMs: parseIntField(kv.get('queryTimeoutMs'), 10_000),
    rowLimit: parseIntField(kv.get('rowLimit'), 1000),
  };
}

function parseTelegramChannels(projectId: string, markdown: string): TgChannelConfig[] {
  const groups = parseSectionObjectList(markdown, 'telegram-channels') ?? [];
  return groups.map((g) => parseTgChannel(projectId, g));
}

function parseTgChannel(projectId: string, kv: Map<string, string>): TgChannelConfig {
  const required = ['id', 'chatId', 'botKeychainService'] as const;
  for (const f of required) {
    if (!kv.has(f) || (kv.get(f) ?? '').length === 0) {
      throw new ProjectMapError(
        projectId,
        `telegram-channels: запись без обязательного поля '${f}' (или пустое). Требуются: ${required.join(', ')}.`,
      );
    }
  }
  const chatId = kv.get('chatId') ?? '';
  if (!/^-?\d+$/.test(chatId)) {
    throw new ProjectMapError(
      projectId,
      `telegram-channels: chatId '${chatId}' должен быть целым числом (отрицательное для группы).`,
    );
  }
  return {
    id: kv.get('id') ?? '',
    chatId,
    purpose: kv.get('purpose') ?? '',
    botKeychainService: kv.get('botKeychainService') ?? '',
  };
}

function parseMetricsEndpoints(markdown: string): MetricsEndpoint[] {
  const groups = parseSectionObjectList(markdown, 'metrics-endpoints') ?? [];
  return groups
    .filter((g) => g.has('id') && g.has('url'))
    .map((g) => ({
      id: g.get('id') ?? '',
      url: g.get('url') ?? '',
      note: g.get('note') ?? '',
    }));
}

// `[]` или `[a, b, c]` или просто `a, b, c` → string[]. Тоgleн пустые строки.
function parseListField(raw: string): string[] {
  const cleaned = raw.replace(/^\[/, '').replace(/\]$/, '').trim();
  if (cleaned === '') return [];
  return cleaned
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseIntField(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined || raw === '') return defaultValue;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}
