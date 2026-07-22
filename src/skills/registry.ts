// Skill registry — единственная точка резолва файлов `skills/<name>/`.
//
// Контракт фазы 1 (план 2026-05-21-skills-architecture-v3, раздел «Фаза 1»):
//   * `listSkills()` — сканирует `skills/<name>/SKILL.md` через fast-glob,
//     парсит каждый файл. Дубликаты `name` → `SkillRegistryError`.
//   * `getSkill(name)` — один скилл по имени или null.
//   * `resolveDeps(names)` — топологическая сортировка по `dependsOn`
//     (Kahn's algorithm). Возвращает скиллы в порядке «зависимости раньше,
//     зависимые позже». Цикл / missing dep → `SkillRegistryError`.
//
// Почему пробегаем все скиллы (а не только нужные) для резолва deps:
//   * Граф зависимостей маленький (~десятки скиллов). Лишний парсинг ≪ 1ms.
//   * Альтернатива (lazy walk графа) усложняет детекцию missing dep —
//     приходится поддерживать промежуточный «нашли/не нашли» state.
//
// DI как в `src/routines/registry.ts`: `{cwd, glob, read}` — опциональные
// перегрузки для тестов.

import { dirname, resolve } from 'node:path';
import fg from 'fast-glob';
import { parseSkill } from './parser.js';
import type { Skill } from './types.js';

export class SkillRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillRegistryError';
  }
}

export interface SkillRegistryOptions {
  // Корень репозитория. По умолчанию `process.cwd()`.
  cwd?: string;
  // DI: подменить glob-резолвер.
  glob?: (pattern: string, cwd: string) => Promise<string[]>;
  // DI: подменить чтение файлов (передаётся в parseSkill).
  read?: (path: string) => Promise<string>;
  // DI: подменить проверку существования (для opt. permissions.md).
  fileExists?: (path: string) => Promise<boolean>;
  // Glob-паттерн, относительный к cwd. По умолчанию `skills/*/SKILL.md`.
  // Параметризуем для тестов (можно скармливать tmpdir).
  skillsGlob?: string;
}

const DEFAULT_SKILLS_GLOB = 'skills/*/SKILL.md';
const DEFAULT_AGENT_SKILLS_GLOB = 'agents/*/skills/*/SKILL.md';

async function defaultGlob(pattern: string, cwd: string): Promise<string[]> {
  return fg(pattern, { cwd, absolute: true, onlyFiles: true });
}

async function loadAll(options: SkillRegistryOptions): Promise<Skill[]> {
  const cwd = options.cwd ?? process.cwd();
  const glob = options.glob ?? defaultGlob;
  const read = options.read;
  const fileExists = options.fileExists;
  const pattern = options.skillsGlob ?? DEFAULT_SKILLS_GLOB;

  const files = await glob(pattern, cwd);

  const parseOptions: Parameters<typeof parseSkill>[1] = {};
  if (read !== undefined) parseOptions.read = read;
  if (fileExists !== undefined) parseOptions.fileExists = fileExists;

  const skills: Skill[] = [];
  for (const file of files) {
    const abs = resolve(file);
    const skillDir = dirname(abs);
    const skill = await parseSkill(skillDir, parseOptions);
    skills.push(skill);
  }

  // ── Агентские приватные скиллы: agents/<id>/skills/<name>/SKILL.md ──
  // parseSkill жёстко требует name == basename(skillDir) (validateName), поэтому
  // namespacing навешиваем ПОСЛЕ парсинга: name → '<agentId>.<name>'. Так два
  // агента могут иметь скилл 'deploy' без коллизии. Берём ТОЛЬКО реальные
  // agents/<id>/skills/<name>/ пути — всё прочее (напр. pattern-игнорящий glob-DI
  // в тестах) тихо пропускаем, чтобы не дублировать top-level скиллы.
  const agentSkillFiles = await glob(DEFAULT_AGENT_SKILLS_GLOB, cwd);
  for (const file of agentSkillFiles) {
    const abs = resolve(file);
    const segs = abs.split('/');
    const agentsIdx = segs.lastIndexOf('agents');
    if (agentsIdx < 0 || segs[agentsIdx + 2] !== 'skills') continue;
    const agentId = segs[agentsIdx + 1];
    if (agentId === undefined || agentId === '') continue;
    const skillDir = dirname(abs); // agents/<id>/skills/<name>
    const skill = await parseSkill(skillDir, parseOptions);
    skills.push({ ...skill, name: `${agentId}.${skill.name}` });
  }

  // Проверка уникальности по name.
  const seen = new Map<string, string>(); // name → filePath первой встреченной
  for (const s of skills) {
    const prev = seen.get(s.name);
    if (prev !== undefined) {
      throw new SkillRegistryError(
        `дубль skill name='${s.name}': '${prev}' и '${s.filePath}'. name должен быть уникален в пределах AI-Cofounder.`,
      );
    }
    seen.set(s.name, s.filePath);
  }

  return skills;
}

export async function listSkills(options: SkillRegistryOptions = {}): Promise<Skill[]> {
  return loadAll(options);
}

