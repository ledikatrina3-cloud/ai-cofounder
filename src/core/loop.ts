// @deprecated — с 2026-05-01 pivot (`plans/`,
// фаза 1.3) единственная точка входа — `runRoutine` из `src/core/dispatcher.ts`.
// runIteration сохраняется как deprecated wrapper для:
//   1) старых тестов `tests/idempotency.test.ts` и `tests/runIteration-e2e.test.ts`
//      (порт под routine support-triage планируется фазой 4.1);
//   2) старого `pnpm dev:tick` и launchd-jobа `com.ai-cofounder.morning-detective`
//      — он продолжит писать event.trigger / audit.repeat по старому контракту
//      пока 4.1 не заменит вертикаль.
//
// runIteration — единственная точка входа агента (src/core/loop.ts).
// Любой триггер из src/core/triggers.ts обязан проходить ЧЕРЕЗ неё.
//
// До фазы 2.5 runIteration был «пустым телом» из 1.4 — только idempotency-гард
// и audit.repeat. С 2.5 здесь сшит весь пайплайн утреннего детектива:
//
//   event.trigger upsert
//     → runIteration.start
//     → fetchSupportMessages (perception 2.1b)
//     → если 0 непрочитанных + 0 pending → empty-report → runIteration.end empty
//     → extractProblems (триаж 2.2a)
//     → mergeProblems (мердж 2.2b)
//     → investigateMany (fan-out 2.3b)
//     → persistFanoutResult (persist 2.3c)
//     → runSolveBatch (fan-out + persist 2.4b) на code-диагнозы
//     → buildReport (отчёт 2.5)
//     → sendReport (Telegram)
//     → audit.report.sent + runIteration.end ok
//
// Стратегии:
//   * `parentSession='runIteration:<eventTriggerId>'` для собственных audit-Records
//     (audit.report.*, audit.runIteration.failed). Существующие upstream-Records
//     (intent.problem/diagnosis/proposal, audit.investigate.*, audit.solve.*,
//     audit.budget.deferred, audit.fetch.support, audit.triage.*) сохраняют свои
//     parentSession'ы и parentId=null — drill-down по конкретной итерации идёт
//     через mentioned*Ids в audit.report.sent.properties + временное окно
//     audit.spend (ретро 2.5).
//   * totalUsdSpent — локальный накопитель из triage/fanout/solve totalUsd. По
//     требованию задания: «источник правды — audit.spend, локальный накопитель —
//     только для отображения». В тесте сверяем оба значения.
//   * fail-fast vs fail-soft: см. шапки `safeStep` и `softStep` ниже.
//
// Контракт RunIterationResult — расширен через `outcome` для bot.ts /run и
// для тестов (которые ожидают увидеть 'empty'/'ok'/'failed').

import { ulid } from 'ulid';
import type { PrismaClient } from '../db/client.js';
import { getPrisma } from '../db/client.js';
import { investigateMany } from '../investigate/fanout.js';
import { persistFanoutResult } from '../investigate/persist.js';
import { type RunIterationStep, emit } from '../observe/bridge.js';
import { fetchSupportMessages } from '../perception/support.js';
import {
  type DeferredCounts,
  type ReportItem,
  type ReportItemCodeNoProposal,
  type ReportItemCodeWithProposal,
  type ReportItemFailure,
  type ReportItemHuman,
  type ReportItemUnclear,
  type ReportStats,
  type TelegramMessage,
  buildEmptyReport,
  buildErrorReport,
  buildReport,
} from '../report/morning.js';
import { type SendReportResult, collectMentionedIds, sendReport } from '../report/sender.js';
import { runSolveBatch } from '../solve/index.js';
import { type SupportMessage, extractProblems } from '../triage/extract.js';
import { mergeProblems } from '../triage/merge.js';
import type { EventTrigger } from './triggers.js';

export type RunIterationOutcome = 'accepted' | 'repeat' | 'empty' | 'ok' | 'failed';

export interface RunIterationResult {
  // Уникальный ключ триггера, как принят в очередь (для логирования).
  idempotencyKey: string;
  // Что произошло на этом проходе.
  outcome: RunIterationOutcome;
  // id Записи event.trigger (новой при accepted/empty/ok/failed; существующей при repeat).
  triggerRecordId: string;
  // id Записи audit.repeat — только при outcome='repeat'.
  repeatRecordId?: string;
  // Telegram message_ids отправленного отчёта (только при empty/ok). Помогает
  // тестам и /run-handler'у показать, что отчёт долетел.
  telegramMessageIds?: number[];
  // Деньги/токены, потраченные за цикл (только при empty/ok). На failed может
  // быть тоже — записан до того как упало.
  totalUsdSpent?: number;
  totalTokensSpent?: number;
}

