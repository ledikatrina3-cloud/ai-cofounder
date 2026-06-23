// bridge/routines-write.ts — write-фасад для CRUD routine'ов из UI.
//
// Зеркалит паттерн bridge/skill-builder.ts:
//   * Bridge tsconfig rootDir=bridge => статически импортить src/ нельзя.
//     Реальные serialize/parse/registry грузим динамически из dist/src/*.
//   * Вся логика принимает DI-deps — тесты подменяют fs/serialize/registry
//     и не требуют собранного dist.
//   * Запись атомарная (temp + rename), путь проверяется на path-traversal,
//     create != overwrite (ENOENT-guard).
//
// Дисциплина discovery (см. src/routines/registry.ts):
//   * Файл routine виден проекту только если матчит его `routinesGlob`
//     (`routines/<prefix>-*.md`).
//   * `routine.projectId` ОБЯЗАН совпадать с проектом, через чей glob файл
//     найден, иначе registry бросает RoutineRegistryError и роняет весь
//     /routines. Поэтому на create проверяем: имя файла матчит ровно ОДИН
//     проектный glob и это заданный projectId.
//   * `id` глобально уникален — на create отвергаем существующий.

import { rename, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Минимальные типы (не зависим от src/ на уровне сборки) ───────────────────

export interface RoutineLike {
  id: string;
  projectId: string;
  enabled: boolean;
  trigger: string;
  tools: string[];
  model: string;
  maxTokens: number;
  timeoutMs: number;
  outputType: string;
  description: string;
  prompt: string;
  filePath: string;
  role?: string;
  avatar?: string;
  color?: string;
  logo?: string;
  bashWhitelist?: string[];
  skills?: string[];
  forceLoad?: string[];
  departmentId?: string;
  targetProject?: string;
}

export interface RoutinePatchLike {
  enabled?: boolean;
  trigger?: string;
  tools?: string[];
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  outputType?: string;
  description?: string;
  prompt?: string;
  role?: string | null;
  avatar?: string | null;
  color?: string | null;
  logo?: string | null;
  bashWhitelist?: string[] | null;
  skills?: string[] | null;
  forceLoad?: string[] | null;
  departmentId?: string | null;
  targetProject?: string | null;
}

export interface ProjectMetaLike {
  id: string;
  routinesGlob: string;
}

// Поля, которые UI присылает на create. id/projectId фиксируют discovery,
// меняться через update не могут.
export interface RoutineCreateInput {
  id: string;
  projectId: string;
  enabled: boolean;
  trigger: string;
  tools: string[];
  model: string;
  maxTokens: number;
  timeoutMs: number;
  outputType: string;
  description: string;
  prompt: string;
  role?: string;
  avatar?: string;
  color?: string;
  logo?: string;
  bashWhitelist?: string[];
  skills?: string[];
  forceLoad?: string[];
  departmentId?: string;
  targetProject?: string;
}

export class RoutineWriteError extends Error {
  // Литералы — чтобы совпасть с Hono StatusCode в server.ts без каста.
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = 'RoutineWriteError';
    this.status = status;
  }
}

// ── DI-deps ─────────────────────────────────────────────────────────────────

export interface RoutineWriteDeps {
  cwd?: string;
  routinesRoot?: string;
  serializeRoutine?: (r: RoutineLike) => string;
  applyRoutinePatch?: (source: string, patch: RoutinePatchLike) => string;
  parseRoutineSource?: (filePath: string, source: string) => RoutineLike;
  listProjects?: () => Promise<ProjectMetaLike[]>;
  getRoutine?: (id: string) => Promise<RoutineLike | null>;
  fileExists?: (path: string) => Promise<boolean>;
  readFileFn?: (path: string) => Promise<string>;
  writeFileAtomic?: (path: string, content: string) => Promise<void>;
  unlinkFn?: (path: string) => Promise<void>;
}

const ROUTINES_DIR_NAME = 'routines';
const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

// ── dist-загрузчики (как в skill-builder) ────────────────────────────────────

interface SerializerMod {
  serializeRoutine: (r: RoutineLike) => string;
  applyRoutinePatch: (source: string, patch: RoutinePatchLike) => string;
}
let cachedSerializer: SerializerMod | null = null;
async function loadSerializer(cwd: string): Promise<SerializerMod> {
  if (cachedSerializer !== null) return cachedSerializer;
  const p = resolve(cwd, 'dist', 'src', 'routines', 'serializer.js');
  cachedSerializer = (await import(pathToFileURL(p).href)) as SerializerMod;
  return cachedSerializer;
}

