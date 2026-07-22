// Семантический мердж проблем триажа (фаза 2.2b).
//
// Вход:  TriageResult из 2.2a — проблемы без межсессионного дедупа.
// Выход: MergeResult — что создано (новый intent.problem) и что слито
//        (новые RecordLink к существующим intent.problem).
//
// Пайплайн на каждую TriageProblem:
//   1. embed(summary) → Float32Array(dim)
//   2. SELECT rowid, distance FROM vec_intent_problem
//        WHERE embedding MATCH ?  AND k = N
//        ORDER BY distance LIMIT N
//      (ANN-поиск sqlite-vec, отсортирован по возрастанию distance)
//   3. Для топ-кандидатов проверяем, что соответствующий intent.problem:
//        a. status='active' (не закрыт)
//        b. createdAt >= now() - windowDays * 86400_000
//      Берём первого подходящего с distance ≤ (1 - threshold).
//   4. Если найден — MERGE:
//        - INSERT RecordLink(linkType='породило') для каждого
//          supportMessageId, которого ещё нет в связях существующего
//          intent.problem. UNIQUE(from,to,toPagePath,linkType) делает
//          повторные сообщения noop'ом.
//      Если не найден — CREATE:
//        - INSERT Record(type='intent.problem', properties={summary, symptoms})
//        - INSERT Embedding(recordId, model, vector)
//        - INSERT vec_intent_problem(rowid, embedding) (mapped через
//          stable hash → BigInt rowid; см. ниже)
//        - INSERT RecordLink(linkType='породило') для каждого supportMessageId
//
// audit.triage.merge: одна запись на вызов, properties = {problemsIn, created,
// merged, embeddingProvider, model, threshold, windowDays, durationMs}.
//
// Маппинг Record.id (ULID, string) → vec rowid (INTEGER):
//   sqlite-vec rowid — INTEGER. Record.id — ULID-строка. Прямой конверсии нет.
//   Решение: maintain отдельную таблицу `IntentProblemVec(recordId TEXT PK,
//   rowid INTEGER UNIQUE autoincrement)`. Все CRUD'ы на vec идут через JOIN.
//   Это аккуратнее, чем хеш-функция со столкновениями.

import { ulid } from 'ulid';
import type { PrismaClient, VecDatabase } from '../db/client.js';
import { getPrisma, getVecClient } from '../db/client.js';
import { type EmbeddingsConfig, loadEmbeddingsConfig } from '../embeddings/config.js';
import { type EmbeddingsClient, createLocalEmbeddingsClient } from '../embeddings/local.js';
import { emit } from '../observe/bridge.js';
import type { TriageProblem, TriageResult } from './extract.js';

// ---------------------------------------------------------------------------
// Контракт MergeResult — критичен для 2.5 (отчёт) и 2.3a (исследователь
// читает intent.problem). Если меняешь — обнови ретро 2.2b.
// ---------------------------------------------------------------------------

/**
 * @deprecated since 2026-05-01 pivot — routine support-triage заменяет этот pipeline
 */
export interface CreatedProblemRef {
  // Новый intent.problem.id.
  problemId: string;
  summary: string;
  // Все event.support.message.id, привязанные через linkType='породило'.
  supportMessageIds: string[];
}

export interface MergedProblemRef {
  // Существующий intent.problem.id, к которому привязали новые сообщения.
  existingProblemId: string;
  // Только те supportMessageIds, для которых **создан новый** RecordLink.
  // Если все ссылки уже существовали (UNIQUE-conflict) — массив пустой,
  // но запись о merge всё равно появляется в результате.
  newSupportMessageIds: string[];
  // cosine distance до победителя; низкое = ближе. similarity = 1 - distance.
  distance: number;
}

