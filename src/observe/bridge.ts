// Bridge-эмиттер на стороне AI-Cofounder. Единственная точка, через которую
// runIteration и любые будущие способности (M2/M3) шлют события в Bridge.
//
// Контракт:
//   * emit(event) — fire-and-forget. Возвращает Promise<void>, который никогда
//     не throw'ит. Если Bridge выключен / порт занят / сеть молчит — событие
//     теряется тихо. Это намеренно: runIteration не должен падать из-за того,
//     что фаундер не открыл Bridge.app.
//   * timeout жёсткий: AbortSignal.timeout(50). 50мс согласовано с
//     plans/ фаза 1.5b (мостик.md L536 — рекомендация
//     для fire-and-forget POST). Под нагрузкой M2 (fan-out 3 sub-агентов × ~1
//     событие/сек) этого с запасом хватает на localhost.
//   * redaction обязательна — все строки события прогоняются через
//     redactSecrets перед сериализацией. См. src/observe/redaction.ts.
//
// Архитектурный crumb из retrospective 1.4:
//   "hook должен лежать в src/observe/, не в src/core/ (loop остаётся пустым
//    контрактом, observability — поверх)"
// — этот файл и есть тот hook. src/core/loop.ts только зовёт emit(); вся
// сетевая логика, redaction, fail-soft — здесь.

import { bridgeBaseUrl } from '../config/bridge.js';
import { redactSecrets } from './redaction.js';

// Контракт BridgeEvent дублирует bridge/events.ts — копия живёт здесь, потому
// что src/ не должен зависеть от bridge/ (Electron-deps). Дисциплина: при
// изменении bridge/events.ts синхронизировать обе копии.

export type BridgeEventSource = 'cofounder' | 'claude-code-hooks' | 'demo' | 'test';

interface BridgeEventBase {
  ts: number;
  source: BridgeEventSource;
}

export interface EventTriggerEvent extends BridgeEventBase {
  type: 'event.trigger';
  recordId: string;
  triggerSource: string;
  idempotencyKey: string;
}

export interface AuditRepeatEvent extends BridgeEventBase {
  type: 'audit.repeat';
  recordId: string;
  existingTriggerId: string;
  idempotencyKey: string;
}

// Sub-agent (фаза 2.3a — обёртка исследователя; 2.3b пристыкует fan-out).
// Аддитивно к 1.5b базовой схеме: problemId + parentSession в start, verdict +
// totalUsd + totalTokens + timedOut в end. Зеркало в `bridge/events.ts`
// синхронизировано.
export interface SubagentStartEvent extends BridgeEventBase {
  type: 'subagent.start';
  subagentId: string;
  subagentType: string;
  parentRecordId?: string;
  problemId?: string;
  parentSession?: string;
}

export interface SubagentEndEvent extends BridgeEventBase {
  type: 'subagent.end';
  subagentId: string;
  durationMs: number;
  verdict?: 'code' | 'human' | 'unclear' | string;
  totalUsd?: number;
  totalTokens?: number;
  timedOut?: boolean;
}

export interface ToolStartEvent extends BridgeEventBase {
  type: 'tool.start';
  toolId: string;
  name: string;
  input: unknown;
}

export interface ToolEndEvent extends BridgeEventBase {
  type: 'tool.end';
  toolId: string;
  output: unknown;
  durationMs: number;
}

export interface ToolErrorEvent extends BridgeEventBase {
  type: 'tool.error';
  toolId: string;
  error: string;
}

export interface AssistantMessageEvent extends BridgeEventBase {
  type: 'assistant.message';
  text: string;
}

// «Мысли» Claude между tool-calls — для облака мыслей в Office UI (plans/).
export interface AssistantThinkingEvent extends BridgeEventBase {
  type: 'assistant.thinking';
  workerId: string;
  text: string;
  done: boolean;
}

export interface AuditSpendEvent extends BridgeEventBase {
  type: 'audit.spend';
  recordId: string;
  promptId: string;
  model: string;
  usd: number;
}

export interface AuditBudgetDenyEvent extends BridgeEventBase {
  type: 'audit.budget.deny';
  recordId: string;
  limit: 'per-cycle' | 'daily' | 'monthly';
  cap: number;
  current: number;
}

