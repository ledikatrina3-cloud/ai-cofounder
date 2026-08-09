// Прямые Anthropic Messages API вызовы (триаж, мердж, report-build).
//
// Транспорт: см. src/llm/transport.ts.
// `LLM_TRANSPORT=apikey` (дефолт) → SDK с дефолтным baseURL и реальным
// ANTHROPIC_API_KEY (per-token биллинг, usd по computeUsd). `oauth`
// (экспериментальный) → SDK с baseURL=LLM_GATEWAY_URL (локальный gateway, usd
// в audit.spend = 0). Переключатель — единый getTransport() из transport.ts.

import Anthropic from '@anthropic-ai/sdk';
import type { PrismaClient } from '../db/client.js';
import { getPrisma } from '../db/client.js';
import { loadEnv } from '../env.js';
import type { BudgetLimits } from './budget.js';
import { loadBudgetLimits } from './budget.js';
import { computeUsd, loadPricing, resolveModel } from './pricing.js';
import {
  type CurrentSpend,
  type LimitKind,
  type SpendUsage,
  computeCurrentSpend,
  recordBudgetDeny,
  recordSpend,
} from './spend.js';
import { type TransportConfig, TransportConfigError, getTransport } from './transport.js';

export interface CallMessage {
  role: 'user' | 'assistant';
  content: string;
}

// System prompt block с опциональным cache_control для prompt-caching.
// Anthropic SDK принимает system как `string | Array<TextBlock>`. Используем массив,
// когда нужно навесить cache_control: ephemeral на тяжёлую шапку (фаза 2.2a).
// snake_case в shape — намеренно: совпадает с Anthropic API, чтобы адаптер не мапил.
export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

// Tool-schema для tool_use ответа (фаза 2.2a). input_schema следует JSON Schema.
export interface CallTool {
  name: string;
  description?: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export type CallToolChoice = { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string };

export interface CallOptions {
  promptId: string;
  model: string;
  messages: CallMessage[];
  // system как простая строка — старый путь, без кэша.
  system?: string;
  // systemBlocks — новый путь с cache_control. Если задан, имеет приоритет над system.
  systemBlocks?: SystemBlock[];
  tools?: CallTool[];
  toolChoice?: CallToolChoice;
  maxTokens?: number;
  cycleParentId?: string | null;
  routineId?: string | null;
  // Только для тестов: позволяет влить временный лимит без правки config/budget.md.
  limitsOverride?: BudgetLimits;
  // Только для тестов: подменяет реальный Anthropic-клиент. В проде не передавать.
  clientOverride?: AnthropicMessagesClient;
}

export interface CallToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface CallResult {
  // Объединённый текст всех text-блоков ответа. При forced tool_use может быть пустой.
  text: string;
  // Все tool_use блоки из ответа. Пустой массив, если модель не вызвала tool.
  toolUses: CallToolUse[];
  // Anthropic stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | null.
  stopReason: string | null;
  usd: number;
  usage: SpendUsage;
  pricingAsOf: number;
  spendRecordId: string;
  modelCanonical: string;
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly limit: LimitKind,
    public readonly current: number,
    public readonly cap: number,
    public readonly denyRecordId: string,
  ) {
    super(
      `budget ${limit} exhausted: current=${current} cap=${cap} (audit.budget.deny=${denyRecordId})`,
    );
    this.name = 'BudgetExceededError';
  }
}

// Анти-pattern: если этот тип импортируется из @anthropic-ai/sdk напрямую — Biome rule сработает только в этом файле.
// Поэтому минимальный shape клиента живёт здесь, чтобы тесты могли его подменить без дополнительного импорта SDK снаружи.
export interface AnthropicMessagesClient {
  messages: {
    create: (params: AnthropicMessagesCreateParams) => Promise<AnthropicMessagesResponse>;
  };
}

export interface AnthropicMessagesCreateParams {
  model: string;
  max_tokens: number;
  // string — старый путь без кэша; массив — новый, с cache_control: ephemeral.
  system?: string | SystemBlock[];
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools?: CallTool[];
  tool_choice?: CallToolChoice;
}

