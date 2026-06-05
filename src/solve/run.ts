// Обёртка sub-agent-решателя (фаза 2.4a).
//
// Что делает solveDiagnosis:
//   1. Грузит intent.diagnosis по id (verdict обязан быть 'code', иначе → SolveConfigError).
//   2. По цепочке RecordLink linkType='заключение' (fromRecordId=diagnosisId,
//      toRecordId=problemId) находит intent.problem.
//   3. По RecordLink linkType='породило' (fromRecordId=event.support.message,
//      toRecordId=problemId) собирает тексты клиентских жалоб.
//   4. Грузит config/solve.md и system-prompt из src/solve/system.md.
//   5. Проверяет существование targetProjectPath. Если папки нет —
//      SolveConfigError(no-target-project) с просьбой обновить config.
//   6. Запускает Claude Agent SDK через runSubagent() с:
//        - cwd = targetProjectPath
//        - allowedTools = [Read, Grep, Glob, Bash]
//        - canUseTool = whitelist Bash через bashWhitelist
//        - timeoutMs / maxTurns / maxTokens из config
//        - tool-schema finish_proposal в системном промпте (как описание),
//          парсится из tool_use блоков ИЛИ JSON-блока в финальном assistant-text
//          (тот же приём, что в 2.3a — кастомный tool в SDK не регистрируется).
//   7. Извлекает finish_proposal → SolveResult.
//   8. Эмитит solve.start/solve.end в Bridge.
//
// Что НЕ делает (намеренно — это 2.4b/2.5/3.3):
//   * НЕ пишет intent.proposal Record и НЕ создаёт RecordLink linkType='решает'.
//     Это материализация в 2.4b. SolveResult — pure value, без побочных INSERT'ов.
//   * НЕ управляет fan-out'ом по нескольким diagnosis. Решатель бежит на каждой
//     'code'-проблеме отдельно через runIteration в 2.5.
//   * НЕ применяет правки к файлам целевого проекта. Edit/Write — это 3.3a (исполнитель).
//   * НЕ интегрируется в runIteration — это 2.5.
//
// Отличия от исследователя (важно для контракта):
//   * verdict-чек: solveDiagnosis работает только с verdict='code'. Любой другой
//     → SolveConfigError, не «синтетический unclear». Никакого пустого предложения.
//   * Тайм-аут — это ошибка, не unclear: → throw SolveTimeoutError. Если ответа
//     нет, отчёт в 2.5 явно покажет «решатель не справился по таймауту»; не
//     маскируем неудачу под «вот вам пустое решение».

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
import { type SolveConfig, loadSolveConfig } from './config.js';

// ---------------------------------------------------------------------------
// Контракт. Критичен для 2.4b (которая принимает SolveResult и материализует
// в intent.proposal со связью linkType='решает' к intent.diagnosis).
// ---------------------------------------------------------------------------

export interface ProposalFile {
  path: string;
  action: 'edit' | 'create' | 'delete';
  oldSnippet?: string;
  newSnippet?: string;
}

export interface SolveResult {
  // Три абзаца — основное тело предложения, формат «как сейчас → проблема → как
  // будет». Каждый — связный текст одного абзаца, без подзаголовков/списков.
  asIs: string;
  problem: string;
  asWillBe: string;
  // Какие файлы предлагается тронуть. Может быть пустым массивом в редких
  // случаях, но обычно для verdict='code' — непустой.
  files: ProposalFile[];
  // Оценка времени правки в минутах для исполнителя (M3.3).
  estimateMinutes: number;
  // ULID sub-agent'а — связка с Bridge solve.start/end и с audit.spend.parentId.
  subagentId: string;
  // Деньги/токены за весь sub-agent run.
  totalUsd: number;
  totalTokens: number;
  durationMs: number;
  // Решатель сам timedOut в SolveResult НЕ выставит как true — на тайм-аут
  // throw'им SolveTimeoutError. Поле остаётся false для совместимости с
  // унифицированным sub-agent shape (тот же паттерн, что в InvestigationResult,
  // на случай если 2.4b/2.5 захотят прочитать его без условной проверки).
  timedOut: boolean;
  // ID Записи audit.spend, которую создал subagent.ts. null — sub-agent упал
  // до того, как мы получили usage (например, SDK abort до result message).
  spendRecordId: string | null;
}

// ---------------------------------------------------------------------------
// Ошибки.
// ---------------------------------------------------------------------------

