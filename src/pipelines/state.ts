// Pipeline state persistence — UPSERT'ы и чтение `pipeline.state` Records.
//
// Pipeline на 7 нод длится часы; мак может уснуть/перезагрузиться. Мы храним
// текущее состояние в SQLite (Record type `pipeline.state`) — runId уникален
// (UPSERT по properties.runId через явный SELECT+UPDATE/INSERT, без UNIQUE
// индекса; runId генерируется один на запуск, конкурентных upsert'ов нет).
//
// Почему НЕ UNIQUE idempotencyKey: idempotencyKey зарезервирован под триггеры
// (event.routine.trigger), и Record_idempotencyKey_key — глобальный. Для
// pipeline state у нас одна запись на runId, мы обновляем `properties` и
// `closedAt/status` через REPLACE-семантику: UPDATE если есть, INSERT иначе.
//
// `status` Record'а:
//   - 'active'  — pipeline ещё работает (есть currentNode).
//   - 'closed'  — pipeline завершён (success / failed / skipped).
//
// Append-only invariant Record'а позволяет менять status + closedAt + properties?
// — НЕТ. properties в `record_immutable_fields` (см. db/invariants-check.ts).
// Поэтому для state-persistence ИСПОЛЬЗУЕМ обходной маршрут:
//   * Каждое обновление state = НОВАЯ запись `pipeline.state` (append-only).
//   * loadPipelineState читает САМУЮ СВЕЖУЮ запись по properties.runId.
//   * findRunningStates — последняя по runId, у которой currentNode !== null.
//
// Это «event sourcing» поверх Record-а: история всех state-переходов остаётся
// в журнале, последняя запись = текущее состояние.

import { ulid } from 'ulid';
import { type PrismaClient, getPrisma } from '../db/client.js';

export type NodeStatus = 'ok' | 'failed' | 'running' | 'waiting-for-approval' | 'skipped';

export interface PipelineState {
  pipelineId: string; // department.id
  runId: string;
  /** Текущая активная нода, null если pipeline завершён. */
  currentNode: string | null;
  nodeStatuses: Record<string, NodeStatus>;
  /** Артефакты: nodeId → абсолютный путь к файлу. */
  artifacts: Record<string, string>;
  startedAt: number;
  /** nodeId если ждём approve, null иначе. */
  waitingForApproval: string | null;
  /** Финальный статус когда currentNode=null. */
  finalStatus?: 'success' | 'failed' | 'skipped';
  /** runDate в формате 'YYYY-MM-DD' (для template ${date} в output путях). */
  runDate?: string;
}

export interface SavePipelineStateOptions {
  db?: PrismaClient;
  now?: () => number;
}

/**
 * Сохраняет новую запись `pipeline.state`. Каждый вызов — новая Record (append-only).
 * loadPipelineState возьмёт самую свежую по runId.
 */
export async function savePipelineState(
  state: PipelineState,
  options: SavePipelineStateOptions = {},
): Promise<string> {
  const db = options.db ?? getPrisma();
  const now = (options.now ?? Date.now)();
  const id = ulid();
  const properties = JSON.stringify(state);
  const status = state.currentNode === null ? 'closed' : 'active';
  const closedAt = status === 'closed' ? now : null;
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'pipeline.state', ?, 'agent', 'autonomous', ?, ?, ?)`,
    id,
    properties,
    status,
    closedAt,
    now,
  );
  return id;
}

/**
 * Загружает САМУЮ СВЕЖУЮ запись pipeline.state по runId. null если не существует.
 *
 * Реализация: SELECT properties FROM Record WHERE type='pipeline.state'
 * AND json_extract(properties, '$.runId') = ? ORDER BY createdAt DESC LIMIT 1.
 *
 * SQLite поддерживает json_extract (нужен JSON1 extension — есть в стандарте
 * SQLite с 2016 года, в better-sqlite3 включён).
 */
export async function loadPipelineState(
  runId: string,
  db: PrismaClient = getPrisma(),
): Promise<PipelineState | null> {
  const rows = await db.$queryRawUnsafe<{ properties: string }[]>(
    `SELECT properties FROM "Record"
      WHERE type = 'pipeline.state'
        AND json_extract(properties, '$.runId') = ?
      ORDER BY createdAt DESC
      LIMIT 1`,
    runId,
  );
  const top = rows[0];
  if (top === undefined) return null;
  try {
    return JSON.parse(top.properties) as PipelineState;
  } catch {
    return null;
  }
}

/**
 * Возвращает все pipeline.state с currentNode !== null (т.е. незавершённые).
 *
 * Стратегия:
 *   1. Достаём ВСЕ runId, которые встречаются в pipeline.state-Records.
 *   2. Для каждого runId берём САМУЮ СВЕЖУЮ запись.
 *   3. Возвращаем те, у которых currentNode !== null.
 *
 * Используется recoverPipelines() при старте app для re-execute / re-prompt
 * waiting-for-approval.
 */
export async function findRunningStates(db: PrismaClient = getPrisma()): Promise<PipelineState[]> {
  const rows = await db.$queryRawUnsafe<{ runId: string; properties: string }[]>(
    `SELECT json_extract(properties, '$.runId') as runId,
            properties
       FROM "Record"
      WHERE type = 'pipeline.state'
        AND createdAt = (
          SELECT MAX(createdAt) FROM "Record" r2
           WHERE r2.type = 'pipeline.state'
             AND json_extract(r2.properties, '$.runId') = json_extract("Record".properties, '$.runId')
        )`,
  );
  const out: PipelineState[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.runId)) continue;
    seen.add(row.runId);
    try {
      const state = JSON.parse(row.properties) as PipelineState;
      if (state.currentNode !== null) out.push(state);
    } catch {
      // битый JSON — пропускаем
    }
  }
  return out;
}

/**
 * Снимает флаг waitingForApproval (сохраняет state c waitingForApproval=null).
 * Вызывается из human-gate callback handler после ✅/❌/✏️.
 */
export async function clearWaitingApproval(
  runId: string,
  options: SavePipelineStateOptions = {},
): Promise<void> {
  const db = options.db ?? getPrisma();
  const existing = await loadPipelineState(runId, db);
  if (existing === null) return;
  if (existing.waitingForApproval === null) return;
  await savePipelineState({ ...existing, waitingForApproval: null }, options);
}