// Telegram allowlist + старт бота (фаза 1.2). Чисто аддитивное расширение
// контракта BridgeEvent: server.ts/JSONL/Renderer не switch'ат по type, поэтому
// добавление вариантов не требует правки `bridge/server.ts` или существующих
// тестов (см. retrospectives/: «Расширение =
// добавить ветку в discriminated union + регенирить тесты. Сервер не патчится»).
// Зеркало в `bridge/events.ts` синхронизировано.
export interface AuditSecurityAllowEvent extends BridgeEventBase {
  type: 'audit.security.allow';
  // chatId nullable: middleware allowlist может пропустить и без chat (служебные
  // update'ы), хотя на практике allow без chatId маловероятен. Согласовано с
  // src/telegram/middleware.ts (chatIdStr: string | null).
  chatId: string | null;
  command: string;
}

export interface AuditSecurityDenyEvent extends BridgeEventBase {
  type: 'audit.security.deny';
  recordId: string;
  chatId: string | null;
  command: string;
}

export interface BotStartEvent extends BridgeEventBase {
  type: 'bot.start';
  processUlid: string;
  allowlistSize: number;
}

// Stateless-fetch support-бота (фаза 2.1b). Аддитивное расширение контракта:
// `support.fetch.start` эмитится в начале `fetchSupportMessages()`, `support.fetch.end`
// — после INSERT'ов и audit.fetch.support. Сервер/JSONL/Renderer не switch'ат по
// type, добавление вариантов не правит `bridge/server.ts` (см. ретро 1.5b).
// Зеркало в `bridge/events.ts` синхронизировано.
export interface SupportFetchStartEvent extends BridgeEventBase {
  type: 'support.fetch.start';
  // since=null означает «первый прогон, в журнале нет event.support.message».
  // ms-timestamp UTC, чтобы Bridge мог отрендерить как «с такого-то времени».
  since: number | null;
  chatIds: string[];
}

export interface SupportFetchEndEvent extends BridgeEventBase {
  type: 'support.fetch.end';
  // recordId — id Записи `audit.fetch.support`, которую только что создали.
  // Renderer'у удобно линковаться на неё для drill-down.
  recordId: string;
  messagesFound: number;
  messagesInserted: number;
  messagesDeduplicated: number;
  durationMs: number;
}

// Триаж (фаза 2.2a). Аддитивное расширение, как 1.5b/2.1b: сервер/JSONL/Renderer
// не switch'ат по type. Зеркало в `bridge/events.ts` синхронизировано.
export interface TriageExtractStartEvent extends BridgeEventBase {
  type: 'triage.extract.start';
  messagesIn: number;
  model: string;
  promptId: string;
}

export interface TriageExtractEndEvent extends BridgeEventBase {
  type: 'triage.extract.end';
  // null означает «вызов упал до записи audit.spend» (например, BudgetExceeded
  // до сетевого hop'а). В норме — id audit.spend Записи.
  spendRecordId: string | null;
  problemsOut: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  durationMs: number;
}

// Семантический мердж триажа (фаза 2.2b). Аддитивное расширение, как 2.2a:
// сервер/JSONL/Renderer не switch'ат по type. Зеркало в `bridge/events.ts`
// синхронизировано.
export interface TriageMergeStartEvent extends BridgeEventBase {
  type: 'triage.merge.start';
  problemsIn: number;
  embeddingProvider: string;
  threshold: number;
  windowDays: number;
}

export interface TriageMergeEndEvent extends BridgeEventBase {
  type: 'triage.merge.end';
  // recordId — id Записи `audit.triage.merge`, которую только что создали.
  recordId: string;
  problemsIn: number;
  created: number;
  merged: number;
  durationMs: number;
}

// Fan-out исследователя (фаза 2.3b). Аддитивное расширение, как 2.2a/2.2b/2.3a:
// сервер/JSONL/Renderer не switch'ат по type. Зеркало в `bridge/events.ts`
// синхронизировано. `parentSession` — общий ULID для всех `subagent.start/end`,
// которые fanout эмитит на каждый problemId внутри batch'а; UI группирует
// мини-ядра по этому полю.
export interface InvestigateBatchStartEvent extends BridgeEventBase {
  type: 'investigate.batch.start';
  parentSession: string;
  // Сколько problemIds пришло на вход (до soft-cap'а).
  problemsIn: number;
  concurrency: number;
}

