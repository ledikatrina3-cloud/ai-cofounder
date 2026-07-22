// Материализация результатов fan-out исследователя в журнал (фаза 2.3c).
//
// Что делает persistFanoutResult:
//   1. На каждый InvestigationResult из fanout.results (включая verdict='unclear'
//      от тайм-аута) → INSERT Record `intent.diagnosis` со
//      properties = { verdict, rationale, codeRefs, gitHints, totalUsd,
//      totalTokens, durationMs, subagentId, timedOut, spendRecordId }
//      + RecordLink linkType='заключение' к intent.problem (toRecordId).
//   2. На каждый InvestigationFailure из fanout.failures → INSERT Record
//      `audit.investigate.failed` со properties = { problemId, errorClass,
//      message, parentSession } + RecordLink linkType='ошибка-расследования'
//      к intent.problem (toRecordId). Это НЕ intent.diagnosis — на failure
//      нет вердикта, нет рассуждения исследователя; есть только отметка
//      «попытка не удалась, причина X».
//   3. На каждый InvestigationDeferred — НИЧЕГО НЕ пишет. Записи
//      `audit.budget.deferred` и `audit.investigate.softcap.skip` уже
//      созданы fanout-уровнем (2.3b). Здесь только учёт в PersistResult.
//   4. Эмитит BridgeEvent `diagnosis.persisted` с batchSize и failuresAudited.
//
// Стратегия плейсхолдера для verdict='code' — (C):
//   НЕ создаём никакого плейсхолдера/маркера. 2.4a (решатель) сам находит
//   диагнозы, ждущие решения, через граф:
//     SELECT d.id FROM "Record" d
//      WHERE d.type = 'intent.diagnosis'
//        AND json_extract(d.properties, '$.verdict') = 'code'
//        AND d.status = 'active'
//        AND NOT EXISTS (
//          SELECT 1 FROM "RecordLink" rl
//           WHERE rl.toRecordId = d.id AND rl.linkType = 'решает'
//        )
//   Когда 2.4b создаёт intent.proposal со связью linkType='решает' к диагнозу,
//   тот автоматически «снимается с очереди» — без UPDATE Record (что append-only
//   запрещает) и без UPDATE RecordLink (тоже запрещено append-only-триггером).
//   Альтернативу (B) — Page-плейсхолдер с последующим update'ом связи —
//   пришлось бы строить как «вторая связь», а старая навсегда висела бы
//   мёртвой ссылкой. Альтернатива (A) — флаг properties.awaitingProposal=true —
//   создаёт второй источник истины (флаг + inverse-связь), и его всё равно
//   надо проверять на наличие inverse-связи, чтобы не предлагать решатель для
//   уже решённого диагноза. (C) — единственный append-only-friendly вариант.
//
// Что НЕ делает:
//   * НЕ интегрируется в runIteration — это 2.5.
//   * НЕ вызывает решатель — это 2.4a.
//   * НЕ повторно пишет audit.budget.deferred / audit.investigate.softcap.skip —
//     эти Records уже существуют (см. ретро 2.3b).
//   * НЕ обновляет существующие связи (append-only RecordLink).

import { ulid } from 'ulid';
import type { PrismaClient } from '../db/client.js';
import { getPrisma } from '../db/client.js';
import { emit } from '../observe/bridge.js';
import type { FanoutInvestigation, FanoutResult, InvestigationFailure } from './fanout.js';

// ---------------------------------------------------------------------------
// Контракт PersistResult — критичен для 2.5 (отчёт читает diagnosesCreated)
// и 2.4a (решатель вызывается только на свежесозданные diagnosis с verdict='code',
// drill-down по diagnosesCreated[]).
// ---------------------------------------------------------------------------

export interface PersistResult {
  // ID intent.diagnosis Records, в порядке создания (по fanout.results[i]).
  diagnosesCreated: string[];
  // ID audit.investigate.failed Records, в порядке создания (по fanout.failures[i]).
  failuresAuditedAs: string[];
  // count из fanout.deferred. Повторно НЕ пишем audit (уже сделал fanout 2.3b).
  deferredAlreadyAudited: number;
}

