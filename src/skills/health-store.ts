// Skill health-check persistence (Фаза 7 плана 2026-05-21-skills-architecture-v3).
//
// Контракт:
//   * `saveHealthCheck(result)` — INSERT в `Record` с type='skill.health.check'.
//     properties: {skillName, status, durationMs, output?, error?, timestamp,
//     reason?}. Используем тот же raw-SQL приём, что в `src/llm/spend.ts`
//     (Prisma sqlite-провайдер не валидирует `type` против enum, поэтому
//     новый тип добавляется без миграции).
//   * `getLatestHealth(skillName)` — последний health-check для одного скилла.
//     Возвращает null если ни одного запуска ещё не было.
//   * `getAllLatestHealth()` — последние health-check'и по всем скиллам
//     (один на скилл, самый свежий). Используется bridge endpoint GET /skills/health.

import { ulid } from 'ulid';
import type { PrismaClient } from '../db/client.js';
import { getPrisma } from '../db/client.js';
import type { HealthCheckResult, HealthCheckStatus } from './health.js';

// ---------------------------------------------------------------------------
// Тип Record-свойств для skill.health.check.
// ---------------------------------------------------------------------------

interface HealthCheckProperties {
  skillName: string;
  status: HealthCheckStatus;
  durationMs: number;
  timestamp: number;
  output?: Record<string, unknown>;
  error?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// saveHealthCheck.
// ---------------------------------------------------------------------------

export async function saveHealthCheck(
  result: HealthCheckResult,
  db: PrismaClient = getPrisma(),
): Promise<string> {
  const id = ulid();
  const properties: HealthCheckProperties = {
    skillName: result.skillName,
    status: result.status,
    durationMs: result.durationMs,
    timestamp: result.timestamp,
  };
  if (result.output !== undefined) properties.output = result.output;
  if (result.error !== undefined) properties.error = result.error;
  if (result.reason !== undefined) properties.reason = result.reason;

  const now = Date.now();
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, parentId, actorKind, visibility, status, closedAt, createdAt) VALUES (?, 'skill.health.check', ?, NULL, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    JSON.stringify(properties),
    now,
    now,
  );
  return id;
}

// ---------------------------------------------------------------------------
// Запросы.
// ---------------------------------------------------------------------------

export interface LatestHealthEntry {
  skillName: string;
  status: HealthCheckStatus;
  durationMs: number;
  /** Unix ms timestamp последнего health-check. */
  lastCheckAt: number;
  output?: Record<string, unknown>;
  error?: string;
  reason?: string;
}

function rowToEntry(properties: string, createdAt: number): LatestHealthEntry | null {
  try {
    const p = JSON.parse(properties) as Partial<HealthCheckProperties>;
    if (typeof p.skillName !== 'string') return null;
    if (p.status !== 'ok' && p.status !== 'failed' && p.status !== 'skipped') return null;
    const entry: LatestHealthEntry = {
      skillName: p.skillName,
      status: p.status,
      durationMs: typeof p.durationMs === 'number' ? p.durationMs : 0,
      lastCheckAt: typeof p.timestamp === 'number' ? p.timestamp : Number(createdAt),
    };
    if (p.output !== undefined && typeof p.output === 'object' && p.output !== null) {
      entry.output = p.output as Record<string, unknown>;
    }
    if (typeof p.error === 'string') entry.error = p.error;
    if (typeof p.reason === 'string') entry.reason = p.reason;
    return entry;
  } catch {
    return null;
  }
}

export async function getLatestHealth(
  skillName: string,
  db: PrismaClient = getPrisma(),
): Promise<LatestHealthEntry | null> {
  const rows = await db.$queryRawUnsafe<{ properties: string; createdAt: number }[]>(
    `SELECT properties, createdAt FROM "Record"
     WHERE type = 'skill.health.check'
       AND json_extract(properties, '$.skillName') = ?
     ORDER BY createdAt DESC
     LIMIT 1`,
    skillName,
  );
  const row = rows[0];
  if (row === undefined) return null;
  return rowToEntry(row.properties, Number(row.createdAt));
}

export async function getAllLatestHealth(
  db: PrismaClient = getPrisma(),
): Promise<LatestHealthEntry[]> {
  // Узкий SQL без оконных функций: подзапросом находим max(createdAt) на
  // skillName, потом JOIN с самим Record по точному совпадению.
  // SQLite поддерживает оконные функции с 3.25 (наш better-sqlite3 их умеет),
  // но raw $queryRawUnsafe с window function — лишний риск; вариант с
  // подзапросом-JOIN'ом понятнее и стабильнее.
  const rows = await db.$queryRawUnsafe<{ properties: string; createdAt: number }[]>(
    `SELECT r1.properties, r1.createdAt
     FROM "Record" r1
     JOIN (
       SELECT json_extract(properties, '$.skillName') AS sn, MAX(createdAt) AS maxAt
       FROM "Record"
       WHERE type = 'skill.health.check'
       GROUP BY sn
     ) latest ON
         json_extract(r1.properties, '$.skillName') = latest.sn
         AND r1.createdAt = latest.maxAt
     WHERE r1.type = 'skill.health.check'`,
  );
  const out: LatestHealthEntry[] = [];
  for (const row of rows) {
    const entry = rowToEntry(row.properties, Number(row.createdAt));
    if (entry !== null) out.push(entry);
  }
  return out;
}
