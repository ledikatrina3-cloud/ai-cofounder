// Project registry — единственная точка чтения `config/projects.md`.
//
// Контракт фазы 1.1:
//   * `listProjects()` — все проекты в реестре, валидированы по обязательным
//     полям (name, path, enabled, mapPath, routinesGlob).
//   * `getProject(id)` — один проект по slug-id или `null`. На физически
//     отсутствующем `path` — `enabled=false` динамически (graceful
//     degradation для multi-mac), `console.warn` с указанием пути.
//   * `getEnabledProjects()` — список с учётом динамического enabled.
//
// Парсинг — через generic primitives `src/lib/page-sections.ts`:
//   parsePageSections + parseKeyValueLines. Тот же подход, что в
//   `src/telegram/secrets.ts:readPageChatIds` (фазы 1.2/2.1a) — единая
//   модель «Page = markdown с секциями ##».
//
// Что НЕ делает этот модуль:
//   * Не загружает карту проекта (`projects/<id>/map.md`) — это
//     `src/projects/map.ts:loadProjectMap`. Реестр знает только МЕТАДАННЫЕ:
//     где код, где карта, какие routine'ы относятся.
//   * Не валидирует `routinesGlob` — это контракт фазы 1.2 (routine
//     registry). Здесь — просто строка.
//   * Не читает Keychain — это контракт фазы 2.3 (project.db.query).

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type PageReader,
  parseKeyValueLines,
  parsePageSections,
  readPage,
} from '../lib/page-sections.js';

export const PROJECTS_REGISTRY_PATH = 'config/projects.md';

const REQUIRED_FIELDS = ['name', 'path', 'enabled', 'mapPath', 'routinesGlob'] as const;

export interface ProjectMeta {
  id: string;
  name: string;
  path: string; // абсолютный путь к репозиторию проекта
  enabled: boolean; // динамический: учитывает существование `path`
  mapPath: string; // относительный к корню AI-Cofounder, например 'projects/example-project/map.md'
  routinesGlob: string; // относительный glob, например 'routines/example-project-*.md'
}

export class ProjectRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectRegistryError';
  }
}

// Структурированный warning: тест может перехватить через vi.spyOn(console, 'warn').
// Сообщение всегда начинается с префикса `[projects]`, чтобы было легко
// отфильтровать в `Bridge.app` JSONL.
type WarnFn = (msg: string) => void;

export interface RegistryOptions {
  io?: PageReader;
  cwd?: string;
  // DI для проверки существования path. По умолчанию — fs/promises stat.
  // В тестах подменяется, чтобы не зависеть от реального FS.
  pathExists?: (absPath: string) => Promise<boolean>;
  warn?: WarnFn;
}