// ---------------------------------------------------------------------------
// DI: всё, что нужно подменить тесту, протекает через RunIterationDeps. Прод
// собирает defaults из соответствующих модулей.
// ---------------------------------------------------------------------------

export interface RunIterationDeps {
  db?: PrismaClient;
  // Часы. Default Date.now.
  now?: () => number;
  // Pipeline-зависимости. Каждая может быть подменена тестом.
  fetchSupportMessages?: typeof fetchSupportMessages;
  extractProblems?: typeof extractProblems;
  mergeProblems?: typeof mergeProblems;
  investigateMany?: typeof investigateMany;
  persistFanoutResult?: typeof persistFanoutResult;
  runSolveBatch?: typeof runSolveBatch;
  buildReport?: typeof buildReport;
  buildEmptyReport?: typeof buildEmptyReport;
  buildErrorReport?: typeof buildErrorReport;
  sendReport?: typeof sendReport;
  // Опционально: rootDir для buildReport (тесты дают tempdir с шаблонами).
  rootDir?: string;
}

/**
 * @deprecated since 2026-05-01 pivot — use runRoutine() from src/core/dispatcher.ts instead.
 *
 * Сохраняется как wrapper для старого `pnpm dev:tick` (cron утреннего детектива)
 * и старых тестов (idempotency, runIteration-e2e). Фаза 4.1 нового плана должна
 * заменить эту вертикаль routine `support-triage`.
 */
