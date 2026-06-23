// bridge/agents-write.ts — write-фасад для CRUD самодостаточных агентов
// `agents/<id>/` из UI. Зеркалит bridge/routines-write.ts, но для нового
// формата-папки (AGENT.md + prompt.md + опц. permissions.yml).
//
// Почему отдельный модуль, а не расширение routines-write: legacy `routines/<id>.md`
// требует projectId из config/projects.md; `agents/<id>/` цепляется к
// синтетическому проекту `self` (= cwd репо) и config/projects.md НЕ требует —
// это и есть путь «посторонний создаёт агента из браузера без правки файлов».
//
// Дисциплина:
//   * id = имя папки (kebab-case), глобально уникален (getRoutine покрывает и
//     agents/, и legacy routines/).
//   * Валидация — через parseAgentFolder ПОСЛЕ сборки контента, но ДО записи
//     на диск (in-memory): граница доверия = диск, плюс нет частичных папок.
//   * Запись атомарная (temp+rename), путь под agentsRoot (path-traversal guard),
//     create != overwrite (папки нет).

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

const AGENTS_DIR_NAME = 'agents';
const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

// ── Типы (не зависим от src/ на уровне сборки) ───────────────────────────────

interface RoutineLike {
  id: string;
  filePath: string;
  agentDir?: string;
}

export interface AgentCreateInput {
  id: string;
  displayName: string; // → role
  description: string; // → body AGENT.md
  prompt: string; // → prompt.md
  model: string;
  enabled: boolean;
  trigger: string; // → schedule
  outputType: string; // → output
  maxTokens?: number;
  timeoutMs?: number;
  avatar?: string;
  color?: string;
  logo?: string;
  departmentId?: string;
  skills?: string[];
  forceLoad?: string[];
  tools?: string[]; // → permissions.yml
  bashWhitelist?: string[]; // → permissions.yml (bash)
}

export interface AgentUpdatePatch {
  displayName?: string;
  model?: string;
  enabled?: boolean;
  trigger?: string;
  outputType?: string;
  maxTokens?: number;
  timeoutMs?: number;
  description?: string;
  prompt?: string;
  avatar?: string | null;
  color?: string | null;
  logo?: string | null;
  departmentId?: string | null;
  skills?: string[] | null;
  forceLoad?: string[] | null;
  tools?: string[];
  bashWhitelist?: string[];
}

export class AgentWriteError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = 'AgentWriteError';
    this.status = status;
  }
}

// ── dist-загрузчики (как в routines-write/skill-builder) ─────────────────────

interface AgentSerializerMod {
  serializeAgentMd: (a: Record<string, unknown>) => string;
  applyAgentMdPatch: (source: string, patch: Record<string, unknown>) => string;
  serializePermissions: (
    existing: Record<string, unknown> | null,
    tools: string[] | undefined,
    bash: string[] | undefined,
  ) => string | null;
}
interface AgentLoaderMod {
  parseAgentFolder: (
    dir: string,
    opts: {
      read?: (p: string) => Promise<string>;
      fileExists?: (p: string) => Promise<boolean>;
      projectId?: string;
    },
  ) => Promise<RoutineLike>;
}
interface RegistryMod {
  getRoutine: (id: string, opts?: { cwd?: string }) => Promise<RoutineLike | null>;
}

async function loadSerializer(cwd: string): Promise<AgentSerializerMod> {
  const p = resolve(cwd, 'dist', 'src', 'routines', 'agent-serializer.js');
  return (await import(pathToFileURL(p).href)) as AgentSerializerMod;
}
async function loadParseAgentFolder(cwd: string): Promise<AgentLoaderMod['parseAgentFolder']> {
  const p = resolve(cwd, 'dist', 'src', 'routines', 'agent-loader.js');
  const mod = (await import(pathToFileURL(p).href)) as AgentLoaderMod;
  return mod.parseAgentFolder;
}
async function loadGetRoutine(cwd: string): Promise<(id: string) => Promise<RoutineLike | null>> {
  const p = resolve(cwd, 'dist', 'src', 'routines', 'registry.js');
  const mod = (await import(pathToFileURL(p).href)) as RegistryMod;
  return (id: string) => mod.getRoutine(id, { cwd });
}

