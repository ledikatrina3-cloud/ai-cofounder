// Обёртка sub-agent-исследователя (фаза 2.3a).
//
// Что делает investigateProblem:
//   1. Грузит intent.problem (summary + symptoms) и тексты привязанных
//      event.support.message по RecordLink linkType='породило'.
//   2. Грузит config/investigate.md и system-prompt из src/investigate/prompt.md.
//   3. Проверяет существование targetProjectPath. Если папки нет —
//      InvestigateConfigError с просьбой обновить config.
//   4. Запускает Claude Agent SDK через runSubagent() с:
//        - cwd = targetProjectPath
//        - allowedTools = [Read, Grep, Glob, Bash]
//        - canUseTool = whitelist Bash через bashWhitelist
//        - timeoutMs / maxTurns / maxTokens из config
//        - tool-schema finish_investigation в системном промпте (как описание),
//          парсится из tool_use блоков последнего assistant-сообщения.
//   5. Извлекает finish_investigation toolUse → InvestigationResult.
//   6. Эмитит subagent.start/end в Bridge (только schema; fan-out в 2.3b).
//
// Что НЕ делает:
//   * НЕ пишет intent.diagnosis Record — это 2.3c.
//   * НЕ управляет fan-out'ом (один вызов = один sub-agent) — это 2.3b.
//   * НЕ интегрируется в runIteration — это 2.5.

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ulid } from 'ulid';
import type { PrismaClient } from '../db/client.js';
import { getPrisma } from '../db/client.js';
import {
  type SDKResultLike,
  type SubagentRunResult,
  runSubagent as defaultRunSubagent,
} from '../llm/subagent.js';
import { emit } from '../observe/bridge.js';
import { type InvestigateConfig, loadInvestigateConfig } from './config.js';

// ---------------------------------------------------------------------------
// Контракт. Критичен для 2.3b (fan-out) и 2.3c (материализация intent.diagnosis).
// ---------------------------------------------------------------------------

/**
 * @deprecated since 2026-05-01 pivot — routine support-triage заменяет этот pipeline
 */
export interface CodeRef {
  path: string;
  line?: number;
  snippet?: string;
}

export type InvestigationVerdict = 'code' | 'human' | 'unclear';

export interface InvestigationResult {
  verdict: InvestigationVerdict;
  rationale: string;
  codeRefs: CodeRef[];
  gitHints: string[];
  // ULID для Bridge subagent.start/end и будущей связки с audit.investigate.*.
  // Уникален на каждый investigateProblem() вызов.
  subagentId: string;
  // Деньги/токены за весь sub-agent run.
  totalUsd: number;
  totalTokens: number;
  durationMs: number;
  // true — sub-agent дошёл до timeoutMs и был отменён. Если так, verdict='unclear',
  // rationale='тайм-аут N мин'.
  timedOut: boolean;
  // ID Записи audit.spend, которую создал subagent.ts. null — sub-agent упал
  // до того, как мы получили usage (например, BudgetExceeded в guard).
  spendRecordId: string | null;
}

export class InvestigateConfigError extends Error {
  constructor(
    message: string,
    public readonly reason: 'no-target-project' | 'no-problem-record' | 'no-support-messages',
  ) {
    super(message);
    this.name = 'InvestigateConfigError';
  }
}

export class InvestigateInvalidResponseError extends Error {
  constructor(
    message: string,
    public readonly reason: 'no-tool-use' | 'wrong-tool' | 'schema-mismatch',
  ) {
    super(message);
    this.name = 'InvestigateInvalidResponseError';
  }
}

// ---------------------------------------------------------------------------
// DI: зависимости можно подменить в тестах. Дефолты — production-пути.
// ---------------------------------------------------------------------------