interface ParserMod {
  parseRoutineSource: (filePath: string, source: string) => RoutineLike;
}
let cachedParser: ParserMod | null = null;
async function loadParser(cwd: string): Promise<ParserMod> {
  if (cachedParser !== null) return cachedParser;
  const p = resolve(cwd, 'dist', 'src', 'routines', 'parser.js');
  cachedParser = (await import(pathToFileURL(p).href)) as ParserMod;
  return cachedParser;
}

interface ProjectsMod {
  listProjects: (opts?: { cwd?: string; includeSelfProject?: boolean }) => Promise<
    ProjectMetaLike[]
  >;
}
interface RoutinesRegistryMod {
  getRoutine: (id: string, opts?: { cwd?: string }) => Promise<RoutineLike | null>;
}
async function loadListProjects(cwd: string): Promise<() => Promise<ProjectMetaLike[]>> {
  const p = resolve(cwd, 'dist', 'src', 'projects', 'registry.js');
  const mod = (await import(pathToFileURL(p).href)) as ProjectsMod;
  return () => mod.listProjects({ cwd });
}
async function loadGetRoutine(cwd: string): Promise<(id: string) => Promise<RoutineLike | null>> {
  const p = resolve(cwd, 'dist', 'src', 'routines', 'registry.js');
  const mod = (await import(pathToFileURL(p).href)) as RoutinesRegistryMod;
  return (id: string) => mod.getRoutine(id, { cwd });
}

// ── Хелперы ──────────────────────────────────────────────────────────────────

