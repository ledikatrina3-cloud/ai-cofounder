// Pipeline parser — читает `pipeline.yml` и возвращает `Pipeline`.
//
// Используем библиотеку `yaml` (pure JS, без нативных зависимостей) — формат
// pipeline.yml сложнее, чем frontmatter скиллов (block-array, nested mappings),
// и писать свой parser было бы дорого.
//
// Контракт:
//   * `parsePipeline(source, filePath)` — sync, throw'ит `PipelineParseError`
//     с указанием поля/ноды.
//   * Валидация: `nodes` непустой, id уникален, inputs ссылаются на known id,
//     onFail/onTimeout — известные значения, duration — парсятся.
//   * `${date}` в `output` НЕ резолвится — executor подставит runDate.
//
// Discriminated union по `kind`:
//   - `type: human-gate` → HumanGateNode
//   - `parallel: [...]` → ParallelNode
//   - всё остальное (с `employee`) → EmployeeNode

import { parse as parseYaml } from 'yaml';
import {
  type EmployeeNode,
  type HumanGateNode,
  type OnFailPolicy,
  type OnTimeoutAction,
  type ParallelBranch,
  type ParallelNode,
  type Pipeline,
  type PipelineNode,
  parseDuration,
} from './types.js';

export class PipelineParseError extends Error {
  constructor(filePath: string, message: string) {
    super(`pipeline ${filePath}: ${message}`);
    this.name = 'PipelineParseError';
  }
}

