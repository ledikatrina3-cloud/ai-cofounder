// Routine dispatcher (фаза 1.3 нового плана `plans/`).
//
// Заменяет hardcoded pipeline `runIteration` (src/core/loop.ts — теперь
// deprecated wrapper) на универсальный движок `runRoutine`. Один и тот же
// dispatcher запускает ЛЮБУЮ routine: и `example-noop`, и будущий
// `support-triage` / `db-morning-triage` / `metrics-weekly`.
//
// Контракт:
//   * runRoutine(routineId, runDate, trigger) — вход для cron-job'а 1.4 и
//     `pnpm dev:run`. Идемпотентность через trigger.idempotencyKey:
//       - cron: `routine:<id>:<YYYY-MM-DD>` — повторный launchd → audit.repeat.
//       - manual: `routine:<id>:manual:<ULID>` — каждый /run уникален.
//   * Любой исход (skipped / repeat / noop) → ровно один audit Record + один
//     emit `routine.end`. Никаких «тихих» путей выхода — Bridge всегда видит
//     событие.
//
// M1' стратегия:
//   * Tools, sub-agent, real prompt — НЕТ. Это M3'. Сейчас тело — stub,
//     который пишет audit.routine.start + audit.routine.end (reason='noop-stub').
//   * Cost-tracking per routine — фаза 1.5. Сейчас не пробрасывается.
//
// Записи Record, которые пишет dispatcher (новые типы, не входят в whitelist
// валидатора invariants-check.ts — это нормально, тип-дискриминатор + JSON
// properties, без изменений колонок Record):
//   * `event.routine.trigger` — UPSERT, idempotencyKey UNIQUE через партишн-индекс
//     (см. миграцию 20260502000000_event_routine_trigger_unique). Один на каждый
//     уникальный trigger.idempotencyKey.
//   * `audit.repeat` — на конфликт UNIQUE'а. parentId → существующий
//     event.routine.trigger. Тип уже использовался старым runIteration; здесь
//     re-use тот же тип, properties.kind отличает повтор routine от повтора
//     старого event.trigger.
//   * `audit.routine.skipped` — на disabled routine, disabled project, или
//     отсутствующую routine/project. parentId=null (нет event.routine.trigger).
//   * `audit.routine.start` — после успешного UPSERT'а event.routine.trigger.
//     parentId → event.routine.trigger.id. Маркер «dispatcher запустил тело».
//   * `audit.routine.end` — последняя точка пайплайна (всегда пишется при
//     accepted-исходе). reason хранит status: 'noop' для stub'а, в M3' будет
//     'ok'/'failed'.
//
// Почему НЕ возвращаем результат: контракт DoD из плана —
// `runRoutine(routineId, runDate, trigger): Promise<void>`. Любой потребитель
// (CLI, cron, Telegram /run) делает решение по audit.* Records или по
// emit'ам Bridge. Это убирает соблазн «делегировать решение в caller».

import { ulid } from 'ulid';
import { type PrismaClient, getPrisma } from '../db/client.js';
import { checkDepartmentDailyBudget } from '../llm/department-budget.js';
import { emit } from '../observe/bridge.js';
import { getProject } from '../projects/registry.js';
import { renderRoutineOutput } from '../report/render.js';
import type { Routine } from '../routines/parser.js';
import { getRoutine, listRoutines } from '../routines/registry.js';
import type { ExecRoutineDeps } from '../routines/runtime.js';
import { executeRoutine, resolveRoutineSkills } from '../routines/runtime.js';
import { getAllowlist, getBotToken } from '../telegram/secrets.js';
import type { RunRoutineTrigger } from './triggers.js';

// ---------------------------------------------------------------------------
// DI: тестам нужно подменить getRoutine/getProject + db + clock. Прод —
// defaults.
// ---------------------------------------------------------------------------