export async function runIteration(
  trigger: EventTrigger,
  deps: RunIterationDeps = {},
): Promise<RunIterationResult> {
  const db = deps.db ?? getPrisma();
  const now = deps.now ?? Date.now;
  const startedAt = now();

  // ─── Шаг 1. event.trigger upsert (1.4 контракт). ─────────────────────────
  const upsert = await upsertEventTrigger(db, trigger, now);
  if (upsert.outcome === 'repeat') {
    return upsert.result;
  }
  const eventTriggerId = upsert.result.triggerRecordId;
  const parentSession = `runIteration:${eventTriggerId}`;

  // ─── Шаг 2. emit runIteration.start ──────────────────────────────────────
  await emit({
    type: 'runIteration.start',
    triggerSource: trigger.source,
    idempotencyKey: trigger.idempotencyKey,
    eventTriggerId,
  });

  // Локальный накопитель usd/tokens — для строки шапки и audit.report.sent.
  // Источник правды — audit.spend (см. SQL-агрегация в тестах).
  const tally = { usd: 0, tokens: 0 };
  // Накопленные deferred-счётчики из investigate/solve.
  const deferred: DeferredCounts = {
    investigateBudget: 0,
    investigateSoftcap: 0,
    solveBudget: 0,
    solveSoftcap: 0,
  };
  // Поднятые из БД items для отчёта.
  const items: ReportItem[] = [];

  // currentStep — на каком шаге pipeline'а мы сейчас. Catch-блок в конце
  // использует это значение, чтобы записать audit.runIteration.failed
  // с правильным `step`. inferStepFromError остаётся как fallback на случай,
  // если ошибка пришла из неожиданного места (вне pipeline-трекинга).
  let currentStep: RunIterationStep = 'fetch';

  try {
    // ─── Шаг 3. fetch support-сообщений ───────────────────────────────────
    currentStep = 'fetch';
    await emitStep(eventTriggerId, 'fetch');
    const fetcher = deps.fetchSupportMessages ?? fetchSupportMessages;
    const fetchResult = await fetcher({ db });

    // ─── Шаг 4. собрать pendingProblemIds (старые intent.problem без diagnosis) ─
    const pendingProblemIds = await selectPendingProblemIds(db);

    // ─── Шаг 5. пустой инпут? ──────────────────────────────────────────────
    if (fetchResult.messagesInserted === 0 && pendingProblemIds.length === 0) {
      const messages = await (deps.buildEmptyReport ?? buildEmptyReport)({
        db,
        rootDir: deps.rootDir,
      });
      const sendImpl = deps.sendReport ?? sendReport;
      // sendReport может упасть — fail-soft: не валим runIteration, audit empty
      // всё равно пишем (фаундер увидит при следующем запуске).
      const sentMessageIds = await safeSend(sendImpl, messages, deps.rootDir, () => undefined);
      await insertAuditReportEmpty(db, {
        eventTriggerId,
        parentSession,
        telegramMessageIds: sentMessageIds,
        nowMs: now(),
      });
      await emit({
        type: 'runIteration.end',
        eventTriggerId,
        status: 'empty',
        totalUsd: 0,
        totalTokens: 0,
        durationMs: now() - startedAt,
      });
      return {
        idempotencyKey: trigger.idempotencyKey,
        outcome: 'empty',
        triggerRecordId: eventTriggerId,
        telegramMessageIds: sentMessageIds,
        totalUsdSpent: 0,
        totalTokensSpent: 0,
      };
    }

    // ─── Шаг 6. вытащить непрочитанные event.support.message ───────────────
    // Если fetcher только что НЕ вставил ничего нового (messagesInserted=0) —
    // триаж нечего разбирать: окно [since, until] будет включать ВСЕ старые
    // event.support.message (since=null означает «первый прогон» в контракте
    // 2.1b). Триаж по ним второй раз — лишний LLM-вызов и риск дубликатов
    // intent.problem (мердж бы спас, но ровно эту работу мерджа мы и не хотим
    // повторять). Если в этом цикле НЕ было INSERT'ов — пропускаем триаж.
    const supportMessages =
      fetchResult.messagesInserted === 0
        ? []
        : await loadInsertedSupport(db, {
            sinceMs: fetchResult.since !== null ? fetchResult.since.getTime() : 0,
            untilMs: fetchResult.until.getTime(),
          });

    // ─── Шаг 7. триаж ──────────────────────────────────────────────────────
    currentStep = 'triage';
    await emitStep(eventTriggerId, 'triage');
    const triage = await runTriageStep(deps, supportMessages, db);
    tally.usd += triage.result?.usd ?? 0;

    // ─── Шаг 8. мердж ──────────────────────────────────────────────────────
    currentStep = 'merge';
    await emitStep(eventTriggerId, 'merge');
    const merge =
      triage.result === null
        ? { created: [], merged: [], auditRecordId: '', durationMs: 0 }
        : await (deps.mergeProblems ?? mergeProblems)(triage.result, { prisma: db });

    // Объединённый список problemId для исследования: новые из merge.created +
    // существующие из merge.merged + хвост из pendingProblemIds (старые без
    // diagnosis с прошлых дней).
    const problemIdSet = new Set<string>();
    for (const c of merge.created) problemIdSet.add(c.problemId);
    for (const m of merge.merged) problemIdSet.add(m.existingProblemId);
    for (const id of pendingProblemIds) problemIdSet.add(id);
    const problemIds = Array.from(problemIdSet);

    // ─── Шаг 9. investigate fan-out ────────────────────────────────────────
    currentStep = 'investigate';
    await emitStep(eventTriggerId, 'investigate');
    const fanout = await (deps.investigateMany ?? investigateMany)(problemIds, { db });
    tally.usd += fanout.totalUsd;
    tally.tokens += fanout.totalTokens;
    for (const d of fanout.deferred) {
      if (d.reason === 'per-cycle-budget') deferred.investigateBudget += 1;
      else if (d.reason === 'soft-cap-skip') deferred.investigateSoftcap += 1;
    }

    // ─── Шаг 10. persist-investigate ───────────────────────────────────────
    currentStep = 'persist-investigate';
    await emitStep(eventTriggerId, 'persist-investigate');
    const persistInvestigate = await (deps.persistFanoutResult ?? persistFanoutResult)(fanout, {
      db,
    });

    // ─── Шаг 11. solve fan-out + persist ───────────────────────────────────
    currentStep = 'solve';
    await emitStep(eventTriggerId, 'solve');
    const codeDiagnosisIds = await selectAwaitingCodeDiagnoses(
      db,
      persistInvestigate.diagnosesCreated,
    );
    let solveBatch: Awaited<ReturnType<typeof runSolveBatch>> | null = null;
    try {
      solveBatch = await (deps.runSolveBatch ?? runSolveBatch)(codeDiagnosisIds, {
        fanoutDeps: { db },
        persistDeps: { db },
      });
      tally.usd += solveBatch.fanout.totalUsd;
      tally.tokens += solveBatch.fanout.totalTokens;
      for (const d of solveBatch.fanout.deferred) {
        if (d.reason === 'per-cycle-budget') deferred.solveBudget += 1;
        else if (d.reason === 'soft-cap-skip') deferred.solveSoftcap += 1;
      }
    } catch (err) {
      // fail-soft: solve целиком упал. Отчитаемся по diagnoses без proposals.
      await insertRunIterationFailed(db, {
        eventTriggerId,
        parentSession,
        step: 'solve',
        err,
        nowMs: now(),
      });
    }

    // Шаг 12 — внутри runSolveBatch (persistSolveFanout) уже сделан.

    // ─── Шаг 13. собрать reportItems ───────────────────────────────────────
    currentStep = 'report';
    await emitStep(eventTriggerId, 'report');
    items.push(
      ...(await assembleItems(db, {
        problemIds,
        fanout,
        persistInvestigate,
        solveBatch,
      })),
    );

    // ─── Шаг 14. sendReport ────────────────────────────────────────────────
    const stats: ReportStats = {
      totalUsdSpent: tally.usd,
      totalTokensSpent: tally.tokens,
      deferred,
      eventTriggerId,
    };
    const buildImpl = deps.buildReport ?? buildReport;
    const messages = await buildImpl({ stats, items }, { db, rootDir: deps.rootDir });
    const sendImpl = deps.sendReport ?? sendReport;
    let sendResult: SendReportResult | null = null;
    let sentMessageIds: number[] = [];
    try {
      sendResult = await sendImpl(messages, {});
      sentMessageIds = sendResult.sentMessageIds;
    } catch (err) {
      // fail-soft: всё уже материализовано в БД, проблема только в Telegram.
      await insertAuditReportSendFailed(db, {
        eventTriggerId,
        parentSession,
        err,
        nowMs: now(),
      });
    }

    // ─── Шаг 15. audit.report.sent ─────────────────────────────────────────
    const mentioned = collectMentionedIds(messages);
    await insertAuditReportSent(db, {
      eventTriggerId,
      parentSession,
      messages,
      stats,
      items,
      sentMessageIds,
      durationMs: now() - startedAt,
      nowMs: now(),
      mentioned,
    });

    // ─── Шаг 16. runIteration.end ok ────────────────────────────────────────
    await emit({
      type: 'runIteration.end',
      eventTriggerId,
      status: 'ok',
      totalUsd: tally.usd,
      totalTokens: tally.tokens,
      durationMs: now() - startedAt,
    });

    return {
      idempotencyKey: trigger.idempotencyKey,
      outcome: 'ok',
      triggerRecordId: eventTriggerId,
      telegramMessageIds: sentMessageIds,
      totalUsdSpent: tally.usd,
      totalTokensSpent: tally.tokens,
    };
  } catch (err) {
    // fail-fast путь: какой-то критический шаг упал. Записываем
    // audit.runIteration.failed + пытаемся отправить error-report, потом
    // emit runIteration.end status='failed' и return.
    // currentStep — точное имя шага из pipeline'а (трекается выше).
    // inferStepFromError — fallback на случай ошибки до выставления currentStep.
    const step: RunIterationStep | string = currentStep ?? inferStepFromError(err);
    await insertRunIterationFailed(db, {
      eventTriggerId,
      parentSession,
      step,
      err,
      nowMs: now(),
    });
    const errMessage = err instanceof Error ? err.message : String(err);
    const errorMessages = await (deps.buildErrorReport ?? buildErrorReport)(step, errMessage, {
      rootDir: deps.rootDir,
    });
    const sendImpl = deps.sendReport ?? sendReport;
    const errorMessageIds = await safeSend(sendImpl, errorMessages, deps.rootDir, () => {
      // sender тоже упал на error-report. Audit уже записан, остаётся только
      // emit failed и return.
    });
    await emit({
      type: 'runIteration.end',
      eventTriggerId,
      status: 'failed',
      totalUsd: tally.usd,
      totalTokens: tally.tokens,
      durationMs: now() - startedAt,
    });
    return {
      idempotencyKey: trigger.idempotencyKey,
      outcome: 'failed',
      triggerRecordId: eventTriggerId,
      telegramMessageIds: errorMessageIds,
      totalUsdSpent: tally.usd,
      totalTokensSpent: tally.tokens,
    };
  }
}

