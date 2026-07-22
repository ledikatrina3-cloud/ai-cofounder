// Routines-API хелперы для bridge/server.ts (план 2026-05-17 «3D-офис»).
//
// Контракт: чистые функции над better-sqlite3 + Routine-метаданными. Эндпоинты
// в server.ts остаются тонкими: открыть DB → позвать helper → отдать JSON.
//
// Почему отдельный файл:
//   * server.ts уже на ~650 строк; добавлять сюда status-derivation и
//     transcript-сборку — поплыть в монолит. Изолированный модуль удобнее
//     тестировать без поднимания HTTP.
//   * Тесты `tests/routines-api.test.ts` импортируют отсюда напрямую, на
//     better-sqlite3-инстансе из tests/fixtures/isolated-db.ts (точнее —
//     открывают тот же filePath через better-sqlite3 read-only).
//
// Все функции принимают уже-открытую `Database` better-sqlite3 — никакого
// path-resolve внутри. Это даёт тестам полный контроль над БД.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';

// ---------------------------------------------------------------------------
// Локальный type-mirror Routine.
//
// bridge/tsconfig.json имеет rootDir='.', поэтому статический import из ../src/
// запрещён компилятором. Мы держим узкий локальный тип, который описывает
// поля Routine, нужные API-эндпоинтам. Если в src/routines/parser.ts добавятся
// новые поля — обновлять и здесь (немного дублирования ради изоляции сборки,
// тот же подход, что в `ChatHandlerFn` в server.ts).
// ---------------------------------------------------------------------------

export interface RoutineRecord {
  id: string;
  projectId: string;
  enabled: boolean;
  trigger: string;
  model: string;
  description: string;
  role?: string;
  avatar?: string;
  color?: string;
  /** Путь к SVG/PNG лого относительно bridge/app/public/ (например, '/logos/vc.svg'). */
  logo?: string;
  /** Имена скиллов, объявленных в routine frontmatter. */
  skills?: string[];
  /** id отдела (Фаза 5). Используется UI для группировки сотрудников по зонам. */
  departmentId?: string;
}

// ---------------------------------------------------------------------------
// Skill discovery DTO. Фаза 3 плана 2026-05-21-skills-architecture-v3:
// UI рендерит до 3-х бейджей-скиллов поверх аватара сотрудника. Для этого
// нужны только лёгкие поля (~80 ток в обычном prompt-discovery), а body
// SKILL.md в UI не нужен.
// ---------------------------------------------------------------------------

export interface SkillDiscovery {
  name: string;
  displayName?: string;
  description: string;
  icon?: string;
  color?: string;
  category?: string;
  /** Версия из SKILL.md frontmatter (опционально). */
  version?: string;
  /**
   * Routine-id'ы, у которых этот скилл объявлен в `skills: [...]`. Не считает
   * транзитивные deps — только прямую зависимость на уровне routine
   * frontmatter'а. Это «used by X сотрудниками» в карточке маркетплейса.
   */
  usedBy?: string[];
}

// ---------------------------------------------------------------------------
// Полный DTO скилла для GET /skills/:name. Включает body SKILL.md,
// permissions, dependsOn — всё, что нужно SkillDetailDrawer'у в UI.
// Bridge не хранит body в /skills (тяжёлый payload), эндпоинт /skills/:name
// — единственный путь получить полный объект.
// ---------------------------------------------------------------------------

export interface SkillFullDto {
  name: string;
  description: string;
  displayName?: string;
  icon?: string;
  color?: string;
  category?: string;
  version?: string;
  dependsOn?: string[];
  /** Тело SKILL.md после frontmatter (markdown-source). */
  body: string;
  /** Permissions из permissions.md (или `{}` если файла нет). */
  permissions: Record<string, unknown>;
  /** Routine-id'ы, где скилл объявлен. */
  usedBy: string[];
}