export interface RunRoutineDeps {
  db?: PrismaClient;
  now?: () => number;
  // DI-шапки реестров: тестам удобнее подменить целый getRoutine/getProject,
  // чем тащить fixture-cwd через настройки реестров. Прод собирает defaults.
  getRoutine?: (id: string) => Promise<Routine | null>;
  getProject?: (id: string) => Promise<Awaited<ReturnType<typeof getProject>>>;
  // DI для executeRoutine (M3'). Если не передан — используется реальный.
  // Тесты dispatcher'а не должны дёргать настоящий sub-agent.
  execRoutineDeps?: ExecRoutineDeps;
  // Прямой DI для всей executeRoutine (для тестов dispatcher'а).
  // Если передан — полностью заменяет вызов executeRoutine.
  executeRoutineImpl?: typeof executeRoutine;
  // DI для отправки сообщений фаундеру (фаза 3.3).
  // Если передан — используется вместо реального Telegram-вызова.
  // Best-effort: ошибки логируются, но не прерывают пайплайн.
  sendToFounder?: (text: string) => Promise<void>;
  // DI для department-budget guard'а (Фаза 5 п. 8). Тесты подменяют
  // listRoutines, чтобы не тащить всю файловую систему. Если не задан —
  // используется реальный listRoutines из routines/registry.
  listRoutinesFn?: () => Promise<Routine[]>;
}