// ---------------------------------------------------------------------------
// Шаг 1: event.trigger upsert (1.4 контракт). Вынесен в отдельную функцию
// чтобы основное тело runIteration было читаемым линейно.
// ---------------------------------------------------------------------------

interface UpsertResult {
  outcome: 'accepted' | 'repeat';
  result: RunIterationResult;
}

async function upsertEventTrigger(
  db: PrismaClient,
  trigger: EventTrigger,
  now: () => number,
): Promise<UpsertResult> {
  const newId = ulid();
  const nowMs = now();
  const properties = JSON.stringify({ source: trigger.source, ...trigger.properties });

  const inserted = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, idempotencyKey, status, createdAt)
     VALUES (?, 'event.trigger', ?, 'system', 'autonomous', ?, 'active', ?)
     ON CONFLICT(idempotencyKey) DO NOTHING
     RETURNING id`,
    newId,
    properties,
    trigger.idempotencyKey,
    nowMs,
  );

  if (inserted.length === 1) {
    const acceptedId = inserted[0]?.id ?? newId;
    await emit({
      type: 'event.trigger',
      recordId: acceptedId,
      triggerSource: trigger.source,
      idempotencyKey: trigger.idempotencyKey,
    });
    return {
      outcome: 'accepted',
      result: {
        idempotencyKey: trigger.idempotencyKey,
        outcome: 'accepted',
        triggerRecordId: acceptedId,
      },
    };
  }

  // Конфликт UNIQUE — поднимаем существующую event.trigger и пишем audit.repeat.
  const existing = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "Record" WHERE type = 'event.trigger' AND idempotencyKey = ?`,
    trigger.idempotencyKey,
  );
  const existingId = existing[0]?.id;
  if (existingId === undefined) {
    throw new Error(
      `runIteration: idempotencyKey ${trigger.idempotencyKey} конфликтует, но event.trigger с таким ключом не найдена.`,
    );
  }

  const repeatId = ulid();
  const repeatProperties = JSON.stringify({
    idempotencyKey: trigger.idempotencyKey,
    source: trigger.source,
    triggerRecordId: existingId,
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, parentId, actorKind, visibility, status, closedAt, createdAt) VALUES (?, 'audit.repeat', ?, ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    repeatId,
    repeatProperties,
    existingId,
    nowMs,
    nowMs,
  );
  await emit({
    type: 'audit.repeat',
    recordId: repeatId,
    existingTriggerId: existingId,
    idempotencyKey: trigger.idempotencyKey,
  });
  return {
    outcome: 'repeat',
    result: {
      idempotencyKey: trigger.idempotencyKey,
      outcome: 'repeat',
      triggerRecordId: existingId,
      repeatRecordId: repeatId,
    },
  };
}