export interface InvestigateDeps {
  db?: PrismaClient;
  // Подмена runSubagent для тестов (без реального SDK-вызова).
  runSubagentImpl?: typeof defaultRunSubagent;
  // Override config — для тестов с tempdir-fixture.
  configOverride?: InvestigateConfig;
  // Override system prompt path. Дефолт — `src/investigate/prompt.md`.
  systemPromptPathOverride?: string;
  // Подменяет fs.stat (для тестов с виртуальной FS). Если не передан —
  // используется `node:fs/promises` stat.
  fsStatImpl?: (path: string) => Promise<{ isDirectory(): boolean }>;
}

const DEFAULT_SYSTEM_PROMPT_PATH = 'src/investigate/prompt.md';
const FINISH_INVESTIGATION_TOOL_NAME = 'finish_investigation';

// ---------------------------------------------------------------------------
// Главная функция.
// ---------------------------------------------------------------------------

export async function investigateProblem(
  problemId: string,
  deps: InvestigateDeps = {},
): Promise<InvestigationResult> {
  const db = deps.db ?? getPrisma();
  const runSubagent = deps.runSubagentImpl ?? defaultRunSubagent;
  const config = deps.configOverride ?? (await loadInvestigateConfig());
  const fsStat = deps.fsStatImpl ?? defaultStat;

  // 1. Достаём intent.problem.
  const problem = await loadIntentProblem(db, problemId);

  // 2. Достаём тексты event.support.message по linkType='породило'.
  const supportMessages = await loadSupportMessages(db, problemId);

  // 3. Проверяем targetProjectPath.
  await assertTargetProjectExists(config.targetProjectPath, fsStat);

  // 4. Грузим system-prompt из файла.
  const systemPromptPath = deps.systemPromptPathOverride ?? DEFAULT_SYSTEM_PROMPT_PATH;
  const systemPromptRaw = await readSystemPrompt(systemPromptPath);
  const systemPrompt = renderSystemPrompt(systemPromptRaw, config);

  // 5. Формируем user-prompt из проблемы и сообщений.
  const userPrompt = buildUserPrompt(problem, supportMessages);

  // 6. Запускаем sub-agent.
  const subagentId = ulid();

  await emit({
    type: 'subagent.start',
    subagentId,
    subagentType: config.subagentType.toLowerCase().includes('explore')
      ? 'investigator'
      : config.subagentType,
    parentRecordId: problemId,
    problemId,
  });

  const startedAt = Date.now();
  const subagentResult = await runSubagent(
    {
      promptId: config.promptId,
      prompt: userPrompt,
      systemPrompt,
      model: config.model,
      cwd: config.targetProjectPath,
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
      canUseTool: makeBashWhitelistGuard(config.bashWhitelist),
      timeoutMs: config.timeoutMs,
      maxTurns: config.maxTurns,
      cycleParentId: problemId,
    },
    db,
  );

  // 7. Парсим вердикт.
  const investigation = extractInvestigation(subagentResult, config.timeoutMs);

  const durationMs = Date.now() - startedAt;
  const totalUsd = subagentResult.result?.total_cost_usd ?? 0;
  const totalTokens = computeTotalTokens(subagentResult.result);

  await emit({
    type: 'subagent.end',
    subagentId,
    durationMs,
    verdict: investigation.verdict,
    totalUsd,
    totalTokens,
    timedOut: subagentResult.timedOut,
  });

  // 8. Лимит токенов на одну investigation (план 2.3a: 100K).
  if (totalTokens > config.maxTokens) {
    throw new InvestigateBudgetExceededError(totalTokens, config.maxTokens);
  }

  return {
    verdict: investigation.verdict,
    rationale: investigation.rationale,
    codeRefs: investigation.codeRefs,
    gitHints: investigation.gitHints,
    subagentId,
    totalUsd,
    totalTokens,
    durationMs,
    timedOut: subagentResult.timedOut,
    spendRecordId: subagentResult.spendRecordId,
  };
}

// ---------------------------------------------------------------------------
// Загрузка intent.problem из Record.
// ---------------------------------------------------------------------------

interface IntentProblemRow {
  id: string;
  summary: string;
  symptoms: string[];
}