export interface PersistDeps {
  db?: PrismaClient;
  // Часы для createdAt. По умолчанию Date.now. Тесты подменяют для детерминизма.
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Главная функция.
// ---------------------------------------------------------------------------

export async function persistFanoutResult(
  fanout: FanoutResult,
  deps: PersistDeps = {},
): Promise<PersistResult> {
  const db = deps.db ?? getPrisma();
  const now = deps.now ?? Date.now;

  const diagnosesCreated: string[] = [];
  for (const result of fanout.results) {
    const diagnosisId = await insertDiagnosis(db, result, now());
    await insertRecordLink(db, {
      fromRecordId: diagnosisId,
      toRecordId: result.problemId,
      linkType: 'заключение',
      createdAt: now(),
    });
    diagnosesCreated.push(diagnosisId);
  }

  const failuresAuditedAs: string[] = [];
  for (const failure of fanout.failures) {
    const failureRecordId = await insertFailureAudit(db, failure, fanout.parentSession, now());
    await insertRecordLink(db, {
      fromRecordId: failureRecordId,
      toRecordId: failure.problemId,
      linkType: 'ошибка-расследования',
      createdAt: now(),
    });
    failuresAuditedAs.push(failureRecordId);
  }

  await emit({
    type: 'diagnosis.persisted',
    parentSession: fanout.parentSession,
    batchSize: diagnosesCreated.length,
    failuresAudited: failuresAuditedAs.length,
    deferredAlreadyAudited: fanout.deferred.length,
  });

  return {
    diagnosesCreated,
    failuresAuditedAs,
    deferredAlreadyAudited: fanout.deferred.length,
  };
}

// ---------------------------------------------------------------------------
// INSERT intent.diagnosis. parentId=null намеренно: связь с intent.problem
// делается через RecordLink linkType='заключение' (по требованию плана 2.3c).
// Это отделяет графовую связь «заключение про X» от иерархических parent-child
// (как тред→сообщения, задача→шаги, гипотеза→эксперимент).
// ---------------------------------------------------------------------------

async function insertDiagnosis(
  db: PrismaClient,
  result: FanoutInvestigation,
  nowMs: number,
): Promise<string> {
  const id = ulid();
  const properties = JSON.stringify({
    verdict: result.verdict,
    rationale: result.rationale,
    codeRefs: result.codeRefs,
    gitHints: result.gitHints,
    totalUsd: result.totalUsd,
    totalTokens: result.totalTokens,
    durationMs: result.durationMs,
    subagentId: result.subagentId,
    timedOut: result.timedOut,
    spendRecordId: result.spendRecordId,
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt)
     VALUES (?, 'intent.diagnosis', ?, 'agent', 'autonomous', 'active', ?)`,
    id,
    properties,
    nowMs,
  );
  return id;
}

// ---------------------------------------------------------------------------
// INSERT audit.investigate.failed. parentId=null, problemId дублируется в
// properties для drill-down без JOIN (тот же паттерн, что у audit.budget.deferred
// и audit.investigate.softcap.skip из 2.3b). Связь через RecordLink
// linkType='ошибка-расследования' — для графовых запросов «все ошибки по
// конкретной проблеме».
//
// Тип `audit.investigate.failed` — новый, но миграции/whitelist не требует:
// триггеры из 1.1 проверяют колонки, не доменные типы; CHECK на visibility —
// prefix `LIKE 'audit.%'`. Тот же путь, по которому в 2.3b добавили
// `audit.investigate.batch` / `audit.investigate.softcap.skip` / `audit.budget.deferred`.
// ---------------------------------------------------------------------------

async function insertFailureAudit(
  db: PrismaClient,
  failure: InvestigationFailure,
  parentSession: string,
  nowMs: number,
): Promise<string> {
  const id = ulid();
  const properties = JSON.stringify({
    problemId: failure.problemId,
    errorClass: failure.errorClass,
    message: failure.message,
    parentSession,
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.investigate.failed', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    properties,
    nowMs,
    nowMs,
  );
  return id;
}

// ---------------------------------------------------------------------------
// INSERT RecordLink. Те же два нюанса SQLite, что в src/triage/merge.ts:
//   1. RecordLink.id — BIGINT NOT NULL PRIMARY KEY. SQLite авто-инкрементит
//      только INTEGER PK (alias ROWID). Для BIGINT нужен явный id; генерим
//      через `(SELECT COALESCE(MAX(id), 0) + 1)` атомарно (single-process MVP).
//   2. UNIQUE(fromRecordId, toRecordId, toPagePath, linkType) с NULL в
//      toPagePath не ловит дубликаты (NULL != NULL в SQL). Здесь это не
//      проблема — каждый persistFanoutResult пишет уникальные пары
//      (новый diagnosisId/failureRecordId → existing problemId), повторов
//      по контракту fan-out нет.
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
