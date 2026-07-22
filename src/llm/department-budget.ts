// Department-level budget — pre-call guard для routines с departmentId.
//
// Контракт:
//   * `checkDepartmentBudget(routine, deps?)` — суммирует audit.spend за
//     сегодня (UTC) для всех routines с тем же departmentId, сравнивает с
//     department.budget.perDayUsd. Превышение → throw'аем DepartmentBudgetError
//     и пишем audit.budget.deny с reason: 'department-cap'.
//   * `checkDepartmentRunBudget(routine, cycleParentId, deps?)` — то же, но
//     суммируем spend ТОЛЬКО за текущий routine run (по cycleParentId =
//     audit.routine.start.id или event.routine.trigger.id) против
//     department.budget.perRunUsd.
//
// Используется dispatcher.ts перед executeRoutine — но пока в качестве
// independent helper'а, который вызывается тестами / executor'ом pipeline'а
// при необходимости. Главное — не вставлять hot-path в каждый call() (это
// был бы global LLM gate).

import { ulid } from 'ulid';
import { type PrismaClient, getPrisma } from '../db/client.js';
import { getDepartment } from '../departments/registry.js';
import type { Department } from '../departments/types.js';
import { emit } from '../observe/bridge.js';
import type { Routine } from '../routines/parser.js';

export class DepartmentBudgetError extends Error {
  constructor(
    message: string,
    public readonly limit: 'perDayUsd' | 'perRunUsd',
    public readonly cap: number,
    public readonly current: number,
  ) {
    super(message);
    this.name = 'DepartmentBudgetError';
  }
}

export interface BudgetCheckOptions {
  db?: PrismaClient;
  getDepartmentFn?: (id: string) => Promise<Department | null>;
  now?: () => Date;
  /** DI для тестов: alert Telegram (best-effort). */
  alert?: (text: string) => Promise<void>;
}

/**
 * Возвращает sum(usd) аудит-spend'ов всех routines, у которых
 * properties.routineId входит в `routineIds`, за период >= `sinceMs`.
 *
 * Запрос:
 *   SELECT SUM(json_extract(properties, '$.usd')) as usd
 *   FROM Record
 *   WHERE type='audit.spend'
 *     AND createdAt >= ?
 *     AND json_extract(properties, '$.routineId') IN (?, ?, ...)
 */
export async function sumRoutineSpend(
  db: PrismaClient,
  routineIds: string[],
  sinceMs: number,
): Promise<number> {
  if (routineIds.length === 0) return 0;
  const placeholders = routineIds.map(() => '?').join(', ');
  const rows = await db.$queryRawUnsafe<{ usd: number | null }[]>(
    `SELECT SUM(json_extract(properties, '$.usd')) as usd
       FROM "Record"
      WHERE type = 'audit.spend'
        AND createdAt >= ?
        AND json_extract(properties, '$.routineId') IN (${placeholders})`,
    sinceMs,
    ...routineIds,
  );
  const top = rows[0];
  return top !== undefined && top.usd !== null ? Number(top.usd) : 0;
}

/**
 * Возвращает spend (USD) для всех аудит.spend Records, чей parentId
 * (или его ancestor — здесь ограничиваемся прямым parentId) равен `cycleParentId`.
 * Используется для per-run budget.
 */
export async function sumSpendByParent(db: PrismaClient, cycleParentId: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ usd: number | null }[]>(
    `SELECT SUM(json_extract(properties, '$.usd')) as usd
       FROM "Record"
      WHERE type = 'audit.spend' AND parentId = ?`,
    cycleParentId,
  );
  const top = rows[0];
  return top !== undefined && top.usd !== null ? Number(top.usd) : 0;
}

/**
 * Возвращает все routine-id'ы того же department (через listRoutines —
 * фильтр по routine.departmentId).
 *
 * DI через listRoutinesFn (для тестов).
 */