async function loadIntentProblem(db: PrismaClient, problemId: string): Promise<IntentProblemRow> {
  const rows = await db.$queryRawUnsafe<Array<{ id: string; properties: string }>>(
    `SELECT id, properties FROM "Record" WHERE id = ? AND type = 'intent.problem' LIMIT 1`,
    problemId,
  );
  const row = rows[0];
  if (row === undefined) {
    throw new InvestigateConfigError(
      `intent.problem с id=${problemId} не найден в журнале. Возможно, 2.2b ещё не отработал?`,
      'no-problem-record',
    );
  }
  let parsed: { summary?: unknown; symptoms?: unknown };
  try {
    parsed = JSON.parse(row.properties) as { summary?: unknown; symptoms?: unknown };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new InvestigateConfigError(
      `intent.problem.properties не парсится как JSON: ${reason}`,
      'no-problem-record',
    );
  }
  if (typeof parsed.summary !== 'string') {
    throw new InvestigateConfigError(
      `intent.problem.properties.summary не строка (id=${problemId})`,
      'no-problem-record',
    );
  }
  const symptoms: string[] = [];
  if (Array.isArray(parsed.symptoms)) {
    for (const s of parsed.symptoms) {
      if (typeof s === 'string') symptoms.push(s);
    }
  }
  return { id: row.id, summary: parsed.summary, symptoms };
}

// ---------------------------------------------------------------------------
// Загрузка текстов support-сообщений через RecordLink linkType='породило'.
//
// Граф: event.support.message --(породило)--> intent.problem.
// Ищем все RecordLink, у которых toRecordId=problemId AND linkType='породило',
// затем тянем Record по fromRecordId.
// ---------------------------------------------------------------------------

interface SupportMessageRow {
  id: string;
  text: string;
  username: string | null;
  timestamp: number;
}

