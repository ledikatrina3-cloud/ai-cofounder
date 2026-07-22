// Контракт BridgeEvent. Источник: bridge/server.ts L198 +
// расширения под нужды AI-Cofounder runIteration (фаза 1.5b) и заявки на M2/M3.
//
// Дисциплина:
//   1. discriminated union по полю `type`. Bridge-server, JSONL-writer и Renderer
//      ничего не предполагают про конкретный type кроме его строкового имени —
//      добавление нового варианта не должно требовать правки server.ts.
//   2. ts (Date.now()) и source ('cofounder' | 'claude-code-hooks' | 'demo') —
//      обязательны на каждом событии. source выставляет эмиттер, чтобы Bridge
//      различал три режима (LIVE/DEMO/AI-Cofounder) одной строкой, без heuristics.
//   3. Для M2/M3 заявлены варианты subagent.* / tool.* / assistant.message /
//      audit.spend / audit.budget.deny — НЕ реализованы emitter'ом сейчас, но
//      зашиты в тип, чтобы будущие фазы не правили схему задним числом.
//   4. Любое поле, способное содержать сырой output от tool'а или текст от
//      пользователя, ОБЯЗАНО проходить через redaction до сериализации в JSON
//      (см. src/observe/redaction.ts и мостик.md L280).

export type BridgeEventSource = 'cofounder' | 'claude-code-hooks' | 'demo' | 'test';

interface BridgeEventBase {
  ts: number;
  source: BridgeEventSource;
}

// AI-Cofounder runIteration (фаза 1.5b — реализовано).
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

// Sub-agent fan-out (M2 — фаза 2.3a добавила исследовательские поля; 2.3b
// пристыкует fan-out без правки этого файла).
export interface SubagentStartEvent extends BridgeEventBase {
  type: 'subagent.start';
  subagentId: string;
  // 'investigator' (2.3a), 'solver' (2.4), 'executor' (3.3), 'reviewer' (3.4).
  // Лейбл для UI; не SDK-параметр.
  subagentType: string;
  parentRecordId?: string;
  // intent.problem.id для исследователя (2.3a) — позволяет UI линковать ядро
  // sub-agent'а к карточке проблемы. Опционально для других subagentType.
  problemId?: string;
  // Исходная сессия главного цикла. Поле резервируется под 2.3b/2.5, когда
  // runIteration соберёт цепочку sessionId. До тех пор undefined.
  parentSession?: string;
}

export interface SubagentEndEvent extends BridgeEventBase {
  type: 'subagent.end';
  subagentId: string;
  durationMs: number;
  // Итог исследователя (2.3a) — Bridge UI рисует цвет ядра по вердикту.
  // Опционально для других subagentType (исполнитель в 3.3 будет слать
  // 'success'|'failed'|'rolled-back', тип сузим в M3).
  verdict?: 'code' | 'human' | 'unclear' | string;
  // Деньги/токены за всю sub-agent сессию. Копия audit.spend.properties.usd
  // и суммы tokens, чтобы UI не тянул из БД.
  totalUsd?: number;
  totalTokens?: number;
  // true — sub-agent дошёл до тайм-аута и был отменён через AbortController.
  timedOut?: boolean;
}

// Tool-вызовы (M2/M3 — мостик.md L201..L204).
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

// Сообщения ассистента — для DECISION FEED.
export interface AssistantMessageEvent extends BridgeEventBase {
  type: 'assistant.message';
  text: string;
}

// «Мысли» ассистента между tool-calls — для облака мыслей над воркером в Office UI.
// План: plans/. Эмитится из emitFromSDKMessage когда:
//   - в content есть text-блок или thinking-блок, ещё нет tool_use следующего
//   - перед очередным tool_use отправляем чанк с done=true чтобы UI «зафиксировал»
// `workerId` — это routineId (как в audit.routine.*), даёт UI ключ для группировки.
// `text` — REDACTED и обрезанный до 280 chars кусок. Полный transcript — в журнале.
export interface AssistantThinkingEvent extends BridgeEventBase {
  type: 'assistant.thinking';
  workerId: string;
  text: string;
  done: boolean;
}

// Бюджет/деньги — после фазы 1.3, эмитится в фазе 2.x когда call(...) внутри runIteration.
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