// ---------------------------------------------------------------------------
// Шаг 4: подобрать pending intent.problem — старые проблемы без intent.diagnosis
// (linkType='заключение' ещё не создан) за окно 7 дней. Используется на пустой
// инпут (empty-detector) и на формирование problemIds для investigateMany.
// ---------------------------------------------------------------------------

const PENDING_WINDOW_DAYS = 7;

async function selectPendingProblemIds(db: PrismaClient): Promise<string[]> {
  const cutoff = Date.now() - PENDING_WINDOW_DAYS * 86_400_000;
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT p.id FROM "Record" p
      WHERE p.type = 'intent.problem'
        AND p.status = 'active'
        AND p.createdAt >= ?
        AND NOT EXISTS (
          SELECT 1 FROM "RecordLink" rl
           WHERE rl.toRecordId = p.id AND rl.linkType = 'заключение'
        )`,
    cutoff,
  );
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Шаг 6: загрузить только что вставленные event.support.message за окно
// [sinceMs, untilMs]. sinceMs=0 в первый запуск (нет ни одного предыдущего
// event.support.message → берём всё, что только что появилось).
// ---------------------------------------------------------------------------

async function loadInsertedSupport(
  db: PrismaClient,
  args: { sinceMs: number; untilMs: number },
): Promise<SupportMessage[]> {
  const rows = await db.$queryRawUnsafe<Array<{ id: string; properties: string }>>(
    `SELECT id, properties FROM "Record"
      WHERE type = 'event.support.message'
        AND createdAt > ?
        AND createdAt <= ?
      ORDER BY createdAt ASC`,
    args.sinceMs,
    args.untilMs,
  );
  const out: SupportMessage[] = [];
  for (const row of rows) {
    try {
      const props = JSON.parse(row.properties) as {
        chatId: string;
        messageId: number;
        userId: string | null;
        username: string | null;
        text: string;
        attachments: Array<{ type: 'voice'; file_id: string; transcribed?: boolean }>;
        timestamp: number;
      };
      out.push({
        id: row.id,
        chatId: props.chatId,
        messageId: props.messageId,
        userId: props.userId,
        username: props.username,
        text: props.text,
        attachments: (props.attachments ?? []).map((a) => ({
          type: a.type,
          file_id: a.file_id,
          transcribed: a.transcribed === true,
        })),
        timestamp: props.timestamp,
      });
    } catch {
      // Битый JSON — пропускаем (лог в БД, не валим pipeline).
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Шаг 7: триаж. Fail-soft на BudgetExceeded (продолжаем без новых проблем,
// pendingProblemIds всё ещё работают). Fail-fast на других ошибках.
// ---------------------------------------------------------------------------

interface TriageOutcome {
  result: {
    problems: { summary: string; symptoms: string[]; supportMessageIds: string[] }[];
    spendRecordId: string;
    usd: number;
    durationMs: number;
  } | null;
}

async function runTriageStep(
  deps: RunIterationDeps,
  messages: SupportMessage[],
  db: PrismaClient,
): Promise<TriageOutcome> {
  if (messages.length === 0) return { result: null };
  const impl = deps.extractProblems ?? extractProblems;
  try {
    const result = await impl(messages, { db });
    return { result };
  } catch (err) {
    if (isBudgetError(err)) {
      // Fail-soft: продолжаем без триажа. Pending проблемы пойдут в investigate.
      // audit.budget.deny уже записан guard'ом call.ts.
      return { result: null };
    }
    // Любая другая ошибка триажа — fail-fast наверх (catch в runIteration).
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Шаг 11: канонический фильтр «диагнозы для решателя» из 2.3c-стратегии (C).
// verdict='code' AND status='active' AND NOT EXISTS inverse 'решает'.
// ---------------------------------------------------------------------------

async function selectAwaitingCodeDiagnoses(
  db: PrismaClient,
  diagnosisIds: string[],
): Promise<string[]> {
  if (diagnosisIds.length === 0) return [];
  const placeholders = diagnosisIds.map(() => '?').join(',');
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT d.id FROM "Record" d
      WHERE d.id IN (${placeholders})
        AND d.type = 'intent.diagnosis'
        AND json_extract(d.properties, '$.verdict') = 'code'
        AND d.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM "RecordLink" rl
           WHERE rl.toRecordId = d.id AND rl.linkType = 'решает'
        )`,
    ...diagnosisIds,
  );
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Шаг 13: собрать reportItems из materialized данных.
// ---------------------------------------------------------------------------

