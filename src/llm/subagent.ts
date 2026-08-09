// Обёртка Claude Agent SDK для sub-agent-вызовов (фаза 2.3a, 2.3b будущая,
// 3.3 future). Существует параллельно с `src/llm/call.ts`:
//
//   * `call.ts` — прямой Anthropic Messages API. Один LLM-вызов, structured
//     output через tool_use, никаких файловых tool'ов. Используется триаж/решатель.
//   * `subagent.ts` — Claude Agent SDK. Многошаговый агент с file-tools (Read,
//     Grep, Glob, Bash), своим cwd, своими permissions. Используется исследователем
//     (2.3a), исполнителем (3.3) — везде, где агент должен сам ходить в код.
//
// Cost-tracking: SDK сам не пишет в наш audit.spend. Эта обёртка обязана это
// сделать, иначе sub-agent уйдёт в обход счётчика и hard-cap не сработает.
//
// Pre-call guard: тот же guard, что в call.ts (per-cycle/daily/monthly), потому
// что sub-agent — это ровно тот же пользовательский Anthropic-API-токен. Без
// guard'а 5 параллельных sub-агентов сожгут дневной бюджет за одну итерацию
// (риск №3 в плане 2026-04-30).
//
// Biome rule `noRestrictedImports` разрешает импорт `@anthropic-ai/claude-agent-sdk`
// только в `src/llm/**`. Любой другой файл, импортирующий SDK напрямую, — баг
// и ошибка сборки. Снаружи зовут `runSubagent(...)`.

import { type SDKMessage, type Options as SDKOptions, query } from '@anthropic-ai/claude-agent-sdk';
import type { PrismaClient } from '../db/client.js';
import { getPrisma } from '../db/client.js';
import { loadEnv } from '../env.js';
import { emit } from '../observe/bridge.js';
import { type BudgetLimits, loadBudgetLimits } from './budget.js';
import { BudgetExceededError } from './call.js';
import {
  type CurrentSpend,
  type LimitKind,
  type SpendUsage,
  computeCurrentSpend,
  recordBudgetDeny,
  recordSpend,
} from './spend.js';
import { getTransport } from './transport.js';

// ---------------------------------------------------------------------------
// Контракт.
// ---------------------------------------------------------------------------

export interface SubagentRunOptions {
  // Идентификатор для audit.spend.properties.promptId. Каноничный для каждого
  // sub-agent-сценария: 'investigate:run', 'execute:run', 'review:run' и т.д.
  promptId: string;
  // Полный текст user-promptа. Шапка (system) — отдельным полем.
  prompt: string;
  // Системный промпт. Если не указан — SDK использует свой дефолт (Claude Code
  // skin), что нам обычно не нужно. Передавай конкретный сценарный промпт.
  systemPrompt?: string;
  // Модель из config.* (sonnet-4-6, opus-4-7, haiku-4-5). Передаётся в SDK.
  model: string;
  // Cwd для sub-agent'а. SDK использует его как корень для file-tools и Bash.
  cwd: string;
  // Какие tool'ы доступны sub-agent'у (без префикса `mcp__`). Например,
  // `['Read', 'Grep', 'Glob', 'Bash']`. Передаётся в `Options.allowedTools`.
  allowedTools: string[];
  // Кастомный обработчик permissions. Используется исследователем для
  // whitelist'а Bash-команд. Если не передан — все вызовы из allowedTools
  // авто-разрешены (поведение SDK по умолчанию для allowedTools).
  canUseTool?: SDKOptions['canUseTool'];
  // Жёсткий тайм-аут в мс. Реализован через AbortController (не через
  // Options.maxTurns — turns не отлавливают зависания внутри одного tool-вызова).
  timeoutMs: number;
  // Потолок agentic-turns SDK. Дополнительная защита от зацикливания.
  maxTurns: number;
  // Опционально: parentId для audit.spend (например, intent.problem.id).
  // Если null — spend пишется без parent'а.
  cycleParentId?: string | null;
  // Опционально: routineId для агрегации spend по routine в /деньги.
  // Если null/undefined — не включается в properties (legacy-поведение).
  routineId?: string | null;
  // Только для тестов: подменяет реальный SDK-query (DI).
  queryImpl?: typeof query;
  // Только для тестов: переопределяет лимиты без правки config/budget.md.
  limitsOverride?: BudgetLimits;
  // По умолчанию true: парсить SDK-stream и эмитить в Bridge tool.start/tool.end/
  // tool.error/assistant.message. Дает «живость» Bridge UI: молнии орбиталей,
  // капсулы EventTimeline, terminal-логи. Тесты могут отключить чтобы не
  // зависеть от глобального fetch и не плодить лишних emit'ов.
  emitToolEvents?: boolean;
  // Permission mode для дочерней claude-сессии. Опциональное поле, проброс
  // в `--permission-mode` флаг CLI. Используется unattended cross-project
  // routine'ами (executeUnattendedRoutine), где надо запустить чужой skill
  // в bypassPermissions автономно. Для legacy in-process subagent'ов (наш
  // canUseTool/audit) — undefined, CLI использует свой дефолт.
  // Возможные значения (claude 2.1+): 'default' | 'acceptEdits' | 'plan' |
  // 'bypassPermissions'. Не валидируем строго — проброс as-is.
  permissionMode?: string;
}

