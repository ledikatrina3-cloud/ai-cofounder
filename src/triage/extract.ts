// Триаж (фаза 2.2a): один Sonnet-вызов, на входе — пакет support-сообщений,
// на выходе — structured-список проблем через tool_use `extract_problems`.
//
// Что эта функция НЕ делает (намеренно):
//   * Не пишет intent.problem Records — это задача 2.2b после межвызовного дедупа.
//   * Не делает embeddings/cosine — это 2.2b.
//   * Не дёргает src/perception/support.ts — caller передаёт готовый массив.
//
// Что эта функция ДЕЛАЕТ:
//   * Грузит system.md (триаж-промпт) + src/triage/character.md (персонаж)
//     и кладёт оба блока в `systemBlocks` с `cache_control: ephemeral`. Так шапка
//     кэшируется на стороне Anthropic — следующие вызовы платят cacheRead-тариф
//     (10× дешевле input).
//   * Форматирует входящие SupportMessage'ы в plain markdown (НЕ JSON.stringify —
//     кириллица в JSON escape'ится в \uXXXX, +30% токенов и хуже читается моделью).
//   * Передаёт tool-schema `extract_problems` через `tools` + `tool_choice: {type:'tool'}`
//     — модель ОБЯЗАНА вернуть structured output, а не свободный текст.
//   * Парсит первый tool_use блок ответа, валидирует shape вручную (без Zod —
//     одна функция, четыре проверки, не стоит лишней зависимости), возвращает
//     `{problems: [...]}`. Невалидный shape → throw + audit.triage.invalid в БД,
//     чтобы остался след.
//   * Эмитит BridgeEvent `triage.extract.start/end`.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ulid } from 'ulid';
import type { PrismaClient } from '../db/client.js';
import { getPrisma } from '../db/client.js';
import { type CallResult, type CallTool, call as llmCall } from '../llm/call.js';
import { emit } from '../observe/bridge.js';
import { type TriageConfig, loadTriageConfig } from './config.js';

// ---------------------------------------------------------------------------
// Контракты — критичны для 2.2b (которая получает TriageResult и материализует
// в intent.problem через embeddings).
// ---------------------------------------------------------------------------

// Минимальный shape входящего сообщения. Совместим с
// `SupportMessageProperties` из `src/perception/support.ts` + добавлено поле `id`
// (Record.id из БД). Импортировать тип из support.ts намеренно НЕ делаем —
// extract.ts не должен зависеть от perception-слоя в production-пути.
/**
 * @deprecated since 2026-05-01 pivot — routine support-triage заменяет этот pipeline
 */
export interface SupportMessage {
  // Record.id event.support.message — попадает в TriageProblem.supportMessageIds.
  id: string;
  chatId: string;
  messageId: number;
  userId: string | null;
  username: string | null;
  text: string;
  attachments: Array<{ type: 'voice'; file_id: string; transcribed: boolean }>;
  // Unix-ms.
  timestamp: number;
}

export interface TriageProblem {
  summary: string;
  symptoms: string[];
  // Record.id всех event.support.message, объединённых в эту проблему.
  // Минимум один. Дубликаты допустимы, но не ожидаются.
  supportMessageIds: string[];
}

export interface TriageResult {
  problems: TriageProblem[];
  // Метаданные вызова — нужны 2.2b/2.5 для отчётов и для сшивки с audit.spend.
  spendRecordId: string;
  usd: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// DI: пути к промпт-файлам можно подменить в тестах. Дефолты — production-пути.
// Промпт триажа (system.md) и персона агента (character.md) лежат рядом
// в `src/triage/` — оба читаются с cache_control: ephemeral.
// ---------------------------------------------------------------------------

export interface ExtractDeps {
  db?: PrismaClient;
  // Подмена call.ts для тестов: возвращает CallResult, аналог clientOverride
  // в budget.test.ts, но на уровень выше (минует guard/spend/pricing). Тесты
  // используют для snapshot/edge-кейсов; в проде не передавать.
  callImpl?: typeof llmCall;
  systemPromptPath?: string;
  characterPath?: string;
  configOverride?: TriageConfig;
}

const DEFAULT_SYSTEM_PROMPT_PATH = 'src/triage/system.md';
const DEFAULT_CHARACTER_PATH = 'src/triage/character.md';

const PROMPT_ID = 'triage:extract';

// ---------------------------------------------------------------------------
// Tool-schema. Зафиксирован в плане 2.2a.
// ---------------------------------------------------------------------------

const EXTRACT_PROBLEMS_TOOL: CallTool = {
  name: 'extract_problems',
  description:
    'Вернуть structured-список проблем, извлечённых из пакета support-сообщений. Дедуп — внутри одного вызова: разные сообщения об одной проблеме объединяются в одну запись со множеством supportMessageIds.',
  input_schema: {
    type: 'object',
    properties: {
      problems: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            summary: {
              type: 'string',
              description: 'Короткое описание проблемы (1 предложение, по-русски).',
            },
            symptoms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Наблюдаемые симптомы из сообщений (цитаты или близко к ним).',
            },
            supportMessageIds: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Record.id всех event.support.message, объединённых в эту проблему. Минимум один.',
            },
          },
          required: ['summary', 'symptoms', 'supportMessageIds'],
        },
      },
    },
    required: ['problems'],
  },
};