export class SolveConfigError extends Error {
  constructor(
    message: string,
    public readonly reason: 'verdict-not-code' | 'no-diagnosis-record' | 'no-target-project',
  ) {
    super(message);
    this.name = 'SolveConfigError';
  }
}

export class SolveInvalidResponseError extends Error {
  constructor(
    message: string,
    public readonly reason: 'no-tool-use' | 'wrong-tool' | 'schema-mismatch',
  ) {
    super(message);
    this.name = 'SolveInvalidResponseError';
  }
}

export class SolveTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`решатель: тайм-аут после ${timeoutMs}ms — предложение не получено`);
    this.name = 'SolveTimeoutError';
  }
}

export class SolveBudgetExceededError extends Error {
  constructor(
    public readonly used: number,
    public readonly cap: number,
  ) {
    super(`решатель: использовано ${used} токенов > лимит ${cap}`);
    this.name = 'SolveBudgetExceededError';
  }
}

// ---------------------------------------------------------------------------
// DI.
// ---------------------------------------------------------------------------

export interface SolveDeps {
  db?: PrismaClient;
  // Подмена runSubagent для тестов (без реального SDK-вызова).
  runSubagentImpl?: typeof defaultRunSubagent;
  // Override config — для тестов с tempdir-fixture.
  configOverride?: SolveConfig;
  // Override system prompt path. Дефолт — `src/solve/system.md`.
  systemPromptPathOverride?: string;
  // Подменяет fs.stat (для тестов с виртуальной FS).
  fsStatImpl?: (path: string) => Promise<{ isDirectory(): boolean }>;
  // Опционально — parentSession для группировки solve.start/end в Bridge.
  // 2.5 будет передавать общий sessionId итерации.
  parentSession?: string;
}

const DEFAULT_SYSTEM_PROMPT_PATH = 'src/solve/system.md';
const FINISH_PROPOSAL_TOOL_NAME = 'finish_proposal';

// ---------------------------------------------------------------------------
// Главная функция.
// ---------------------------------------------------------------------------

export async function solveDiagnosis(
  diagnosisId: string,
  deps: SolveDeps = {},
): Promise<SolveResult> {
  const db = deps.db ?? getPrisma();
  const runSubagent = deps.runSubagentImpl ?? defaultRunSubagent;
  const config = deps.configOverride ?? (await loadSolveConfig());
  const fsStat = deps.fsStatImpl ?? defaultStat;

  // 1. Достаём intent.diagnosis. verdict='code' — обязательно.
  const diagnosis = await loadDiagnosis(db, diagnosisId);

  // 2. Находим intent.problem через RecordLink linkType='заключение'.
  const problem = await loadProblemForDiagnosis(db, diagnosisId);

  // 3. Тексты клиентских жалоб.
  const supportMessages = await loadSupportMessages(db, problem.id);

  // 4. Проверяем targetProjectPath.
  await assertTargetProjectExists(config.targetProjectPath, fsStat);

  // 5. Грузим system-prompt.
  const systemPromptPath = deps.systemPromptPathOverride ?? DEFAULT_SYSTEM_PROMPT_PATH;
  const systemPromptRaw = await readSystemPrompt(systemPromptPath);
  const systemPrompt = renderSystemPrompt(systemPromptRaw, config);

  // 6. User-prompt.
  const userPrompt = buildUserPrompt(diagnosis, problem, supportMessages);

  // 7. Запускаем sub-agent.
  const subagentId = ulid();

  const startEvent: {
    type: 'solve.start';
    subagentId: string;
    diagnosisId: string;
    parentSession?: string;
  } = {
    type: 'solve.start',
    subagentId,
    diagnosisId,
  };
  if (deps.parentSession !== undefined) {
    startEvent.parentSession = deps.parentSession;
  }
  await emit(startEvent);

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
      cycleParentId: diagnosisId,
    },
    db,
  );

  const durationMs = Date.now() - startedAt;
  const totalUsd = subagentResult.result?.total_cost_usd ?? 0;
  const totalTokens = computeTotalTokens(subagentResult.result);

  await emit({
    type: 'solve.end',
    subagentId,
    durationMs,
    totalUsd,
    totalTokens,
    timedOut: subagentResult.timedOut,
  });

  // 8. На тайм-аут — throw, не fake-результат. У решателя «решения нет» = ошибка.
  if (subagentResult.timedOut) {
    throw new SolveTimeoutError(config.timeoutMs);
  }

  // 9. Лимит токенов на одну solve-сессию (config: 100K).
  if (totalTokens > config.maxTokens) {
    throw new SolveBudgetExceededError(totalTokens, config.maxTokens);
  }

  // 10. Парсим финальное предложение.
  const proposal = extractProposal(subagentResult);

  return {
    asIs: proposal.asIs,
    problem: proposal.problem,
    asWillBe: proposal.asWillBe,
    files: proposal.files,
    estimateMinutes: proposal.estimateMinutes,
    subagentId,
    totalUsd,
    totalTokens,
    durationMs,
    timedOut: false,
    spendRecordId: subagentResult.spendRecordId,
  };
}