/** glob c единственным `*` → RegExp. `routines/content-team-*.md`. */
export function globToRegExp(glob: string): RegExp {
  // Сегменты между `*` экранируем как литералы, `*` → `.*`. Без плейсхолдера.
  const escaped = glob
    .split('*')
    .map((seg) => seg.replace(/[.+?^${}()|[\]\\]/g, (ch) => `\\${ch}`))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function defaultWriteAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

function resolveSafe(root: string, filename: string): string {
  const full = resolve(root, filename);
  if (full !== `${root}/${filename}` && !full.startsWith(`${root}/`)) {
    throw new RoutineWriteError(`небезопасный путь '${filename}'.`, 400);
  }
  return full;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function createRoutine(
  input: RoutineCreateInput,
  deps: RoutineWriteDeps = {},
): Promise<{ ok: true; id: string; filePath: string }> {
  const cwd = deps.cwd ?? process.cwd();
  const routinesRoot = deps.routinesRoot ?? resolve(cwd, ROUTINES_DIR_NAME);
  const serialize = deps.serializeRoutine ?? (await loadSerializer(cwd)).serializeRoutine;
  const parse = deps.parseRoutineSource ?? (await loadParser(cwd)).parseRoutineSource;
  const listProjectsFn = deps.listProjects ?? (await loadListProjects(cwd));
  const getRoutineFn = deps.getRoutine ?? (await loadGetRoutine(cwd));
  const fileExists = deps.fileExists ?? defaultFileExists;
  const writeAtomic = deps.writeFileAtomic ?? defaultWriteAtomic;

  if (!ID_RE.test(input.id)) {
    throw new RoutineWriteError(
      `id '${input.id}' должен быть kebab-case (^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$).`,
    );
  }

  // 1. Глобальная уникальность id.
  if ((await getRoutineFn(input.id)) !== null) {
    throw new RoutineWriteError(`routine с id '${input.id}' уже существует.`, 409);
  }

  // 2. Discovery: имя файла = <id>.md должно матчить ровно ОДИН проектный glob
  //    и это заданный projectId. Иначе registry либо не увидит routine, либо
  //    упадёт на projectId-mismatch.
  const filename = `${input.id}.md`;
  // listProjects бросает ProjectRegistryError, если config/projects.md нет —
  // для legacy-routine с реальным projectId это понятная 400, а не сырая 500
  // (ревью D3-2). Самодостаточному агенту projectId не нужен — он идёт через
  // agents-write, сюда не попадает.
  let projects: ProjectMetaLike[];
  try {
    projects = await listProjectsFn();
  } catch (err) {
    throw new RoutineWriteError(
      `не удалось прочитать реестр проектов: ${
        err instanceof Error ? err.message : String(err)
      }. Для самодостаточного агента не указывай projectId (он создастся в agents/<id>/).`,
      400,
    );
  }
  const matching = projects.filter((p) =>
    globToRegExp(p.routinesGlob).test(`routines/${filename}`),
  );
  if (matching.length === 0) {
    const project = projects.find((p) => p.id === input.projectId);
    const hint = project
      ? ` Ожидался id с префиксом из glob '${project.routinesGlob}'.`
      : ` Проекта '${input.projectId}' нет в config/projects.md.`;
    throw new RoutineWriteError(
      `routine '${input.id}' не матчит ни один проектный routinesGlob — будет невидим.${hint}`,
    );
  }
  if (matching.length > 1) {
    throw new RoutineWriteError(
      `routine '${input.id}' матчит несколько проектов (${matching
        .map((p) => p.id)
        .join(', ')}) — это сломает registry. Выбери уникальный префикс.`,
    );
  }
  if (matching[0]?.id !== input.projectId) {
    throw new RoutineWriteError(
      `routine '${input.id}' по имени относится к проекту '${matching[0]?.id}', а projectId='${input.projectId}'. Они должны совпадать.`,
    );
  }

  // 3. Путь + защита от overwrite.
  const filePath = resolveSafe(routinesRoot, filename);
  if (await fileExists(filePath)) {
    throw new RoutineWriteError(`файл '${filename}' уже существует.`, 409);
  }

  // 4. Сериализация + валидация через parser (тот же набор проверок, что и при
  //    чтении: cron, model-prefix, outputType, posint, непустой body).
  const routine: RoutineLike = { ...input, filePath };
  let serialized: string;
  try {
    serialized = serialize(routine);
  } catch (err) {
    // RoutineSerializeError (напр. значение с обеими кавычками) — это невалидный
    // ВВОД, а не сбой сервера: 400, а не 500 (ревью 2026-06-22).
    throw new RoutineWriteError(
      `значение нельзя сохранить: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    parse(filePath, serialized);
  } catch (err) {
    throw new RoutineWriteError(
      `валидация не прошла: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  await writeAtomic(filePath, serialized);
  return { ok: true, id: input.id, filePath };
}

export async function updateRoutine(
  id: string,
  patch: RoutinePatchLike,
  deps: RoutineWriteDeps = {},
): Promise<{ ok: true; id: string; filePath: string }> {
  const cwd = deps.cwd ?? process.cwd();
  const routinesRoot = deps.routinesRoot ?? resolve(cwd, ROUTINES_DIR_NAME);
  const applyPatch = deps.applyRoutinePatch ?? (await loadSerializer(cwd)).applyRoutinePatch;
  const parse = deps.parseRoutineSource ?? (await loadParser(cwd)).parseRoutineSource;
  const getRoutineFn = deps.getRoutine ?? (await loadGetRoutine(cwd));
  const readFileFn =
    deps.readFileFn ??
    ((p: string) => import('node:fs/promises').then((m) => m.readFile(p, 'utf8')));
  const writeAtomic = deps.writeFileAtomic ?? defaultWriteAtomic;

  const existing = await getRoutineFn(id);
  if (existing === null) {
    throw new RoutineWriteError(`routine '${id}' не найден.`, 404);
  }
  const filePath = existing.filePath;
  // filePath должен лежать внутри routinesRoot (agents/<id>/ — отдельный формат,
  // его этим API не редактируем).
  if (!filePath.startsWith(`${routinesRoot}/`)) {
    throw new RoutineWriteError(
      `routine '${id}' лежит вне ${ROUTINES_DIR_NAME}/ (возможно, это agents/<id>/) — редактирование не поддержано.`,
      400,
    );
  }

  const source = await readFileFn(filePath);
  let updated: string;
  try {
    updated = applyPatch(source, patch);
  } catch (err) {
    throw new RoutineWriteError(
      `значение нельзя сохранить: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    parse(filePath, updated);
  } catch (err) {
    throw new RoutineWriteError(
      `валидация не прошла: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  await writeAtomic(filePath, updated);
  return { ok: true, id, filePath };
}

export async function deleteRoutine(
  id: string,
  deps: RoutineWriteDeps = {},
): Promise<{ ok: true; id: string }> {
  const cwd = deps.cwd ?? process.cwd();
  const routinesRoot = deps.routinesRoot ?? resolve(cwd, ROUTINES_DIR_NAME);
  const getRoutineFn = deps.getRoutine ?? (await loadGetRoutine(cwd));
  const unlinkFn = deps.unlinkFn ?? unlink;

  const existing = await getRoutineFn(id);
  if (existing === null) {
    throw new RoutineWriteError(`routine '${id}' не найден.`, 404);
  }
  if (!existing.filePath.startsWith(`${routinesRoot}/`)) {
    throw new RoutineWriteError(
      `routine '${id}' лежит вне ${ROUTINES_DIR_NAME}/ — удаление не поддержано.`,
      400,
    );
  }
  await unlinkFn(existing.filePath);
  return { ok: true, id };
}