export type SkipReason =
  | 'routine-not-found'
  | 'routine-disabled'
  | 'project-not-found'
  | 'project-disabled';

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export async function runRoutine(
  routineId: string,
  runDate: string,
  trigger: RunRoutineTrigger,
  deps: RunRoutineDeps = {},
): Promise<void> {
  const db = deps.db ?? getPrisma();
  const nowFn = deps.now ?? Date.now;
  const startedAt = nowFn();

  // Bridge видит routine ВСЕГДА — даже если её нет, даже если skipped.
  await emit({
    type: 'routine.start',
    routineId,
    runDate,
    trigger: { source: trigger.source, idempotencyKey: trigger.idempotencyKey },
  });

  // ── 1. Загружаем routine. null → audit.routine.skipped + ранний выход. ──
  const routineLoader = deps.getRoutine ?? ((id: string) => getRoutine(id));
  const routine = await routineLoader(routineId);
  if (routine === null) {
    await skipAndEmit({
      db,
      routineId,
      runDate,
      reason: 'routine-not-found',
      startedAt,
      nowFn,
    });
    return;
  }
  if (!routine.enabled) {
    await skipAndEmit({
      db,
      routineId,
      runDate,
      reason: 'routine-disabled',
      startedAt,
      nowFn,
    });
    return;
  }

  // ── 2. Загружаем project. Те же скип-ветки. ────────────────────────────
  const projectLoader = deps.getProject ?? ((id: string) => getProject(id));
  const project = await projectLoader(routine.projectId);
  if (project === null) {
    await skipAndEmit({
      db,
      routineId,
      runDate,
      reason: 'project-not-found',
      startedAt,
      nowFn,
    });
    return;
  }
  if (!project.enabled) {
    await skipAndEmit({
      db,
      routineId,
      runDate,
      reason: 'project-disabled',
      startedAt,
      nowFn,
    });
    return;
  }

  // ── 3. UPSERT event.routine.trigger через партишн-UNIQUE индекс. ───────
  const upsert = await upsertEventRoutineTrigger(db, {
    routineId,
    projectId: routine.projectId,
    runDate,
    trigger,
    nowMs: nowFn(),
  });

  if (upsert.outcome === 'repeat') {
    // На конфликт UNIQUE — audit.repeat и emit routine.end status='repeat'.
    await emit({
      type: 'routine.end',
      routineId,
      runDate,
      status: 'repeat',
      durationMs: nowFn() - startedAt,
    });
    return;
  }

  // ── 4. audit.routine.start — маркер «dispatcher принял routine». ───────
  //     Заодно — пред-резолв скиллов: имена идут в audit.routine.start.properties
  //     для отчётности (Фаза 2 плана 2026-05-21-skills-architecture-v3, п.5).
  //     Если резолв падает (missing skill, cycle, forceLoad mismatch) — fail
  //     fast: пишем audit.routine.end status='failed', не продолжаем.
  let skillNames: string[] = [];
  if (routine.skills !== undefined && routine.skills.length > 0) {
    try {
      const skillResolveImpl = deps.execRoutineDeps?.resolveSkillDeps;
      const resolved = await resolveRoutineSkills(routine, skillResolveImpl);
      skillNames = resolved.resolvedSkills.map((s) => s.name);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const durationMs = nowFn() - startedAt;
      await insertAuditRoutineEnd(db, {
        eventTriggerId: upsert.eventTriggerId,
        routineId,
        projectId: routine.projectId,
        runDate,
        status: 'failed',
        reason: `skill-resolve: ${reason}`,
        durationMs,
        nowMs: nowFn(),
      });
      await emit({
        type: 'routine.end',
        routineId,
        runDate,
        status: 'failed',
        reason: `skill-resolve: ${reason}`,
        durationMs,
      });
      return;
    }
  }

  await insertAuditRoutineStart(db, {
    eventTriggerId: upsert.eventTriggerId,
    routineId,
    projectId: routine.projectId,
    runDate,
    trigger,
    nowMs: nowFn(),
    skills: skillNames,
  });

  // ── 4b. Department-level budget guard (Фаза 5 п. 8 плана v3). ──────────
  //   Если у routine есть departmentId и DEPARTMENT.md объявляет budget —
  //   суммируем today's audit.spend по routines с тем же departmentId.
  //   Превышение perDayUsd → audit.budget.deny + audit.routine.end status='failed'.
  //   Без departmentId или без budget — pass-through. checkDepartment*Budget
  //   сам обрабатывает оба случая.
  if (routine.departmentId !== undefined) {
    try {
      const listFn = deps.listRoutinesFn ?? (() => listRoutines());
      const budgetCheck = await checkDepartmentDailyBudget(routine, listFn, { db });
      if (!budgetCheck.ok) {
        const reason = `department-cap: cap=$${(budgetCheck.cap ?? 0).toFixed(2)}, spent=$${(budgetCheck.current ?? 0).toFixed(2)}`;
        const durationMs = nowFn() - startedAt;
        await insertAuditRoutineEnd(db, {
          eventTriggerId: upsert.eventTriggerId,
          routineId,
          projectId: routine.projectId,
          runDate,
          status: 'failed',
          reason,
          durationMs,
          nowMs: nowFn(),
        });
        await emit({
          type: 'routine.end',
          routineId,
          runDate,
          status: 'failed',
          reason,
          durationMs,
        });
        return;
      }
    } catch (err) {
      // best-effort: ошибка budget-check'а НЕ блокирует routine.
      // (например, БД временно недоступна для $queryRawUnsafe). Лучше дать
      // routine отработать и упасть позже на global cap, чем заблокировать
      // нормальную работу из-за миграции.
      console.error(
        `[dispatcher] routine '${routineId}': department-budget check failed (best-effort, продолжаем):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ── 5. M3': executeRoutine — запуск sub-agent с tools из routine. ──────
  let execStatus: 'ok' | 'failed' | 'noop' = 'ok';
  let execReason = 'ok';

  const execFn = deps.executeRoutineImpl ?? executeRoutine;

  try {
    const result = await execFn(routine, project, runDate, {
      db,
      ...(deps.execRoutineDeps ?? {}),
    });

    execStatus = result.status === 'ok' ? 'ok' : 'failed';
    execReason = result.status;

    await insertAuditRoutineEnd(db, {
      eventTriggerId: upsert.eventTriggerId,
      routineId,
      projectId: routine.projectId,
      runDate,
      status: execStatus,
      reason: execReason,
      durationMs: result.durationMs,
      nowMs: nowFn(),
      output: result.output,
    });

    await emit({
      type: 'routine.end',
      routineId,
      runDate,
      status: execStatus === 'ok' ? 'ok' : 'failed',
      reason: execReason,
      durationMs: result.durationMs,
    });

    // ── 6. Фаза 3.3: отправляем output в Telegram если нужно. ─────────────
    if (routine.outputType === 'telegram-thread' || routine.outputType === 'both') {
      try {
        const messages = await renderRoutineOutput(routine, result);
        const sender = deps.sendToFounder ?? buildDefaultSendToFounder(db);
        for (const msg of messages) {
          await sender(msg.text);
        }
      } catch (sendErr) {
        // best-effort: отправка в Telegram не фатальна — логируем и продолжаем.
        console.error(
          `[dispatcher] routine '${routineId}': ошибка отправки в Telegram (best-effort):`,
          sendErr instanceof Error ? sendErr.message : String(sendErr),
        );
      }
    }
  } catch (err) {
    // executeRoutine бросил (например, BudgetExceededError или ошибка сети).
    // Перехватываем, пишем audit.routine.end status='failed', emit failed.
    const reason = err instanceof Error ? err.message : String(err);
    const durationMs = nowFn() - startedAt;

    await insertAuditRoutineEnd(db, {
      eventTriggerId: upsert.eventTriggerId,
      routineId,
      projectId: routine.projectId,
      runDate,
      status: 'failed',
      reason,
      durationMs,
      nowMs: nowFn(),
    });

    await emit({
      type: 'routine.end',
      routineId,
      runDate,
      status: 'failed',
      reason,
      durationMs,
    });

    // Не перебрасываем — dispatcher молчаливо завершает с audit-следом.
  }
}

// ---------------------------------------------------------------------------
// Фаза 3.3: отправка сообщения фаундеру через реальный Telegram-клиент.
// ---------------------------------------------------------------------------

function buildDefaultSendToFounder(_db: PrismaClient): (text: string) => Promise<void> {
  return async (text: string) => {
    const allowlist = await getAllowlist();
    const chatId = allowlist[0];
    if (chatId === undefined) {
      throw new Error(
        'dispatcher: sendToFounder — founder chat не настроен (пустой allowlist). Запусти `pnpm pair`.',
      );
    }
    const token = await getBotToken();
    // Ленивый импорт grammy — тесты, которые подменяют sendToFounder через DI,
    // не загружают grammy в process.
    const { Bot } = await import('grammy');
    const bot = new Bot(token);
    try {
      await bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (err) {
      // Markdown-parse error от Telegram (400: can't parse entities) случается
      // когда в тексте несбалансированы `_`, `*` или есть незакрытый ```.
      // Фаундер всё равно должен получить сообщение — отправляем plain text
      // как fallback. Прецедент: 2026-05-22, routine marketing-content-example
      // (agent обернул финал в ``` → Telegram отверг весь Markdown).
      const msg = err instanceof Error ? err.message : String(err);
      const isParseError = msg.includes("can't parse entities") || msg.includes('parse entities');
      if (!isParseError) throw err;
      console.warn(`[dispatcher] Markdown parse failed (${msg}), retrying as plain text.`);
      await bot.api.sendMessage(chatId, text);
    }
  };
}

// ---------------------------------------------------------------------------
// Шаг 3: UPSERT event.routine.trigger (партишн-UNIQUE контракт). Аналог
// upsertEventTrigger из src/core/loop.ts, но под новый тип Record.
// ---------------------------------------------------------------------------

interface UpsertRoutineTriggerArgs {
  routineId: string;
  projectId: string;
  runDate: string;
  trigger: RunRoutineTrigger;
  nowMs: number;
}

interface UpsertRoutineTriggerResult {
  outcome: 'accepted' | 'repeat';
  eventTriggerId: string; // id новой (accepted) или существующей (repeat) Записи
}

async function upsertEventRoutineTrigger(
  db: PrismaClient,
  args: UpsertRoutineTriggerArgs,
): Promise<UpsertRoutineTriggerResult> {
  const newId = ulid();
  const properties = JSON.stringify({
    routineId: args.routineId,
    projectId: args.projectId,
    runDate: args.runDate,
    source: args.trigger.source,
  });

  const inserted = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, idempotencyKey, status, createdAt)
     VALUES (?, 'event.routine.trigger', ?, 'system', 'autonomous', ?, 'active', ?)
     ON CONFLICT(idempotencyKey) DO NOTHING
     RETURNING id`,
    newId,
    properties,
    args.trigger.idempotencyKey,
    args.nowMs,
  );

  if (inserted.length === 1) {
    const acceptedId = inserted[0]?.id ?? newId;
    return { outcome: 'accepted', eventTriggerId: acceptedId };
  }

  // Конфликт UNIQUE → ищем существующий event.routine.trigger по
  // idempotencyKey, пишем audit.repeat со связью parentId.
  const existing = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "Record"
      WHERE type = 'event.routine.trigger' AND idempotencyKey = ?`,
    args.trigger.idempotencyKey,
  );
  const existingId = existing[0]?.id;
  if (existingId === undefined) {
    // Это означает, что глобальный UNIQUE Record_idempotencyKey_key поймал
    // конфликт с записью ДРУГОГО типа (event.trigger или event.support.message).
    // Это или баг (пересечение namespace'ов), или фаундер сделал что-то странное
    // (вручную INSERT'нул в БД). Падаем громко — лучше явный crash, чем silent
    // skip с потерей audit-следа.
    throw new Error(
      `runRoutine: idempotencyKey '${args.trigger.idempotencyKey}' конфликтует, но event.routine.trigger с таким ключом не найдена. Возможно, пересечение namespace'ов c другим типом event.* — проверь триггер-адаптеры.`,
    );
  }

  const repeatId = ulid();
  const repeatProperties = JSON.stringify({
    kind: 'routine.repeat',
    routineId: args.routineId,
    projectId: args.projectId,
    runDate: args.runDate,
    source: args.trigger.source,
    idempotencyKey: args.trigger.idempotencyKey,
    triggerRecordId: existingId,
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, parentId, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.repeat', ?, ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    repeatId,
    repeatProperties,
    existingId,
    args.nowMs,
    args.nowMs,
  );
  await emit({
    type: 'audit.repeat',
    recordId: repeatId,
    existingTriggerId: existingId,
    idempotencyKey: args.trigger.idempotencyKey,
  });

  return { outcome: 'repeat', eventTriggerId: existingId };
}

