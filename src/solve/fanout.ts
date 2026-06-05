// Fan-out решателя (фаза 2.4b).
//
// Что делает solveMany:
//   1. Грузит config/solve.md (concurrency, maxProblemsPerCycle, parentSessionPrefix).
//   2. Применяет soft-cap: если diagnosisIds.length > maxProblemsPerCycle —
//      обрезает хвост и кладёт его в `deferred[]` с reason='soft-cap-skip'.
//      На каждый skipped — Record audit.solve.softcap.skip.
//   3. Эмитит solve.batch.start с общим parentSession (ULID) для группы.
//   4. Запускает sub-agent'ов через простой promise-pool с лимитом concurrency.
//      На каждый diagnosisId внутри лимита:
//        a. await solveDiagnosis(diagnosisId, { parentSession }).
//        b. catch:
//           - SolveBudgetExceededError / BudgetExceededError → budgetTripped=true,
//             текущий → deferred(per-cycle-budget). Семафор завершает уже
//             запущенные (drain), новых не стартует. ВСЕ оставшиеся (которые
//             не успели стартовать) — sweep'ом в deferred.
//           - другие (SolveConfigError / SolveTimeoutError / SolveInvalidResponseError) →
//             failures с {diagnosisId, errorClass, message}.
//   5. На каждый deferred(per-cycle-budget) пишет Record audit.budget.deferred
//      (тот же тип, что в исследователе — это generic budget-defer audit).
//   6. Финал: пишет одну Record audit.solve.batch с counters'ами.
//   7. Эмитит solve.batch.end.
//
// Что НЕ делает:
//   * НЕ создаёт intent.proposal Record — это persistSolveFanout (тот же файл
//     рядом). Мы не объединяем для тестируемости — fanout даёт чистый value
//     SolveFanoutResult, persist принимает его и материализует.
//   * НЕ фильтрует diagnosisIds по verdict='code'. Если сюда придёт human/unclear —
//     solveDiagnosis сам бросит SolveConfigError('verdict-not-code'); мы это
//     запишем как failure. Канонический фильтр — обязанность 2.5 (runIteration).
//   * НЕ интегрируется в runIteration — это 2.5.
//   * НЕ переделывает cost-tracking — он встроен в solveDiagnosis через
//     src/llm/subagent.ts (recordSpend).
//
// Стратегия cancel при BudgetExceeded — DRAIN, не cancel. Тот же выбор, что
// в src/investigate/fanout.ts: уже запущенные sub-agent'ы дорабатывают,
// токены уже потрачены, отмена через AbortController усложнила бы API
// solveDiagnosis (он не отдаёт controller наружу) и не сэкономила бы деньги.

import { ulid } from 'ulid';
import type { PrismaClient } from '../db/client.js';
import { getPrisma } from '../db/client.js';
import { BudgetExceededError } from '../llm/call.js';
import { emit } from '../observe/bridge.js';
import { type SolveConfig, loadSolveConfig } from './config.js';
import {
  SolveBudgetExceededError,
  type SolveDeps,
  type SolveResult,
  solveDiagnosis as defaultSolveDiagnosis,
} from './run.js';

// ---------------------------------------------------------------------------
// Контракт. Критичен для persistSolveFanout (материализация intent.proposal
// + audit.solve.failed) и для 2.5 (отчёт читает счётчики).
// ---------------------------------------------------------------------------

// Результат успешной solve, расширенный diagnosisId — необходим persist'у
// для FK на intent.diagnosis. SolveResult из 2.4a его не несёт; добавляем
// слоем выше как intersection (без правки 2.4a-контракта).
export type FanoutSolve = SolveResult & { diagnosisId: string };

export interface SolveFailure {
  diagnosisId: string;
  // Имя класса исключения, напр. 'SolveTimeoutError' / 'SolveInvalidResponseError' /
  // 'SolveConfigError'. БЕЗ Budget* — те идут в deferred.
  errorClass: string;
  message: string;
}

export interface SolveDeferred {
  diagnosisId: string;
  reason: 'per-cycle-budget' | 'soft-cap-skip';
}

export interface SolveFanoutResult {
  results: FanoutSolve[];
  failures: SolveFailure[];
  deferred: SolveDeferred[];
  parentSession: string;
  totalUsd: number;
  totalTokens: number;
  durationMs: number;
  // ID Записи audit.solve.batch — для persist и 2.5 (drill-down).
  auditRecordId: string;
}

// ---------------------------------------------------------------------------
// DI: подменяемые зависимости для тестов.
// ---------------------------------------------------------------------------

export interface SolveFanoutDeps {
  db?: PrismaClient;
  // Подмена solveDiagnosis — тесты передают мок без реального SDK.
  solveDiagnosisImpl?: typeof defaultSolveDiagnosis;
  // Override config — тесты задают concurrency/maxProblemsPerCycle/etc.
  configOverride?: SolveConfig;
  // Часы для durationMs / attemptedAt. По умолчанию Date.now.
  now?: () => number;
  // Прокинуть deps дальше в solveDiagnosis (db/configOverride/runSubagentImpl/
  // fsStatImpl/parentSession). Default — пустой объект; solveDiagnosis сам
  // подтянет prod-defaults. Поле parentSession из этого объекта переопределяется
  // нашим внутренним parentSession (он генерится здесь, чтобы группировать
  // все solve.start/end в Bridge через одну сессию).
  solveDepsOverride?: Omit<SolveDeps, 'parentSession'>;
}

// ---------------------------------------------------------------------------
// Главная функция.
// ---------------------------------------------------------------------------

