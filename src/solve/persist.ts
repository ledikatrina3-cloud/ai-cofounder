// Материализация результатов fan-out решателя в журнал (фаза 2.4b).
//
// Что делает persistSolveFanout:
//   1. На каждый FanoutSolve из fanout.results → INSERT Record `intent.proposal`
//      со properties = { asIs, problem, asWillBe, files, estimateMinutes,
//      totalUsd, totalTokens, durationMs, subagentId, spendRecordId,
//      parentSession } + RecordLink linkType='решает' к intent.diagnosis
//      (toRecordId).
//      Связь 'решает' автоматически снимает диагноз с очереди awaiting-proposal
//      по контракту 2.3c (стратегия (C): SELECT с NOT EXISTS inverse 'решает').
//   2. На каждый SolveFailure из fanout.failures → INSERT Record
//      `audit.solve.failed` со properties = { diagnosisId, errorClass,
//      message, parentSession } + RecordLink linkType='ошибка-решения'
//      к intent.diagnosis (toRecordId). Это НЕ intent.proposal — на failure
//      нет предложения; есть только отметка «попытка не удалась, причина X».
//      Тот же приём, что у audit.investigate.failed из 2.3c.
//   3. На каждый SolveDeferred — НИЧЕГО НЕ пишет. Records audit.budget.deferred
//      и audit.solve.softcap.skip уже созданы fanout-уровнем (solveMany).
//      Здесь только учёт в SolvePersistResult.
//   4. Эмитит BridgeEvent `proposal.persisted` с batchSize и failuresAudited.
//
// Что НЕ делает:
//   * НЕ интегрируется в runIteration — это 2.5.
//   * НЕ вызывает решатель — это solveMany.
//   * НЕ повторно пишет audit.budget.deferred / audit.solve.softcap.skip —
//     эти Records уже существуют (см. контракт solveMany).
//   * НЕ обновляет существующий intent.diagnosis (append-only). Снятие с
//     очереди — через новую связь 'решает', не через UPDATE.

import { ulid } from 'ulid';
import type { PrismaClient } from '../db/client.js';
import { getPrisma } from '../db/client.js';
import { emit } from '../observe/bridge.js';
import type { FanoutSolve, SolveFailure, SolveFanoutResult } from './fanout.js';

// ---------------------------------------------------------------------------
// Контракт SolvePersistResult — критичен для 2.5 (отчёт читает proposalsCreated)
// и для М3 (исполнитель в 3.3 принимает intent.proposal.id).
// ---------------------------------------------------------------------------

export interface SolvePersistResult {
  // ID intent.proposal Records, в порядке создания (по fanout.results[i]).
  proposalsCreated: string[];
  // ID audit.solve.failed Records, в порядке создания (по fanout.failures[i]).
  failuresAuditedAs: string[];
  // count из fanout.deferred. Повторно НЕ пишем audit (уже сделал solveMany).
  deferredAlreadyAudited: number;
}