const ON_FAIL_ACTIONS = new Set(['alert', 'halt', 'continue', 'skip-pipeline']);
const ON_TIMEOUT_ACTIONS = new Set<OnTimeoutAction>(['skip-pipeline', 'halt', 'auto-approve']);
const NODE_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function parsePipeline(source: string, filePath: string): Pipeline {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new PipelineParseError(filePath, `не парсится как YAML: ${reason}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PipelineParseError(filePath, 'корневой объект должен быть mapping (yml object).');
  }

  const obj = parsed as Record<string, unknown>;
  const nodesRaw = obj.nodes;
  if (!Array.isArray(nodesRaw)) {
    throw new PipelineParseError(filePath, "поле 'nodes' должно быть массивом нод.");
  }
  if (nodesRaw.length === 0) {
    throw new PipelineParseError(filePath, "поле 'nodes' не должно быть пустым.");
  }

  const nodes: PipelineNode[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < nodesRaw.length; i++) {
    const raw = nodesRaw[i];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new PipelineParseError(filePath, `node[${i}]: должна быть mapping (yml object).`);
    }
    const node = parseNode(raw as Record<string, unknown>, i, filePath);
    if (seenIds.has(node.id)) {
      throw new PipelineParseError(filePath, `node[${i}]: дубль id '${node.id}'.`);
    }
    if (!NODE_ID_RE.test(node.id)) {
      throw new PipelineParseError(
        filePath,
        `node[${i}]: id '${node.id}' должен быть kebab-case ([a-z][a-z0-9]*(?:-[a-z0-9]+)*).`,
      );
    }
    seenIds.add(node.id);
    nodes.push(node);
  }

  // Проверяем что все inputs ссылаются на known id.
  for (const node of nodes) {
    const inputs = collectInputs(node);
    for (const dep of inputs) {
      if (!seenIds.has(dep)) {
        throw new PipelineParseError(
          filePath,
          `node '${node.id}': input '${dep}' не соответствует ни одной известной node id.`,
        );
      }
    }
  }

  return { nodes };
}

function collectInputs(node: PipelineNode): string[] {
  if (node.kind === 'parallel') {
    // parallel-узел декларирует общий список inputs (все ветки могут потреблять
    // их). Plus, у каждой ветки могут быть свои input(s) — это id предыдущих
    // нод pipeline'а, а не имена ветвей parallel-узла.
    const all = new Set(node.inputs);
    for (const b of node.branches) {
      if (b.input !== undefined) all.add(b.input);
      for (const i of b.inputs ?? []) all.add(i);
    }
    return [...all];
  }
  return node.inputs;
}

function parseNode(raw: Record<string, unknown>, idx: number, filePath: string): PipelineNode {
  const id = asString(raw.id, filePath, `node[${idx}].id`);
  // Discriminate.
  if (raw.type === 'human-gate') {
    return parseHumanGate(raw, id, filePath);
  }
  if (Array.isArray(raw.parallel)) {
    return parseParallel(raw, id, filePath);
  }
  return parseEmployee(raw, id, filePath);
}

function parseEmployee(raw: Record<string, unknown>, id: string, filePath: string): EmployeeNode {
  const employee = asString(raw.employee, filePath, `node '${id}'.employee`);
  const inputs = asStringArray(raw.inputs ?? [], filePath, `node '${id}'.inputs`);
  const output = asString(raw.output, filePath, `node '${id}'.output`);

  const node: EmployeeNode = {
    kind: 'employee',
    id,
    employee,
    inputs,
    output,
  };

  if (raw.schedule !== undefined) {
    node.schedule = asString(raw.schedule, filePath, `node '${id}'.schedule`);
  }
  if (raw.model !== undefined) {
    node.model = asString(raw.model, filePath, `node '${id}'.model`);
  }
  if (raw.timeout !== undefined) {
    const dur = asString(raw.timeout, filePath, `node '${id}'.timeout`);
    node.timeoutMs = parseDurationOrThrow(dur, `node '${id}'.timeout`, filePath);
  }
  if (raw.onTimeout !== undefined) {
    node.onTimeout = parseOnTimeout(raw.onTimeout, `node '${id}'.onTimeout`, filePath);
  }
  if (raw.onFail !== undefined) {
    node.onFail = parseOnFail(raw.onFail, `node '${id}'.onFail`, filePath);
  }
  if (raw.lookback !== undefined) {
    node.lookback = parseLookback(raw.lookback, `node '${id}'.lookback`, filePath);
  }

  return node;
}

function parseHumanGate(raw: Record<string, unknown>, id: string, filePath: string): HumanGateNode {
  const via = asString(raw.via, filePath, `node '${id}'.via`);
  if (raw.timeout === undefined) {
    throw new PipelineParseError(filePath, `node '${id}': human-gate требует 'timeout'.`);
  }
  const timeoutMs = parseDurationOrThrow(
    asString(raw.timeout, filePath, `node '${id}'.timeout`),
    `node '${id}'.timeout`,
    filePath,
  );
  if (raw.onTimeout === undefined) {
    throw new PipelineParseError(
      filePath,
      `node '${id}': human-gate требует 'onTimeout' (skip-pipeline | halt | auto-approve).`,
    );
  }
  const onTimeout = parseOnTimeout(raw.onTimeout, `node '${id}'.onTimeout`, filePath);
  const inputs = asStringArray(raw.inputs ?? [], filePath, `node '${id}'.inputs`);

  return {
    kind: 'human-gate',
    id,
    via,
    timeoutMs,
    onTimeout,
    inputs,
  };
}

function parseParallel(raw: Record<string, unknown>, id: string, filePath: string): ParallelNode {
  const branchesRaw = raw.parallel;
  if (!Array.isArray(branchesRaw) || branchesRaw.length === 0) {
    throw new PipelineParseError(
      filePath,
      `node '${id}': parallel должен быть непустым массивом веток.`,
    );
  }
  const branches: ParallelBranch[] = [];
  for (let i = 0; i < branchesRaw.length; i++) {
    const b = branchesRaw[i];
    if (b === null || typeof b !== 'object' || Array.isArray(b)) {
      throw new PipelineParseError(filePath, `node '${id}'.parallel[${i}]: должна быть mapping.`);
    }
    const br = b as Record<string, unknown>;
    const branch: ParallelBranch = {
      employee: asString(br.employee, filePath, `node '${id}'.parallel[${i}].employee`),
    };
    if (br.input !== undefined) {
      branch.input = asString(br.input, filePath, `node '${id}'.parallel[${i}].input`);
    }
    if (br.inputs !== undefined) {
      branch.inputs = asStringArray(br.inputs, filePath, `node '${id}'.parallel[${i}].inputs`);
    }
    if (br.output !== undefined) {
      branch.output = asString(br.output, filePath, `node '${id}'.parallel[${i}].output`);
    }
    if (br.model !== undefined) {
      branch.model = asString(br.model, filePath, `node '${id}'.parallel[${i}].model`);
    }
    if (br.timeout !== undefined) {
      const dur = asString(br.timeout, filePath, `node '${id}'.parallel[${i}].timeout`);
      branch.timeoutMs = parseDurationOrThrow(dur, `node '${id}'.parallel[${i}].timeout`, filePath);
    }
    if (br.onFail !== undefined) {
      branch.onFail = parseOnFail(br.onFail, `node '${id}'.parallel[${i}].onFail`, filePath);
    }
    branches.push(branch);
  }
  // inputs: declared top-level или собранные из веток для toposort.
  const declared = asStringArray(raw.inputs ?? [], filePath, `node '${id}'.inputs`);
  return {
    kind: 'parallel',
    id,
    branches,
    inputs: declared,
  };
}

function parseOnFail(raw: unknown, field: string, filePath: string): OnFailPolicy {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PipelineParseError(
      filePath,
      `${field}: должен быть mapping {retries, backoff, then}.`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const retries = asNonNegativeInt(obj.retries ?? 0, filePath, `${field}.retries`);
  const thenRaw = asString(obj.then, filePath, `${field}.then`);
  if (!ON_FAIL_ACTIONS.has(thenRaw)) {
    throw new PipelineParseError(
      filePath,
      `${field}.then '${thenRaw}' не входит в [${[...ON_FAIL_ACTIONS].join(', ')}].`,
    );
  }
  const policy: OnFailPolicy = {
    retries,
    then: thenRaw as OnFailPolicy['then'],
  };
  if (obj.backoff !== undefined) {
    const dur = asString(obj.backoff, filePath, `${field}.backoff`);
    policy.backoffMs = parseDurationOrThrow(dur, `${field}.backoff`, filePath);
  }
  return policy;
}

function parseOnTimeout(raw: unknown, field: string, filePath: string): OnTimeoutAction {
  const v = asString(raw, filePath, field);
  if (!ON_TIMEOUT_ACTIONS.has(v as OnTimeoutAction)) {
    throw new PipelineParseError(
      filePath,
      `${field} '${v}' не входит в [${[...ON_TIMEOUT_ACTIONS].join(', ')}].`,
    );
  }
  return v as OnTimeoutAction;
}

function parseLookback(
  raw: unknown,
  field: string,
  filePath: string,
): { source: string; windowMs: number } {
  // Поддерживаем строковый формат 'publish:24h' и mapping {source, window}.
  if (typeof raw === 'string') {
    const m = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*):(.+)$/.exec(raw);
    if (m === null || m[1] === undefined || m[2] === undefined) {
      throw new PipelineParseError(
        filePath,
        `${field}: ожидался формат 'nodeId:duration' (например, 'publish:24h'), получено '${raw}'.`,
      );
    }
    return { source: m[1], windowMs: parseDurationOrThrow(m[2], `${field}.window`, filePath) };
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const source = asString(obj.source, filePath, `${field}.source`);
    const windowRaw = asString(obj.window, filePath, `${field}.window`);
    return { source, windowMs: parseDurationOrThrow(windowRaw, `${field}.window`, filePath) };
  }
  throw new PipelineParseError(
    filePath,
    `${field}: должен быть строкой 'nodeId:duration' или mapping {source, window}.`,
  );
}

// ---------------------------------------------------------------------------
// Низкоуровневые валидаторы.
// ---------------------------------------------------------------------------

function asString(value: unknown, filePath: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PipelineParseError(
      filePath,
      `${field}: ожидалась непустая строка, получено '${String(value)}'.`,
    );
  }
  return value;
}

function asStringArray(value: unknown, filePath: string, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new PipelineParseError(filePath, `${field}: ожидался массив строк.`);
  }
  return value.map((v, i) => {
    if (typeof v !== 'string' || v.trim() === '') {
      throw new PipelineParseError(
        filePath,
        `${field}[${i}]: ожидалась непустая строка, получено '${String(v)}'.`,
      );
    }
    return v;
  });
}

function asNonNegativeInt(value: unknown, filePath: string, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new PipelineParseError(
      filePath,
      `${field}: ожидалось целое число ≥ 0, получено '${String(value)}'.`,
    );
  }
  return value;
}

function parseDurationOrThrow(raw: string, field: string, filePath: string): number {
  try {
    return parseDuration(raw, field);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new PipelineParseError(filePath, reason);
  }
}
