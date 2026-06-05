// Routine registry — единственная точка резолва routine-файлов.
//
// Контракт фазы 1.2:
//   * `listRoutines()` — для всех проектов реестра (включая disabled —
//     знание о routine не зависит от того, замаунтен ли проект сейчас)
//     резолвит `routinesGlob` каждого проекта и парсит каждый найденный
//     файл. Дубль `routine.id` (внутри проекта или между проектами) →
//     `RoutineRegistryError`.
//   * `getRoutine(id)` — один routine по id или null.
//   * `getEnabledRoutines()` — фильтрует по `routine.enabled=true` И по
//     тому, что соответствующий проект сейчас enabled (динамически —
//     учитывая graceful degradation из 1.1).
//   * `getRoutinesByCron()` — только enabled routines с trigger != 'manual'
//     (источник для cron-генератора 1.4).
//
// Почему пробегаем ВСЕ проекты, а не только enabled:
//   * Если проект disabled из-за multi-mac (нет path), мы всё равно хотим
//     видеть его routines в реестре (например, для отчёта `/routines`).
//   * `getEnabledRoutines` уже фильтрует по `project.enabled` — там
//     ровно та семантика «что реально может сейчас бежать».
//
// Glob-резолюция — через `fast-glob`. `routinesGlob` из ProjectMeta —
// относительный к корню AI-Cofounder. Резолвим относительно `cwd`.

import { dirname, resolve } from 'node:path';
import fg from 'fast-glob';
import {
  type ProjectMeta,
  type RegistryOptions as ProjectRegistryOptions,
  getProject,
  listProjects,
} from '../projects/registry.js';
import { parseAgentFolder } from './agent-loader.js';
import { type Routine, parseRoutineFile } from './parser.js';

export class RoutineRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutineRegistryError';
  }
}

export interface RoutineRegistryOptions {
  cwd?: string;
  // DI: подменить glob-резолвер (для тестов и edge-cases).
  glob?: (pattern: string, cwd: string) => Promise<string[]>;
  // DI: подменить чтение routine-файла.
  read?: (path: string) => Promise<string>;
  // Пробрасываются в `listProjects`/`getProject`.
  projectRegistryOptions?: ProjectRegistryOptions;
}

async function defaultGlob(pattern: string, cwd: string): Promise<string[]> {
  // `absolute: true` чтобы parseRoutineFile получил абсолютный путь
  // (это совпадает с контрактом `Routine.filePath`).
  return fg(pattern, { cwd, absolute: true, onlyFiles: true });
}

interface ResolvedFromProject {
  routine: Routine;
  project: ProjectMeta;
}

async function loadRoutinesForProject(
  project: ProjectMeta,
  options: RoutineRegistryOptions,
): Promise<ResolvedFromProject[]> {
  const cwd = options.cwd ?? process.cwd();
  const glob = options.glob ?? defaultGlob;
  const read = options.read;

  const files = await glob(project.routinesGlob, cwd);
  const out: ResolvedFromProject[] = [];
  for (const file of files) {
    const abs = resolve(file); // на случай если glob отдал относительный
    // Изоляция per-файл: один битый legacy-routine (ошибка ПАРСИНГА) не должен
    // ронять весь реестр (и через него — диспетчер/cron всех ЗДОРОВЫХ routine'ов).
    // Скип + warn. ВАЖНО: ловим только parse-ошибки; integrity-ошибки реестра
    // (projectId-mismatch ниже) — это рассогласование конфига, его НАДО всплывать.
    let routine: Routine;
    try {
      routine = await parseRoutineFile(abs, read ? { read } : {});
    } catch (err) {
      console.warn(
        `[routines:registry] пропускаю битый routine-файл '${abs}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    if (routine.projectId !== project.id) {
      throw new RoutineRegistryError(
        `routine '${routine.id}' (${abs}) объявляет projectId='${routine.projectId}', но найден через glob проекта '${project.id}' ('${project.routinesGlob}'). projectId routine'ы должен совпадать с проектом, в котором она лежит.`,
      );
    }
    out.push({ routine, project });
  }
  return out;
}

const DEFAULT_AGENTS_GLOB = 'agents/*/AGENT.md';