export interface AnthropicMessagesResponse {
  // Расширенный union: text + tool_use блоки. Адаптер createAnthropicClient
  // нормализует SDK-ответ в этот shape, тесты подменяют через clientOverride.
  content: Array<
    { type: 'text'; text?: string } | { type: 'tool_use'; id: string; name: string; input: unknown }
  >;
  stop_reason?: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

const DEFAULT_MAX_TOKENS = 1024;

export async function call(opts: CallOptions, db: PrismaClient = getPrisma()): Promise<CallResult> {
  loadEnv();

  const transport = getTransport();
  if (transport.mode === 'codex') {
    throw new TransportConfigError(
      'LLM_TRANSPORT=codex ???????????? agent/routine-??????? ????? Codex CLI. ?????? Messages API call() ??? triage/structured-output ???? ??????? apikey ??? oauth gateway.',
    );
  }
  const limits = opts.limitsOverride ?? (await loadBudgetLimits());
  const current = await computeCurrentSpend(db);
  await guardOrDeny(current, limits, opts, db);

  const pricing = await loadPricing();
  const { canonical, tariff } = resolveModel(pricing, opts.model);

  const client = opts.clientOverride ?? createAnthropicClient(transport);
  // Приоритет: systemBlocks (с cache_control) > system (плоская строка). Если оба
  // заданы — systemBlocks побеждает (явный сигнал «хочу кэш-шапку»).
  const systemParam: string | SystemBlock[] | undefined =
    opts.systemBlocks !== undefined ? opts.systemBlocks : opts.system;
  const response = await client.messages.create({
    model: canonical,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: systemParam,
    messages: opts.messages,
    tools: opts.tools,
    tool_choice: opts.toolChoice,
  });

  const usage: SpendUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
  };
  // computeUsd считаем всегда (нужен для retrospective-аналитики «сколько бы
  // заплатили по API»); в audit.spend и в CallResult в oauth-режиме пишем 0,
  // потому что фактический биллинг идёт через подписку (см. src/llm/transport.ts).
  const usd = computeUsd(tariff, usage);
  const recordedUsd = transport.mode === 'oauth' ? 0 : usd;
  const text = extractText(response);
  const toolUses = extractToolUses(response);

  const spendRecordId = await recordSpend(
    {
      promptId: opts.promptId,
      model: canonical,
      modelRequested: opts.model,
      usage,
      usd: recordedUsd,
      pricingAsOf: pricing.asOf,
      cycleParentId: opts.cycleParentId ?? null,
      routineId: opts.routineId ?? null,
      transport: transport.mode,
    },
    db,
  );

  return {
    text,
    toolUses,
    stopReason: response.stop_reason ?? null,
    usd: recordedUsd,
    usage,
    pricingAsOf: pricing.asOf,
    spendRecordId,
    modelCanonical: canonical,
  };
}

async function guardOrDeny(
  current: CurrentSpend,
  limits: BudgetLimits,
  opts: CallOptions,
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

function createAnthropicClient(transport: TransportConfig): AnthropicMessagesClient {
  // Тонкий адаптер: SDK возвращает Message с полями `cache_*: number | null`,
  // нам же удобнее `number | undefined`. Один обёртывающий вызов нормализует null → undefined.
  // Также нормализуем content-блоки: text → {type:'text', text}, tool_use → {type:'tool_use', id, name, input}.
  //
  // В oauth-режиме `baseURL` указывает на локальный gateway, а `apiKey`
  // — dummy (gateway подменяет на OAuth Bearer). В apikey-режиме `baseURL`
  // не передан (SDK сам выберет дефолт), `apiKey` — реальный ANTHROPIC_API_KEY.
  const sdk = new Anthropic({
    apiKey: transport.apiKey,
    ...(transport.baseURL !== undefined ? { baseURL: transport.baseURL } : {}),
  });
  return {
    messages: {
      create: async (params) => {
        // SDK типизирован строже нашего внутреннего shape (system/tools/tool_choice
        // имеют точные union'ы). Передаём params как есть — SDK совместим, лишние
        // поля undefined игнорируются. Каст узкий: только для system, потому что
        // SDK ждёт string | TextBlockParam[] | ImageBlockParam[]; наш SystemBlock
        // совместим с TextBlockParam (type:'text', text, cache_control).
        // Cast `params` к union type SDK (overload включает Stream); `sdkResponse`
        // обратно сужаем к Message — без stream в params ответ всегда Message.
        const sdkResponse = (await sdk.messages.create(
          params as Parameters<typeof sdk.messages.create>[0],
        )) as Anthropic.Messages.Message;
        const content: AnthropicMessagesResponse['content'] = sdkResponse.content.map((block) => {
          if (block.type === 'tool_use') {
            return {
              type: 'tool_use' as const,
              id: block.id,
              name: block.name,
              input: block.input,
            };
          }
          if (block.type === 'text') {
            return { type: 'text' as const, text: block.text };
          }
          // thinking / server_tool_use / прочие будущие блоки — отдаём как text без текста.
          // Триаж их не использует; cost-meter уже посчитал по usage.
          return { type: 'text' as const, text: undefined };
        });
        return {
          content,
          stop_reason: sdkResponse.stop_reason ?? null,
          usage: {
            input_tokens: sdkResponse.usage.input_tokens,
            output_tokens: sdkResponse.usage.output_tokens,
            cache_read_input_tokens: sdkResponse.usage.cache_read_input_tokens ?? undefined,
            cache_creation_input_tokens: sdkResponse.usage.cache_creation_input_tokens ?? undefined,
          },
        };
      },
    },
  };
}

function extractText(response: AnthropicMessagesResponse): string {
  return response.content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('');
}

function extractToolUses(response: AnthropicMessagesResponse): CallToolUse[] {
  const result: CallToolUse[] = [];
  for (const block of response.content) {
    if (block.type === 'tool_use') {
      result.push({ id: block.id, name: block.name, input: block.input });
    }
  }
  return result;
}