export interface InvestigateBatchEndEvent extends BridgeEventBase {
  type: 'investigate.batch.end';
  parentSession: string;
  succeeded: number;
  failed: number;
  deferred: number;
  totalUsd: number;
  totalTokens: number;
  durationMs: number;
}

// Решатель — sub-agent предложения по одному intent.diagnosis (фаза 2.4a).
// Аддитивное расширение, как 2.3a/2.3b/2.3c: сервер/JSONL/Renderer не switch'ат
// по type. Зеркало в `bridge/events.ts` синхронизировано. Event'ы НЕ совпадают
// с subagent.start/end — у решателя другая семантика (одно предложение по одному
// диагнозу, не «батч по N проблемам»), и UI должен рисовать его отдельным узлом.
// `parentSession` — опционально: будет заполнено в 2.5, когда runIteration соберёт
// цепочку sessionId. Сейчас undefined.
export interface SolveStartEvent extends BridgeEventBase {
  type: 'solve.start';
  subagentId: string;
  diagnosisId: string;
  parentSession?: string;
}

export interface SolveEndEvent extends BridgeEventBase {
  type: 'solve.end';
  subagentId: string;
  durationMs: number;
  totalUsd: number;
  totalTokens: number;
  timedOut: boolean;
}

// Материализация результатов fan-out исследователя в журнал (фаза 2.3c).
// Аддитивное расширение, как 2.3b: сервер/JSONL/Renderer не switch'ат по type.
// Зеркало в `bridge/events.ts` синхронизировано. Эмитится один раз в конце
// persistFanoutResult — после всех INSERT'ов intent.diagnosis +
// audit.investigate.failed + RecordLink'ов. Связан с investigate.batch.* через
// общий `parentSession` из FanoutResult.
export interface DiagnosisPersistedEvent extends BridgeEventBase {
  type: 'diagnosis.persisted';
  parentSession: string;
  // Сколько intent.diagnosis Records создано (по одному на каждый results[i]).
  batchSize: number;
  // Сколько audit.investigate.failed Records создано (по одному на failures[i]).
  failuresAudited: number;
  // Сколько deferred прошло через fan-out — для UI это «попробуем завтра».
  // Здесь повторно НЕ пишется audit (сделано в 2.3b), только счётчик.
  deferredAlreadyAudited: number;
}

// Fan-out решателя (фаза 2.4b). Аддитивное расширение, как 2.3b: сервер/JSONL/
// Renderer не switch'ат по type. Зеркало в `bridge/events.ts` синхронизировано.
// `parentSession` — общий ULID для всех `solve.start/end` внутри batch'а; UI
// группирует фиолетовые ядра решателя одной плашкой. Не пересекается с
// `investigate.batch.*` — другая семантика, другая ширина (исследователь —
// «N проблем → N вердиктов», решатель — «K code-диагнозов → K предложений»).
export interface SolveBatchStartEvent extends BridgeEventBase {
  type: 'solve.batch.start';
  parentSession: string;
  // Сколько diagnosisIds пришло на вход (до soft-cap'а).
  diagnosesIn: number;
  concurrency: number;
}

export interface SolveBatchEndEvent extends BridgeEventBase {
  type: 'solve.batch.end';
  parentSession: string;
  succeeded: number;
  failed: number;
  deferred: number;
  totalUsd: number;
  totalTokens: number;
  durationMs: number;
}