// Грузит самодостаточные agents/<id>/ через parseAgentFolder. Attach'ит
// синтетический проект 'self'. Зеркалит glob→dirname→parse паттерн skills/.
async function loadAgents(
  selfProject: ProjectMeta,
  options: RoutineRegistryOptions,
): Promise<ResolvedFromProject[]> {
  const cwd = options.cwd ?? process.cwd();
  const glob = options.glob ?? defaultGlob;
  const read = options.read;

  const files = await glob(DEFAULT_AGENTS_GLOB, cwd);
  const out: ResolvedFromProject[] = [];
  for (const file of files) {
    const abs = resolve(file);
    const agentDir = dirname(abs);
    // Изоляция per-папка: форкнувший юзер, опечатавшийся в одном agents/<id>/,
    // НЕ должен терять все остальные здоровые агенты (и валить scheduler на
    // старте). Битую папку скипаем с warn; дубль id ловится глобально в loadAll.
    try {
      const routine = await parseAgentFolder(agentDir, read ? { read } : {});
      out.push({ routine, project: selfProject });
    } catch (err) {
      console.warn(
        `[routines:registry] пропускаю битую папку агента '${agentDir}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return out;
}

async function loadAll(options: RoutineRegistryOptions = {}): Promise<ResolvedFromProject[]> {
  const cwd = options.cwd ?? process.cwd();
  const projects = await listProjects(options.projectRegistryOptions ?? { cwd });

  // Синтетический built-in проект 'self' — owner всех agents/<id>/.
  const selfProject = projects.find((p) => p.id === 'self');
  if (selfProject === undefined) {
    throw new RoutineRegistryError(
      "встроенный проект 'self' отсутствует в реестре — баг инъекции синтетического проекта (src/projects/registry.ts).",
    );
  }

  // Параллельно по проектам — ничего не пишем, только читаем.
  const perProject = await Promise.all(projects.map((p) => loadRoutinesForProject(p, options)));
  const legacyFlat = perProject.flat();

  // agents/<id>/ — новый формат, ПОБЕЖДАЮТ при коллизии id: молча отбрасываем
  // legacy-routine, чей id уже занят агентом (agents-win). Дубль ВНУТРИ agents
  // или ВНУТРИ legacy всё равно throw'нется проверкой уникальности ниже —
  // тихий скип только для пары agent↔legacy на время миграции.
  const agentFlat = await loadAgents(selfProject, options);
  const agentIds = new Set(agentFlat.map((r) => r.routine.id));
  const filteredLegacy = legacyFlat.filter((r) => !agentIds.has(r.routine.id));
  const flat = [...agentFlat, ...filteredLegacy];

  // Проверка глобальной уникальности routine.id.
  const seen = new Map<string, string>(); // id → filePath первой встреченной
  for (const { routine } of flat) {
    const prev = seen.get(routine.id);
    if (prev !== undefined) {
      throw new RoutineRegistryError(
        `дубль routine id='${routine.id}': '${prev}' и '${routine.filePath}'. id routine'ы должен быть уникален в пределах AI-Cofounder.`,
      );
    }
    seen.set(routine.id, routine.filePath);
  }

  // Проверка, что projectId routine'ы вообще существует в реестре.
  // Технически уже гарантировано фильтром выше (мы итерируемся по
  // listProjects), но оставим явную проверку — на случай рефакторинга.
  const knownProjectIds = new Set(projects.map((p) => p.id));
  for (const { routine } of flat) {
    if (!knownProjectIds.has(routine.projectId)) {
      throw new RoutineRegistryError(
        `routine '${routine.id}' (${routine.filePath}) ссылается на projectId='${routine.projectId}', которого нет в config/projects.md.`,
      );
    }
  }

  return flat;
}

export async function listRoutines(options: RoutineRegistryOptions = {}): Promise<Routine[]> {
  const all = await loadAll(options);
  return all.map((r) => r.routine);
}

export async function getRoutine(
  id: string,
  options: RoutineRegistryOptions = {},
): Promise<Routine | null> {
  const all = await listRoutines(options);
  return all.find((r) => r.id === id) ?? null;
}

// Routines, которые сейчас реально могут запуститься: routine.enabled=true И
// project.enabled=true (учитывая динамический enabled из 1.1).
export async function getEnabledRoutines(options: RoutineRegistryOptions = {}): Promise<Routine[]> {
  const cwd = options.cwd ?? process.cwd();
  const all = await loadAll(options);
  const out: Routine[] = [];
  for (const { routine, project } of all) {
    if (!routine.enabled) continue;
    // Если getProject вернёт null — значит проект пропал из реестра между
    // двумя чтениями (race condition). На всякий случай защита.
    const fresh = await getProject(project.id, options.projectRegistryOptions ?? { cwd });
    if (fresh === null || !fresh.enabled) continue;
    out.push(routine);
  }
  return out;
}

// Cron-trigger routines (для launchd-генератора 1.4).
export async function getRoutinesByCron(options: RoutineRegistryOptions = {}): Promise<Routine[]> {
  const enabled = await getEnabledRoutines(options);
  return enabled.filter((r) => r.trigger !== 'manual');
}