// ---------------------------------------------------------------------------
// Кэш промпт-файлов в процессе. Триаж 1×/день, но в тестах загрузка на каждый
// it() даст лишний IO. Простая Map по path, без TTL — файлы не меняются за
// время жизни процесса (правка триаж-промпта = restart).
// ---------------------------------------------------------------------------

const PROMPT_FILE_CACHE = new Map<string, Promise<string>>();

function loadPromptFile(path: string, rootDir: string = process.cwd()): Promise<string> {
  const abs = resolve(rootDir, path);
  let cached = PROMPT_FILE_CACHE.get(abs);
  if (cached === undefined) {
    cached = readFile(abs, 'utf-8');
    PROMPT_FILE_CACHE.set(abs, cached);
  }
  return cached;
}

// Тестовый хук: сбросить кэш промпт-файлов между тестами, если они подменяют пути.
export function _resetPromptCache(): void {
  PROMPT_FILE_CACHE.clear();
}

// ---------------------------------------------------------------------------
// Основная функция.
// ---------------------------------------------------------------------------

export async function extractProblems(
  messages: SupportMessage[],
  deps: ExtractDeps = {},
): Promise<TriageResult> {
  const db = deps.db ?? getPrisma();
  const callImpl = deps.callImpl ?? llmCall;
  const systemPromptPath = deps.systemPromptPath ?? DEFAULT_SYSTEM_PROMPT_PATH;
  const characterPath = deps.characterPath ?? DEFAULT_CHARACTER_PATH;

  const config = deps.configOverride ?? (await loadTriageConfig());

  const startedAt = Date.now();

  await emit({
    type: 'triage.extract.start',
    messagesIn: messages.length,
    model: config.model,
    promptId: PROMPT_ID,
  });

  // Шапка из двух markdown-файлов с cache_control: ephemeral. Anthropic кэширует
  // обе плашки; на холодном вызове платим cacheWrite-тариф, на тёплом (≤5 мин)
  // — cacheRead (~10× дешевле input).
  const [systemMd, characterMd] = await Promise.all([
    loadPromptFile(systemPromptPath),
    loadPromptFile(characterPath),
  ]);

  const userMessage = formatSupportMessages(messages);

  let result: CallResult;
  try {
    result = await callImpl(
      {
        promptId: PROMPT_ID,
        model: config.model,
        maxTokens: config.maxTokens,
        systemBlocks: [
          { type: 'text', text: systemMd, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: characterMd, cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: userMessage }],
        tools: [EXTRACT_PROBLEMS_TOOL],
        toolChoice: config.toolChoice,
      },
      db,
    );
  } catch (err) {
    // BudgetExceededError или сетевая ошибка — эмитим end с null spendRecordId
    // и пробрасываем дальше. audit.budget.deny уже записан guard'ом, отдельный
    // audit.triage.invalid писать НЕ нужно (это не наша вина).
    await emit({
      type: 'triage.extract.end',
      spendRecordId: null,
      problemsOut: 0,
      usd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }

  const problems = await parseAndValidateToolUse(result, db);

  const durationMs = Date.now() - startedAt;

  await emit({
    type: 'triage.extract.end',
    spendRecordId: result.spendRecordId,
    problemsOut: problems.length,
    usd: result.usd,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheReadTokens: result.usage.cacheReadTokens,
    cacheCreationTokens: result.usage.cacheCreationTokens,
    durationMs,
  });

  return {
    problems,
    spendRecordId: result.spendRecordId,
    usd: result.usd,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Форматирование входящих сообщений в plain markdown.
//
// Почему НЕ JSON.stringify: кириллица escape'ится в \uXXXX (+30% токенов),
// модель хуже читает escape'нутый JSON, чем плоский список. Markdown — компактнее
// и понятнее. Это согласовано с system.md.
// ---------------------------------------------------------------------------

export function formatSupportMessages(messages: SupportMessage[]): string {
  if (messages.length === 0) {
    return 'Сообщений нет. Верни problems: [].';
  }
  const lines: string[] = ['Пакет сообщений из support-канала:', ''];
  for (const m of messages) {
    const username = m.username !== null ? `@${m.username}` : 'без username';
    const ts = new Date(m.timestamp).toISOString();
    const body = m.text.length > 0 ? m.text : '(текста нет)';
    lines.push(`[id=${m.id}] ${username} (${ts}): ${body}`);
    if (m.attachments.length > 0) {
      const summary = m.attachments
        .map((a) => `${a.type}${a.transcribed ? '' : ' (не разобрано)'}`)
        .join(', ');
      lines.push(`  attachments: ${summary}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Парсинг и валидация tool_use ответа.
// ---------------------------------------------------------------------------

export class TriageInvalidResponseError extends Error {
  constructor(
    message: string,
    public readonly reason: 'no-tool-use' | 'wrong-tool' | 'schema-mismatch',
    public readonly auditRecordId: string,
  ) {
    super(message);
    this.name = 'TriageInvalidResponseError';
  }
}

async function parseAndValidateToolUse(
  result: CallResult,
  db: PrismaClient,
): Promise<TriageProblem[]> {
  const toolUse = result.toolUses.find((t) => t.name === EXTRACT_PROBLEMS_TOOL.name);
  if (toolUse === undefined) {
    const auditId = await recordTriageInvalid(db, {
      reason: result.toolUses.length === 0 ? 'no-tool-use' : 'wrong-tool',
      stopReason: result.stopReason,
      rawText: result.text.slice(0, 500),
      spendRecordId: result.spendRecordId,
    });
    const reason = result.toolUses.length === 0 ? 'no-tool-use' : 'wrong-tool';
    const detail =
      result.toolUses.length === 0
        ? `модель не вызвала tool. stop_reason=${String(result.stopReason)}`
        : `модель вызвала чужой tool: ${result.toolUses.map((t) => t.name).join(', ')}`;
    throw new TriageInvalidResponseError(
      `triage:extract — ${detail} (audit.triage.invalid=${auditId})`,
      reason,
      auditId,
    );
  }

  const validated = validateProblemsShape(toolUse.input);
  if (validated === null) {
    const auditId = await recordTriageInvalid(db, {
      reason: 'schema-mismatch',
      stopReason: result.stopReason,
      rawText: JSON.stringify(toolUse.input).slice(0, 500),
      spendRecordId: result.spendRecordId,
    });
    throw new TriageInvalidResponseError(
      `triage:extract — tool_use input не соответствует схеме (audit.triage.invalid=${auditId})`,
      'schema-mismatch',
      auditId,
    );
  }

  return validated;
}

// Ручная валидация без Zod. Возврат null = невалид, иначе массив проблем.
// Логика: input должен быть `{problems: [...]}`, каждый problem — объект с
// summary:string, symptoms:string[], supportMessageIds:string[].
function validateProblemsShape(input: unknown): TriageProblem[] | null {
  if (typeof input !== 'object' || input === null) return null;
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.problems)) return null;

  const out: TriageProblem[] = [];
  for (const item of obj.problems) {
    if (typeof item !== 'object' || item === null) return null;
    const p = item as Record<string, unknown>;
    if (typeof p.summary !== 'string' || p.summary.length === 0) return null;
    if (!Array.isArray(p.symptoms)) return null;
    if (!Array.isArray(p.supportMessageIds) || p.supportMessageIds.length === 0) return null;

    const symptoms: string[] = [];
    for (const s of p.symptoms) {
      if (typeof s !== 'string') return null;
      symptoms.push(s);
    }
    const ids: string[] = [];
    for (const id of p.supportMessageIds) {
      if (typeof id !== 'string' || id.length === 0) return null;
      ids.push(id);
    }
    out.push({ summary: p.summary, symptoms, supportMessageIds: ids });
  }
  return out;
}

interface TriageInvalidInput {
  reason: 'no-tool-use' | 'wrong-tool' | 'schema-mismatch';
  stopReason: string | null;
  rawText: string;
  spendRecordId: string;
}

async function recordTriageInvalid(db: PrismaClient, input: TriageInvalidInput): Promise<string> {
  const id = ulid();
  const now = Date.now();
  // Контракт audit.* (правила-нерушимые.md:24): visibility='autonomous',
  // actorKind='agent', status='closed', closedAt=createdAt. Тот же шаблон,
  // что audit.spend / audit.fetch.support.
  const properties = JSON.stringify({
    promptId: PROMPT_ID,
    reason: input.reason,
    stopReason: input.stopReason,
    rawText: input.rawText,
    spendRecordId: input.spendRecordId,
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, parentId, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.triage.invalid', ?, ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    properties,
    input.spendRecordId,
    now,
    now,
  );
  return id;
}