export async function solveMany(
  diagnosisIds: string[],
  deps: SolveFanoutDeps = {},
): Promise<SolveFanoutResult> {
  const db = deps.db ?? getPrisma();
  const config = deps.configOverride ?? (await loadSolveConfig());
  const solveDiagnosis = deps.solveDiagnosisImpl ?? defaultSolveDiagnosis;
  const now = deps.now ?? Date.now;

  const parentSession = `${config.parentSessionPrefix}-${ulid()}`;
  const startedAt = now();

  // ---- Soft-cap: разделяем входной массив на queue + skip-tail. ----
  const queueIds = diagnosisIds.slice(0, config.maxProblemsPerCycle);
  const skipIds = diagnosisIds.slice(config.maxProblemsPerCycle);

  const deferred: SolveDeferred[] = [];
  for (const id of skipIds) {
    deferred.push({ diagnosisId: id, reason: 'soft-cap-skip' });
    await recordSoftcapSkip(db, id, parentSession, now());
  }

  // ---- emit batch.start. diagnosesIn = original length, до soft-cap'а. ----
  await emit({
    type: 'solve.batch.start',
    parentSession,
    diagnosesIn: diagnosisIds.length,
    concurrency: config.concurrency,
  });

  const results: FanoutSolve[] = [];
  const failures: SolveFailure[] = [];

  // budgetTripped — общий флаг семафора. Один из workers поймал BudgetExceeded
  // → новые задачи не стартуют. Уже запущенные дорабатывают (drain).
  let budgetTripped = false;

  // Множество diagnosisId, которые worker «забрал» из очереди — для финального
  // sweep'а (всё, что не handled, идёт в deferred per-cycle-budget).
  const handled = new Set<string>();

  // ---- Простой promise-pool без зависимостей. Тот же приём, что в
  //      src/investigate/fanout.ts: один общий nextIdx + while-loop в worker'е,
  //      flag-driven cancel. См. ретро 2.3b — реализация ручная намеренно.
  let nextIdx = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      if (budgetTripped) return;
      const i = nextIdx++;
      if (i >= queueIds.length) return;
      const diagnosisId = queueIds[i];
      if (diagnosisId === undefined) return;
      handled.add(diagnosisId);

      try {
        const result = await solveDiagnosis(diagnosisId, {
          ...(deps.solveDepsOverride ?? {}),
          parentSession,
        });
        results.push({ ...result, diagnosisId });
      } catch (err) {
        if (isBudgetError(err)) {
          // Текущий diagnosisId сам не дошёл до result — defer.
          // Уже запущенные другие workers дорабатывают; новые не стартуют.
          budgetTripped = true;
          deferred.push({ diagnosisId, reason: 'per-cycle-budget' });
          await recordBudgetDeferred(db, diagnosisId, 'per-cycle-budget', parentSession, now());
          return;
        }
        const errorClass = err instanceof Error ? err.constructor.name : 'UnknownError';
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ diagnosisId, errorClass, message });
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
    deferred.push({ diagnosisId: id, reason: 'per-cycle-budget' });
    await recordBudgetDeferred(db, id, 'per-cycle-budget', parentSession, now());
  }

  // ---- Сводные метрики. ----
  const totalUsd = results.reduce((sum, r) => sum + r.totalUsd, 0);
  const totalTokens = results.reduce((sum, r) => sum + r.totalTokens, 0);
  const durationMs = now() - startedAt;

  const auditRecordId = await recordBatchAudit(db, {
    parentSession,
    diagnosesIn: diagnosisIds.length,
    succeeded: results.length,
    failed: failures.length,
    deferredCount: deferred.length,
    totalUsd,
    totalTokens,
    durationMs,
    nowMs: now(),
  });

  await emit({
    type: 'solve.batch.end',
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
  if (err instanceof SolveBudgetExceededError) return true;
  // Безопасно по name — на случай, если ошибка пересоздана в другом контексте
  // (не instanceof) или если в M3 кто-то расширит иерархию.
  if (err instanceof Error) {
    if (err.name === 'BudgetExceededError') return true;
    if (err.name === 'SolveBudgetExceededError') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Record-инъекции. Все три — append-only `Record` с status='closed' и closedAt
// (паттерн из src/investigate/fanout.ts).
// ---------------------------------------------------------------------------

// parentId=null намеренно: diagnosisId хранится в properties для drill-down.
// FK на intent.diagnosis не выставляем — то же соображение, что в исследователе:
// связь делается семантически через properties.diagnosisId.
async function recordSoftcapSkip(
  db: PrismaClient,
  diagnosisId: string,
  parentSession: string,
  nowMs: number,
): Promise<string> {
  const id = ulid();
  const properties = JSON.stringify({
    diagnosisId,
    reason: 'soft-cap-skip',
    parentSession,
    attemptedAt: nowMs,
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.solve.softcap.skip', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    properties,
    nowMs,
    nowMs,
  );
  return id;
}

// audit.budget.deferred — тот же тип, что в исследователе. Это generic
// budget-defer audit (не привязан к investigate); в properties добавляем
// `subjectKind: 'diagnosis'` чтобы 2.5 мог разделить deferred исследователя
// и решателя по этому полю без анализа parentSession-prefix'а.
async function recordBudgetDeferred(
  db: PrismaClient,
  diagnosisId: string,
  reason: SolveDeferred['reason'],
  parentSession: string,
  nowMs: number,
): Promise<string> {
  const id = ulid();
  const properties = JSON.stringify({
    diagnosisId,
    subjectKind: 'diagnosis',
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
  diagnosesIn: number;
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
    diagnosesIn: input.diagnosesIn,
    succeeded: input.succeeded,
    failed: input.failed,
    deferred: input.deferredCount,
    totalUsd: input.totalUsd,
    totalTokens: input.totalTokens,
    durationMs: input.durationMs,
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.solve.batch', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    properties,
    input.nowMs,
    input.nowMs,
  );
  return id;
}