export interface MergeResult {
  created: CreatedProblemRef[];
  merged: MergedProblemRef[];
  // ID Записи audit.triage.merge для последующих запросов.
  auditRecordId: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Внутренние таблицы: маппинг ULID ↔ vec rowid.
// Создаётся идемпотентно при первом вызове mergeProblems().
// ---------------------------------------------------------------------------

const ROWID_MAP_TABLE = 'IntentProblemVec';

function ensureRowidMapTable(vec: VecDatabase): void {
  vec.exec(
    `CREATE TABLE IF NOT EXISTS ${ROWID_MAP_TABLE} (
       recordId TEXT PRIMARY KEY,
       rowid INTEGER UNIQUE NOT NULL
     )`,
  );
}

// ---------------------------------------------------------------------------
// DI: подменяемые зависимости для тестов.
// ---------------------------------------------------------------------------

export interface MergeDeps {
  prisma?: PrismaClient;
  vec?: VecDatabase;
  embeddings?: EmbeddingsClient;
  configOverride?: EmbeddingsConfig;
  // Часы для окна windowDays. По умолчанию Date.now(). Тесты подменяют.
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Главная функция.
// ---------------------------------------------------------------------------

export async function mergeProblems(
  triage: TriageResult,
  deps: MergeDeps = {},
): Promise<MergeResult> {
  const prisma = deps.prisma ?? getPrisma();
  const vec = deps.vec ?? getVecClient();
  const config = deps.configOverride ?? (await loadEmbeddingsConfig());
  const embeddings = deps.embeddings ?? createLocalEmbeddingsClient({ config });
  const now = deps.now ?? Date.now;

  ensureRowidMapTable(vec);

  const startedAt = now();

  await emit({
    type: 'triage.merge.start',
    problemsIn: triage.problems.length,
    embeddingProvider: config.provider,
    threshold: config.mergeThreshold,
    windowDays: config.mergeWindowDays,
  });

  const created: CreatedProblemRef[] = [];
  const merged: MergedProblemRef[] = [];

  // distance threshold: similarity ≥ T  ≡  distance ≤ 1 - T.
  const distanceCutoff = 1 - config.mergeThreshold;
  const windowMs = config.mergeWindowDays * 86_400_000;
  const windowStart = now() - windowMs;

  for (const problem of triage.problems) {
    const vector = await embeddings.embedText(problem.summary);
    const match = await findClosestActive({
      vec,
      prisma,
      config,
      vector,
      windowStart,
      distanceCutoff,
    });

    if (match !== null) {
      const newLinks = await linkSupportMessages(
        prisma,
        match.problemId,
        problem.supportMessageIds,
      );
      merged.push({
        existingProblemId: match.problemId,
        newSupportMessageIds: newLinks,
        distance: match.distance,
      });
    } else {
      const newProblemId = await createIntentProblem({
        prisma,
        vec,
        config,
        problem,
        vector,
        nowMs: now(),
      });
      created.push({
        problemId: newProblemId,
        summary: problem.summary,
        supportMessageIds: problem.supportMessageIds,
      });
    }
  }

  const durationMs = now() - startedAt;
  const auditRecordId = await recordMergeAudit(prisma, {
    problemsIn: triage.problems.length,
    created: created.length,
    merged: merged.length,
    embeddingProvider: config.provider,
    model: config.model,
    threshold: config.mergeThreshold,
    windowDays: config.mergeWindowDays,
    durationMs,
    spendRecordId: triage.spendRecordId,
  });

  await emit({
    type: 'triage.merge.end',
    recordId: auditRecordId,
    problemsIn: triage.problems.length,
    created: created.length,
    merged: merged.length,
    durationMs,
  });

  return { created, merged, auditRecordId, durationMs };
}

// ---------------------------------------------------------------------------
// Поиск ближайшего открытого intent.problem за окно windowDays.
// ---------------------------------------------------------------------------

interface FindClosestArgs {
  vec: VecDatabase;
  prisma: PrismaClient;
  config: EmbeddingsConfig;
  vector: Float32Array;
  windowStart: number;
  distanceCutoff: number;
}

interface ClosestMatch {
  problemId: string;
  distance: number;
}

async function findClosestActive(args: FindClosestArgs): Promise<ClosestMatch | null> {
  const { vec, prisma, config, vector, windowStart, distanceCutoff } = args;

  // sqlite-vec syntax: WHERE embedding MATCH ?  AND k = N — KNN-лимит.
  // ORDER BY distance ASC — distance уже cosine из virtual table.
  const candidateLimit = 5;
  const rows = vec
    .prepare(
      `SELECT rowid, distance FROM ${config.vecTable}
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance`,
    )
    .all(Buffer.from(vector.buffer), candidateLimit) as Array<{
    rowid: number | bigint;
    distance: number;
  }>;

  if (rows.length === 0) return null;

  // Фильтруем по distance cutoff заранее — нечего ходить в Prisma за теми,
  // кто всё равно слишком далеко.
  const close = rows.filter((r) => r.distance <= distanceCutoff);
  if (close.length === 0) return null;

  const rowidsBig = close.map((r) => BigInt(r.rowid));
  const placeholders = rowidsBig.map(() => '?').join(',');
  const mappingRows = vec
    .prepare(`SELECT recordId, rowid FROM ${ROWID_MAP_TABLE} WHERE rowid IN (${placeholders})`)
    .all(...rowidsBig) as Array<{ recordId: string; rowid: number | bigint }>;

  // Сохраняем порядок distance: для каждого rowid берём mapping и Record.
  const rowidToRecordId = new Map<string, string>();
  for (const m of mappingRows) {
    rowidToRecordId.set(String(m.rowid), m.recordId);
  }

  // Тянем кандидатов из Record одной выборкой и фильтруем по статусу/окну.
  const recordIds = mappingRows.map((m) => m.recordId);
  if (recordIds.length === 0) return null;

  const recordRows = await prisma.$queryRawUnsafe<
    Array<{ id: string; status: string; createdAt: number }>
  >(
    `SELECT id, status, createdAt FROM "Record" WHERE id IN (${recordIds
      .map(() => '?')
      .join(',')}) AND type = 'intent.problem'`,
    ...recordIds,
  );

  const eligible = new Map<string, { status: string; createdAt: number }>();
  for (const r of recordRows) {
    if (r.status === 'active' && Number(r.createdAt) >= windowStart) {
      eligible.set(r.id, { status: r.status, createdAt: Number(r.createdAt) });
    }
  }

  // Идём по close в порядке distance ASC — первый, у кого запись eligible,
  // и есть наш победитель.
  for (const candidate of close) {
    const recordId = rowidToRecordId.get(String(candidate.rowid));
    if (recordId === undefined) continue;
    if (!eligible.has(recordId)) continue;
    return { problemId: recordId, distance: candidate.distance };
  }
  return null;
}

// ---------------------------------------------------------------------------
// CREATE: новый intent.problem + embedding + vec rowid + RecordLink'и.
// ---------------------------------------------------------------------------

interface CreateProblemArgs {
  prisma: PrismaClient;
  vec: VecDatabase;
  config: EmbeddingsConfig;
  problem: TriageProblem;
  vector: Float32Array;
  nowMs: number;
}

async function createIntentProblem(args: CreateProblemArgs): Promise<string> {
  const { prisma, vec, config, problem, vector, nowMs } = args;
  const problemId = ulid();

  const properties = JSON.stringify({
    summary: problem.summary,
    symptoms: problem.symptoms,
  });

  // 1) Record (intent.problem). status='active' по дефолту схемы.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt)
     VALUES (?, 'intent.problem', ?, 'agent', 'autonomous', 'active', ?)`,
    problemId,
    properties,
    nowMs,
  );

  // 2) Embedding 1:1 с Record. Vector в формате float32-LE Buffer (как в vec).
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Embedding" (recordId, model, vector, createdAt) VALUES (?, ?, ?, ?)`,
    problemId,
    config.model,
    Buffer.from(vector.buffer),
    nowMs,
  );

