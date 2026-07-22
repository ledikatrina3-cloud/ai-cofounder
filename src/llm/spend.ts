import { ulid } from 'ulid';
import type { PrismaClient } from '../db/client.js';
import { getPrisma } from '../db/client.js';

export interface SpendUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface SpendRecordInput {
  promptId: string;
  model: string;
  modelRequested: string;
  usage: SpendUsage;
  usd: number;
  pricingAsOf: number;
  cycleParentId?: string | null;
  routineId?: string | null;
  // Транспорт, через который шёл вызов: 'oauth' (gateway/claude CLI,
  // биллинг по подписке, usd=0) или 'apikey' (per-token биллинг). Опционально:
  // legacy-записи без транспорта продолжают валидно парситься. См. src/llm/transport.ts.
  transport?: 'oauth' | 'apikey' | 'codex';
}

export interface CurrentSpend {
  perCycle: { inputTokens: number };
  daily: { usd: number };
  monthly: { usd: number };
}

export type LimitKind = 'per-cycle' | 'daily' | 'monthly';

export interface BudgetDenyInput {
  limitKind: LimitKind;
  current: number;
  cap: number;
  promptId: string;
  model: string;
  cycleParentId?: string | null;
}

interface SpendProperties {
  promptId: string;
  model: string;
  modelRequested: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  usd: number;
  pricingAsOf: number;
  routineId?: string;
  // Метка транспорта для retrospective-аналитики. См. src/llm/transport.ts.
  transport?: 'oauth' | 'apikey' | 'codex';
}

export async function recordSpend(
  input: SpendRecordInput,
  db: PrismaClient = getPrisma(),
): Promise<string> {
  const id = ulid();
  const properties: SpendProperties = {
    promptId: input.promptId,
    model: input.model,
    modelRequested: input.modelRequested,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cacheReadTokens: input.usage.cacheReadTokens,
    cacheCreationTokens: input.usage.cacheCreationTokens,
    usd: input.usd,
    pricingAsOf: input.pricingAsOf,
    ...(typeof input.routineId === 'string' ? { routineId: input.routineId } : {}),
    ...(input.transport !== undefined ? { transport: input.transport } : {}),
  };
  const now = Date.now();
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, parentId, actorKind, visibility, status, closedAt, createdAt) VALUES (?, 'audit.spend', ?, ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    JSON.stringify(properties),
    input.cycleParentId ?? null,
    now,
    now,
  );
  return id;
}

export async function recordBudgetDeny(
  input: BudgetDenyInput,
  db: PrismaClient = getPrisma(),
): Promise<string> {
  const id = ulid();
  const properties = {
    limit: input.limitKind,
    current: input.current,
    cap: input.cap,
    promptId: input.promptId,
    model: input.model,
  };
  const now = Date.now();
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, parentId, actorKind, visibility, status, closedAt, createdAt) VALUES (?, 'audit.budget.deny', ?, ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    JSON.stringify(properties),
    input.cycleParentId ?? null,
    now,
    now,
  );
  return id;
}

export async function computeCurrentSpend(
  db: PrismaClient = getPrisma(),
  now: Date = new Date(),
): Promise<CurrentSpend> {
  const cycleStart = await getCycleStart(db);
  const dayStart = startOfUtcDay(now);
  const monthStart = startOfUtcMonth(now);

  const cycleRows = await db.$queryRawUnsafe<{ properties: string }[]>(
    `SELECT properties FROM "Record" WHERE type = 'audit.spend' AND createdAt >= ?`,
    cycleStart,
  );
  const dayRows = await db.$queryRawUnsafe<{ properties: string }[]>(
    `SELECT properties FROM "Record" WHERE type = 'audit.spend' AND createdAt >= ?`,
    dayStart,
  );
  const monthRows = await db.$queryRawUnsafe<{ properties: string }[]>(
    `SELECT properties FROM "Record" WHERE type = 'audit.spend' AND createdAt >= ?`,
    monthStart,
  );

  return {
    perCycle: { inputTokens: sumField(cycleRows, 'inputTokens') },
    daily: { usd: sumField(dayRows, 'usd') },
    monthly: { usd: sumField(monthRows, 'usd') },
  };
}

async function getCycleStart(db: PrismaClient): Promise<number> {
  // Цикл = период с момента последнего `event.trigger` (см. plans/, фаза 1.4).
  // До появления event.trigger (фаза 1.4 ещё не сделана) per-cycle = весь spend за всю историю.
  const rows = await db.$queryRawUnsafe<{ createdAt: number }[]>(
    `SELECT createdAt FROM "Record" WHERE type = 'event.trigger' ORDER BY createdAt DESC LIMIT 1`,
  );
  const top = rows[0];
  return top ? Number(top.createdAt) : 0;
}

function sumField(rows: { properties: string }[], field: 'inputTokens' | 'usd'): number {
  let total = 0;
  for (const row of rows) {
    try {
      const props = JSON.parse(row.properties) as Record<string, unknown>;
      const value = props[field];
      if (typeof value === 'number' && Number.isFinite(value)) {
        total += value;
      }
    } catch {
      // Битый JSON в audit.spend — это сама по себе проблема, но не повод убить call().
      // Smoke-валидатор/тесты ловят шейп; здесь не маскируем, но и не ронялем cost-meter.
    }
  }
  return total;
}

function startOfUtcDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function startOfUtcMonth(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}