// ---------------------------------------------------------------------------
// audit.* Records.
// ---------------------------------------------------------------------------

interface SkipArgs {
  db: PrismaClient;
  routineId: string;
  runDate: string;
  reason: SkipReason;
  startedAt: number;
  nowFn: () => number;
}

async function skipAndEmit(args: SkipArgs): Promise<void> {
  const id = ulid();
  const nowMs = args.nowFn();
  const properties = JSON.stringify({
    routineId: args.routineId,
    runDate: args.runDate,
    reason: args.reason,
  });
  await args.db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.routine.skipped', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    properties,
    nowMs,
    nowMs,
  );
  await emit({
    type: 'routine.end',
    routineId: args.routineId,
    runDate: args.runDate,
    status: 'skipped',
    reason: args.reason,
    durationMs: args.nowFn() - args.startedAt,
  });
}

interface AuditRoutineStartArgs {
  eventTriggerId: string;
  routineId: string;
  projectId: string;
  runDate: string;
  trigger: RunRoutineTrigger;
  nowMs: number;
  /**
   * Имена скиллов (после resolveDeps, включая транзитивные deps), которые
   * routine инжектит в свой system prompt. Пустой массив — routine скиллы не
   * объявил. Фаза 2 плана 2026-05-21-skills-architecture-v3, п.5.
   */
  skills?: string[];
}