// ---------------------------------------------------------------------------
// Загрузка intent.diagnosis. verdict='code' обязателен.
// ---------------------------------------------------------------------------

interface DiagnosisRow {
  id: string;
  rationale: string;
  codeRefs: Array<{ path: string; line?: number; snippet?: string }>;
  gitHints: string[];
}

async function loadDiagnosis(db: PrismaClient, diagnosisId: string): Promise<DiagnosisRow> {
  const rows = await db.$queryRawUnsafe<Array<{ id: string; properties: string }>>(
    `SELECT id, properties FROM "Record" WHERE id = ? AND type = 'intent.diagnosis' LIMIT 1`,
    diagnosisId,
  );
  const row = rows[0];
  if (row === undefined) {
    throw new SolveConfigError(
      `intent.diagnosis с id=${diagnosisId} не найден в журнале. Возможно, 2.3c ещё не отработал?`,
      'no-diagnosis-record',
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.properties) as Record<string, unknown>;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new SolveConfigError(
      `intent.diagnosis.properties не парсится как JSON: ${reason}`,
      'no-diagnosis-record',
    );
  }
  const verdict = parsed.verdict;
  if (verdict !== 'code') {
    throw new SolveConfigError(
      `intent.diagnosis(${diagnosisId}).verdict='${String(verdict)}' — решатель работает только с verdict='code'. Это, скорее всего, баг вызывающего кода: он должен фильтровать через 2.4a-канонический SELECT (verdict='code' AND NOT EXISTS inverse 'решает').`,
      'verdict-not-code',
    );
  }
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale : '';
  const codeRefs: Array<{ path: string; line?: number; snippet?: string }> = [];
  if (Array.isArray(parsed.codeRefs)) {
    for (const ref of parsed.codeRefs) {
      if (typeof ref !== 'object' || ref === null) continue;
      const r = ref as Record<string, unknown>;
      if (typeof r.path !== 'string' || r.path.length === 0) continue;
      const next: { path: string; line?: number; snippet?: string } = { path: r.path };
      if (typeof r.line === 'number' && Number.isFinite(r.line)) next.line = r.line;
      if (typeof r.snippet === 'string') next.snippet = r.snippet;
      codeRefs.push(next);
    }
  }
  const gitHints: string[] = [];
  if (Array.isArray(parsed.gitHints)) {
    for (const h of parsed.gitHints) {
      if (typeof h === 'string') gitHints.push(h);
    }
  }
  return { id: row.id, rationale, codeRefs, gitHints };
}

// ---------------------------------------------------------------------------
// Поиск intent.problem через RecordLink linkType='заключение'.
//
// Граф: intent.diagnosis --(заключение)--> intent.problem.
// fromRecordId = diagnosisId, toRecordId = problemId.
// Берём первую связь — по контракту 2.3c у одного диагноза один заключение-link.
// ---------------------------------------------------------------------------

interface ProblemRow {
  id: string;
  summary: string;
  symptoms: string[];
}

async function loadProblemForDiagnosis(db: PrismaClient, diagnosisId: string): Promise<ProblemRow> {
  const rows = await db.$queryRawUnsafe<Array<{ id: string; properties: string }>>(
    `SELECT r.id, r.properties
       FROM "RecordLink" l
       JOIN "Record" r ON r.id = l.toRecordId
      WHERE l.fromRecordId = ?
        AND l.linkType = 'заключение'
        AND r.type = 'intent.problem'
      LIMIT 1`,
    diagnosisId,
  );
  const row = rows[0];
  if (row === undefined) {
    throw new SolveConfigError(
      `intent.diagnosis(${diagnosisId}) не имеет связи linkType='заключение' к intent.problem. Возможно, 2.3c не сработал или связь была удалена (что append-only запрещает).`,
      'no-diagnosis-record',
    );
  }
  let parsed: { summary?: unknown; symptoms?: unknown };
  try {
    parsed = JSON.parse(row.properties) as { summary?: unknown; symptoms?: unknown };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new SolveConfigError(
      `intent.problem.properties не парсится как JSON: ${reason}`,
      'no-diagnosis-record',
    );
  }
  const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
  const symptoms: string[] = [];
  if (Array.isArray(parsed.symptoms)) {
    for (const s of parsed.symptoms) {
      if (typeof s === 'string') symptoms.push(s);
    }
  }
  return { id: row.id, summary, symptoms };
}