// Материализация результатов fan-out решателя в журнал (фаза 2.4b — зеркало
// `bridge/events.ts`). Эмитится один раз в конце `persistSolveFanout` после
// INSERT'ов intent.proposal + audit.solve.failed + RecordLink'ов. Связан с
// `solve.batch.*` через общий `parentSession` из SolveFanoutResult.
export interface ProposalPersistedEvent extends BridgeEventBase {
  type: 'proposal.persisted';
  parentSession: string;
  // Сколько intent.proposal Records создано (по одному на каждый results[i]).
  batchSize: number;
  // Сколько audit.solve.failed Records создано (по одному на failures[i]).
  failuresAudited: number;
  // Сколько deferred прошло через fan-out — для UI «попробую следующим циклом».
  // Здесь повторно НЕ пишется audit (сделано в solveMany), только счётчик.
  deferredAlreadyAudited: number;
}

// runIteration события (фаза 2.5). Аддитивное расширение, как все предыдущие:
// сервер/JSONL/Renderer не switch'ат по type. Зеркало в `bridge/events.ts`
// синхронизировано. Эмитятся внутри `src/core/loop.ts` на ключевых точках
// сшивки pipeline'а utr-детектива (fetch → triage → merge → investigate →
// persist-investigate → solve → persist-solve → report). UI группирует все
// под-события (subagent.*, triage.*, investigate.batch.*, solve.batch.*,
// proposal.persisted, ...) в одну сессию через общий `eventTriggerId`.
export type RunIterationStep =
  | 'fetch'
  | 'triage'
  | 'merge'
  | 'investigate'
  | 'persist-investigate'
  | 'solve'
  | 'persist-solve'
  | 'report';

export interface RunIterationStartEvent extends BridgeEventBase {
  type: 'runIteration.start';
  triggerSource: string;
  idempotencyKey: string;
  eventTriggerId: string;
}

export interface RunIterationStepEvent extends BridgeEventBase {
  type: 'runIteration.step';
  eventTriggerId: string;
  step: RunIterationStep;
}

export interface RunIterationEndEvent extends BridgeEventBase {
  type: 'runIteration.end';
  eventTriggerId: string;
  status: 'ok' | 'empty' | 'failed';
  totalUsd: number;
  totalTokens: number;
  durationMs: number;
}

// Routine dispatcher (фаза 1.3 нового плана `routines.md`). Аддитивное
// расширение, как все предыдущие: сервер/JSONL/Renderer не switch'ат по type,
// добавление вариантов не правит `bridge/server.ts`. Зеркало в `bridge/events.ts`
// синхронизировано. Эмитятся внутри `src/core/dispatcher.ts` — start на входе,
// end после audit.routine.end (любой исход). UI группирует под-события (будущие
// subagent.*, tool.*) одной сессией через общий `routineId + runDate`.
export type RoutineEndStatus = 'noop' | 'skipped' | 'repeat' | 'ok' | 'failed';

export interface RoutineStartEvent extends BridgeEventBase {
  type: 'routine.start';
  routineId: string;
  runDate: string; // 'YYYY-MM-DD'
  trigger: { source: 'cron' | 'manual'; idempotencyKey: string };
}

export interface RoutineEndEvent extends BridgeEventBase {
  type: 'routine.end';
  routineId: string;
  runDate: string;
  status: RoutineEndStatus;
  // Опциональная причина — для status='skipped' (например 'routine-disabled',
  // 'project-not-found') или 'failed' (краткий human-readable).
  reason?: string;
  durationMs: number;
}

// Skills (Фаза 2 плана 2026-05-21-skills-architecture-v3). Аддитивное
// расширение, как все предыдущие. Зеркало в `bridge/events.ts` синхронизировано.
// skill.loaded — эмитится в executeRoutine при инжекции скилла в system prompt.
// skill.action.start/end — эмитятся когда скрипт скилла реально вызывается
// (на этой фазе — через canUseTool Bash hook, имя извлекается из
// `pnpm exec tsx skills/<name>/scripts/...`).
export interface SkillLoadedEvent extends BridgeEventBase {
  type: 'skill.loaded';
  routineId: string;
  skillName: string;
  displayName?: string;
  icon?: string;
  mode: 'discovery' | 'forceLoad';
}

export interface SkillActionStartEvent extends BridgeEventBase {
  type: 'skill.action.start';
  routineId: string;
  skillName: string;
  actionId: string;
  command: string;
}

export interface SkillActionEndEvent extends BridgeEventBase {
  type: 'skill.action.end';
  routineId: string;
  skillName: string;
  actionId: string;
  durationMs: number;
  exitCode?: number;
  isError: boolean;
}