async function defaultPathExists(absPath: string): Promise<boolean> {
  try {
    const s = await stat(absPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

// Разбирает Page целиком и валидирует поля каждой секции. Возвращает массив
// «сырых» проектов — БЕЗ проверки физического существования path. Это
// разделение сделано для тестируемости: один шаг — парсинг, другой шаг —
// FS-проверка.
function parseProjectsRegistry(markdown: string): ProjectMeta[] {
  const sections = parsePageSections(markdown);
  const out: ProjectMeta[] = [];
  for (const [id, lines] of sections) {
    const kv = parseKeyValueLines(lines);

    for (const f of REQUIRED_FIELDS) {
      if (!kv.has(f)) {
        throw new ProjectRegistryError(
          `${PROJECTS_REGISTRY_PATH}: секция [## ${id}] не содержит обязательное поле '${f}'. Обязательные поля: ${REQUIRED_FIELDS.join(', ')}.`,
        );
      }
    }

    const enabledRaw = kv.get('enabled') ?? '';
    if (enabledRaw !== 'true' && enabledRaw !== 'false') {
      throw new ProjectRegistryError(
        `${PROJECTS_REGISTRY_PATH}: секция [## ${id}] поле 'enabled' должно быть 'true' или 'false', получено '${enabledRaw}'.`,
      );
    }

    const rawPath = kv.get('path') ?? '';
    // Раскрываем env-плейсхолдеры вида ${PROJECTS_ROOT} перед валидацией — так
    // config/projects.md переносим между машинами/форками (см. .env.example).
    // Незаданная переменная -> пустая строка: путь станет несуществующим и
    // проект отключится через applyEnabledOverrides, а не свалит весь реестр.
    const path = rawPath.replace(/\$\{(\w+)\}/g, (_m, name) => process.env[name] ?? '');
    if (!path.startsWith('/')) {
      throw new ProjectRegistryError(
        `${PROJECTS_REGISTRY_PATH}: секция [## ${id}] поле 'path' должно быть абсолютным путём (начинаться с '/'), получено '${path}' (из '${rawPath}'). Задай переменные окружения вроде PROJECTS_ROOT.`,
      );
    }

    out.push({
      id,
      name: kv.get('name') ?? '',
      path,
      enabled: enabledRaw === 'true',
      mapPath: kv.get('mapPath') ?? '',
      routinesGlob: kv.get('routinesGlob') ?? '',
    });
  }
  return out;
}

async function applyEnabledOverrides(
  projects: ProjectMeta[],
  pathExists: (p: string) => Promise<boolean>,
  warn: WarnFn,
): Promise<ProjectMeta[]> {
  return Promise.all(
    projects.map(async (p) => {
      if (!p.enabled) return p; // в файле уже false — ничего не делаем
      const exists = await pathExists(p.path);
      if (exists) return p;
      warn(
        `[projects] проект '${p.id}' помечен enabled=true, но path='${p.path}' не существует или не директория. Динамически считаю enabled=false (graceful degradation, multi-mac setup).`,
      );
      return { ...p, enabled: false };
    }),
  );
}

async function loadAllProjects(options: RegistryOptions = {}): Promise<ProjectMeta[]> {
  const cwd = options.cwd ?? process.cwd();
  const io = options.io;
  const pathExists = options.pathExists ?? defaultPathExists;
  const warn = options.warn ?? ((msg) => console.warn(msg));

  const markdown = await readPage(PROJECTS_REGISTRY_PATH, io, cwd);
  // config/projects.md опционален: self-contained форк без кросс-проектов его не
  // имеет (файл в .gitignore; /setup создаёт из config/projects.example.md).
  // Отсутствует → только синтетический 'self' ниже; agents/<id>/ грузятся всё
  // равно. Кросс-проектные (target-)агенты требуют записи в этом файле.
  const parsed = markdown === null ? [] : parseProjectsRegistry(markdown);

  // Синтетический built-in проект 'self' — это сам репозиторий AI-Cofounder
  // (cwd). Owner всех agents/<id>/. path = resolve(cwd) (абсолютный, всегда
  // существует), поэтому applyEnabledOverrides не отключит его. НЕ из markdown:
  // инъектим напрямую, минуя ${VAR}-раскрытие и startsWith('/')-гейт.
  // routinesGlob заведомо ничего не матчит — agents/<id>/ грузятся отдельным
  // loader'ом (loadAgents), а не через routinesGlob.
  if (!parsed.some((p) => p.id === 'self')) {
    parsed.push({
      id: 'self',
      name: 'AI-Cofounder',
      path: resolve(cwd),
      enabled: true,
      mapPath: '',
      routinesGlob: 'agents/__never__/*.md',
    });
  }

  return applyEnabledOverrides(parsed, pathExists, warn);
}

// Все проекты, валидированы и с учётом динамического enabled.
export async function listProjects(options: RegistryOptions = {}): Promise<ProjectMeta[]> {
  return loadAllProjects(options);
}

// Один проект по id или null. На physically-missing path — enabled=false +
// warning (не throw): фаундер мог пэйрнуть на ноуте, а сейчас работает с
// десктопа без mounted-volume.
export async function getProject(
  id: string,
  options: RegistryOptions = {},
): Promise<ProjectMeta | null> {
  const all = await loadAllProjects(options);
  return all.find((p) => p.id === id) ?? null;
}

// Проекты, на которых routine-движок реально может работать сейчас.
// Источник истины для cron-планировщика (фаза 1.4) и `pnpm dev:run`.
export async function getEnabledProjects(options: RegistryOptions = {}): Promise<ProjectMeta[]> {
  const all = await loadAllProjects(options);
  return all.filter((p) => p.enabled);
}