async function loadSupportMessages(
  db: PrismaClient,
  problemId: string,
): Promise<SupportMessageRow[]> {
  const rows = await db.$queryRawUnsafe<
    Array<{ id: string; properties: string; createdAt: number }>
  >(
    `SELECT r.id, r.properties, r.createdAt
       FROM "RecordLink" l
       JOIN "Record" r ON r.id = l.fromRecordId
      WHERE l.toRecordId = ?
        AND l.linkType = 'породило'
        AND r.type = 'event.support.message'
      ORDER BY r.createdAt ASC`,
    problemId,
  );

  const out: SupportMessageRow[] = [];
  for (const row of rows) {
    let parsed: { text?: unknown; username?: unknown; timestamp?: unknown };
    try {
      parsed = JSON.parse(row.properties) as {
        text?: unknown;
        username?: unknown;
        timestamp?: unknown;
      };
    } catch {
      continue;
    }
    const text = typeof parsed.text === 'string' ? parsed.text : '';
    const username = typeof parsed.username === 'string' ? parsed.username : null;
    const timestamp =
      typeof parsed.timestamp === 'number' ? parsed.timestamp : Number(row.createdAt);
    out.push({ id: row.id, text, username, timestamp });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Проверка папки проекта.
// ---------------------------------------------------------------------------

async function defaultStat(path: string): Promise<{ isDirectory(): boolean }> {
  return stat(path);
}

async function assertTargetProjectExists(
  path: string,
  fsStat: (p: string) => Promise<{ isDirectory(): boolean }>,
): Promise<void> {
  let info: { isDirectory(): boolean };
  try {
    info = await fsStat(path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new InvestigateConfigError(
      `targetProjectPath=${path} не существует: ${reason}. Положи репозиторий проекта по этому пути или обнови config/investigate.md.`,
      'no-target-project',
    );
  }
  if (!info.isDirectory()) {
    throw new InvestigateConfigError(
      `targetProjectPath=${path} существует, но это не директория. Обнови config/investigate.md.`,
      'no-target-project',
    );
  }
}

// ---------------------------------------------------------------------------
// Загрузка system-prompt + рендер плейсхолдеров.
// ---------------------------------------------------------------------------

async function readSystemPrompt(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const abs = resolve(process.cwd(), path);
  return readFile(abs, 'utf-8');
}

function renderSystemPrompt(template: string, config: InvestigateConfig): string {
  // Имя проекта — последний сегмент пути. Например, «example-project».
  const projectName = extractProjectName(config.targetProjectPath);
  const timeoutMin = Math.round(config.timeoutMs / 60_000);
  const maxTokensK = Math.round(config.maxTokens / 1000);
  return template
    .replace(/\{\{projectName\}\}/g, projectName)
    .replace(/\{\{timeoutMin\}\}/g, String(timeoutMin))
    .replace(/\{\{maxTokensK\}\}/g, String(maxTokensK));
}

function extractProjectName(absPath: string): string {
  const segments = absPath.split('/').filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? 'неизвестный-проект';
}

// ---------------------------------------------------------------------------
// User prompt — что именно sub-agent читает на старте.
// ---------------------------------------------------------------------------

function buildUserPrompt(problem: IntentProblemRow, supportMessages: SupportMessageRow[]): string {
  const lines: string[] = [];
  lines.push(`# intent.problem ${problem.id}`);
  lines.push('');
  lines.push(`**Summary:** ${problem.summary}`);
  lines.push('');
  if (problem.symptoms.length > 0) {
    lines.push('**Симптомы:**');
    for (const s of problem.symptoms) {
      lines.push(`- ${s}`);
    }
    lines.push('');
  }
  lines.push(`## Тексты клиентских жалоб (${supportMessages.length} сообщений из support-канала)`);
  if (supportMessages.length === 0) {
    lines.push('');
    lines.push(
      '_Сообщений нет. Это редкий случай — обычно intent.problem связан минимум с одним event.support.message. Сделай вердикт unclear и объясни в rationale._',
    );
  } else {
    for (const m of supportMessages) {
      lines.push('');
      const username = m.username !== null ? `@${m.username}` : 'без username';
      const ts = new Date(m.timestamp).toISOString();
      const text = m.text.length > 0 ? m.text : '(текста нет)';
      lines.push(`### [${m.id}] ${username} · ${ts}`);
      lines.push(text);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    `Иди в код, сделай расследование, в конце вызови tool **${FINISH_INVESTIGATION_TOOL_NAME}** со схемой:`,
  );
  lines.push('```json');
  lines.push(`${JSON.stringify(FINISH_INVESTIGATION_INPUT_SCHEMA, null, 2)}`);
  lines.push('```');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool-schema финального ответа sub-agent. План 2.3a фиксирует shape.
//
// Sub-agent в SDK не имеет нашего custom tool как «настоящего» tool'а — Claude
// Agent SDK работает с системными tool'ами (Read/Grep/Bash/...). Поэтому
// finish_investigation мы ловим через ParseTextWithJsonBlock в последнем
// assistant-сообщении: модели показано в системном промпте «вызови tool X со
// схемой Y», она в финальном assistant-блоке выдаёт JSON-блок с этой формой.
// Это эквивалентно forced-tool в чистом Anthropic API, но через текстовый
// канал — для SDK так проще, чем регистрировать MCP-tool ради одного вызова.
// ---------------------------------------------------------------------------

const FINISH_INVESTIGATION_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['code', 'human', 'unclear'] },
    rationale: {
      type: 'string',
      description: 'обоснование 2-5 предложений на русском',
    },
    codeRefs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          line: { type: 'number' },
          snippet: { type: 'string' },
        },
        required: ['path'],
      },
    },
    gitHints: {
      type: 'array',
      items: { type: 'string', description: 'commit sha, PR url, или текстовый хинт' },
    },
  },
  required: ['verdict', 'rationale'],
} as const;

