// Pipeline executor — запускает все ноды department.pipeline по топологическому
// порядку, эмитит Bridge events, персистит state.
//
// Контракт:
//   * `executePipeline(dept, runId, deps?)` — берёт Department, runId,
//     прогоняет все ноды. Возвращает `PipelineRunResult`.
//   * Топосорт: по `inputs`. Параллельные ноды (ParallelNode) — одна группа
//     веток, исполняются через Promise.all.
//   * EmployeeNode — вызов runRoutine(employee, runDate, trigger).
//   * HumanGateNode — requestApproval из ./human-gate.
//   * onFail policy: retries + backoff + then (alert/halt/continue/skip).
//   * Bridge events: pipeline.start, pipeline.node.start, pipeline.node.end,
//     pipeline.end.
//   * Артефакты: пишем employee.output как файл. Если employee вернул output
//     как текст — пишем его; для structured — JSON.
//   * `${date}` template в output — заменяется на runDate (формат YYYY-MM-DD).
//
// Идемпотентность: при recover'е проверяем существует ли artifact для ноды;
// если файл уже есть и не пустой — skip ноды.

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { ulid } from 'ulid';
import { runRoutine as defaultRunRoutine } from '../core/dispatcher.js';
import { triggerManualRoutine } from '../core/triggers.js';
import type { Department } from '../departments/types.js';
import { emit } from '../observe/bridge.js';
import { requestApproval as defaultRequestApproval } from './human-gate.js';
import {
  type NodeStatus,
  type PipelineState,
  loadPipelineState,
  savePipelineState,
} from './state.js';
import type {
  EmployeeNode,
  HumanGateNode,
  OnFailPolicy,
  ParallelBranch,
  ParallelNode,
  PipelineNode,
} from './types.js';

// ---------------------------------------------------------------------------
// Контракт.
// ---------------------------------------------------------------------------

export interface PipelineRunResult {
  runId: string;
  pipelineId: string;
  status: 'success' | 'failed' | 'skipped';
  artifacts: Record<string, string>;
  nodeStatuses: Record<string, NodeStatus>;
  startedAt: number;
  endedAt: number;
}

/**
 * Результат запуска одной employee-ноды. Сообщает executor'у status и output.
 */
export interface RunNodeResult {
  status: 'ok' | 'failed';
  /** Output текст от routine — пишется в node.output если file пустой. */
  output?: string;
  reason?: string;
}

/**
 * DI-shim для тестов. Прод-deps берут реальные impls.
 */
export interface ExecutePipelineDeps {
  runRoutine?: (
    routineId: string,
    runDate: string,
    trigger: ReturnType<typeof triggerManualRoutine>,
  ) => Promise<RunNodeResult>;
  requestApproval?: typeof defaultRequestApproval;
  /** DI для тестов: replace file writer. */
  writeArtifact?: (absPath: string, content: string) => Promise<void>;
  /** DI для тестов: replace check file existence. */
  artifactExists?: (absPath: string) => Promise<boolean>;
  /** DI: подменить runDate (по умолчанию — сегодня в UTC). */
  now?: () => Date;
  /** Корень репозитория (для резолва output относительных путей). */
  cwd?: string;
  /** Skip state-persistence (для unit-тестов pure executor logic). */
  skipPersist?: boolean;
}

// ---------------------------------------------------------------------------
// Главная функция.
// ---------------------------------------------------------------------------