// Skill health-check (Фаза 7 плана 2026-05-21-skills-architecture-v3).
// Аддитивное расширение, зеркало в `bridge/events.ts` синхронизировано.
// Эмитятся из `src/skills/health.ts` runHealthCheck() — `ok` когда скрипт
// вернул валидный JSON с status='ok' и exit=0, `failed` во всех других
// случаях (timeout / exit!=0 / status:failed / невалидный JSON).
export interface SkillHealthOkEvent extends BridgeEventBase {
  type: 'skill.health.ok';
  skillName: string;
  durationMs: number;
}

export interface SkillHealthFailedEvent extends BridgeEventBase {
  type: 'skill.health.failed';
  skillName: string;
  durationMs: number;
  error: string;
}

// Pipeline executor (Фаза 5 плана 2026-05-21-skills-architecture-v3).
// Аддитивное расширение; сервер не switch'ит по type. Зеркало в
// bridge/events.ts синхронизировано. UI группирует под-события (routine.*,
// pipeline.node.*) одной сессией через общий runId.
export type PipelineEndStatus = 'success' | 'failed' | 'skipped';

export interface PipelineStartEvent extends BridgeEventBase {
  type: 'pipeline.start';
  pipelineId: string;
  runId: string;
  runDate: string;
  nodeCount: number;
}

export interface PipelineNodeStartEvent extends BridgeEventBase {
  type: 'pipeline.node.start';
  pipelineId: string;
  runId: string;
  nodeId: string;
  kind: 'employee' | 'human-gate' | 'parallel';
}

export interface PipelineNodeEndEvent extends BridgeEventBase {
  type: 'pipeline.node.end';
  pipelineId: string;
  runId: string;
  nodeId: string;
  status: 'ok' | 'failed' | 'skipped' | 'waiting-for-approval';
  durationMs: number;
  reason?: string;
}

export interface PipelineEndEvent extends BridgeEventBase {
  type: 'pipeline.end';
  pipelineId: string;
  runId: string;
  status: PipelineEndStatus;
  durationMs: number;
}

export interface PipelineAlertEvent extends BridgeEventBase {
  type: 'pipeline.alert';
  pipelineId: string;
  runId: string;
  nodeId: string;
  reason?: string;
}

export interface PipelineRecoveredEvent extends BridgeEventBase {
  type: 'pipeline.recovered';
  pipelineId: string;
  runId: string;
  nodeId: string | null;
  /** Что executor сделал на старте: re-run / re-prompt / skip. */
  action: 're-run' | 're-prompt' | 'skip';
}

export type BridgeEvent =
  | EventTriggerEvent
  | AuditRepeatEvent
  | SubagentStartEvent
  | SubagentEndEvent
  | ToolStartEvent
  | ToolEndEvent
  | ToolErrorEvent
  | AssistantMessageEvent
  | AssistantThinkingEvent
  | AuditSpendEvent
  | AuditBudgetDenyEvent
  | AuditSecurityAllowEvent
  | AuditSecurityDenyEvent
  | BotStartEvent
  | SupportFetchStartEvent
  | SupportFetchEndEvent
  | TriageExtractStartEvent
  | TriageExtractEndEvent
  | TriageMergeStartEvent
  | TriageMergeEndEvent
  | InvestigateBatchStartEvent
  | InvestigateBatchEndEvent
  | DiagnosisPersistedEvent
  | SolveStartEvent
  | SolveEndEvent
  | SolveBatchStartEvent
  | SolveBatchEndEvent
  | ProposalPersistedEvent
  | RunIterationStartEvent
  | RunIterationStepEvent
  | RunIterationEndEvent
  | RoutineStartEvent
  | RoutineEndEvent
  | SkillLoadedEvent
  | SkillActionStartEvent
  | SkillActionEndEvent
  | SkillHealthOkEvent
  | SkillHealthFailedEvent
  | PipelineStartEvent
  | PipelineNodeStartEvent
  | PipelineNodeEndEvent
  | PipelineEndEvent
  | PipelineAlertEvent
  | PipelineRecoveredEvent;