// ---------------------------------------------------------------------------
// Runtime-loader для listRoutines() из src/. Тот же приём, что
// loadChatHandler в server.ts: грузим из dist/src через dynamic import. Это
// держит bridge-тс-сборку изолированной (rootDir=bridge), но позволяет
// эндпоинту опереться на единственный реестр routines в src/.
// ---------------------------------------------------------------------------

type ListRoutinesFn = () => Promise<RoutineRecord[]>;
let cachedListRoutines: ListRoutinesFn | null = null;

export async function loadListRoutines(): Promise<ListRoutinesFn> {
  if (cachedListRoutines !== null) return cachedListRoutines;
  const registryPath = resolve(process.cwd(), 'dist', 'src', 'routines', 'registry.js');
  const mod = (await import(pathToFileURL(registryPath).href)) as {
    listRoutines: () => Promise<RoutineRecord[]>;
  };
  cachedListRoutines = mod.listRoutines;
  return cachedListRoutines;
}

// ---------------------------------------------------------------------------
// Skills loaders. Тот же приём: грузим listSkills/resolveDeps из dist/src
// (bridge tsconfig имеет rootDir=bridge, статический import из src/ запрещён).
// ---------------------------------------------------------------------------

interface SkillFull {
  name: string;
  description: string;
  displayName?: string;
  icon?: string;
  color?: string;
  category?: string;
  version?: string;
  dependsOn?: string[];
  /** Markdown-body SKILL.md без frontmatter. */
  prompt: string;
  /** Permissions из permissions.md. */
  permissions: Record<string, unknown>;
}

type ListSkillsFn = () => Promise<SkillFull[]>;
type ResolveDepsFn = (skillNames: string[]) => Promise<SkillFull[]>;

let cachedListSkills: ListSkillsFn | null = null;
let cachedResolveDeps: ResolveDepsFn | null = null;

async function loadSkillsRegistry(): Promise<{
  listSkills: ListSkillsFn;
  resolveDeps: ResolveDepsFn;
}> {
  if (cachedListSkills !== null && cachedResolveDeps !== null) {
    return { listSkills: cachedListSkills, resolveDeps: cachedResolveDeps };
  }
  const registryPath = resolve(process.cwd(), 'dist', 'src', 'skills', 'registry.js');
  const mod = (await import(pathToFileURL(registryPath).href)) as {
    listSkills: ListSkillsFn;
    resolveDeps: ResolveDepsFn;
  };
  cachedListSkills = mod.listSkills;
  cachedResolveDeps = mod.resolveDeps;
  return { listSkills: cachedListSkills, resolveDeps: cachedResolveDeps };
}

/** Маппит «толстый» Skill из реестра в discovery-DTO для UI. */
function toDiscovery(s: SkillFull): SkillDiscovery {
  const d: SkillDiscovery = {
    name: s.name,
    description: s.description,
  };
  if (s.displayName !== undefined) d.displayName = s.displayName;
  if (s.icon !== undefined) d.icon = s.icon;
  if (s.color !== undefined) d.color = s.color;
  if (s.category !== undefined) d.category = s.category;
  if (s.version !== undefined) d.version = s.version;
  return d;
}

/**
 * Собирает map skill-name → routine-id'ы, где этот скилл объявлен в
 * `skills: [...]`. Не считает транзитивные deps — только то, что
 * прописано в routine frontmatter'е. Используется и в /skills (поле
 * `usedBy`), и в /skills/:name (там же).
 */
async function buildUsedByMap(): Promise<Map<string, string[]>> {
  const listRoutines = await loadListRoutines();
  const routines = await listRoutines();
  const map = new Map<string, string[]>();
  for (const r of routines) {
    for (const name of r.skills ?? []) {
      let arr = map.get(name);
      if (arr === undefined) {
        arr = [];
        map.set(name, arr);
      }
      arr.push(r.id);
    }
  }
  return map;
}