// ---------------------------------------------------------------------------
// Загрузка текстов support-сообщений (тот же приём, что в src/investigate/run.ts).
// Граф: event.support.message --(породило)--> intent.problem.
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
    throw new SolveConfigError(
      `targetProjectPath=${path} не существует: ${reason}. Положи репозиторий проекта по этому пути или обнови config/solve.md.`,
      'no-target-project',
    );
  }
  if (!info.isDirectory()) {
    throw new SolveConfigError(
      `targetProjectPath=${path} существует, но это не директория. Обнови config/solve.md.`,
      'no-target-project',
    );
  }
}

// ---------------------------------------------------------------------------
// System-prompt + плейсхолдеры.
// ---------------------------------------------------------------------------

async function readSystemPrompt(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const abs = resolve(process.cwd(), path);
  return readFile(abs, 'utf-8');
}

function renderSystemPrompt(template: string, config: SolveConfig): string {
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
// User-prompt.
// ---------------------------------------------------------------------------

function buildUserPrompt(
  diagnosis: DiagnosisRow,
  problem: ProblemRow,
  supportMessages: SupportMessageRow[],
): string {
  const lines: string[] = [];
  lines.push(`# intent.diagnosis ${diagnosis.id}`);
  lines.push('');
  lines.push(`**Связан с intent.problem:** ${problem.id}`);
  lines.push('');
  lines.push(`**Summary проблемы:** ${problem.summary}`);
  lines.push('');
  if (problem.symptoms.length > 0) {
    lines.push('**Симптомы:**');
    for (const s of problem.symptoms) {
      lines.push(`- ${s}`);
    }
    lines.push('');
  }
  lines.push('## Обоснование исследователя');
  lines.push('');
  lines.push(diagnosis.rationale.length > 0 ? diagnosis.rationale : '_(пусто)_');
  lines.push('');
  if (diagnosis.codeRefs.length > 0) {
    lines.push('## Зацепки в коде (`codeRefs`)');
    lines.push('');
    for (const ref of diagnosis.codeRefs) {
      const loc = ref.line !== undefined ? `${ref.path}:${ref.line}` : ref.path;
      lines.push(`- **${loc}**`);
      if (ref.snippet !== undefined && ref.snippet.length > 0) {
        lines.push('  ```');
        lines.push(`  ${ref.snippet}`);
        lines.push('  ```');
      }
    }
    lines.push('');
  }
  if (diagnosis.gitHints.length > 0) {
    lines.push('## Git-зацепки');
    lines.push('');
    for (const h of diagnosis.gitHints) {
      lines.push(`- ${h}`);
    }
    lines.push('');
  }
  lines.push(`## Тексты клиентских жалоб (${supportMessages.length} сообщений)`);
  if (supportMessages.length === 0) {
    lines.push('');
    lines.push(
      '_Сообщений нет. Это редкий случай — обычно intent.problem связан минимум с одним event.support.message. Опиши решение по тому, что есть в `rationale` и `codeRefs`._',
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
    `Используй зацепки исследователя, при необходимости открой файлы из codeRefs. В конце вызови tool **${FINISH_PROPOSAL_TOOL_NAME}** со схемой:`,
  );
  lines.push('```json');
  lines.push(`${JSON.stringify(FINISH_PROPOSAL_INPUT_SCHEMA, null, 2)}`);
  lines.push('```');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool-schema финального ответа sub-agent. Зафиксирована планом 2.4a.
//
// Sub-agent в SDK не имеет нашего custom tool как «настоящего» tool'а. Поэтому
// finish_proposal мы ловим: (1) среди tool_use блоков (если SDK когда-нибудь
// будет регистрировать кастомный tool через MCP), (2) среди JSON-блоков
// финального assistant-text. Та же стратегия, что в 2.3a.
// ---------------------------------------------------------------------------

const FINISH_PROPOSAL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    asIs: { type: 'string', description: 'как сейчас (1 абзац)' },
    problem: { type: 'string', description: 'почему это проблема (1 абзац)' },
    asWillBe: { type: 'string', description: 'как будет после правки (1 абзац)' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          action: { type: 'string', enum: ['edit', 'create', 'delete'] },
          oldSnippet: { type: 'string' },
          newSnippet: { type: 'string' },
        },
        required: ['path', 'action'],
      },
    },
    estimateMinutes: {
      type: 'number',
      description: 'оценка времени на исправление в минутах',
    },
  },
  required: ['asIs', 'problem', 'asWillBe', 'files', 'estimateMinutes'],
} as const;