// Тип ввода: type + источниковые поля. ts/source выставляются эмиттером, чтобы
// callsite не путался с Date.now() и не забыл source='cofounder'.
export type BridgeEventInput =
  | (Omit<EventTriggerEvent, 'ts' | 'source'> & { ts?: number; source?: BridgeEventSource })
  | (Omit<AuditRepeatEvent, 'ts' | 'source'> & { ts?: number; source?: BridgeEventSource })
  | (Omit<SubagentStartEvent, 'ts' | 'source'> & { ts?: number; source?: BridgeEventSource })
  | (Omit<SubagentEndEvent, 'ts' | 'source'> & { ts?: number; source?: BridgeEventSource })
  | (Omit<ToolStartEvent, 'ts' | 'source'> & { ts?: number; source?: BridgeEventSource })
  | (Omit<ToolEndEvent, 'ts' | 'source'> & { ts?: number; source?: BridgeEventSource })
  | (Omit<ToolErrorEvent, 'ts' | 'source'> & { ts?: number; source?: BridgeEventSource })
  | (Omit<AssistantMessageEvent, 'ts' | 'source'> & { ts?: number; source?: BridgeEventSource })
  | (Omit<AssistantThinkingEvent, 'ts' | 'source'> & { ts?: number; source?: BridgeEventSource })
  | (Omit<AuditSpendEvent, 'ts' | 'source'> & { ts?: number; source?: BridgeEventSource })
  | (Omit<AuditBudgetDenyEvent, 'ts' | 'source'> & { ts?: number; source?: BridgeEventSource })
  | (Omit<AuditSecurityAllowEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<AuditSecurityDenyEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<BotStartEvent, 'ts' | 'source'> & { ts?: number; source?: BridgeEventSource })
  | (Omit<SupportFetchStartEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<SupportFetchEndEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<TriageExtractStartEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<TriageExtractEndEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<TriageMergeStartEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<TriageMergeEndEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<InvestigateBatchStartEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<InvestigateBatchEndEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<DiagnosisPersistedEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<SolveStartEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<SolveEndEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<SolveBatchStartEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<SolveBatchEndEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<ProposalPersistedEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<RunIterationStartEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<RunIterationStepEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<RunIterationEndEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<RoutineStartEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<RoutineEndEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<SkillLoadedEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<SkillActionStartEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<SkillActionEndEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<SkillHealthOkEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<SkillHealthFailedEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<PipelineStartEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<PipelineNodeStartEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<PipelineNodeEndEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<PipelineEndEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<PipelineAlertEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    })
  | (Omit<PipelineRecoveredEvent, 'ts' | 'source'> & {
      ts?: number;
      source?: BridgeEventSource;
    });

const BRIDGE_TIMEOUT_MS = 50;

export interface EmitOptions {
  // Опционально — для тестов, чтобы не зависеть от глобального fetch.
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export async function emit(event: BridgeEventInput, opts: EmitOptions = {}): Promise<void> {
  const enriched: BridgeEvent = {
    ...event,
    ts: event.ts ?? Date.now(),
    source: event.source ?? 'cofounder',
  } as BridgeEvent;

  // Сначала redaction — на сериализованном JSON. Если в input.text/output
  // оказался Telegram-токен или sk-..., он не утечёт ни в Bridge, ни в JSONL.
  const raw = JSON.stringify(enriched);
  const redacted = redactSecrets(raw);

  const url = `${opts.baseUrl ?? bridgeBaseUrl()}/event/${encodeURIComponent(enriched.type)}`;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: redacted,
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
    // Считываем body, чтобы Node закрыл соединение (иначе keep-alive держит fd).
    // Игнорируем результат — это fire-and-forget, нам нужен только факт, что
    // соединение закрыто чисто.
    if (res.body !== null && typeof res.body.cancel === 'function') {
      await res.body.cancel().catch(() => {});
    }
  } catch {
    // Bridge выключен / timeout / сеть молчит. Намеренно тихо: см. контракт выше.
    // Не используем console.error, чтобы не загрязнять stdout dev:tick'а
    // в нормальном режиме «Bridge не запущен».
  }
}