export async function executePipeline(
  dept: Department,
  runId: string,
  deps: ExecutePipelineDeps = {},
): Promise<PipelineRunResult> {
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? (() => new Date());
  const runDate = isoDate(now());
  const startedAt = Date.now();
  const writeArtifact = deps.writeArtifact ?? defaultWriteArtifact;
  const artifactExists = deps.artifactExists ?? defaultArtifactExists;
  const runRoutineFn = deps.runRoutine ?? buildDefaultRunRoutineAdapter();
  const requestApproval = deps.requestApproval ?? defaultRequestApproval;

  // 1. Bridge: pipeline.start.
  await emit({
    type: 'pipeline.start',
    pipelineId: dept.id,
    runId,
    runDate,
    nodeCount: dept.pipeline.nodes.length,
  });

  // 2. Topological sort.
  const ordered = topoSort(dept.pipeline.nodes);

  // 3. Initial state.
  let state: PipelineState = await initState({
    dept,
    runId,
    runDate,
    startedAt,
    skipPersist: deps.skipPersist === true,
  });

  // 4. Execute nodes in order. На каждой ноде — обновляем state, эмитим events.
  let pipelineStatus: PipelineRunResult['status'] = 'success';
  let halt = false;

  for (const node of ordered) {
    if (halt) {
      // Не запускаем дальше, отмечаем skipped.
      state = {
        ...state,
        nodeStatuses: { ...state.nodeStatuses, [node.id]: 'skipped' },
      };
      if (deps.skipPersist !== true) await savePipelineState(state);
      continue;
    }

    state = {
      ...state,
      currentNode: node.id,
      nodeStatuses: { ...state.nodeStatuses, [node.id]: 'running' },
    };
    if (deps.skipPersist !== true) await savePipelineState(state);

    const nodeStarted = Date.now();
    await emit({
      type: 'pipeline.node.start',
      pipelineId: dept.id,
      runId,
      nodeId: node.id,
      kind: node.kind,
    });

    let nodeStatus: NodeStatus = 'ok';
    let nodeReason: string | undefined;
    let artifactPath: string | undefined;

    try {
      if (node.kind === 'employee') {
        const result = await runEmployeeNode({
          node,
          dept,
          runId,
          runDate,
          cwd,
          state,
          runRoutineFn,
          writeArtifact,
          artifactExists,
        });
        nodeStatus = result.status;
        if (result.reason !== undefined) nodeReason = result.reason;
        if (result.artifactPath !== undefined) artifactPath = result.artifactPath;
      } else if (node.kind === 'human-gate') {
        const gateRes = await runHumanGateNode({
          node,
          dept,
          runId,
          state,
          requestApproval,
        });
        if (gateRes === 'approved') {
          nodeStatus = 'ok';
        } else if (gateRes === 'rejected' || gateRes === 'edited') {
          nodeStatus = 'failed';
          nodeReason = `human-gate: ${gateRes}`;
        } else if (gateRes === 'timeout') {
          // Apply onTimeout policy.
          if (node.onTimeout === 'auto-approve') {
            nodeStatus = 'ok';
          } else {
            nodeStatus = 'failed';
            nodeReason = `human-gate: timeout (${node.onTimeout})`;
          }
        }
      } else {
        // parallel
        const parallelResult = await runParallelNode({
          node,
          dept,
          runId,
          runDate,
          cwd,
          state,
          runRoutineFn,
          writeArtifact,
          artifactExists,
        });
        nodeStatus = parallelResult.status;
        if (parallelResult.reason !== undefined) nodeReason = parallelResult.reason;
        // Артефакты parallel-ветвей сохраняются под ключами branch.<id>:<i>.
        for (const [k, v] of Object.entries(parallelResult.branchArtifacts)) {
          state = {
            ...state,
            artifacts: { ...state.artifacts, [k]: v },
          };
        }
      }
    } catch (err) {
      nodeStatus = 'failed';
      nodeReason = `node-error: ${err instanceof Error ? err.message : String(err)}`;
    }

    state = {
      ...state,
      nodeStatuses: { ...state.nodeStatuses, [node.id]: nodeStatus },
      ...(artifactPath !== undefined
        ? { artifacts: { ...state.artifacts, [node.id]: artifactPath } }
        : {}),
    };

    await emit({
      type: 'pipeline.node.end',
      pipelineId: dept.id,
      runId,
      nodeId: node.id,
      // narrow: к моменту emit nodeStatus может быть 'running' только если мы
      // вышли из branch без присваивания — этого не происходит. На уровне
      // типа Bridge events 'running' не валидно, поэтому маппим 'running'/
      // 'waiting-for-approval' в 'failed' fail-safe (это никогда не должно
      // случиться; см. инварианты выше).
      status:
        nodeStatus === 'ok' || nodeStatus === 'failed' || nodeStatus === 'skipped'
          ? nodeStatus
          : nodeStatus === 'waiting-for-approval'
            ? 'waiting-for-approval'
            : 'failed',
      durationMs: Date.now() - nodeStarted,
      ...(nodeReason !== undefined ? { reason: nodeReason } : {}),
    });

    // ── onFail handling — для employee и human-gate (parallel сам разобрался) ─
    if (nodeStatus === 'failed') {
      const action = resolveFailAction(node);
      // alert — попадает в Bridge через pipeline.node.end + ниже доп. event.
      if (action === 'alert') {
        await emit({
          type: 'pipeline.alert',
          pipelineId: dept.id,
          runId,
          nodeId: node.id,
          ...(nodeReason !== undefined ? { reason: nodeReason } : {}),
        });
        // продолжаем
      } else if (action === 'halt') {
        halt = true;
        pipelineStatus = 'failed';
      } else if (action === 'skip-pipeline') {
        halt = true;
        pipelineStatus = 'skipped';
      } else {
        // 'continue' — игнорим failure
      }
    }

    if (deps.skipPersist !== true) await savePipelineState(state);
  }

  // 5. Final state.
  const endedAt = Date.now();
  const finalState: PipelineState = {
    ...state,
    currentNode: null,
    finalStatus: pipelineStatus,
  };
  if (deps.skipPersist !== true) await savePipelineState(finalState);

  await emit({
    type: 'pipeline.end',
    pipelineId: dept.id,
    runId,
    status: pipelineStatus,
    durationMs: endedAt - startedAt,
  });

  return {
    runId,
    pipelineId: dept.id,
    status: pipelineStatus,
    artifacts: finalState.artifacts,
    nodeStatuses: finalState.nodeStatuses,
    startedAt,
    endedAt,
  };
}