// Telegram allowlist + старт бота (фаза 1.2 — зеркало src/observe/bridge.ts).
// Сервер по-прежнему не switch'ит по type — это просто расширение контракта.
export interface AuditSecurityAllowEvent extends BridgeEventBase {
  type: 'audit.security.allow';
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

// Stateless-fetch support-бота (фаза 2.1b — зеркало src/observe/bridge.ts).
// Сервер не switch'ит по type, добавление вариантов не правит server.ts.
export interface SupportFetchStartEvent extends BridgeEventBase {
  type: 'support.fetch.start';
  since: number | null;
  chatIds: string[];
}

export interface SupportFetchEndEvent extends BridgeEventBase {
  type: 'support.fetch.end';
  recordId: string;
  messagesFound: number;
  messagesInserted: number;
  messagesDeduplicated: number;
  durationMs: number;
}

// Триаж (фаза 2.2a — зеркало src/observe/bridge.ts).
// Эмитится вокруг одиночного Sonnet-вызова extractProblems(). Сервер не switch'ит
// по type, добавление вариантов не правит server.ts.
export interface TriageExtractStartEvent extends BridgeEventBase {
  type: 'triage.extract.start';
  // Сколько support-сообщений на входе. Используется Bridge UI для прогресс-бара.
  messagesIn: number;
  model: string;
  promptId: string;
}

export interface TriageExtractEndEvent extends BridgeEventBase {
  type: 'triage.extract.end';
  // null означает «вызов упал до записи audit.spend» (например, BudgetExceeded
  // до сетевого hop'а). В норме — id audit.spend Записи.
  spendRecordId: string | null;
  // Сколько проблем вернул триаж после внутреннего дедупа. 0 — валидный исход.
  problemsOut: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  durationMs: number;
}

// Семантический мердж триажа (фаза 2.2b — зеркало src/observe/bridge.ts).
// Эмитится вокруг mergeProblems(): start — перед embedding-расчётом и поиском
// в sqlite-vec, end — после INSERT'ов intent.problem/Embedding/RecordLink и
// audit.triage.merge. Сервер не switch'ит по type, добавление вариантов не
// правит server.ts.
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
  // created — сколько новых intent.problem появилось в журнале за вызов.
  created: number;
  // merged — сколько проблем из триажа были привязаны к существующим
  // intent.problem (новый RecordLink linkType='породило', без новой записи).
  merged: number;
  durationMs: number;
}