/**
 * listAllSkills — возвращает все скиллы как discovery DTO + поле `usedBy`
 * (routine-id'ы, где скилл объявлен в frontmatter'е). Лёгкий вариант: body
 * SKILL.md и permissions сюда НЕ попадают — для них есть GET /skills/:name.
 */
export async function listAllSkills(): Promise<SkillDiscovery[]> {
  const { listSkills } = await loadSkillsRegistry();
  const [skills, usedBy] = await Promise.all([listSkills(), buildUsedByMap()]);
  return skills.map((s) => {
    const d = toDiscovery(s);
    d.usedBy = usedBy.get(s.name) ?? [];
    return d;
  });
}

/**
 * getSkillFull — полный DTO одного скилла: всё, что нужно SkillDetailDrawer'у.
 * Возвращает null, если скилла с таким именем нет.
 */
export async function getSkillFull(name: string): Promise<SkillFullDto | null> {
  const { listSkills } = await loadSkillsRegistry();
  const [skills, usedBy] = await Promise.all([listSkills(), buildUsedByMap()]);
  const skill = skills.find((s) => s.name === name);
  if (skill === undefined) return null;
  const dto: SkillFullDto = {
    name: skill.name,
    description: skill.description,
    body: skill.prompt,
    permissions: skill.permissions ?? {},
    usedBy: usedBy.get(skill.name) ?? [],
  };
  if (skill.displayName !== undefined) dto.displayName = skill.displayName;
  if (skill.icon !== undefined) dto.icon = skill.icon;
  if (skill.color !== undefined) dto.color = skill.color;
  if (skill.category !== undefined) dto.category = skill.category;
  if (skill.version !== undefined) dto.version = skill.version;
  if (skill.dependsOn !== undefined) dto.dependsOn = skill.dependsOn;
  return dto;
}

/**
 * resolveRoutineSkillsForUi — возвращает discovery-DTO для скиллов одной
 * routine'ы (с резолвом транзитивных deps через resolveDeps). Используется
 * эндпоинтом GET /routines/:id/skills. Пустой массив, если routine не
 * объявил skills.
 */
export async function resolveRoutineSkillsForUi(routine: RoutineRecord): Promise<SkillDiscovery[]> {
  const skillNames = routine.skills ?? [];
  if (skillNames.length === 0) return [];
  const { resolveDeps } = await loadSkillsRegistry();
  const resolved = await resolveDeps(skillNames);
  return resolved.map(toDiscovery);
}

// ---------------------------------------------------------------------------
// Skill health (Фаза 7). Тот же приём — dynamic-import из dist/src.
// ---------------------------------------------------------------------------

export interface SkillHealthRow {
  skillName: string;
  status: 'ok' | 'failed' | 'skipped';
  durationMs: number;
  lastCheckAt: number;
  error?: string;
  reason?: string;
  output?: Record<string, unknown>;
}

interface HealthStoreModule {
  getAllLatestHealth: () => Promise<
    Array<{
      skillName: string;
      status: 'ok' | 'failed' | 'skipped';
      durationMs: number;
      lastCheckAt: number;
      output?: Record<string, unknown>;
      error?: string;
      reason?: string;
    }>
  >;
}

let cachedHealthStore: HealthStoreModule | null = null;

async function loadHealthStore(): Promise<HealthStoreModule> {
  if (cachedHealthStore !== null) return cachedHealthStore;
  const path = resolve(process.cwd(), 'dist', 'src', 'skills', 'health-store.js');
  const mod = (await import(pathToFileURL(path).href)) as HealthStoreModule;
  cachedHealthStore = mod;
  return cachedHealthStore;
}

/**
 * listSkillHealth — возвращает последний health-check на каждый скилл,
 * у которого есть запись в Record. Скиллы БЕЗ healthCheck в permissions
 * сюда тоже не попадают (нет записи). UI рендерит точку в карточке:
 *  - status='ok' → зелёная
 *  - status='failed' → красная
 *  - status='skipped' → серая
 *  - нет записи → grey, tooltip 'unknown' (не было прогона ещё)
 */
