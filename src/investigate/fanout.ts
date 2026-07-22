// Fan-out исследователя (фаза 2.3b).
//
// Что делает investigateMany:
//   1. Грузит config/investigate.md (concurrency, maxProblemsPerCycle).
//   2. Применяет soft-cap: если problemIds.length > maxProblemsPerCycle —
//      обрезает хвост и кладёт его в `deferred[]` с reason='soft-cap-skip'.
//      На каждый skipped — Record audit.investigate.softcap.skip.
//   3. Эмитит investigate.batch.start с общим parentSession (ULID) для группы.
//   4. Запускает sub-agent'ов через простой promise-pool с лимитом concurrency.
//      На каждый problemId внутри лимита:
//        a. emit subagent.start { subagentId, parentSession, problemId, type:'investigator' }.
//        b. await investigateProblem(problemId).
//        c. catch:
//           - BudgetExceeded / InvestigateBudgetExceededError → budgetTripped=true,
//             текущий → deferred(per-cycle-budget). Семафор завершает уже
//             запущенные (drain), новых не стартует. ВСЕ оставшиеся (которые
//             не успели стартовать) — sweep'ом в deferred.
//           - другие → failures с {problemId, errorClass, message}.
//        d. emit subagent.end { subagentId, durationMs, verdict?, totalUsd?, ... }.
//   5. На каждый deferred(per-cycle-budget) пишет Record audit.budget.deferred.
//   6. Финал: пишет одну Record audit.investigate.batch с counters'ами.
//   7. Эмитит investigate.batch.end.
//
// Что НЕ делает:
//   * НЕ создаёт intent.diagnosis Record — это 2.3c.
//   * НЕ дёргает mergeProblems — caller передаёт готовый массив problemIds.
//   * НЕ интегрируется в runIteration — это 2.5.
//   * НЕ переделывает cost-tracking — он встроен в каждый investigateProblem
//     через src/llm/subagent.ts (recordSpend).
//
// Стратегия cancel при BudgetExceeded:
//   DRAIN, не cancel. Уже запущенные sub-agent'ы дорабатывают до конца —
//   их токены уже потрачены, отмена через AbortController усложнила бы API
//   investigateProblem (он не отдаёт controller наружу) и не сэкономила бы
//   деньги. Новые sub-agent'ы не стартуют (флаг budgetTripped). См. ретро 2.3b.

import { ulid } from 'ulid';
import type { PrismaClient } from '../db/client.js';
import { getPrisma } from '../db/client.js';
import { BudgetExceededError } from '../llm/call.js';
import { emit } from '../observe/bridge.js';
import { type InvestigateConfig, loadInvestigateConfig } from './config.js';
import {
  InvestigateBudgetExceededError,
  type InvestigateDeps,
  type InvestigationResult,
  investigateProblem as defaultInvestigateProblem,
} from './run.js';

// ---------------------------------------------------------------------------
// Контракт. Критичен для 2.3c (материализация intent.diagnosis с разными
// статусами по results / failures / deferred) и для 2.5 (отчёт).
// ---------------------------------------------------------------------------

// Результат успешной investigation, расширенный problemId — необходим 2.3c
// для FK на intent.problem. InvestigationResult из 2.3a его не содержит,
// мы добавляем здесь как intersection (без правки 2.3a-контракта).
export type FanoutInvestigation = InvestigationResult & { problemId: string };

export interface InvestigationFailure {
  problemId: string;
  // Имя класса исключения (errorClass), напр.
  // 'InvestigateInvalidResponseError' / 'InvestigateConfigError' / etc.
  errorClass: string;
  message: string;
}

export interface InvestigationDeferred {
  problemId: string;
  reason: 'per-cycle-budget' | 'soft-cap-skip';
}

export interface FanoutResult {
  results: FanoutInvestigation[];
  failures: InvestigationFailure[];
  deferred: InvestigationDeferred[];
  parentSession: string;
  totalUsd: number;
  totalTokens: number;
  durationMs: number;
  // ID Записи audit.investigate.batch — для 2.3c и 2.5 (drill-down).
  auditRecordId: string;
}

// ---------------------------------------------------------------------------
// DI: подменяемые зависимости для тестов.
// ---------------------------------------------------------------------------