export async function getSkill(
  name: string,
  options: SkillRegistryOptions = {},
): Promise<Skill | null> {
  const all = await loadAll(options);
  return all.find((s) => s.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// resolveDeps — топологическая сортировка через Kahn's algorithm.
//
// Вход: имена скиллов, которые надо «активировать». Выход: те же скиллы
// + все транзитивные зависимости, в порядке, где dependsOn идёт раньше
// зависящего. Цикл / missing dep → SkillRegistryError.
//
// Kahn:
//   1. Считаем in-degree для каждого узла (сколько раз встречается как
//      «зависящий», т.е. как ИСТОЧНИК стрелки в графе deps→dependents).
//   2. Кладём в очередь узлы с in-degree 0 (без зависимостей).
//   3. Достаём узел, добавляем в результат, декрементируем in-degree
//      его dependents'ов, кладём в очередь когда in-degree становится 0.
//   4. Если результат меньше всех узлов — есть цикл.
//
// Направление графа: ребро (A → B) означает «A зависит от B», т.е. B
// должен идти раньше A. В Kahn'е сначала выходят узлы без зависимостей,
// поэтому это правильный порядок: зависимости первыми.
// ---------------------------------------------------------------------------

export async function resolveDeps(
  skillNames: string[],
  options: SkillRegistryOptions = {},
): Promise<Skill[]> {
  const all = await loadAll(options);
  const byName = new Map<string, Skill>(all.map((s) => [s.name, s]));

  // 1. BFS от запрошенных узлов вниз по dependsOn — собираем все нужные узлы.
  const needed = new Set<string>();
  const queue: string[] = [];
  for (const n of skillNames) {
    if (!byName.has(n)) {
      throw new SkillRegistryError(`skill '${n}' не найден в реестре (resolveDeps).`);
    }
    if (!needed.has(n)) {
      needed.add(n);
      queue.push(n);
    }
  }
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    const skill = byName.get(cur);
    if (skill === undefined) {
      // не должно случаться (мы проверили выше при добавлении), но защита.
      throw new SkillRegistryError(`skill '${cur}' не найден в реестре (resolveDeps).`);
    }
    for (const dep of skill.dependsOn ?? []) {
      if (!byName.has(dep)) {
        throw new SkillRegistryError(
          `skill '${cur}' зависит от '${dep}', который отсутствует в реестре.`,
        );
      }
      if (!needed.has(dep)) {
        needed.add(dep);
        queue.push(dep);
      }
    }
  }

  // 2. Считаем in-degree (= количество dependsOn, лежащих в `needed`).
  const inDegree = new Map<string, number>();
  for (const n of needed) {
    const skill = byName.get(n) as Skill;
    const deps = (skill.dependsOn ?? []).filter((d) => needed.has(d));
    inDegree.set(n, deps.length);
  }

  // 3. Карта обратных рёбер: depName → имена скиллов, которые от него зависят.
  const dependents = new Map<string, string[]>();
  for (const n of needed) {
    const skill = byName.get(n) as Skill;
    for (const dep of skill.dependsOn ?? []) {
      if (!needed.has(dep)) continue;
      let arr = dependents.get(dep);
      if (arr === undefined) {
        arr = [];
        dependents.set(dep, arr);
      }
      arr.push(n);
    }
  }

  // 4. Kahn.
  const ready: string[] = [];
  for (const [n, deg] of inDegree) {
    if (deg === 0) ready.push(n);
  }
  // Сортируем стартовые узлы по имени — детерминированный порядок для тестов.
  ready.sort();

  const out: Skill[] = [];
  while (ready.length > 0) {
    const cur = ready.shift() as string;
    out.push(byName.get(cur) as Skill);
    const next = dependents.get(cur) ?? [];
    // Сортируем подаваемых dependents для детерминированности.
    const justUnlocked: string[] = [];
    for (const d of next) {
      const newDeg = (inDegree.get(d) ?? 0) - 1;
      inDegree.set(d, newDeg);
      if (newDeg === 0) justUnlocked.push(d);
    }
    justUnlocked.sort();
    for (const d of justUnlocked) ready.push(d);
  }

  if (out.length !== needed.size) {
    // Найден цикл. Соберём один пример пути цикла для понятной ошибки.
    const remaining = [...needed].filter((n) => !out.some((s) => s.name === n));
    const cycle = findCycle(remaining, byName);
    throw new SkillRegistryError(`cycle in dependsOn: ${cycle.join(' → ')}`);
  }

  return out;
}

// DFS-поиск цикла в подграфе из `nodes`. Возвращает массив имён, замыкающих
// цикл (первый и последний элемент — одно и то же имя), например ['a','b','a'].
function findCycle(nodes: string[], byName: Map<string, Skill>): string[] {
  const nodeSet = new Set(nodes);
  const visiting = new Set<string>();
  const path: string[] = [];

  function dfs(n: string): string[] | null {
    if (visiting.has(n)) {
      // Нашли цикл — режем path с момента первого вхождения n.
      const i = path.indexOf(n);
      return [...path.slice(i), n];
    }
    visiting.add(n);
    path.push(n);
    const skill = byName.get(n);
    for (const dep of skill?.dependsOn ?? []) {
      if (!nodeSet.has(dep)) continue;
      const found = dfs(dep);
      if (found !== null) return found;
    }
    path.pop();
    visiting.delete(n);
    return null;
  }

  for (const n of nodes) {
    const found = dfs(n);
    if (found !== null) return found;
  }
  // Не нашли — fallback, выводим список.
  return nodes;
}