export async function listSkillHealth(): Promise<SkillHealthRow[]> {
  const { getAllLatestHealth } = await loadHealthStore();
  const rows = await getAllLatestHealth();
  return rows.map((r) => {
    const out: SkillHealthRow = {
      skillName: r.skillName,
      status: r.status,
      durationMs: r.durationMs,
      lastCheckAt: r.lastCheckAt,
    };
    if (r.error !== undefined) out.error = r.error;
    if (r.reason !== undefined) out.reason = r.reason;
    if (r.output !== undefined) out.output = r.output;
    return out;
  });
}

// ---------------------------------------------------------------------------
// Типы DTO. Зеркало контракта из plans/.
// ---------------------------------------------------------------------------

export type RoutineStatus = 'idle' | 'running' | 'failed';
export type RoutineRunStatus = 'ok' | 'failed' | 'noop';

export interface RoutineSummary {
  id: string;
  projectId: string;
  departmentId?: string;
  enabled: boolean;
  trigger: string; // 'manual' или cron-expression
  model: string;
  description: string;
  role?: string;
  avatar?: string;
  color?: string;
  logo?: string;
  status: RoutineStatus;
  lastRunAt?: number; // unix ms
  lastRunStatus?: RoutineRunStatus;
  nextRunAt?: number; // unix ms (только cron)
  last7DaysRunCount: number;
}

export interface RoutineRunSummary {
  triggerId: string;
  startedAt: number;
  endedAt?: number;
  status?: RoutineRunStatus;
  durationMs?: number;
  totalUsd?: number;
  toolCallCount: number;
  /** Финальный отчёт sub-agent'а (audit.routine.end.properties.output). */
  output?: string;
}