export interface FanoutDeps {
  db?: PrismaClient;
  // Подмена investigateProblem — тесты передают мок без реального SDK.
  investigateProblemImpl?: typeof defaultInvestigateProblem;
  // Override config — тесты задают concurrency/maxProblemsPerCycle/etc.
  configOverride?: InvestigateConfig;
  // Часы для durationMs / attemptedAt. По умолчанию Date.now.
  now?: () => number;
  // Прокинуть deps дальше в investigateProblem (db/configOverride/runSubagentImpl).
  // Default — пустой объект; investigateProblem сам подтянет prod-defaults.
  // configOverride/db в этом объекте используются КАК есть, не пересекаясь
  // с FanoutDeps.configOverride/db (их назначение — fanout-уровень, не run-уровень).
  investigateDepsOverride?: InvestigateDeps;
}

// ---------------------------------------------------------------------------
// Главная функция.
// ---------------------------------------------------------------------------

export async function investigateMany(
  problemIds: string[],
  deps: FanoutDeps = {},
): Promise<FanoutResult> {
  const db = deps.db ?? getPrisma();
  const config = deps.configOverride ?? (await loadInvestigateConfig());
  const investigateProblem = deps.investigateProblemImpl ?? defaultInvestigateProblem;
  const now = deps.now ?? Date.now;

  const parentSession = `${config.parentSessionPrefix}-${ulid()}`;
  const startedAt = now();

  // ---- Soft-cap: разделяем входной массив на queue + skip-tail. ----
  const queueIds = problemIds.slice(0, config.maxProblemsPerCycle);
  const skipIds = problemIds.slice(config.maxProblemsPerCycle);

  const deferred: InvestigationDeferred[] = [];
  for (const id of skipIds) {
    deferred.push({ problemId: id, reason: 'soft-cap-skip' });
    await recordSoftcapSkip(db, id, parentSession, now());
  }

  // ---- emit batch.start. problemsIn = original length, до soft-cap'а. ----
  await emit({
    type: 'investigate.batch.start',
    parentSession,
    problemsIn: problemIds.length,
    concurrency: config.concurrency,
  });

  const results: FanoutInvestigation[] = [];
  const failures: InvestigationFailure[] = [];

  // budgetTripped — общий флаг семафора. Один из workers поймал BudgetExceeded
  // → новые задачи не стартуют. Уже запущенные дорабатывают (drain).
  let budgetTripped = false;

  // Множество problemId, которые worker «забрал» из очереди. Используется
  // для финального sweep'а: всё, что не handled, идёт в deferred per-cycle-budget.
  const handled = new Set<string>();

  // ---- Семафор: простой promise-pool, без зависимостей. ----
  // Один счётчик `nextIdx` — общий для всех workers. Каждый worker в while-loop:
  //   1. проверяет budgetTripped (если да — выходит, не берёт следующий);
  //   2. атомарно (single-thread JS) забирает следующий id через nextIdx++;
  //   3. обрабатывает; повторяет.
  // Реализация ручная (не p-limit), потому что:
  //   — у нас нет лишних deps в проекте (CLAUDE.md правило: «деплой локально, лишний npm-пакет = риск»);
  //   — нужен flag-driven cancel («больше не стартуй новых»), который p-limit не даёт из коробки;
  //   — ~30 строк своего кода читаются тривиально и тестируются легче, чем чужая абстракция.
  let nextIdx = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      if (budgetTripped) return;
      const i = nextIdx++;
      if (i >= queueIds.length) return;
      const problemId = queueIds[i];
      if (problemId === undefined) return;
      handled.add(problemId);

      const subagentId = ulid();
      const subagentStartedAt = now();

      await emit({
        type: 'subagent.start',
        subagentId,
        subagentType: 'investigator',
        parentRecordId: problemId,
        problemId,
        parentSession,
      });

      try {
        const result = await investigateProblem(problemId, deps.investigateDepsOverride);
        results.push({ ...result, problemId });
        await emit({
          type: 'subagent.end',
          subagentId,
          durationMs: result.durationMs,
          verdict: result.verdict,
          totalUsd: result.totalUsd,
          totalTokens: result.totalTokens,
          timedOut: result.timedOut,
        });
      } catch (err) {
        if (isBudgetError(err)) {
          // Текущий problemId сам не успел/не дошёл до result — defer.
          // Уже запущенные другие workers дорабатывают; новые не стартуют.
          budgetTripped = true;
          deferred.push({ problemId, reason: 'per-cycle-budget' });
          await recordBudgetDeferred(db, problemId, 'per-cycle-budget', parentSession, now());
          await emit({
            type: 'subagent.end',
            subagentId,
            durationMs: now() - subagentStartedAt,
            timedOut: false,
          });
          return;
        }
        const errorClass = err instanceof Error ? err.constructor.name : 'UnknownError';
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ problemId, errorClass, message });
        await emit({
          type: 'subagent.end',
          subagentId,
          durationMs: now() - subagentStartedAt,
          timedOut: false,
        });
      }
    }
  };

  const workersN = Math.min(config.concurrency, queueIds.length);
  const workerPromises: Promise<void>[] = [];
  for (let i = 0; i < workersN; i++) {
    workerPromises.push(worker());
  }
  await Promise.all(workerPromises);

  // ---- Sweep: всё в queueIds, что не было handled (worker не успел забрать
  //      из-за budgetTripped), помечаем deferred per-cycle-budget. ----
  for (const id of queueIds) {
    if (handled.has(id)) continue;
    deferred.push({ problemId: id, reason: 'per-cycle-budget' });
    await recordBudgetDeferred(db, id, 'per-cycle-budget', parentSession, now());
  }

  // ---- Сводные метрики. ----
  const totalUsd = results.reduce((sum, r) => sum + r.totalUsd, 0);
  const totalTokens = results.reduce((sum, r) => sum + r.totalTokens, 0);
  const durationMs = now() - startedAt;

  const auditRecordId = await recordBatchAudit(db, {
    parentSession,
    problemsIn: problemIds.length,
    succeeded: results.length,
    failed: failures.length,
    deferredCount: deferred.length,
    totalUsd,
    totalTokens,
    durationMs,
    nowMs: now(),
  });

  await emit({
    type: 'investigate.batch.end',
    parentSession,
    succeeded: results.length,
    failed: failures.length,
    deferred: deferred.length,
    totalUsd,
    totalTokens,
    durationMs,
  });

  return {
    results,
    failures,
    deferred,
    parentSession,
    totalUsd,
    totalTokens,
    durationMs,
    auditRecordId,
  };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function isBudgetError(err: unknown): boolean {
  if (err instanceof BudgetExceededError) return true;
  if (err instanceof InvestigateBudgetExceededError) return true;
  // Безопасно по name — на случай, если ошибка пересоздана в другом контексте
  // (не instanceof) или если кто-то в M3 расширит иерархию.
  if (err instanceof Error) {
    if (err.name === 'BudgetExceededError') return true;
    if (err.name === 'InvestigateBudgetExceededError') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Record-инъекции. Все три — append-only `Record` с status='closed' и closedAt
// (паттерн из audit.triage.merge / audit.spend).
// ---------------------------------------------------------------------------

// parentId=null намеренно: problemId хранится в properties для drill-down.
// FK на intent.problem не выставляем — на больших объёмах это лишний JOIN
// для БД, а связь делается семантически через properties.problemId. (Те же
// соображения, что у audit.investigate.batch — у него вообще нет одного
// parent'а.)
async function recordSoftcapSkip(
  db: PrismaClient,
  problemId: string,
  parentSession: string,
  nowMs: number,
): Promise<string> {
  const id = ulid();
  const properties = JSON.stringify({
    problemId,
    reason: 'soft-cap-skip',
    parentSession,
    attemptedAt: nowMs,
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.investigate.softcap.skip', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    properties,
    nowMs,
    nowMs,
  );
  return id;
}

async function recordBudgetDeferred(
  db: PrismaClient,
  problemId: string,
  reason: InvestigationDeferred['reason'],
  parentSession: string,
  nowMs: number,
): Promise<string> {
  const id = ulid();
  const properties = JSON.stringify({
    problemId,
    reason,
    parentSession,
    attemptedAt: nowMs,
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.budget.deferred', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    properties,
    nowMs,
    nowMs,
  );
  return id;
}

interface BatchAuditInput {
  parentSession: string;
  problemsIn: number;
  succeeded: number;
  failed: number;
  deferredCount: number;
  totalUsd: number;
  totalTokens: number;
  durationMs: number;
  nowMs: number;
}

async function recordBatchAudit(db: PrismaClient, input: BatchAuditInput): Promise<string> {
  const id = ulid();
  const properties = JSON.stringify({
    parentSession: input.parentSession,
    problemsIn: input.problemsIn,
    succeeded: input.succeeded,
    failed: input.failed,
    deferred: input.deferredCount,
    totalUsd: input.totalUsd,
    totalTokens: input.totalTokens,
    durationMs: input.durationMs,
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.investigate.batch', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    properties,
    input.nowMs,
    input.nowMs,
  );
  return id;
}