export interface SolvePersistDeps {
  db?: PrismaClient;
  // Часы для createdAt. По умолчанию Date.now. Тесты подменяют для детерминизма.
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Главная функция.
// ---------------------------------------------------------------------------

export async function persistSolveFanout(
  fanout: SolveFanoutResult,
  deps: SolvePersistDeps = {},
): Promise<SolvePersistResult> {
  const db = deps.db ?? getPrisma();
  const now = deps.now ?? Date.now;

  const proposalsCreated: string[] = [];
  for (const result of fanout.results) {
    const proposalId = await insertProposal(db, result, fanout.parentSession, now());
    await insertRecordLink(db, {
      fromRecordId: proposalId,
      toRecordId: result.diagnosisId,
      linkType: 'решает',
      createdAt: now(),
    });
    proposalsCreated.push(proposalId);
  }

  const failuresAuditedAs: string[] = [];
  for (const failure of fanout.failures) {
    const failureRecordId = await insertFailureAudit(db, failure, fanout.parentSession, now());
    await insertRecordLink(db, {
      fromRecordId: failureRecordId,
      toRecordId: failure.diagnosisId,
      linkType: 'ошибка-решения',
      createdAt: now(),
    });
    failuresAuditedAs.push(failureRecordId);
  }

  await emit({
    type: 'proposal.persisted',
    parentSession: fanout.parentSession,
    batchSize: proposalsCreated.length,
    failuresAudited: failuresAuditedAs.length,
    deferredAlreadyAudited: fanout.deferred.length,
  });

  return {
    proposalsCreated,
    failuresAuditedAs,
    deferredAlreadyAudited: fanout.deferred.length,
  };
}

// ---------------------------------------------------------------------------
// INSERT intent.proposal. parentId=null намеренно: связь с intent.diagnosis
// делается через RecordLink linkType='решает' (по требованию плана 2.4b и
// контракту 2.3c — стратегия (C)).
//
// status='active', closedAt=null. По правилам нерушимым intent.proposal
// должен иметь ровно один терминальный переход через audit.{approval|rejection}
// (M3.1). До тех пор живёт в active.
// ---------------------------------------------------------------------------

async function insertProposal(
  db: PrismaClient,
  result: FanoutSolve,
  parentSession: string,
  nowMs: number,
): Promise<string> {
  const id = ulid();
  const properties = JSON.stringify({
    asIs: result.asIs,
    problem: result.problem,
    asWillBe: result.asWillBe,
    files: result.files,
    estimateMinutes: result.estimateMinutes,
    totalUsd: result.totalUsd,
    totalTokens: result.totalTokens,
    durationMs: result.durationMs,
    subagentId: result.subagentId,
    spendRecordId: result.spendRecordId,
    parentSession,
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt)
     VALUES (?, 'intent.proposal', ?, 'agent', 'autonomous', 'active', ?)`,
    id,
    properties,
    nowMs,
  );
  return id;
}

// ---------------------------------------------------------------------------
// INSERT audit.solve.failed. parentId=null, diagnosisId дублируется в
// properties для drill-down без JOIN (тот же паттерн, что у audit.budget.deferred
// и audit.investigate.failed). Связь через RecordLink linkType='ошибка-решения'
// — для графовых запросов «все ошибки решателя по конкретному диагнозу».
//
// Тип `audit.solve.failed` — новый, но миграции/whitelist не требует:
// триггеры из 1.1 проверяют колонки, не доменные типы; CHECK на visibility —
// prefix `LIKE 'audit.%'`. Тот же путь, по которому в 2.3b/2.3c добавили
// `audit.investigate.batch` / `audit.investigate.failed` / etc.
// ---------------------------------------------------------------------------

async function insertFailureAudit(
  db: PrismaClient,
  failure: SolveFailure,
  parentSession: string,
  nowMs: number,
): Promise<string> {
  const id = ulid();
  const properties = JSON.stringify({
    diagnosisId: failure.diagnosisId,
    errorClass: failure.errorClass,
    message: failure.message,
    parentSession,
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.solve.failed', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    properties,
    nowMs,
    nowMs,
  );
  return id;
}

// ---------------------------------------------------------------------------
// INSERT RecordLink. Те же два нюанса SQLite, что в src/investigate/persist.ts
// и src/triage/merge.ts:
//   1. RecordLink.id — BIGINT NOT NULL PRIMARY KEY. Атомарный auto-id через
//      `(SELECT COALESCE(MAX(id), 0) + 1)` (single-process MVP).
//   2. UNIQUE(fromRecordId, toRecordId, toPagePath, linkType) с NULL в
//      toPagePath не ловит дубликаты. Здесь это не проблема — каждый
//      persistSolveFanout пишет уникальные пары (новый proposalId/failureRecordId
//      → existing diagnosisId), повторов по контракту fan-out нет.
// ---------------------------------------------------------------------------

interface RecordLinkInput {
  fromRecordId: string;
  toRecordId: string;
  linkType: string;
  createdAt: number;
}

async function insertRecordLink(db: PrismaClient, input: RecordLinkInput): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "RecordLink" (id, fromRecordId, toRecordId, toPagePath, linkType, createdAt)
     VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM "RecordLink"), ?, ?, NULL, ?, ?)`,
    input.fromRecordId,
    input.toRecordId,
    input.linkType,
    input.createdAt,
  );
}