// ---------------------------------------------------------------------------
// Bash whitelist через canUseTool. SDK вызывает callback для каждого tool-use
// ДО исполнения. Мы пропускаем Read/Grep/Glob без проверки (они read-only по
// определению) и Bash — только если команда начинается с одного из whitelist'ов.
// ---------------------------------------------------------------------------

type CanUseTool = NonNullable<Parameters<typeof defaultRunSubagent>[0]['canUseTool']>;

function makeBashWhitelistGuard(whitelist: string[]): CanUseTool {
  return async (toolName, input) => {
    if (toolName !== 'Bash') {
      return { behavior: 'allow', updatedInput: input };
    }
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (command.length === 0) {
      return { behavior: 'deny', message: 'пустая Bash-команда не разрешена' };
    }
    // Простая защита: запрещаем shell-композиторы, чтобы не пробросить
    // write-команду через `&&`/`;`/pipe. Read-only исследователю это не нужно.
    if (/[;&|`$]/.test(command)) {
      return {
        behavior: 'deny',
        message: `запрещены shell-композиторы (;, &, |, \`, $) в Bash; команда: ${command.slice(0, 80)}`,
      };
    }
    for (const allowed of whitelist) {
      if (command === allowed || command.startsWith(`${allowed} `)) {
        return { behavior: 'allow', updatedInput: input };
      }
    }
    return {
      behavior: 'deny',
      message: `Bash-команда не в whitelist'е config/investigate.md: ${command.slice(0, 80)}`,
    };
  };
}

// ---------------------------------------------------------------------------
// Парсинг ответа sub-agent — finish_investigation tool_use блок ИЛИ
// JSON-блок в финальном assistant-сообщении.
// ---------------------------------------------------------------------------

class InvestigateBudgetExceededError extends Error {
  constructor(
    public readonly used: number,
    public readonly cap: number,
  ) {
    super(`investigate: использовано ${used} токенов > лимит ${cap}`);
    this.name = 'InvestigateBudgetExceededError';
  }
}

interface ParsedInvestigation {
  verdict: InvestigationVerdict;
  rationale: string;
  codeRefs: CodeRef[];
  gitHints: string[];
}

function extractInvestigation(
  subagentResult: SubagentRunResult,
  timeoutMs: number,
): ParsedInvestigation {
  // Если был тайм-аут — возвращаем синтетический «unclear».
  if (subagentResult.timedOut) {
    const minutes = Math.round(timeoutMs / 60_000);
    return {
      verdict: 'unclear',
      rationale: `тайм-аут ${minutes} мин`,
      codeRefs: [],
      gitHints: [],
    };
  }

  // Если SDK дошёл до error_max_turns / error_max_budget_usd — тоже unclear.
  if (subagentResult.result !== null && subagentResult.result.subtype !== 'success') {
    return {
      verdict: 'unclear',
      rationale: `sub-agent не дошёл до вердикта: ${subagentResult.result.subtype}`,
      codeRefs: [],
      gitHints: [],
    };
  }

  // Ищем finish_investigation:
  //   1) среди tool_use блоков всех assistant-сообщений (если SDK зарегистрирует
  //      кастомный tool через MCP — мы готовы ловить);
  //   2) среди JSON-блоков финального assistant-text сообщения (текущий путь —
  //      модель пишет JSON в текст по инструкции из системного промпта).
  const fromToolUse = findFinishToolUse(subagentResult.messages);
  if (fromToolUse !== null) {
    const validated = validateInvestigationShape(fromToolUse);
    if (validated === null) {
      throw new InvestigateInvalidResponseError(
        'finish_investigation tool_use input не соответствует схеме',
        'schema-mismatch',
      );
    }
    return validated;
  }

  const fromText = findFinishJsonInText(subagentResult.messages);
  if (fromText === null) {
    throw new InvestigateInvalidResponseError(
      'sub-agent не вернул finish_investigation (ни tool_use, ни JSON в тексте)',
      'no-tool-use',
    );
  }
  const validated = validateInvestigationShape(fromText);
  if (validated === null) {
    throw new InvestigateInvalidResponseError(
      'JSON в финальном тексте не соответствует схеме finish_investigation',
      'schema-mismatch',
    );
  }
  return validated;
}

// Перебираем messages в обратном порядке — нужен ПОСЛЕДНИЙ tool_use
// finish_investigation. Тип SDKMessage — широкий union, лезем по shape вручную.
function findFinishToolUse(messages: ReadonlyArray<unknown>): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg.type !== 'assistant') continue;
    const content = (msg.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j] as Record<string, unknown>;
      if (block.type === 'tool_use' && block.name === FINISH_INVESTIGATION_TOOL_NAME) {
        return block.input;
      }
    }
  }
  return null;
}