// ── DI-deps ──────────────────────────────────────────────────────────────────

export interface AgentWriteDeps {
  cwd?: string;
  agentsRoot?: string;
  serializeAgentMd?: AgentSerializerMod['serializeAgentMd'];
  applyAgentMdPatch?: AgentSerializerMod['applyAgentMdPatch'];
  serializePermissions?: AgentSerializerMod['serializePermissions'];
  parseAgentFolder?: AgentLoaderMod['parseAgentFolder'];
  getRoutine?: (id: string) => Promise<RoutineLike | null>;
  dirExists?: (path: string) => Promise<boolean>;
  readFileFn?: (path: string) => Promise<string>;
  fileExists?: (path: string) => Promise<boolean>;
  writeFileAtomic?: (path: string, content: string) => Promise<void>;
  mkdirp?: (path: string) => Promise<void>;
  rmrf?: (path: string) => Promise<void>;
}

async function defaultDirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
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

function resolveAgentDir(root: string, id: string): string {
  const full = resolve(root, id);
  if (full !== `${root}/${id}` && !full.startsWith(`${root}/`)) {
    throw new AgentWriteError(`небезопасный id '${id}'.`, 400);
  }
  return full;
}

// In-memory валидация: parseAgentFolder поверх будущего содержимого папки.
async function validateInMemory(
  agentDir: string,
  fileMap: Record<string, string>,
  parseAgentFolderFn: AgentLoaderMod['parseAgentFolder'],
): Promise<void> {
  const read = async (p: string): Promise<string> => {
    const rel = p.startsWith(`${agentDir}/`) ? p.slice(agentDir.length + 1) : p;
    const c = fileMap[rel];
    if (c === undefined) throw new Error(`ENOENT ${p}`);
    return c;
  };
  const fileExists = async (p: string): Promise<boolean> => {
    const rel = p.startsWith(`${agentDir}/`) ? p.slice(agentDir.length + 1) : p;
    return fileMap[rel] !== undefined;
  };
  try {
    await parseAgentFolderFn(agentDir, { read, fileExists, projectId: 'self' });
  } catch (err) {
    throw new AgentWriteError(
      `валидация не прошла: ${err instanceof Error ? err.message : String(err)}`,
      400,
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function createAgent(
  input: AgentCreateInput,
  deps: AgentWriteDeps = {},
): Promise<{ ok: true; id: string; agentDir: string }> {
  const cwd = deps.cwd ?? process.cwd();
  const agentsRoot = deps.agentsRoot ?? resolve(cwd, AGENTS_DIR_NAME);
  const serializeAgentMd = deps.serializeAgentMd ?? (await loadSerializer(cwd)).serializeAgentMd;
  const serializePerms =
    deps.serializePermissions ?? (await loadSerializer(cwd)).serializePermissions;
  const parseAgentFolderFn = deps.parseAgentFolder ?? (await loadParseAgentFolder(cwd));
  const getRoutineFn = deps.getRoutine ?? (await loadGetRoutine(cwd));
  const dirExists = deps.dirExists ?? defaultDirExists;
  const writeAtomic = deps.writeFileAtomic ?? defaultWriteAtomic;
  const mkdirp = deps.mkdirp ?? (async (p: string) => void (await mkdir(p, { recursive: true })));
  const rmrf = deps.rmrf ?? (async (p: string) => rm(p, { recursive: true, force: true }));

  if (!ID_RE.test(input.id)) {
    throw new AgentWriteError(
      `id '${input.id}' должен быть kebab-case (^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$).`,
    );
  }
  if ((await getRoutineFn(input.id)) !== null) {
    throw new AgentWriteError(`агент или routine с id '${input.id}' уже существует.`, 409);
  }

  const agentDir = resolveAgentDir(agentsRoot, input.id);
  if (await dirExists(agentDir)) {
    throw new AgentWriteError(`папка agents/${input.id}/ уже существует.`, 409);
  }

  // Сборка контента.
  const agentMd = serializeAgentMd({
    displayName: input.displayName,
    description: input.description,
    model: input.model,
    enabled: input.enabled,
    trigger: input.trigger,
    outputType: input.outputType,
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
    ...(input.color !== undefined ? { color: input.color } : {}),
    ...(input.logo !== undefined ? { logo: input.logo } : {}),
    ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
    ...(input.skills !== undefined ? { skills: input.skills } : {}),
    ...(input.forceLoad !== undefined ? { forceLoad: input.forceLoad } : {}),
  });
  const promptMd = `${input.prompt.replace(/\s+$/, '')}\n`;
  const permsYml = serializePerms(null, input.tools, input.bashWhitelist);

  const fileMap: Record<string, string> = { 'AGENT.md': agentMd, 'prompt.md': promptMd };
  if (permsYml !== null) fileMap['permissions.yml'] = permsYml;

  // Валидация ДО записи.
  await validateInMemory(agentDir, fileMap, parseAgentFolderFn);

  // Запись с откатом папки при частичном сбое (атомарность create).
  await mkdirp(agentDir);
  try {
    for (const [rel, content] of Object.entries(fileMap)) {
      await writeAtomic(join(agentDir, rel), content);
    }
  } catch (err) {
    await rmrf(agentDir).catch(() => {});
    throw err;
  }
  return { ok: true, id: input.id, agentDir };
}

export async function updateAgent(
  id: string,
  patch: AgentUpdatePatch,
  deps: AgentWriteDeps = {},
): Promise<{ ok: true; id: string; agentDir: string }> {
  const cwd = deps.cwd ?? process.cwd();
  const agentsRoot = deps.agentsRoot ?? resolve(cwd, AGENTS_DIR_NAME);
  const serializerMod = deps.applyAgentMdPatch ? null : await loadSerializer(cwd);
  const applyPatch = deps.applyAgentMdPatch ?? serializerMod!.applyAgentMdPatch;
  const serializePerms = deps.serializePermissions ?? serializerMod!.serializePermissions;
  const parseAgentFolderFn = deps.parseAgentFolder ?? (await loadParseAgentFolder(cwd));
  const getRoutineFn = deps.getRoutine ?? (await loadGetRoutine(cwd));
  const readFileFn = deps.readFileFn ?? ((p: string) => readFile(p, 'utf8'));
  const fileExists = deps.fileExists ?? defaultFileExists;
  const writeAtomic = deps.writeFileAtomic ?? defaultWriteAtomic;
  const rmrf = deps.rmrf ?? (async (p: string) => rm(p, { recursive: true, force: true }));

  const existing = await getRoutineFn(id);
  if (existing === null) {
    throw new AgentWriteError(`агент '${id}' не найден.`, 404);
  }
  const agentDir = existing.agentDir;
  if (agentDir === undefined || agentDir === '') {
    throw new AgentWriteError(
      `'${id}' — это legacy routine (routines/${id}.md), а не agents/<id>/. Используй routine-API.`,
      400,
    );
  }
  // Гард: agentDir обязан лежать под agentsRoot.
  if (agentDir !== `${agentsRoot}/${id}` && !agentDir.startsWith(`${agentsRoot}/`)) {
    throw new AgentWriteError(`агент '${id}' вне ${AGENTS_DIR_NAME}/ — правка не поддержана.`, 400);
  }

  // Текущее содержимое (для merge и in-memory валидации полной папки).
  const map: Record<string, string> = {};
  map['AGENT.md'] = await readFileFn(join(agentDir, 'AGENT.md'));
  map['prompt.md'] = await readFileFn(join(agentDir, 'prompt.md'));
  for (const opt of ['permissions.yml', 'target.yml', 'rules.md', 'report.md']) {
    if (await fileExists(join(agentDir, opt))) {
      map[opt] = await readFileFn(join(agentDir, opt));
    }
  }

  // Снимок оригиналов ДО мутации map — для отката при частичной записи (D1-1).
  // undefined = файла не было (на откате его надо удалить).
  const originals: Record<string, string | undefined> = { ...map };

  // Применяем патч к контенту в памяти.
  const changed: Record<string, string> = {};
  const agentMdPatch = {
    ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.trigger !== undefined ? { trigger: patch.trigger } : {}),
    ...(patch.outputType !== undefined ? { outputType: patch.outputType } : {}),
    ...(patch.maxTokens !== undefined ? { maxTokens: patch.maxTokens } : {}),
    ...(patch.timeoutMs !== undefined ? { timeoutMs: patch.timeoutMs } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}),
    ...(patch.logo !== undefined ? { logo: patch.logo } : {}),
    ...(patch.departmentId !== undefined ? { departmentId: patch.departmentId } : {}),
    ...(patch.skills !== undefined ? { skills: patch.skills } : {}),
    ...(patch.forceLoad !== undefined ? { forceLoad: patch.forceLoad } : {}),
  };
  if (Object.keys(agentMdPatch).length > 0) {
    map['AGENT.md'] = applyPatch(map['AGENT.md'], agentMdPatch);
    changed['AGENT.md'] = map['AGENT.md'];
  }
  if (patch.prompt !== undefined) {
    map['prompt.md'] = `${patch.prompt.replace(/\s+$/, '')}\n`;
    changed['prompt.md'] = map['prompt.md'];
  }
  if (patch.tools !== undefined || patch.bashWhitelist !== undefined) {
    let existingPerms: Record<string, unknown> | null = null;
    if (map['permissions.yml'] !== undefined) {
      const parsed = parseYaml(map['permissions.yml']);
      existingPerms =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
    }
    const permsYml = serializePerms(existingPerms, patch.tools, patch.bashWhitelist);
    if (permsYml === null) {
      // Стало пусто — убираем permissions.yml из валидируемой папки и помечаем
      // файл к удалению. delete нужен, чтобы parseAgentFolder не «увидел» файл.
      // biome-ignore lint/performance/noDelete: точечное удаление ключа из небольшой map
      delete map['permissions.yml'];
      changed['__delete__permissions.yml'] = '';
    } else {
      map['permissions.yml'] = permsYml;
      changed['permissions.yml'] = permsYml;
    }
  }

  // Валидация полной папки после изменений.
  await validateInMemory(agentDir, map, parseAgentFolderFn);

  // Запись только изменённых файлов. Несколько файлов = не атомарно по своей
  // природе; при сбое на середине откатываем уже записанное к оригиналам (D1-1),
  // чтобы агент не остался в полу-применённом состоянии (новый frontmatter, старый
  // prompt).
  const written: string[] = [];
  try {
    for (const [rel, content] of Object.entries(changed)) {
      if (rel === '__delete__permissions.yml') {
        await rmrf(join(agentDir, 'permissions.yml')).catch(() => {});
        written.push('permissions.yml');
      } else {
        await writeAtomic(join(agentDir, rel), content);
        written.push(rel);
      }
    }
  } catch (err) {
    for (const rel of written) {
      const orig = originals[rel];
      if (orig === undefined) await rmrf(join(agentDir, rel)).catch(() => {});
      else await writeAtomic(join(agentDir, rel), orig).catch(() => {});
    }
    throw new AgentWriteError(
      `запись прервана и откачена к прежнему состоянию: ${
        err instanceof Error ? err.message : String(err)
      }`,
      400,
    );
  }
  return { ok: true, id, agentDir };
}

export async function deleteAgent(
  id: string,
  deps: AgentWriteDeps = {},
): Promise<{ ok: true; id: string }> {
  const cwd = deps.cwd ?? process.cwd();
  const agentsRoot = deps.agentsRoot ?? resolve(cwd, AGENTS_DIR_NAME);
  const getRoutineFn = deps.getRoutine ?? (await loadGetRoutine(cwd));
  const rmrf = deps.rmrf ?? (async (p: string) => rm(p, { recursive: true, force: true }));

  const existing = await getRoutineFn(id);
  if (existing === null) {
    throw new AgentWriteError(`агент '${id}' не найден.`, 404);
  }
  const agentDir = existing.agentDir;
  if (agentDir === undefined || agentDir === '') {
    throw new AgentWriteError(
      `'${id}' — legacy routine, а не agents/<id>/ — удаление через routine-API.`,
      400,
    );
  }
  if (agentDir !== `${agentsRoot}/${id}` && !agentDir.startsWith(`${agentsRoot}/`)) {
    throw new AgentWriteError(
      `агент '${id}' вне ${AGENTS_DIR_NAME}/ — удаление не поддержано.`,
      400,
    );
  }
  await rmrf(agentDir);
  return { ok: true, id };
}