export interface SubagentRunResult {
  // Все сообщения, которые SDK выдал в потоке (assistant text/tool_use блоки,
  // user tool_result, system meta, result). Caller'ы парсят их в свои
  // структуры (например, исследователь ищет finish_investigation tool_use).
  messages: SDKMessage[];
  // Финальный SDKResultMessage. По нему понимаем — success/error/timeout.
  // null — если SDK не дал result message (теоретически невозможно, но
  // защищаемся).
  result: SDKResultLike | null;
  // ID Записи audit.spend, которую только что создали. null, если sub-agent
  // упал до того, как мы получили usage (вход в guard упал, например).
  spendRecordId: string | null;
  // Длительность всего runSubagent'а в мс (включая guard и spend INSERT).
  durationMs: number;
  // Если sub-agent дошёл до тайм-аута через AbortController.
  timedOut: boolean;
}

// Узкий тип, чтобы тесты могли возвращать минимальный shape без полного
// SDKResultMessage (там много union'ов и origin/uuid/sessionId). Реальный
// SDKResultMessage гарантированно совместим с этим shape.
export interface SDKResultLike {
  type: 'result';
  subtype: string;
  duration_ms: number;
  is_error: boolean;
  num_turns: number;
  total_cost_usd: number;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
}

export class SubagentTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`sub-agent тайм-аут после ${timeoutMs}ms`);
    this.name = 'SubagentTimeoutError';
  }
}

// ---------------------------------------------------------------------------
// Главная функция.
// ---------------------------------------------------------------------------