// ---------------------------------------------------------------------------
// Employee node.
// ---------------------------------------------------------------------------

interface RunEmployeeArgs {
  node: EmployeeNode;
  dept: Department;
  runId: string;
  runDate: string;
  cwd: string;
  state: PipelineState;
  runRoutineFn: NonNullable<ExecutePipelineDeps['runRoutine']>;
  writeArtifact: NonNullable<ExecutePipelineDeps['writeArtifact']>;
  artifactExists: NonNullable<ExecutePipelineDeps['artifactExists']>;
}

interface RunEmployeeRes {
  status: NodeStatus;
  reason?: string;
  artifactPath?: string;
}

async function runEmployeeNode(args: RunEmployeeArgs): Promise<RunEmployeeRes> {
  const { node, runId, runDate, cwd, runRoutineFn, writeArtifact, artifactExists } = args;
  const policy: OnFailPolicy = node.onFail ?? { retries: 0, then: 'halt' };

  // Идемпотентность: если artifact уже существует (от прошлого run'а) — skip.
  const artifactPath = resolveOutputPath(cwd, node.output, runDate);
  if (await artifactExists(artifactPath)) {
    return { status: 'ok', artifactPath, reason: 'idempotency: artifact already exists' };
  }

  let lastErr = '';
  for (let attempt = 0; attempt <= policy.retries; attempt++) {
    if (attempt > 0 && policy.backoffMs !== undefined && policy.backoffMs > 0) {
      await sleep(policy.backoffMs);
    }
    try {
      const trigger = triggerManualRoutine(node.employee);
      const res = await runRoutineFn(node.employee, runDate, trigger);
      if (res.status === 'ok') {
        // Пишем артефакт. Если output — текст, пишем его. Иначе — заметка.
        const content = res.output ?? `# ${node.id} ${runDate}\n\n(empty)`;
        await writeArtifact(artifactPath, content);
        return { status: 'ok', artifactPath };
      }
      lastErr = res.reason ?? 'routine returned failed';
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  return { status: 'failed', reason: lastErr };
}

// ---------------------------------------------------------------------------
// Human-gate node.
// ---------------------------------------------------------------------------

interface RunHumanGateArgs {
  node: HumanGateNode;
  dept: Department;
  runId: string;
  state: PipelineState;
  requestApproval: typeof defaultRequestApproval;
}

async function runHumanGateNode(
  args: RunHumanGateArgs,
): Promise<'approved' | 'rejected' | 'edited' | 'timeout'> {
  const { node, dept, runId, state, requestApproval } = args;
  // Собираем превью артефактов inputs для отображения в Telegram.
  const attachments: string[] = [];
  for (const inputId of node.inputs) {
    const artifact = state.artifacts[inputId];
    if (artifact !== undefined) attachments.push(artifact);
  }
  return requestApproval({
    pipelineId: dept.id,
    runId,
    nodeId: node.id,
    message: `🤖 *Approve gate*: ${node.id}\n\nПовод посмотреть артефакты и принять решение.`,
    attachments,
    timeoutMs: node.timeoutMs,
  });
}

// ---------------------------------------------------------------------------
// Parallel node.
// ---------------------------------------------------------------------------

interface RunParallelArgs {
  node: ParallelNode;
  dept: Department;
  runId: string;
  runDate: string;
  cwd: string;
  state: PipelineState;
  runRoutineFn: NonNullable<ExecutePipelineDeps['runRoutine']>;
  writeArtifact: NonNullable<ExecutePipelineDeps['writeArtifact']>;
  artifactExists: NonNullable<ExecutePipelineDeps['artifactExists']>;
}

interface RunParallelRes {
  status: NodeStatus;
  reason?: string;
  branchArtifacts: Record<string, string>;
}

async function runParallelNode(args: RunParallelArgs): Promise<RunParallelRes> {
  const { node, runId, runDate, cwd, runRoutineFn, writeArtifact, artifactExists } = args;

  // Запускаем все ветки Promise.all. Если любая упала с onFail.then=halt —
  // мы НЕ можем по-настоящему отменить уже запущенные routine (нет AbortController
  // через границу runRoutine), но возвращаем status=failed; pipeline далее halt'нет.
  const branchPromises = node.branches.map(async (b, idx) => {
    const branchId = `${node.id}:${idx}`;
    const policy: OnFailPolicy = b.onFail ?? { retries: 0, then: 'halt' };
    const output = b.output ?? `outputs/${node.id}/${idx}-${runDate}.md`;
    const artifactPath = resolveOutputPath(cwd, output, runDate);
    if (await artifactExists(artifactPath)) {
      return { branchId, ok: true as const, artifactPath };
    }
    let lastErr = '';
    for (let attempt = 0; attempt <= policy.retries; attempt++) {
      if (attempt > 0 && policy.backoffMs !== undefined && policy.backoffMs > 0) {
        await sleep(policy.backoffMs);
      }
      try {
        const trigger = triggerManualRoutine(b.employee);
        const res = await runRoutineFn(b.employee, runDate, trigger);
        if (res.status === 'ok') {
          const content = res.output ?? `# ${branchId} ${runDate}\n\n(empty)`;
          await writeArtifact(artifactPath, content);
          return { branchId, ok: true as const, artifactPath };
        }
        lastErr = res.reason ?? 'routine returned failed';
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
    }
    return { branchId, ok: false as const, reason: lastErr, policy };
  });

  const results = await Promise.all(branchPromises);

  const branchArtifacts: Record<string, string> = {};
  const failures: string[] = [];
  let haltRequested = false;
  for (const r of results) {
    if (r.ok) {
      branchArtifacts[r.branchId] = r.artifactPath;
    } else {
      failures.push(`${r.branchId}: ${r.reason ?? '?'}`);
      const action = r.policy.then;
      if (action === 'halt' || action === 'skip-pipeline') haltRequested = true;
    }
  }
  if (failures.length === 0) {
    return { status: 'ok', branchArtifacts };
  }
  return {
    status: 'failed',
    reason: `parallel failures: ${failures.join('; ')}${haltRequested ? ' (halt requested)' : ''}`,
    branchArtifacts,
  };
}

// ---------------------------------------------------------------------------
// Topological sort + state init.
// ---------------------------------------------------------------------------

/**
 * Kahn's algorithm. Сортирует ноды по `inputs`. Для parallel-узла собираем
 * все его inputs (включая inputs веток). Цикл → throw'аем.
 */
export function topoSort(nodes: PipelineNode[]): PipelineNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, Set<string>>(); // nodeId → set of deps
  const dependents = new Map<string, string[]>(); // depId → list of nodes that depend on it

  for (const n of nodes) {
    const deps = new Set<string>();
    if (n.kind === 'parallel') {
      for (const i of n.inputs) deps.add(i);
      for (const b of n.branches) {
        if (b.input !== undefined) deps.add(b.input);
        for (const i of b.inputs ?? []) deps.add(i);
      }
    } else {
      for (const i of n.inputs) deps.add(i);
    }
    incoming.set(n.id, deps);
    for (const d of deps) {
      let arr = dependents.get(d);
      if (arr === undefined) {
        arr = [];
        dependents.set(d, arr);
      }
      arr.push(n.id);
    }
  }

  const ready: string[] = [];
  for (const [id, deps] of incoming) {
    if (deps.size === 0) ready.push(id);
  }
  ready.sort();

  const out: PipelineNode[] = [];
  while (ready.length > 0) {
    const cur = ready.shift() as string;
    const n = byId.get(cur);
    if (n === undefined) continue;
    out.push(n);
    for (const dep of dependents.get(cur) ?? []) {
      const remaining = incoming.get(dep);
      if (remaining === undefined) continue;
      remaining.delete(cur);
      if (remaining.size === 0) ready.push(dep);
    }
    // detect ready batch sorted for determinism
    ready.sort();
  }

  if (out.length !== nodes.length) {
    throw new Error('pipeline: цикл в графе nodes (inputs ссылаются друг на друга).');
  }
  return out;
}

interface InitStateArgs {
  dept: Department;
  runId: string;
  runDate: string;
  startedAt: number;
  skipPersist: boolean;
}

async function initState(args: InitStateArgs): Promise<PipelineState> {
  // Если уже есть state по runId (recover) — берём его, иначе создаём новый.
  if (!args.skipPersist) {
    const existing = await loadPipelineState(args.runId);
    if (existing !== null) {
      return {
        ...existing,
        currentNode: existing.currentNode ?? args.dept.pipeline.nodes[0]?.id ?? null,
      };
    }
  }
  const newState: PipelineState = {
    pipelineId: args.dept.id,
    runId: args.runId,
    currentNode: args.dept.pipeline.nodes[0]?.id ?? null,
    nodeStatuses: {},
    artifacts: {},
    startedAt: args.startedAt,
    waitingForApproval: null,
    runDate: args.runDate,
  };
  if (!args.skipPersist) await savePipelineState(newState);
  return newState;
}

// ---------------------------------------------------------------------------
// onFail / Artifact / Util helpers.
// ---------------------------------------------------------------------------

function resolveFailAction(node: PipelineNode): 'alert' | 'halt' | 'continue' | 'skip-pipeline' {
  if (node.kind === 'employee') return node.onFail?.then ?? 'halt';
  if (node.kind === 'human-gate') {
    // human-gate failed может быть из-за: (а) reject/edit → halt (фаундер
    // явно отказал), (б) timeout → onTimeout policy (skip-pipeline / halt).
    // auto-approve до сюда не дойдёт (там status='ok').
    return node.onTimeout === 'skip-pipeline' ? 'skip-pipeline' : 'halt';
  }
  // parallel — fail-policy уже разобрана внутри
  return 'halt';
}

/**
 * Резолвит `${date}` template в путях и возвращает абсолютный путь.
 *
 * Безопасность: pipeline.yml — это data, которая в multi-user будущем может
 * прийти из marketplace-шаблона (см. п.1 «5 решений для multi-user»). Поэтому
 * запрещаем абсолютные пути и path-traversal `..`, выводящие за `cwd`. Это
 * защита уровня executor'а — даже если template-валидатор не отловит, executor
 * не позволит записать в /etc/passwd.
 *
 * Throws Error если output резолвится за пределы cwd.
 */
export function resolveOutputPath(cwd: string, output: string, runDate: string): string {
  const replaced = output.replace(/\$\{date\}/g, runDate);
  if (isAbsolute(replaced)) {
    throw new Error(
      `pipeline output path '${replaced}': абсолютные пути запрещены (data-as-code: pipeline.yml не должен указывать вне репозитория).`,
    );
  }
  // resolve('.', ...) нормализует .. — затем проверим что результат под cwd.
  const absCwd = resolvePath(cwd);
  const abs = resolvePath(absCwd, replaced);
  if (abs !== absCwd && !abs.startsWith(`${absCwd}/`)) {
    throw new Error(
      `pipeline output path '${replaced}' резолвится за пределы cwd '${absCwd}' — отказ (path-traversal).`,
    );
  }
  // Возвращаем абсолютный, нормализованный путь (resolve уже сделал ..-резолв).
  return abs;
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function defaultWriteArtifact(absPath: string, content: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, content, 'utf8');
}

async function defaultArtifactExists(absPath: string): Promise<boolean> {
  try {
    const s = await stat(absPath);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Default runRoutine adapter — оборачивает src/core/dispatcher.runRoutine
// (которая `Promise<void>`) в `Promise<RunNodeResult>`.
//
// Для прод-исполнения мы НЕ можем легко узнать output текста после dispatcher'а
// — он хранится в audit.routine.end.properties.output. Здесь мы запускаем
// runRoutine и возвращаем 'ok' без output (executor запишет пустой artifact-stub).
// Для теста / Фазы 6 это будет заменено на адаптер, который читает result из БД.
// ---------------------------------------------------------------------------

function buildDefaultRunRoutineAdapter(): NonNullable<ExecutePipelineDeps['runRoutine']> {
  return async (routineId, runDate, trigger) => {
    try {
      await defaultRunRoutine(routineId, runDate, trigger);
      // dispatcher не возвращает output; pipeline executor запишет stub-файл
      // с meta-данными. Реальный output лежит в БД (audit.routine.end). В
      // Фазе 6 здесь появится загрузка output из БД и пересохранение в
      // node.output. Сейчас — заглушка.
      return {
        status: 'ok',
        output: `# routine ${routineId} ${runDate}\n\n(output в БД, audit.routine.end)`,
      };
    } catch (err) {
      return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
    }
  };
}