export interface TranscriptEvent {
  ts: number;
  type: string;
  properties: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Внутренние shape'ы строк БД. Все колонки Record, которые мы вытаскиваем.
// ---------------------------------------------------------------------------

interface RecordRow {
  id: string;
  type: string;
  properties: string;
  parentId: string | null;
  createdAt: number;
}

interface RoutineStartRow {
  id: string;
  parentId: string | null;
  createdAt: number;
}

interface RoutineEndRow {
  parentId: string | null;
  properties: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Cron next-run. Возвращает unix ms или undefined для 'manual'/невалидного.
// ---------------------------------------------------------------------------

export function computeNextRunAt(trigger: string, now: Date = new Date()): number | undefined {
  if (trigger === 'manual') return undefined;
  // Поддержка ';'-разделённых выражений (см. src/routines/parser.ts) — берём
  // минимум по всем next() из валидных частей. Без этого мульти-слотовый
  // trigger ронял парсер ("too many fields"), UI падал на fallback scheduled-once.
  const parts = trigger
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  let best: number | undefined;
  for (const part of parts) {
    try {
      const it = CronExpressionParser.parse(part, { currentDate: now });
      const ms = it.next().toDate().getTime();
      if (best === undefined || ms < best) best = ms;
    } catch {
      // невалидное выражение — парсер при загрузке routine отверг бы, но
      // защищаемся на случай ручной правки file → bridge без перезапуска.
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// One-shot scheduled fires — для manual-routines, у которых cron не считается.
// Когда `scripts/schedule-one-shot.ts` ставит routine на запуск через N секунд,
// он INSERT'ит Record type='event.routine.scheduled-once' со status='active' и
// scheduledAtMs в properties. После реального запуска wrapper закрывает запись
// (status='consumed'), и она перестаёт считаться «next».
//
// UI читает `nextRunAt` через `buildRoutineSummary` — он автоматически делает
// fallback на эту запись, если cron-расчёт ничего не дал.
// ---------------------------------------------------------------------------

interface ScheduledOnceProps {
  routineId?: unknown;
  scheduledAtMs?: unknown;
}

function readActiveOneShotScheduled(
  db: Database.Database,
  routineId: string,
  now: number,
): number | undefined {
  const stmt = db.prepare<[string], { properties: string }>(
    `SELECT properties FROM "Record"
     WHERE type = 'event.routine.scheduled-once'
       AND status = 'active'
       AND json_extract(properties, '$.routineId') = ?
     ORDER BY createdAt DESC
     LIMIT 1`,
  );
  const row = stmt.get(routineId);
  if (row === undefined) return undefined;
  const props = safeParseJSON(row.properties) as ScheduledOnceProps;
  const ts = props.scheduledAtMs;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return undefined;
  // Если плановое время уже в прошлом и Record не закрылся (wrapper не успел /
  // упал) — не показываем как «next», иначе UI бы счёл что воркер «вот-вот»
  // навсегда. 5-минутный grace = реалистичное окно между fire и close.
  if (ts < now - 5 * 60 * 1000) return undefined;
  return ts;
}

// ---------------------------------------------------------------------------
// safeParseJSON — properties у Record хранятся как строка JSON. Битые записи
// (теоретически — миграция, ручной INSERT) не валим, просто возвращаем {}.
// ---------------------------------------------------------------------------

function safeParseJSON(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Status-detection для одной routine.
//
// running:
//   * Есть audit.routine.start без матчевого audit.routine.end (через
//     общего parentId = event.routine.trigger.id).
//   * И start.createdAt > now - 1ч (защита от «висящих» вечно: процесс мог
//     упасть и не написать audit.routine.end).
//
// failed:
//   * Самая свежая audit.routine.end имеет status === 'failed'.
//
// idle: иначе.
//
// Возвращаем также lastRunAt (createdAt последнего trigger.id, где есть end)
// и lastRunStatus.
// ---------------------------------------------------------------------------

const ONE_HOUR_MS = 60 * 60 * 1000;

interface RoutineState {
  status: RoutineStatus;
  lastRunAt?: number;
  lastRunStatus?: RoutineRunStatus;
}

function deriveRoutineState(
  db: Database.Database,
  routineId: string,
  now: number = Date.now(),
): RoutineState {
  // ── Последний audit.routine.end по routineId. JSON-фильтр через
  //   json_extract — есть в SQLite по умолчанию (JSON1).
  const endStmt = db.prepare<[string], RoutineEndRow>(
    `SELECT parentId, properties, createdAt FROM "Record"
     WHERE type = 'audit.routine.end'
       AND json_extract(properties, '$.routineId') = ?
     ORDER BY createdAt DESC
     LIMIT 1`,
  );
  const lastEnd = endStmt.get(routineId);

  let lastRunAt: number | undefined;
  let lastRunStatus: RoutineRunStatus | undefined;
  if (lastEnd !== undefined) {
    const props = safeParseJSON(lastEnd.properties);
    const st = typeof props.status === 'string' ? props.status : undefined;
    if (st === 'ok' || st === 'failed' || st === 'noop') lastRunStatus = st;
    lastRunAt = Number(lastEnd.createdAt);
  }

  // ── Свежий audit.routine.start без end'а за последний час. Поиск по
  //   triggerId (parentId): start есть, end отсутствует.
  const cutoff = now - ONE_HOUR_MS;
  const startStmt = db.prepare<[string, number], RoutineStartRow>(
    `SELECT id, parentId, createdAt FROM "Record"
     WHERE type = 'audit.routine.start'
       AND json_extract(properties, '$.routineId') = ?
       AND createdAt >= ?
     ORDER BY createdAt DESC`,
  );
  const recentStarts = startStmt.all(routineId, cutoff);

  let running = false;
  if (recentStarts.length > 0) {
    // Берём parentId'ы запусков (triggerId'ы) и проверяем есть ли end для каждого.
    const triggerIds = recentStarts.map((s) => s.parentId).filter((p): p is string => p !== null);
    if (triggerIds.length > 0) {
      const placeholders = triggerIds.map(() => '?').join(',');
      const endRowsStmt = db.prepare<string[], { parentId: string }>(
        `SELECT parentId FROM "Record"
         WHERE type = 'audit.routine.end' AND parentId IN (${placeholders})`,
      );
      const endRows = endRowsStmt.all(...triggerIds);
      const endedSet = new Set(endRows.map((r) => r.parentId));
      running = triggerIds.some((tid) => !endedSet.has(tid));
    }
  }

  let status: RoutineStatus = 'idle';
  if (running) {
    status = 'running';
  } else if (lastRunStatus === 'failed') {
    status = 'failed';
  }

  const result: RoutineState = { status };
  if (lastRunAt !== undefined) result.lastRunAt = lastRunAt;
  if (lastRunStatus !== undefined) result.lastRunStatus = lastRunStatus;
  return result;
}

// ---------------------------------------------------------------------------
// last7DaysRunCount — сколько раз тело routine'ы реально стартовало за 7д.
// Считаем audit.routine.start (не trigger — потому что dup-trigger через
// idempotency UNIQUE становятся audit.repeat без start'а).
// ---------------------------------------------------------------------------

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function count7DaysRuns(
  db: Database.Database,
  routineId: string,
  now: number = Date.now(),
): number {
  const stmt = db.prepare<[string, number], { c: number }>(
    `SELECT count(*) as c FROM "Record"
     WHERE type = 'audit.routine.start'
       AND json_extract(properties, '$.routineId') = ?
       AND createdAt >= ?`,
  );
  const row = stmt.get(routineId, now - SEVEN_DAYS_MS);
  return row?.c ?? 0;
}

// ---------------------------------------------------------------------------
// Public: summary для одной routine. Чистая функция, server.ts мапит её на
// массив роутайн-метаданных из registry.
// ---------------------------------------------------------------------------

export function buildRoutineSummary(
  db: Database.Database,
  routine: RoutineRecord,
  now: number = Date.now(),
): RoutineSummary {
  const state = deriveRoutineState(db, routine.id, now);
  const last7 = count7DaysRuns(db, routine.id, now);
  // Сперва пытаемся cron-расчёт; если trigger='manual' или cron невалидный —
  // fallback на одноразовую запись event.routine.scheduled-once (для запусков
  // через scripts/schedule-one-shot.ts). Это позволяет UI показывать таймер
  // обратного отсчёта для manual-routines, поставленных в очередь руками.
  const cronNext = computeNextRunAt(routine.trigger, new Date(now));
  const nextRunAt = cronNext ?? readActiveOneShotScheduled(db, routine.id, now);

  const summary: RoutineSummary = {
    id: routine.id,
    projectId: routine.projectId,
    enabled: routine.enabled,
    trigger: routine.trigger,
    model: routine.model,
    description: routine.description,
    status: state.status,
    last7DaysRunCount: last7,
  };
  if (routine.role !== undefined) summary.role = routine.role;
  if (routine.avatar !== undefined) summary.avatar = routine.avatar;
  if (routine.color !== undefined) summary.color = routine.color;
  if (routine.logo !== undefined) summary.logo = routine.logo;
  if (routine.departmentId !== undefined) summary.departmentId = routine.departmentId;
  if (state.lastRunAt !== undefined) summary.lastRunAt = state.lastRunAt;
  if (state.lastRunStatus !== undefined) summary.lastRunStatus = state.lastRunStatus;
  if (nextRunAt !== undefined) summary.nextRunAt = nextRunAt;
  return summary;
}

// ---------------------------------------------------------------------------
// Recent runs для одной routine. Возвращаем до `limit` последних запусков,
// каждый — pair (event.routine.trigger, audit.routine.end?).
//
// Подход:
//   1. Подтянуть последние N event.routine.trigger по routineId.
//   2. Для каждого — найти audit.routine.end (max 1, parentId = triggerId).
//   3. Подсчитать audit.spend Records с routineId внутри окна
//      [startedAt, endedAt ?? now]. spend.parentId часто null (cycleParentId
//      null в runtime.ts:132), поэтому связь идёт по time-window + routineId.
//
// toolCallCount — упрощённый прокси: один audit.spend ≈ один LLM-call ≈
// один turn sub-agent'а. У нас нет отдельной таблицы tool_calls. Это та же
// эвристика, что в /metrics (см. server.ts:144).
// ---------------------------------------------------------------------------

export function listRecentRuns(
  db: Database.Database,
  routineId: string,
  limit = 20,
): RoutineRunSummary[] {
  const triggerStmt = db.prepare<[string, number], RecordRow>(
    `SELECT id, type, properties, parentId, createdAt FROM "Record"
     WHERE type = 'event.routine.trigger'
       AND json_extract(properties, '$.routineId') = ?
     ORDER BY createdAt DESC
     LIMIT ?`,
  );
  const triggers = triggerStmt.all(routineId, limit);

  if (triggers.length === 0) return [];

  // Подтягиваем все end-Records одним IN-запросом — экономим round-trip'ы.
  const triggerIds = triggers.map((t) => t.id);
  const placeholders = triggerIds.map(() => '?').join(',');
  const endStmt = db.prepare<string[], RecordRow>(
    `SELECT id, type, properties, parentId, createdAt FROM "Record"
     WHERE type = 'audit.routine.end' AND parentId IN (${placeholders})`,
  );
  const endRows = endStmt.all(...triggerIds);

  const endByTrigger = new Map<string, RecordRow>();
  for (const e of endRows) {
    if (e.parentId !== null) endByTrigger.set(e.parentId, e);
  }

  // Один bulk-запрос spend'ов по routineId за окно с самого старого trigger'а.
  // Дальше мапим spend → trigger через time-window. spend.parentId сейчас null
  // (runtime.ts:132 cycleParentId=null), поэтому связь по timestamp'у —
  // единственный реалистичный путь. Triggers отсортированы DESC; windows
  // не перекрываются по contract (один run за раз для одной routine'ы).
  const minStart = Math.min(...triggers.map((t) => Number(t.createdAt)));
  const spendStmt = db.prepare<[string, number], { properties: string; createdAt: number }>(
    `SELECT properties, createdAt FROM "Record"
     WHERE type = 'audit.spend'
       AND json_extract(properties, '$.routineId') = ?
       AND createdAt >= ?
     ORDER BY createdAt ASC`,
  );
  const spendRows = spendStmt.all(routineId, minStart);

  // Сортируем триггеры по startedAt ASC для прохода спендам — потом перевернём.
  const ascTriggers = [...triggers].sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
  // Окна: для каждого триггера [startedAt, endedAt ?? nextTriggerStart ?? Infinity).
  const windows = ascTriggers.map((t, i) => {
    const startedAt = Number(t.createdAt);
    const end = endByTrigger.get(t.id);
    const endedAt = end !== undefined ? Number(end.createdAt) : undefined;
    const nextStart =
      i + 1 < ascTriggers.length ? Number(ascTriggers[i + 1]?.createdAt) : Number.MAX_SAFE_INTEGER;
    const windowEnd = endedAt ?? nextStart;
    return { triggerId: t.id, startedAt, windowEnd };
  });

  const totalsByTrigger = new Map<string, { totalUsd: number; toolCallCount: number }>();
  for (const w of windows) totalsByTrigger.set(w.triggerId, { totalUsd: 0, toolCallCount: 0 });

  for (const s of spendRows) {
    const ts = Number(s.createdAt);
    // Найдём окно, в которое попал spend.
    const window = windows.find((w) => ts >= w.startedAt && ts < w.windowEnd);
    if (window === undefined) continue;
    const totals = totalsByTrigger.get(window.triggerId);
    if (totals === undefined) continue;
    const p = safeParseJSON(s.properties);
    if (typeof p.usd === 'number' && Number.isFinite(p.usd)) totals.totalUsd += p.usd;
    totals.toolCallCount += 1;
  }

  // Возвращаем в исходном (DESC по startedAt) порядке.
  const out: RoutineRunSummary[] = [];
  for (const trig of triggers) {
    const startedAt = Number(trig.createdAt);
    const end = endByTrigger.get(trig.id);
    const endProps = end !== undefined ? safeParseJSON(end.properties) : {};
    const totals = totalsByTrigger.get(trig.id) ?? { totalUsd: 0, toolCallCount: 0 };

    let endedAt: number | undefined;
    let status: RoutineRunStatus | undefined;
    let durationMs: number | undefined;
    if (end !== undefined) {
      endedAt = Number(end.createdAt);
      const st = typeof endProps.status === 'string' ? endProps.status : undefined;
      if (st === 'ok' || st === 'failed' || st === 'noop') status = st;
      if (typeof endProps.durationMs === 'number') durationMs = endProps.durationMs;
    }

    const run: RoutineRunSummary = {
      triggerId: trig.id,
      startedAt,
      toolCallCount: totals.toolCallCount,
    };
    if (endedAt !== undefined) run.endedAt = endedAt;
    if (status !== undefined) run.status = status;
    if (durationMs !== undefined) run.durationMs = durationMs;
    if (totals.totalUsd > 0) run.totalUsd = totals.totalUsd;
    if (typeof endProps.output === 'string' && endProps.output.length > 0) {
      run.output = endProps.output;
    }
    out.push(run);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transcript: все Records для одного конкретного run'а.
//
// Источник — таблица Record. Идём 2 уровня вглубь:
//   1. Сам event.routine.trigger (как первое событие).
//   2. Records с parentId = triggerId (audit.routine.start, audit.routine.end,
//      audit.repeat, audit.routine.skipped).
//   3. Records с parentId IN (children level 1) — пока что таких немного
//      (spend пишется с parentId=null в runtime.ts:132), но эта семантика
//      готова к будущему: если когда-то spend начнёт линковать на
//      audit.routine.start.id, transcript подхватит автоматически.
//
// Сортировка — по createdAt ASC. Первое событие всегда trigger.
// ---------------------------------------------------------------------------

export function buildTranscript(
  db: Database.Database,
  triggerId: string,
): TranscriptEvent[] | null {
  // Достаём сам trigger; null если не найден.
  const triggerStmt = db.prepare<[string], RecordRow>(
    `SELECT id, type, properties, parentId, createdAt FROM "Record"
     WHERE id = ? AND type = 'event.routine.trigger'`,
  );
  const trigger = triggerStmt.get(triggerId);
  if (trigger === undefined) return null;

  // Уровень 1: прямые дети trigger'а.
  const level1Stmt = db.prepare<[string], RecordRow>(
    `SELECT id, type, properties, parentId, createdAt FROM "Record"
     WHERE parentId = ?`,
  );
  const level1 = level1Stmt.all(triggerId);

  // Уровень 2: внуки (parentId IN level1.id).
  let level2: RecordRow[] = [];
  if (level1.length > 0) {
    const ids = level1.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const level2Stmt = db.prepare<string[], RecordRow>(
      `SELECT id, type, properties, parentId, createdAt FROM "Record"
       WHERE parentId IN (${placeholders})`,
    );
    level2 = level2Stmt.all(...ids);
  }

  // Собрать всё в один массив, сортировать по createdAt ASC.
  // Trigger — всегда первый, остальные — по createdAt. createdAt в SQLite
  // — миллисекунды (integer), сортировка стабильна.
  const all: RecordRow[] = [trigger, ...level1, ...level2];
  all.sort((a, b) => Number(a.createdAt) - Number(b.createdAt));

  return all.map((r) => ({
    ts: Number(r.createdAt),
    type: r.type,
    properties: safeParseJSON(r.properties),
  }));
}