// Ищем JSON-блок в последнем assistant-text. Поддерживаем два формата:
//   1) ```json { ... } ``` — codefence;
//   2) голый { ... } в конце текста.
function findFinishJsonInText(messages: ReadonlyArray<unknown>): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg.type !== 'assistant') continue;
    const content = (msg.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) continue;
    const textBlocks: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') textBlocks.push(b.text);
    }
    if (textBlocks.length === 0) continue;
    const text = textBlocks.join('\n');

    const codefence = text.match(/```json\s*\n([\s\S]*?)\n```/);
    if (codefence && codefence[1] !== undefined) {
      try {
        return JSON.parse(codefence[1]);
      } catch {
        // ищем дальше
      }
    }
    // Голый JSON: последний `{` до конца текста.
    const start = text.lastIndexOf('{');
    if (start >= 0) {
      const candidate = text.slice(start);
      try {
        return JSON.parse(candidate);
      } catch {
        // ищем дальше
      }
    }
    // Этот assistant без валидного JSON — но он последний; смысла идти к
    // более раннему нет (там не финальный вердикт).
    return null;
  }
  return null;
}

function validateInvestigationShape(input: unknown): ParsedInvestigation | null {
  if (typeof input !== 'object' || input === null) return null;
  const obj = input as Record<string, unknown>;
  const verdict = obj.verdict;
  if (verdict !== 'code' && verdict !== 'human' && verdict !== 'unclear') return null;
  if (typeof obj.rationale !== 'string' || obj.rationale.length === 0) return null;

  const codeRefs: CodeRef[] = [];
  if (Array.isArray(obj.codeRefs)) {
    for (const ref of obj.codeRefs) {
      if (typeof ref !== 'object' || ref === null) return null;
      const r = ref as Record<string, unknown>;
      if (typeof r.path !== 'string' || r.path.length === 0) return null;
      const next: CodeRef = { path: r.path };
      if (typeof r.line === 'number' && Number.isFinite(r.line)) next.line = r.line;
      if (typeof r.snippet === 'string') next.snippet = r.snippet;
      codeRefs.push(next);
    }
  }

  const gitHints: string[] = [];
  if (Array.isArray(obj.gitHints)) {
    for (const h of obj.gitHints) {
      if (typeof h !== 'string') return null;
      gitHints.push(h);
    }
  }

  return { verdict, rationale: obj.rationale, codeRefs, gitHints };
}

// SDK NonNullableUsage — camelCase. Тестовые SDKResultLike могут отдать
// snake_case. Sum: input + output + cacheRead + cacheCreation. Используется
// для лимита 100K (план 2.3a).
function computeTotalTokens(result: SDKResultLike | null): number {
  if (result === null) return 0;
  const u = result.usage;
  return (
    (u.inputTokens ?? u.input_tokens ?? 0) +
    (u.outputTokens ?? u.output_tokens ?? 0) +
    (u.cacheReadInputTokens ?? u.cache_read_input_tokens ?? 0) +
    (u.cacheCreationInputTokens ?? u.cache_creation_input_tokens ?? 0)
  );
}

// Экспортирована для тестов — чтобы они могли проверить deny-логику Bash.
export const __test_makeBashWhitelistGuard = makeBashWhitelistGuard;
export { InvestigateBudgetExceededError };