export async function runSubagent(
  opts: SubagentRunOptions,
  db: PrismaClient = getPrisma(),
): Promise<SubagentRunResult> {
  loadEnv();

  // CLI transports run through subprocess adapters. The public
  // SubagentRunResult contract stays the same for routines/investigate/solve.
  // Test DI via queryImpl keeps using the SDK path.
  const transport = getTransport();
  if (opts.queryImpl === undefined) {
    if (transport.mode === 'oauth') {
      const { runSubagentViaCli } = await import('./subagent-cli.js');
      return runSubagentViaCli(opts, db);
    }
    if (transport.mode === 'codex') {
      const { runSubagentViaCodex } = await import('./subagent-codex.js');
      return runSubagentViaCodex(opts, db);
    }
  }

  const limits = opts.limitsOverride ?? (await loadBudgetLimits());
  const current = await computeCurrentSpend(db);
  await guardOrDeny(current, limits, opts, db);

  const queryFn = opts.queryImpl ?? query;
  const startedAt = Date.now();

  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    abortController.abort();
  }, opts.timeoutMs);

  const messages: SDKMessage[] = [];
  let result: SDKResultLike | null = null;
  let timedOut = false;

  try {
    const sdkOptions: SDKOptions = {
      abortController,
      cwd: opts.cwd,
      model: opts.model,
      allowedTools: opts.allowedTools,
      maxTurns: opts.maxTurns,
      systemPrompt: opts.systemPrompt,
      canUseTool: opts.canUseTool,
      // persistSession: false — мы не хотим, чтобы каждый sub-agent run писал
      // JSONL в `~/.claude/projects/`. У нас свой журнал (Record), trace в
      // Bridge JSONL. Дисковый дубликат — лишний (риск рассинхрона + privacy).
      persistSession: false,
    };

    const stream = queryFn({ prompt: opts.prompt, options: sdkOptions });
    const toolStarts = new Map<string, number>();
    const shouldEmit = opts.emitToolEvents !== false;
    // Thinking context: накапливает текст между tool_use'ами, эмитит
    // assistant.thinking для облака мыслей над воркером в Office UI.
    // Активен только если у нас есть workerId (routineId).
    const thinkingCtx: ThinkingEmitContext | undefined =
      shouldEmit && opts.routineId !== undefined && opts.routineId !== null
        ? { workerId: opts.routineId, buffer: { value: '' } }
        : undefined;
    for await (const msg of stream) {
      messages.push(msg);
      if (msg.type === 'result') {
        result = msg as SDKResultLike;
      }
      if (shouldEmit) {
        emitFromSDKMessage(msg, toolStarts, thinkingCtx);
      }
    }
    // Финальный flush — если sub-agent закончил с накопленной мыслью.
    if (thinkingCtx !== undefined && thinkingCtx.buffer.value.length > 0) {
      void emit({
        type: 'assistant.thinking',
        workerId: thinkingCtx.workerId,
        text: thinkingCtx.buffer.value.slice(-280),
        done: true,
      });
    }
  } catch (err) {
    if (
      abortController.signal.aborted ||
      (err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort')))
    ) {
      timedOut = true;
    } else {
      clearTimeout(timeoutHandle);
      throw err;
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  const durationMs = Date.now() - startedAt;

  let spendRecordId: string | null = null;
  if (result !== null) {
    const usage = normalizeUsage(result.usage);
    spendRecordId = await recordSpend(
      {
        promptId: opts.promptId,
        model: opts.model,
        modelRequested: opts.model,
        usage,
        usd: result.total_cost_usd,
        // SDK не возвращает pricingAsOf — он у нас в config/pricing.md, но
        // считает cost сам. Используем 0 как маркер «cost от SDK, не из
        // нашего pricing». 2.5/3.x при необходимости заменят на реальный mtimeMs.
        pricingAsOf: 0,
        cycleParentId: opts.cycleParentId ?? null,
        routineId: opts.routineId ?? null,
        // Этот путь — только apikey (oauth выше уходит в CLI subprocess), но
        // если caller передал queryImpl как тестовый DI и LLM_TRANSPORT=oauth,
        // считаем по реальному режиму из getTransport().
        transport: getTransport().mode,
      },
      db,
    );
    if (opts.emitToolEvents !== false) {
      // Bridge live-feed: dual-write в шину после INSERT'а в БД. Renderer
      // обновляет SPEND/MODEL не дожидаясь polling'а /metrics.
      void emit({
        type: 'audit.spend',
        recordId: spendRecordId,
        promptId: opts.promptId,
        model: opts.model,
        usd: result.total_cost_usd,
      });
    }
  }

  return {
    messages,
    result,
    spendRecordId,
    durationMs,
    timedOut,
  };
}

// Pre-call guard: общий для Agent SDK и CLI-subprocess путей (см. subagent-cli.ts).
// Бросает BudgetExceededError + пишет audit.budget.deny если какой-то cap
// исчерпан. Экспортирован, чтобы subagent-cli.ts не дублировал ту же логику.
export async function guardOrDeny(
  current: CurrentSpend,
  limits: BudgetLimits,
  opts: SubagentRunOptions,
  db: PrismaClient,
): Promise<void> {
  const checks: Array<{ kind: LimitKind; current: number; cap: number }> = [
    { kind: 'per-cycle', current: current.perCycle.inputTokens, cap: limits.perCycle.inputTokens },
    { kind: 'daily', current: current.daily.usd, cap: limits.daily.usd },
    { kind: 'monthly', current: current.monthly.usd, cap: limits.monthly.usd },
  ];
  for (const check of checks) {
    if (check.current >= check.cap) {
      const denyId = await recordBudgetDeny(
        {
          limitKind: check.kind,
          current: check.current,
          cap: check.cap,
          promptId: opts.promptId,
          model: opts.model,
          cycleParentId: opts.cycleParentId ?? null,
        },
        db,
      );
      throw new BudgetExceededError(check.kind, check.current, check.cap, denyId);
    }
  }
}

// Bridge live-feed: парсит assistant/user блоки из SDK-stream и эмитит
// tool.start/tool.end/tool.error/assistant.message/assistant.thinking через
// src/observe/bridge. Fire-and-forget: emit() сам глотает ошибки.
// Логика:
//   * SDKAssistantMessage: message.content[] может содержать text-блоки
//     (assistant.message), thinking-блоки (assistant.thinking), и tool_use
//     (tool.start, помним id+ts для durationMs).
//   * SDKUserMessage: message.content[] — tool_result, эмитим tool.end/error.
//   * Прочие игнорим.
//   * Если передан thinking context — text/thinking блоки между tool_use
//     буферизуются и эмитятся как assistant.thinking. На каждом tool_use
//     буфер flush'ится с done=true (UI «фиксирует» мысль перед действием).
//
// Экспортирован: stream-json от `claude` CLI (см. subagent-cli.ts) имеет
// идентичный shape — переиспользуем функцию.

/** Опции эмита thinking-событий. Передаются runSubagent → emitFromSDKMessage. */
export interface ThinkingEmitContext {
  /** ID воркера, к которому привязывать мысли (= routineId). */
  workerId: string;
  /** Мутабельный буфер накопленного текста. Caller создаёт `{ value: '' }`. */
  buffer: { value: string };
}

export function emitFromSDKMessage(
  msg: SDKMessage,
  toolStarts: Map<string, number>,
  thinking?: ThinkingEmitContext,
): void {
  const m = msg as Record<string, unknown>;
  if (m.type === 'assistant') {
    const message = m.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        // Flush pending thinking — модель закончила «комментарий-план» перед действием.
        if (thinking !== undefined && thinking.buffer.value.length > 0) {
          void emit({
            type: 'assistant.thinking',
            workerId: thinking.workerId,
            text: thinking.buffer.value.slice(-280),
            done: true,
          });
          thinking.buffer.value = '';
        }
        toolStarts.set(b.id, Date.now());
        void emit({ type: 'tool.start', toolId: b.id, name: b.name, input: b.input ?? {} });
      } else if (b.type === 'text' && typeof b.text === 'string') {
        const text = b.text.trim();
        if (text.length > 0) {
          void emit({ type: 'assistant.message', text });
          if (thinking !== undefined) {
            thinking.buffer.value =
              (thinking.buffer.value.length > 0 ? `${thinking.buffer.value} ` : '') + text;
            void emit({
              type: 'assistant.thinking',
              workerId: thinking.workerId,
              text: thinking.buffer.value.slice(-280),
              done: false,
            });
          }
        }
      } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
        // Extended thinking блок — Claude SDK прокидывает его отдельно от text.
        const text = b.thinking.trim();
        if (text.length > 0 && thinking !== undefined) {
          thinking.buffer.value =
            (thinking.buffer.value.length > 0 ? `${thinking.buffer.value} ` : '') + text;
          void emit({
            type: 'assistant.thinking',
            workerId: thinking.workerId,
            text: thinking.buffer.value.slice(-280),
            done: false,
          });
        }
      }
    }
    return;
  }
  if (m.type === 'user') {
    const message = m.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      const startedAt = toolStarts.get(b.tool_use_id);
      if (startedAt === undefined) continue;
      const durationMs = Date.now() - startedAt;
      toolStarts.delete(b.tool_use_id);
      const isError = b.is_error === true;
      // tool_result.content: либо строка, либо массив content-блоков. Сводим
      // к одной строке, чтобы Bridge мог отрендерить в Terminal/timeline без
      // знания внутреннего shape SDK.
      let outputStr: string;
      if (typeof b.content === 'string') {
        outputStr = b.content;
      } else if (Array.isArray(b.content)) {
        outputStr = b.content
          .map((c) => {
            const cb = c as Record<string, unknown>;
            if (typeof cb.text === 'string') return cb.text;
            return '';
          })
          .filter((s) => s.length > 0)
          .join('\n');
      } else {
        outputStr = '';
      }
      const truncated = outputStr.slice(0, 800);
      if (isError) {
        void emit({ type: 'tool.error', toolId: b.tool_use_id, error: truncated });
      } else {
        void emit({ type: 'tool.end', toolId: b.tool_use_id, output: truncated, durationMs });
      }
    }
  }
}

// SDK ResultMessage usage — это NonNullableUsage с camelCase
// (inputTokens/outputTokens/...). Тестовые моки могут отдать snake_case
// (input_tokens) или сокращённый shape. Нормализуем оба варианта.
//
// Экспортирован для переиспользования в subagent-cli.ts: stream-json у CLI
// отдаёт usage в том же гибридном shape.
export function normalizeUsage(usage: SDKResultLike['usage']): SpendUsage {
  return {
    inputTokens: usage.inputTokens ?? usage.input_tokens ?? 0,
    outputTokens: usage.outputTokens ?? usage.output_tokens ?? 0,
    cacheReadTokens: usage.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens ?? 0,
  };
}
