// Pipeline recover — при старте app ищет «зависшие» pipeline'ы и продолжает их.
//
// Сценарий: pipeline на 7 нод длится часы; мак уснул/перезагрузился;
// state в SQLite остался. При следующем старте:
//   1. findRunningStates() — все pipeline.state с currentNode !== null.
//   2. Если waitingForApproval !== null — повторно отправляем Telegram-напоминание
//      («ты не ответил на approve gate, вот ссылка ещё раз»).
//   3. Если currentNode был 'running' — re-execute от текущей ноды. Идемпотентность
//      через artifact path: если файл артефакта уже существует и не пустой —
//      нода skipped с reason 'idempotency'.
//
// Вызывается из bridge/server.ts startup или scripts/tick-cron.ts.

import { listDepartments } from '../departments/registry.js';
import type { Department } from '../departments/types.js';
import { emit } from '../observe/bridge.js';
import { executePipeline } from './executor.js';
import { requestApproval } from './human-gate.js';
import { findRunningStates, savePipelineState } from './state.js';
import type { PipelineState } from './state.js';

export interface RecoverOptions {
  /** DI для тестов. */
  findStatesFn?: typeof findRunningStates;
  listDepartmentsFn?: typeof listDepartments;
  requestApprovalFn?: typeof requestApproval;
  executePipelineFn?: typeof executePipeline;
}

export interface RecoverResult {
  recovered: number;
  reprompted: number;
  reExecuted: number;
  skipped: number;
}

export async function recoverPipelines(options: RecoverOptions = {}): Promise<RecoverResult> {
  const findStates = options.findStatesFn ?? findRunningStates;
  const listDepts = options.listDepartmentsFn ?? listDepartments;
  const requestApprovalImpl = options.requestApprovalFn ?? requestApproval;
  const executePipelineImpl = options.executePipelineFn ?? executePipeline;

  const states = await findStates();
  if (states.length === 0) {
    return { recovered: 0, reprompted: 0, reExecuted: 0, skipped: 0 };
  }

  // Загружаем все departments один раз — потом по id мапим.
  const departments = await listDepts();
  const byId = new Map(departments.map((d) => [d.id, d]));

  let reprompted = 0;
  let reExecuted = 0;
  let skipped = 0;

  for (const state of states) {
    const dept = byId.get(state.pipelineId);
    if (dept === undefined) {
      skipped++;
      await emit({
        type: 'pipeline.recovered',
        pipelineId: state.pipelineId,
        runId: state.runId,
        nodeId: state.currentNode,
        action: 'skip',
      });
      continue;
    }

    if (state.waitingForApproval !== null) {
      await rePromptApproval(state, dept, requestApprovalImpl);
      reprompted++;
      continue;
    }

    if (state.currentNode !== null) {
      // re-execute — продолжаем pipeline. Идемпотентность по artifact уже в
      // executor.runEmployeeNode / runParallelNode.
      await emit({
        type: 'pipeline.recovered',
        pipelineId: state.pipelineId,
        runId: state.runId,
        nodeId: state.currentNode,
        action: 're-run',
      });
      try {
        await executePipelineImpl(dept, state.runId);
        reExecuted++;
      } catch {
        // recover не падает, но не считает как successful re-execute.
        skipped++;
      }
    } else {
      skipped++;
    }
  }

  return {
    recovered: states.length,
    reprompted,
    reExecuted,
    skipped,
  };
}

async function rePromptApproval(
  state: PipelineState,
  dept: Department,
  requestApprovalImpl: typeof requestApproval,
): Promise<void> {
  const nodeId = state.waitingForApproval;
  if (nodeId === null) return;
  const node = dept.pipeline.nodes.find((n) => n.id === nodeId);
  if (node === undefined || node.kind !== 'human-gate') return;

  await emit({
    type: 'pipeline.recovered',
    pipelineId: state.pipelineId,
    runId: state.runId,
    nodeId,
    action: 're-prompt',
  });

  // best-effort: послать сообщение, но не ждать (recover не блокирует).
  // requestApproval сразу зарегистрирует listener на approvalBus, но тут мы
  // не дожидаемся результата — pipeline executor отдельно может крутиться в
  // фоне и подберёт callback.
  void requestApprovalImpl({
    pipelineId: dept.id,
    runId: state.runId,
    nodeId,
    message: `🔁 *Напоминание*: pipeline '${dept.id}' ждёт approve на ноде \`${nodeId}\` (recover после рестарта).`,
    timeoutMs: node.timeoutMs,
  }).catch(() => {
    /* swallow — recover должен быть устойчив */
  });

  // Сбросим waitingForApproval=null нельзя — мы всё ещё ждём. Но обновим
  // startedAt чтобы UI знал что мы подняли таймер заново.
  await savePipelineState({ ...state, startedAt: Date.now() });
}