interface AssembleArgs {
  problemIds: string[];
  fanout: Awaited<ReturnType<typeof investigateMany>>;
  persistInvestigate: Awaited<ReturnType<typeof persistFanoutResult>>;
  solveBatch: Awaited<ReturnType<typeof runSolveBatch>> | null;
}

async function assembleItems(db: PrismaClient, args: AssembleArgs): Promise<ReportItem[]> {
  const items: ReportItem[] = [];

  // Карта problemId → summary (берём из intent.problem.properties).
  const summaryByProblem = await loadProblemSummaries(db, args.problemIds);

  // Карта problemId → diagnosis (по successful results из fanout).
  const diagnosisByProblem = new Map<
    string,
    { id: string; verdict: 'code' | 'human' | 'unclear'; rationale: string }
  >();
  for (let i = 0; i < args.fanout.results.length; i++) {
    const r = args.fanout.results[i];
    const diagnosisId = args.persistInvestigate.diagnosesCreated[i];
    if (r === undefined || diagnosisId === undefined) continue;
    diagnosisByProblem.set(r.problemId, {
      id: diagnosisId,
      verdict: r.verdict,
      rationale: r.rationale,
    });
  }

  // Карта diagnosisId → proposal (по successful results из solveBatch).
  const proposalByDiagnosis = new Map<
    string,
    {
      id: string;
      asIs: string;
      problem: string;
      asWillBe: string;
      files: ReportItemCodeWithProposal['files'];
      estimateMinutes: number;
    }
  >();
  if (args.solveBatch !== null) {
    for (let i = 0; i < args.solveBatch.fanout.results.length; i++) {
      const r = args.solveBatch.fanout.results[i];
      const proposalId = args.solveBatch.persist.proposalsCreated[i];
      if (r === undefined || proposalId === undefined) continue;
      proposalByDiagnosis.set(r.diagnosisId, {
        id: proposalId,
        asIs: r.asIs,
        problem: r.problem,
        asWillBe: r.asWillBe,
        files: r.files,
        estimateMinutes: r.estimateMinutes,
      });
    }
  }

  // Карта problemId → failure (audit.investigate.failed для problemId).
  const investigateFailureByProblem = new Map<string, string>();
  for (const f of args.fanout.failures) {
    investigateFailureByProblem.set(f.problemId, f.message);
  }

  // Карта diagnosisId → failure (audit.solve.failed).
  const solveFailureByDiagnosis = new Map<string, string>();
  if (args.solveBatch !== null) {
    for (const f of args.solveBatch.fanout.failures) {
      solveFailureByDiagnosis.set(f.diagnosisId, f.message);
    }
  }

  // На каждый problemId один item — самый информативный из доступного.
  for (const problemId of args.problemIds) {
    const summary = summaryByProblem.get(problemId) ?? '<без summary>';
    // 1. failure исследователя — приоритет: исследователь упал, дальше нечего.
    const investigateFail = investigateFailureByProblem.get(problemId);
    if (investigateFail !== undefined) {
      const item: ReportItemFailure = {
        kind: 'failure',
        problemId,
        summary,
        step: 'investigate',
        message: investigateFail,
      };
      items.push(item);
      continue;
    }
    const diag = diagnosisByProblem.get(problemId);
    if (diag === undefined) {
      // diagnosis нет, failure нет — вероятно deferred. На отчёт не выводим
      // (счётчик deferred уже в шапке).
      continue;
    }
    if (diag.verdict === 'human') {
      const item: ReportItemHuman = {
        kind: 'human',
        problemId,
        summary,
        diagnosisId: diag.id,
        rationale: diag.rationale,
      };
      items.push(item);
      continue;
    }
    if (diag.verdict === 'unclear') {
      const item: ReportItemUnclear = {
        kind: 'unclear',
        problemId,
        summary,
        diagnosisId: diag.id,
        rationale: diag.rationale,
      };
      items.push(item);
      continue;
    }
    // verdict='code'.
    // Failure решателя — выводим как failure step='solve'.
    const solveFail = solveFailureByDiagnosis.get(diag.id);
    if (solveFail !== undefined) {
      const item: ReportItemFailure = {
        kind: 'failure',
        problemId,
        summary,
        step: 'solve',
        message: solveFail,
      };
      items.push(item);
      continue;
    }
    const proposal = proposalByDiagnosis.get(diag.id);
    if (proposal !== undefined) {
      const item: ReportItemCodeWithProposal = {
        kind: 'code',
        problemId,
        summary,
        diagnosisId: diag.id,
        rationale: diag.rationale,
        proposalId: proposal.id,
        asIs: proposal.asIs,
        problem: proposal.problem,
        asWillBe: proposal.asWillBe,
        files: proposal.files,
        estimateMinutes: proposal.estimateMinutes,
      };
      items.push(item);
      continue;
    }
    // verdict='code' без proposal'а — diagnosis записан, решатель не дошёл
    // (deferred / не запускался).
    const item: ReportItemCodeNoProposal = {
      kind: 'code-no-proposal',
      problemId,
      summary,
      diagnosisId: diag.id,
      rationale: diag.rationale,
    };
    items.push(item);
  }

  return items;
}