  // 3) Маппинг ULID → INTEGER rowid + INSERT в virtual table. Делается в
  //    транзакции better-sqlite3, чтобы автоинкремент и vec-INSERT были атомарны.
  const tx = vec.transaction((recordId: string, vectorBuf: Buffer): bigint => {
    const insertMap = vec.prepare(
      `INSERT INTO ${ROWID_MAP_TABLE} (recordId, rowid) VALUES (?, (SELECT COALESCE(MAX(rowid), 0) + 1 FROM ${ROWID_MAP_TABLE}))`,
    );
    insertMap.run(recordId);
    const row = vec
      .prepare(`SELECT rowid FROM ${ROWID_MAP_TABLE} WHERE recordId = ?`)
      .get(recordId) as { rowid: number | bigint };
    const rowid = BigInt(row.rowid);
    vec
      .prepare(`INSERT INTO ${config.vecTable}(rowid, embedding) VALUES (?, ?)`)
      .run(rowid, vectorBuf);
    return rowid;
  });
  tx(problemId, Buffer.from(vector.buffer));

  // 4) RecordLink: каждое event.support.message.id → новый intent.problem.id.
  await linkSupportMessages(prisma, problemId, problem.supportMessageIds);

  return problemId;
}

// ---------------------------------------------------------------------------
// MERGE: добавить RecordLink linkType='породило' для новых supportMessageIds.
// Возвращает массив id'шников, для которых ссылка реально создана (не было
// ранее). Дубликаты ловятся UNIQUE(from,to,toPagePath,linkType).
// ---------------------------------------------------------------------------

async function linkSupportMessages(
  prisma: PrismaClient,
  problemId: string,
  supportMessageIds: string[],
): Promise<string[]> {
  // Два нюанса SQLite, которые здесь критичны:
  //   1. RecordLink.id — BIGINT NOT NULL PRIMARY KEY. В SQLite только INTEGER PK
  //      становится алиасом ROWID и авто-инкрементится; BIGINT PK — нет. Поэтому
  //      и raw INSERT, и Prisma `recordLink.create({...})` падают на NOT NULL
  //      без явного id. Генерим id через `(SELECT COALESCE(MAX(id), 0) + 1)`
  //      внутри INSERT — атомарно, без race-окна (single-process MVP,
  //      design-решение в коде).
  //   2. UNIQUE (fromRecordId, toRecordId, toPagePath, linkType) c NULL в
  //      toPagePath не ловит дубликаты — SQLite (как и SQL standard) считает
  //      NULL != NULL. Поэтому повторный INSERT не упадёт сам, и идемпотентность
  //      пришлось бы реализовывать через триггер. Дешевле — pre-check SELECT.
  if (supportMessageIds.length === 0) return [];
  const unique = Array.from(new Set(supportMessageIds));

  const placeholders = unique.map(() => '?').join(',');
  const existing = await prisma.$queryRawUnsafe<Array<{ fromRecordId: string }>>(
    `SELECT fromRecordId FROM "RecordLink"
      WHERE toRecordId = ? AND toPagePath IS NULL AND linkType = 'породило'
        AND fromRecordId IN (${placeholders})`,
    problemId,
    ...unique,
  );
  const known = new Set(existing.map((r) => r.fromRecordId));

  const created: string[] = [];
  for (const supportId of unique) {
    if (known.has(supportId)) continue;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "RecordLink" (id, fromRecordId, toRecordId, toPagePath, linkType, createdAt)
       VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM "RecordLink"), ?, ?, NULL, 'породило', ?)`,
      supportId,
      problemId,
      Date.now(),
    );
    created.push(supportId);
  }
  return created;
}

// ---------------------------------------------------------------------------
// audit.triage.merge — одна запись на вызов mergeProblems().
// ---------------------------------------------------------------------------

interface MergeAuditInput {
  problemsIn: number;
  created: number;
  merged: number;
  embeddingProvider: string;
  model: string;
  threshold: number;
  windowDays: number;
  durationMs: number;
  spendRecordId: string;
}

async function recordMergeAudit(prisma: PrismaClient, input: MergeAuditInput): Promise<string> {
  const id = ulid();
  const nowMs = Date.now();
  const properties = JSON.stringify({
    problemsIn: input.problemsIn,
    created: input.created,
    merged: input.merged,
    embeddingProvider: input.embeddingProvider,
    model: input.model,
    threshold: input.threshold,
    windowDays: input.windowDays,
    durationMs: input.durationMs,
  });
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, parentId, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.triage.merge', ?, ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    properties,
    input.spendRecordId,
    nowMs,
    nowMs,
  );
  return id;
}