export async function findDepartmentRoutineIds(
  departmentId: string,
  listRoutinesFn: () => Promise<Routine[]>,
): Promise<string[]> {
  const all = await listRoutinesFn();
  return all.filter((r) => r.departmentId === departmentId).map((r) => r.id);
}

interface DenyArgs {
  db: PrismaClient;
  routineId: string;
  departmentId: string;
  limit: 'perDayUsd' | 'perRunUsd';
  cap: number;
  current: number;
}

async function recordDeny(args: DenyArgs): Promise<string> {
  const id = ulid();
  const properties = JSON.stringify({
    limit: 'department-cap',
    sublimit: args.limit,
    departmentId: args.departmentId,
    routineId: args.routineId,
    cap: args.cap,
    current: args.current,
    reason: 'department-cap',
  });
  const now = Date.now();
  await args.db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, parentId, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.budget.deny', ?, NULL, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    properties,
    now,
    now,
  );
  void emit({
    type: 'audit.budget.deny',
    recordId: id,
    limit: 'daily',
    cap: args.cap,
    current: args.current,
  });
  return id;
}

export interface CheckBudgetResult {
  ok: boolean;
  reason?: string;
  cap?: number;
  current?: number;
}

/**
 * Проверяет per-day cap. Если cap превышен — пишет audit.budget.deny и
 * возвращает {ok: false}. Если нет departmentId или нет budget — {ok: true}.
 */
export async function checkDepartmentDailyBudget(
  routine: Routine,
  listRoutinesFn: () => Promise<Routine[]>,
  options: BudgetCheckOptions = {},
): Promise<CheckBudgetResult> {
  if (routine.departmentId === undefined) return { ok: true };
  const db = options.db ?? getPrisma();
  const getDept = options.getDepartmentFn ?? ((id) => getDepartment(id));
  const dept = await getDept(routine.departmentId);
  if (dept === null || dept.budget === undefined) return { ok: true };

  const now = (options.now ?? (() => new Date()))();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const routineIds = await findDepartmentRoutineIds(routine.departmentId, listRoutinesFn);
  const current = await sumRoutineSpend(db, routineIds, dayStart);

  if (current >= dept.budget.perDayUsd) {
    await recordDeny({
      db,
      routineId: routine.id,
      departmentId: routine.departmentId,
      limit: 'perDayUsd',
      cap: dept.budget.perDayUsd,
      current,
    });
    if (options.alert !== undefined) {
      try {
        await options.alert(
          `⚠️ Отдел \`${routine.departmentId}\` упёрся в дневной бюджет $${dept.budget.perDayUsd.toFixed(2)}. Pipeline пропускает дневной цикл.`,
        );
      } catch {
        /* best-effort */
      }
    }
    return {
      ok: false,
      reason: 'department-cap',
      cap: dept.budget.perDayUsd,
      current,
    };
  }
  return { ok: true };
}

/**
 * Проверяет per-run cap. cycleParentId — id Record'а, под который висят все
 * spend'ы текущего routine run'а (обычно audit.routine.start.id).
 */
export async function checkDepartmentRunBudget(
  routine: Routine,
  cycleParentId: string,
  options: BudgetCheckOptions = {},
): Promise<CheckBudgetResult> {
  if (routine.departmentId === undefined) return { ok: true };
  const db = options.db ?? getPrisma();
  const getDept = options.getDepartmentFn ?? ((id) => getDepartment(id));
  const dept = await getDept(routine.departmentId);
  if (dept === null || dept.budget === undefined) return { ok: true };

  const current = await sumSpendByParent(db, cycleParentId);
  if (current >= dept.budget.perRunUsd) {
    await recordDeny({
      db,
      routineId: routine.id,
      departmentId: routine.departmentId,
      limit: 'perRunUsd',
      cap: dept.budget.perRunUsd,
      current,
    });
    return {
      ok: false,
      reason: 'department-cap',
      cap: dept.budget.perRunUsd,
      current,
    };
  }
  return { ok: true };
}