// ---------------------------------------------------------------------------
// Bash whitelist через canUseTool.
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
      message: `Bash-команда не в whitelist'е config/solve.md: ${command.slice(0, 80)}`,
    };
  };
}

// ---------------------------------------------------------------------------
// Парсинг ответа sub-agent — finish_proposal tool_use ИЛИ JSON-блок.
// ---------------------------------------------------------------------------

interface ParsedProposal {
  asIs: string;
  problem: string;
  asWillBe: string;
  files: ProposalFile[];
  estimateMinutes: number;
}

function extractProposal(subagentResult: SubagentRunResult): ParsedProposal {
  // SDK дошёл до error_max_turns / error_max_budget_usd → парсить нечего.
  if (subagentResult.result !== null && subagentResult.result.subtype !== 'success') {
    throw new SolveInvalidResponseError(
      `sub-agent не дошёл до предложения: ${subagentResult.result.subtype}`,
      'no-tool-use',
    );
  }

  const fromToolUse = findFinishToolUse(subagentResult.messages);
  if (fromToolUse !== null) {
    const validated = validateProposalShape(fromToolUse);
    if (validated === null) {
      throw new SolveInvalidResponseError(
        'finish_proposal tool_use input не соответствует схеме',
        'schema-mismatch',
      );
    }
    return validated;
  }

  const fromText = findFinishJsonInText(subagentResult.messages);
  if (fromText === null) {
    throw new SolveInvalidResponseError(
      'sub-agent не вернул finish_proposal (ни tool_use, ни JSON в тексте)',
      'no-tool-use',
    );
  }
  const validated = validateProposalShape(fromText);
  if (validated === null) {
    throw new SolveInvalidResponseError(
      'JSON в финальном тексте не соответствует схеме finish_proposal',
      'schema-mismatch',
    );
  }
  return validated;
}

function findFinishToolUse(messages: ReadonlyArray<unknown>): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg.type !== 'assistant') continue;
    const content = (msg.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j] as Record<string, unknown>;
      if (block.type === 'tool_use' && block.name === FINISH_PROPOSAL_TOOL_NAME) {
        return block.input;
      }
    }
  }
  return null;
}

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
    const start = text.lastIndexOf('{');
    if (start >= 0) {
      const candidate = text.slice(start);
      try {
        return JSON.parse(candidate);
      } catch {
        // ищем дальше
      }
    }
    return null;
  }
  return null;
}

function validateProposalShape(input: unknown): ParsedProposal | null {
  if (typeof input !== 'object' || input === null) return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.asIs !== 'string' || obj.asIs.length === 0) return null;
  if (typeof obj.problem !== 'string' || obj.problem.length === 0) return null;
  if (typeof obj.asWillBe !== 'string' || obj.asWillBe.length === 0) return null;
  if (typeof obj.estimateMinutes !== 'number' || !Number.isFinite(obj.estimateMinutes)) return null;
  if (!Array.isArray(obj.files)) return null;

  const files: ProposalFile[] = [];
  for (const item of obj.files) {
    if (typeof item !== 'object' || item === null) return null;
    const f = item as Record<string, unknown>;
    if (typeof f.path !== 'string' || f.path.length === 0) return null;
    if (f.action !== 'edit' && f.action !== 'create' && f.action !== 'delete') return null;
    const next: ProposalFile = { path: f.path, action: f.action };
    if (typeof f.oldSnippet === 'string') next.oldSnippet = f.oldSnippet;
    if (typeof f.newSnippet === 'string') next.newSnippet = f.newSnippet;
    files.push(next);
  }

  return {
    asIs: obj.asIs,
    problem: obj.problem,
    asWillBe: obj.asWillBe,
    files,
    estimateMinutes: obj.estimateMinutes,
  };
}

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

// Экспорт для тестов deny-логики Bash.
export const __test_makeBashWhitelistGuard = makeBashWhitelistGuard;