async function loadProblemSummaries(
  db: PrismaClient,
  problemIds: string[],
): Promise<Map<string, string>> {
  if (problemIds.length === 0) return new Map();
  const placeholders = problemIds.map(() => '?').join(',');
  const rows = await db.$queryRawUnsafe<Array<{ id: string; properties: string }>>(
    `SELECT id, properties FROM "Record" WHERE type = 'intent.problem' AND id IN (${placeholders})`,
    ...problemIds,
  );
  const out = new Map<string, string>();
  for (const row of rows) {
    try {
      const props = JSON.parse(row.properties) as { summary?: string };
      const s = typeof props.summary === 'string' ? props.summary : '';
      out.set(row.id, s);
    } catch {
      // битый JSON — пропускаем
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Audit Records.
// ---------------------------------------------------------------------------

interface AuditReportSentInput {
  eventTriggerId: string;
  parentSession: string;
  messages: TelegramMessage[];
  stats: ReportStats;
  items: ReportItem[];
  sentMessageIds: number[];
  durationMs: number;
  nowMs: number;
  mentioned: { problemIds: string[]; diagnosisIds: string[]; proposalIds: string[] };
}

async function insertAuditReportSent(
  db: PrismaClient,
  input: AuditReportSentInput,
): Promise<string> {
  const id = ulid();
  const counts = {
    code: 0,
    human: 0,
    unclear: 0,
    failure: 0,
  };
  for (const item of input.items) {
    if (item.kind === 'code' || item.kind === 'code-no-proposal') counts.code += 1;
    else if (item.kind === 'human') counts.human += 1;
    else if (item.kind === 'unclear') counts.unclear += 1;
    else if (item.kind === 'failure') counts.failure += 1;
  }
  const properties = JSON.stringify({
    parentSession: input.parentSession,
    eventTriggerId: input.eventTriggerId,
    messagesCount: input.messages.length,
    problemsTotal: input.items.length,
    problemsByVerdict: counts,
    deferred: input.stats.deferred,
    totalUsdSpent: input.stats.totalUsdSpent,
    totalTokensSpent: input.stats.totalTokensSpent,
    durationMs: input.durationMs,
    mentionedProblemIds: input.mentioned.problemIds,
    mentionedDiagnosisIds: input.mentioned.diagnosisIds,
    mentionedProposalIds: input.mentioned.proposalIds,
    telegramMessageIds: input.sentMessageIds,
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, parentId, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.report.sent', ?, ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    properties,
    input.eventTriggerId,
    input.nowMs,
    input.nowMs,
  );
  return id;
}

interface AuditReportEmptyInput {
  eventTriggerId: string;
  parentSession: string;
  telegramMessageIds: number[];
  nowMs: number;
}

async function insertAuditReportEmpty(
  db: PrismaClient,
  input: AuditReportEmptyInput,
): Promise<string> {
  const id = ulid();
  const properties = JSON.stringify({
    parentSession: input.parentSession,
    eventTriggerId: input.eventTriggerId,
    telegramMessageIds: input.telegramMessageIds,
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, parentId, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.report.empty', ?, ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    properties,
    input.eventTriggerId,
    input.nowMs,
    input.nowMs,
  );
  return id;
}

interface AuditFailedInput {
  eventTriggerId: string;
  parentSession: string;
  step: RunIterationStep | string;
  err: unknown;
  nowMs: number;
}

async function insertRunIterationFailed(
  db: PrismaClient,
  input: AuditFailedInput,
): Promise<string> {
  const id = ulid();
  const errorClass = input.err instanceof Error ? input.err.constructor.name : 'UnknownError';
  const message = input.err instanceof Error ? input.err.message : String(input.err);
  const stack = input.err instanceof Error ? input.err.stack : undefined;
  const properties = JSON.stringify({
    parentSession: input.parentSession,
    eventTriggerId: input.eventTriggerId,
    step: input.step,
    errorClass,
    message,
    stack: stack !== undefined ? stack.split('\n').slice(0, 10).join('\n') : null,
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, parentId, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.runIteration.failed', ?, ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    properties,
    input.eventTriggerId,
    input.nowMs,
    input.nowMs,
  );
  return id;
}

interface AuditReportSendFailedInput {
  eventTriggerId: string;
  parentSession: string;
  err: unknown;
  nowMs: number;
}

async function insertAuditReportSendFailed(
  db: PrismaClient,
  input: AuditReportSendFailedInput,
): Promise<string> {
  const id = ulid();
  const errorClass = input.err instanceof Error ? input.err.constructor.name : 'UnknownError';
  const message = input.err instanceof Error ? input.err.message : String(input.err);
  const properties = JSON.stringify({
    parentSession: input.parentSession,
    eventTriggerId: input.eventTriggerId,
    errorClass,
    message,
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, parentId, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.report.send.failed', ?, ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    properties,
    input.eventTriggerId,
    input.nowMs,
    input.nowMs,
  );
  return id;
}

// ---------------------------------------------------------------------------
// Утилиты.
// ---------------------------------------------------------------------------

async function emitStep(eventTriggerId: string, step: RunIterationStep): Promise<void> {
  await emit({ type: 'runIteration.step', eventTriggerId, step });
}

function inferStepFromError(err: unknown): RunIterationStep | string {
  // Stack-based heuristic — лучше чем «просто скажи runIteration». Однако
  // надёжнее опираться на name класса, если он есть, ведь разные ошибки
  // приходят с разных шагов. На практике для отчёта достаточно первой
  // строки stack'а; для audit'а есть полный.
  if (err instanceof Error) {
    const name = err.constructor.name;
    if (name.startsWith('Triage')) return 'triage';
    if (name.startsWith('Investigate')) return 'investigate';
    if (name.startsWith('Solve')) return 'solve';
    if (name.includes('SupportBotToken')) return 'fetch';
    if (name === 'BudgetExceededError') return 'triage';
  }
  return 'unknown';
}

function isBudgetError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.constructor.name === 'BudgetExceededError') return true;
  if (err.name === 'BudgetExceededError') return true;
  return false;
}

async function safeSend(
  sendImpl: typeof sendReport,
  messages: TelegramMessage[],
  rootDir: string | undefined,
  onError: () => void,
): Promise<number[]> {
  try {
    const result = await sendImpl(messages, {});
    return result.sentMessageIds;
  } catch {
    onError();
    return [];
  }
}