async function insertAuditRoutineStart(
  db: PrismaClient,
  args: AuditRoutineStartArgs,
): Promise<string> {
  const id = ulid();
  const properties = JSON.stringify({
    routineId: args.routineId,
    projectId: args.projectId,
    runDate: args.runDate,
    source: args.trigger.source,
    idempotencyKey: args.trigger.idempotencyKey,
    eventTriggerId: args.eventTriggerId,
    ...(args.skills !== undefined ? { skills: args.skills } : {}),
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, parentId, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.routine.start', ?, ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    properties,
    args.eventTriggerId,
    args.nowMs,
    args.nowMs,
  );
  return id;
}

interface AuditRoutineEndArgs {
  eventTriggerId: string;
  routineId: string;
  projectId: string;
  runDate: string;
  status: 'noop' | 'ok' | 'failed';
  reason: string;
  durationMs: number;
  nowMs: number;
  /** Финальный текст от sub-agent (последнее assistant-сообщение). Для UI/transcript. */
  output?: string;
}

async function insertAuditRoutineEnd(db: PrismaClient, args: AuditRoutineEndArgs): Promise<string> {
  const id = ulid();
  // output укорачиваем до 8000 символов: при таком лимите Record остаётся
  // компактным, но финальный отчёт routine'ы помещается. Длиннее — обрезаем
  // и помечаем (transcript-UI покажет хвост '...').
  const outputClipped =
    typeof args.output === 'string'
      ? args.output.length > 8000
        ? `${args.output.slice(0, 8000)}…[truncated]`
        : args.output
      : undefined;
  const properties = JSON.stringify({
    routineId: args.routineId,
    projectId: args.projectId,
    runDate: args.runDate,
    status: args.status,
    reason: args.reason,
    durationMs: args.durationMs,
    eventTriggerId: args.eventTriggerId,
    ...(outputClipped !== undefined ? { output: outputClipped } : {}),
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, parentId, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.routine.end', ?, ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    properties,
    args.eventTriggerId,
    args.nowMs,
    args.nowMs,
  );
  return id;
}
