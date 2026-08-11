import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ulid } from 'ulid';
import { parse as parseYaml } from 'yaml';
import { type PrismaClient, getPrisma } from '../db/client.js';
import { emit } from '../observe/bridge.js';
import type { RunRoutineTrigger } from './triggers.js';

export type RoutineSignalEvent = 'routine.completed';

export interface RoutineSignalSubscription {
  enabled: boolean;
  event: RoutineSignalEvent;
  sourceRoutineId: string;
  targetRoutineId: string;
}

export interface HandleRoutineCompletedSignalArgs {
  db?: PrismaClient;
  sourceRoutineId: string;
  runDate: string;
  sourceEventTriggerId: string;
  rootEventTriggerId?: string;
  visitedRoutineIds?: string[];
  now?: () => number;
  loadSubscriptions?: () => Promise<RoutineSignalSubscription[]>;
  runRoutine: (routineId: string, runDate: string, trigger: RunRoutineTrigger) => Promise<void>;
}

export class RoutineSignalParseError extends Error {
  constructor(filePath: string, message: string) {
    super(`routine signals ${filePath}: ${message}`);
    this.name = 'RoutineSignalParseError';
  }
}

const DEFAULT_SIGNALS_PATH = 'routines/signals.yml';
const ROUTINE_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export async function loadRoutineSignalSubscriptions(
  filePath = resolve(process.cwd(), DEFAULT_SIGNALS_PATH),
): Promise<RoutineSignalSubscription[]> {
  try {
    const source = await readFile(filePath, 'utf8');
    return parseRoutineSignalSubscriptions(source, filePath);
  } catch (err) {
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : null;
    if (code === 'ENOENT') return [];
    throw err;
  }
}

export function parseRoutineSignalSubscriptions(
  source: string,
  filePath: string,
): RoutineSignalSubscription[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RoutineSignalParseError(filePath, `не парсится как YAML: ${reason}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RoutineSignalParseError(filePath, 'корневой объект должен быть YAML mapping.');
  }

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.subscriptions)) {
    throw new RoutineSignalParseError(filePath, "поле 'subscriptions' должно быть массивом.");
  }

  return obj.subscriptions.map((raw, idx) => parseSubscription(raw, idx, filePath));
}

export async function handleRoutineCompletedSignal(
  args: HandleRoutineCompletedSignalArgs,
): Promise<void> {
  const db = args.db ?? getPrisma();
  const now = args.now ?? Date.now;
  const rootEventTriggerId = args.rootEventTriggerId ?? args.sourceEventTriggerId;
  const visited = args.visitedRoutineIds ?? [args.sourceRoutineId];
  const visitedSet = new Set(visited);
  const loadSubscriptions = args.loadSubscriptions ?? (() => loadRoutineSignalSubscriptions());
  const subscriptions = await loadSubscriptions();
  const matches = subscriptions.filter(
    (s) =>
      s.enabled &&
      s.event === 'routine.completed' &&
      s.sourceRoutineId === args.sourceRoutineId &&
      !visitedSet.has(s.targetRoutineId),
  );

  for (const sub of matches) {
    const idempotencyKey = `routine-signal:${rootEventTriggerId}:${args.sourceRoutineId}:${sub.targetRoutineId}`;
    const inserted = await insertRoutineSignal(db, {
      idempotencyKey,
      rootEventTriggerId,
      sourceEventTriggerId: args.sourceEventTriggerId,
      sourceRoutineId: args.sourceRoutineId,
      targetRoutineId: sub.targetRoutineId,
      visitedRoutineIds: visited,
      runDate: args.runDate,
      nowMs: now(),
    });
    if (!inserted) continue;

    await emit({
      type: 'routine.signal',
      sourceRoutineId: args.sourceRoutineId,
      targetRoutineId: sub.targetRoutineId,
      runDate: args.runDate,
      idempotencyKey,
    });

    await args.runRoutine(sub.targetRoutineId, args.runDate, {
      source: 'signal',
      idempotencyKey: `routine:${sub.targetRoutineId}:signal:${rootEventTriggerId}:${args.sourceRoutineId}`,
      signal: {
        rootEventTriggerId,
        visitedRoutineIds: [...visited, sub.targetRoutineId],
      },
    });
  }
}

interface InsertRoutineSignalArgs {
  idempotencyKey: string;
  rootEventTriggerId: string;
  sourceEventTriggerId: string;
  sourceRoutineId: string;
  targetRoutineId: string;
  visitedRoutineIds: string[];
  runDate: string;
  nowMs: number;
}

async function insertRoutineSignal(
  db: PrismaClient,
  args: InsertRoutineSignalArgs,
): Promise<boolean> {
  const id = ulid();
  const properties = JSON.stringify({
    event: 'routine.completed',
    sourceRoutineId: args.sourceRoutineId,
    targetRoutineId: args.targetRoutineId,
    runDate: args.runDate,
    rootEventTriggerId: args.rootEventTriggerId,
    sourceEventTriggerId: args.sourceEventTriggerId,
    visitedRoutineIds: args.visitedRoutineIds,
    idempotencyKey: args.idempotencyKey,
  });

  const inserted = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "Record" (id, type, properties, parentId, actorKind, visibility, idempotencyKey, status, createdAt)
     VALUES (?, 'event.routine.signal', ?, ?, 'system', 'autonomous', ?, 'active', ?)
     ON CONFLICT(idempotencyKey) DO NOTHING
     RETURNING id`,
    id,
    properties,
    args.sourceEventTriggerId,
    args.idempotencyKey,
    args.nowMs,
  );

  return inserted.length === 1;
}

function parseSubscription(raw: unknown, idx: number, filePath: string): RoutineSignalSubscription {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RoutineSignalParseError(filePath, `subscriptions[${idx}] должен быть mapping.`);
  }

  const obj = raw as Record<string, unknown>;
  const event = asString(obj.on, filePath, `subscriptions[${idx}].on`);
  if (event !== 'routine.completed') {
    throw new RoutineSignalParseError(
      filePath,
      `subscriptions[${idx}].on '${event}' не поддерживается. Сейчас доступно: routine.completed.`,
    );
  }

  const sourceRoutineId = asRoutineId(obj.source, filePath, `subscriptions[${idx}].source`);
  const targetRoutineId = asRoutineId(obj.run, filePath, `subscriptions[${idx}].run`);
  const enabled = obj.enabled === undefined ? true : asBoolean(obj.enabled, filePath, idx);

  return {
    enabled,
    event,
    sourceRoutineId,
    targetRoutineId,
  };
}

function asString(raw: unknown, filePath: string, field: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new RoutineSignalParseError(
      filePath,
      `${field}: ожидалась непустая строка, получено '${String(raw)}'.`,
    );
  }
  return raw.trim();
}

function asRoutineId(raw: unknown, filePath: string, field: string): string {
  const value = asString(raw, filePath, field);
  if (!ROUTINE_ID_RE.test(value)) {
    throw new RoutineSignalParseError(filePath, `${field}: '${value}' должен быть kebab-case.`);
  }
  return value;
}

function asBoolean(raw: unknown, filePath: string, idx: number): boolean {
  if (typeof raw !== 'boolean') {
    throw new RoutineSignalParseError(
      filePath,
      `subscriptions[${idx}].enabled должен быть boolean.`,
    );
  }
  return raw;
}