// Fan-out исследователя (фаза 2.3b — зеркало src/observe/bridge.ts).
// Эмитится вокруг investigateMany(): start — перед запуском первого sub-agent'а
// и эмитом soft-cap audit-Records, end — после Promise.all всех workers и записи
// audit.investigate.batch. Сервер не switch'ит по type, добавление вариантов не
// правит server.ts.
export interface InvestigateBatchStartEvent extends BridgeEventBase {
  type: 'investigate.batch.start';
  parentSession: string;
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

// Решатель — sub-agent предложения по одному intent.diagnosis (фаза 2.4a —
// зеркало src/observe/bridge.ts). Эмитится вокруг solveDiagnosis(): start —
// перед запуском sub-agent'а Plan-класса, end — после run'а с тайм-аутом или
// без. UI рисует отдельным узлом (не subagent.* — другая семантика: одно
// предложение по одному диагнозу). Связь с investigate.batch.* в 2.5 через
// общий parentSession.
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

// Материализация результатов fan-out исследователя в журнал (фаза 2.3c —
// зеркало src/observe/bridge.ts). Эмитится один раз в конце persistFanoutResult
// после INSERT'ов intent.diagnosis + audit.investigate.failed + RecordLink'ов.
// Связан с investigate.batch.* через общий `parentSession` из FanoutResult.
export interface DiagnosisPersistedEvent extends BridgeEventBase {
  type: 'diagnosis.persisted';
  parentSession: string;
  batchSize: number;
  failuresAudited: number;
  deferredAlreadyAudited: number;
}

// Fan-out решателя (фаза 2.4b — зеркало src/observe/bridge.ts). Эмитится
// вокруг solveMany(): start — перед запуском первого sub-agent'а (после
// soft-cap audit-Records), end — после Promise.all всех workers и записи
// audit.solve.batch. UI рисует группой фиолетовых ядер по parentSession.
export interface SolveBatchStartEvent extends BridgeEventBase {
  type: 'solve.batch.start';
  parentSession: string;
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
// src/observe/bridge.ts). Эмитится один раз в конце persistSolveFanout после
// INSERT'ов intent.proposal + audit.solve.failed + RecordLink'ов. Связан с
// solve.batch.* через общий `parentSession` из SolveFanoutResult.
export interface ProposalPersistedEvent extends BridgeEventBase {
  type: 'proposal.persisted';
  parentSession: string;
  batchSize: number;
  failuresAudited: number;
  deferredAlreadyAudited: number;
}

// runIteration сшивка (фаза 2.5 — зеркало src/observe/bridge.ts). Сервер не
// switch'ит по type, добавление вариантов не правит server.ts. Эмитятся внутри
// src/core/loop.ts на ключевых точках pipeline'а; UI группирует под-события
// (subagent.*, triage.*, investigate.batch.*, solve.batch.*, proposal.persisted,
// ...) в одну сессию через общий `eventTriggerId`.
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

// Routine dispatcher (фаза 1.3 нового плана `routines.md` — зеркало
// src/observe/bridge.ts). Эмитятся внутри src/core/dispatcher.ts на входе и
// после audit.routine.end (любой исход). UI группирует под-события по
// (routineId, runDate). Сервер не switch'ит по type — добавление вариантов не
// правит bridge/server.ts.
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
  reason?: string;
  durationMs: number;
}

// Skills (Фаза 2 плана 2026-05-21-skills-architecture-v3). Аддитивное
// расширение, как все предыдущие. Сервер не switch'ит по type, добавление
// вариантов не правит bridge/server.ts. Зеркало в src/observe/bridge.ts
// синхронизировано.
//
// `skill.loaded` — эмитится в executeRoutine при инжекции скилла в system
// prompt. mode='discovery' (только name+description) или mode='forceLoad'
// (полный body SKILL.md).
//
// `skill.action.start` / `skill.action.end` — эмитятся когда скрипт скилла
// реально вызывается (на этой фазе — через canUseTool Bash hook,
// извлекая имя из `pnpm exec tsx skills/<name>/scripts/...`).
// `end` пишет durationMs и exitCode (опционально, если доступен от runtime'а).
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
  /** Полная Bash-команда (или другая операция). Прогоняется через redaction. */
  command: string;
}

export interface SkillActionEndEvent extends BridgeEventBase {
  type: 'skill.action.end';
  routineId: string;
  skillName: string;
  actionId: string;
  durationMs: number;
  /** Exit-code если скилл-action — Bash-команда. undefined для не-bash actions. */
  exitCode?: number;
  /** true если действие завершилось ошибкой. */
  isError: boolean;
}

// Skill health-check (Фаза 7 плана 2026-05-21-skills-architecture-v3).
// Аддитивное расширение, как все skill-события. Эмитятся из src/skills/health.ts
// runHealthCheck() — `ok` когда скрипт вернул `{status: 'ok', ...}` с exit=0,
// `failed` во всех остальных случаях (timeout / exit!=0 / status:failed /
// невалидный JSON). Сервер не switch'ит по type, добавление вариантов не
// правит bridge/server.ts.
export interface SkillHealthOkEvent extends BridgeEventBase {
  type: 'skill.health.ok';
  skillName: string;
  durationMs: number;
}

export interface SkillHealthFailedEvent extends BridgeEventBase {
  type: 'skill.health.failed';
  skillName: string;
  durationMs: number;
  /** Human-readable причина: timeout / spawn-error / exit-code / JSON parse / status:failed. */
  error: string;
}

// Pipeline executor (Фаза 5 плана 2026-05-21-skills-architecture-v3 — зеркало
// src/observe/bridge.ts). Эмитятся внутри src/pipelines/executor.ts. UI группирует
// под-события одной сессией через общий runId.
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

// Предикат: валиден ли произвольный JSON как BridgeEvent.
// Не строгая JSON-Schema-валидация — server.ts всё равно принимает любой POST
// для совместимости с claude-code-hooks (мостик.md L162 LIVE-режим). Но для
// тестов и для типизированных эмиттеров этот guard полезен.
export function isBridgeEvent(value: unknown): value is BridgeEvent {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.type === 'string' && typeof obj.ts === 'number' && typeof obj.source === 'string'
  );
}
