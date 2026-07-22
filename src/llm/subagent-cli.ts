// Sub-agent через subprocess `claude` CLI v2.1+ (фаза 3 плана 2026-05-17,
// src/llm/transport.ts). Контракт SubagentRunOptions → SubagentRunResult идентичен
// `runSubagent` из subagent.ts — caller'ы (investigate/run.ts, solve/) не
// видят разницы.
//
// Почему subprocess, а не Agent SDK напрямую:
//   * Agent SDK v0.2.8+ не уважает ANTHROPIC_BASE_URL (issue #144).
//   * Anthropic явно запрещает OAuth-биллинг для Agent SDK по TOS.
//   * `claude` CLI — официальный клиент с биллингом через подписку
//     из коробки, file-tools/Bash/WebSearch уже встроены.
//
// Что эта обёртка делает:
//   1. Pre-call guard (`guardOrDeny` из subagent.ts) — общий для двух путей.
//   2. spawn('claude', [--print, --output-format stream-json, --model, ...]).
//   3. Промт в stdin (избегаем ARG_MAX и shell-инъекций).
//   4. Парсит stdout по \n, каждая строка — JSON SDK-Message-like.
//   5. Эмитит tool.start/end/error/assistant.message в Bridge (reuse
//      `emitFromSDKMessage` из subagent.ts — формат у CLI идентичен SDK).
//   6. AbortController → SIGTERM → SIGKILL (через 2s) по opts.timeoutMs.
//   7. Финальный `result` event → recordSpend(usd=0 в oauth, usd=total_cost в apikey).
//
// stream-json формат (фактический, проверено на claude 2.1.119):
//   {"type":"system","subtype":"init",...}        — игнорируем
//   {"type":"rate_limit_event",...}               — игнорируем
//   {"type":"assistant","message":{...},"uuid":...} — emit
//   {"type":"user","message":{...}}               — emit (tool_result)
//   {"type":"result","total_cost_usd":...,"usage":{...}} — финал, spend
//
// Если CLI упадёт без result event — возвращаем result=null, без spend записи.

import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import type { PrismaClient } from '../db/client.js';
import { getPrisma } from '../db/client.js';
import { loadEnv } from '../env.js';
import { emit } from '../observe/bridge.js';
import { loadBudgetLimits } from './budget.js';
import { computeCurrentSpend, recordSpend } from './spend.js';
import {
  type SDKResultLike,
  type SubagentRunOptions,
  type SubagentRunResult,
  emitFromSDKMessage,
  guardOrDeny,
  normalizeUsage,
} from './subagent.js';
import { getTransport } from './transport.js';

// Время от SIGTERM до SIGKILL. claude-CLI обычно умирает по SIGTERM в течение
// сотен мс; 2 секунды — щедрый запас, после чего гарантированно SIGKILL.
const SIGKILL_GRACE_MS = 2_000;

// Тип для DI в тестах. Принимает любую функцию, совместимую с node:child_process.spawn.
// Используем минимальный shape ChildProcess, чтобы тесты могли вернуть мок.
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface SubagentCliDeps {
  spawnImpl?: SpawnImpl;
}

export async function runSubagentViaCli(
  opts: SubagentRunOptions,
  db: PrismaClient = getPrisma(),
  deps: SubagentCliDeps = {},
): Promise<SubagentRunResult> {
  loadEnv();

  const limits = opts.limitsOverride ?? (await loadBudgetLimits());
  const current = await computeCurrentSpend(db);
  await guardOrDeny(current, limits, opts, db);

  const transport = getTransport();
  const cliPath = transport.claudeCliPath ?? 'claude';
  const spawnImpl = deps.spawnImpl ?? (spawn as unknown as SpawnImpl);

  const args: string[] = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose', // stream-json требует --verbose для прокидывания всех событий
    '--model',
    opts.model,
    '--max-turns',
    String(opts.maxTurns),
    // --allowed-tools — список через запятую или пробел. Идём по запятой,
    // CLI её парсит. Пустой список не передаём (CLI тогда использует default).
    ...(opts.allowedTools.length > 0 ? ['--allowed-tools', opts.allowedTools.join(',')] : []),
    ...(opts.systemPrompt !== undefined ? ['--system-prompt', opts.systemPrompt] : []),
    // --permission-mode — опциональный. Используется unattended cross-project
    // routine'ами для запуска skill'ов в чужом репо в bypassPermissions.
    // Для in-process subagent'ов опускаем — CLI применит свой дефолт.
    ...(opts.permissionMode !== undefined ? ['--permission-mode', opts.permissionMode] : []),
  ];

  const startedAt = Date.now();
  const messages: unknown[] = [];
  let result: SDKResultLike | null = null;
  let timedOut = false;

  const child = spawnImpl(cliPath, args, {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  // SIGTERM → SIGKILL по таймауту. SIGKILL запускаем через setTimeout, не сразу
  // — child нужно дать шанс закрыться чисто (важно для stdout-буфера).
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    if (!child.killed) {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, SIGKILL_GRACE_MS);
    }
  }, opts.timeoutMs);

  // Промт в stdin: избегаем ARG_MAX (на macOS ~1MB) и shell-quoting issues.
  if (child.stdin) {
    child.stdin.write(`${opts.prompt}\n`);
    child.stdin.end();
  }

  const toolStarts = new Map<string, number>();
  const shouldEmit = opts.emitToolEvents !== false;
  // Thinking context для эмита assistant.thinking — мысли воркера для облака
  // над головой в Office UI. Активен если у opts есть routineId.
  const thinkingCtx =
    shouldEmit && opts.routineId !== undefined && opts.routineId !== null
      ? { workerId: opts.routineId, buffer: { value: '' } }
      : undefined;

  // Парсим stdout: line-delimited JSON. Буферизуем хвост на случай частичной строки.
  let stdoutBuf = '';
  const stderrChunks: string[] = [];

  if (child.stdout) {
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      let newlineIdx = stdoutBuf.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = stdoutBuf.slice(0, newlineIdx).trim();
        stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
        newlineIdx = stdoutBuf.indexOf('\n');
        if (line.length === 0) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          messages.push(parsed);
          if (parsed.type === 'result') {
            result = parsed as unknown as SDKResultLike;
          }
          if (shouldEmit) {
            // emitFromSDKMessage ожидает SDKMessage shape — JSON-объект из
            // stream-json совместим (type + message.content[]).
            emitFromSDKMessage(parsed as never, toolStarts, thinkingCtx);
          }
        } catch {
          // Битая строка — игнорируем. CLI иногда пишет non-JSON warnings.
        }
      }
    });
  }

  if (child.stderr) {
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      stderrChunks.push(chunk);
    });
  }

  // Ждём завершения subprocess (exit или error). exitCode мы тоже учитываем:
  // если CLI упал с !=0 без result event, возвращаем result=null.
  const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('close', (code, signal) => {
        resolve({ code, signal });
      });
      child.once('error', () => {
        // spawn-error (binary not found и т.п.) — отдаём code=null,
        // вызывающий код увидит result=null и решит, что делать.
        resolve({ code: null, signal: null });
      });
    },
  );

  clearTimeout(timeoutHandle);

  // Хвост в stdoutBuf может содержать последний event без \n.
  const tail = stdoutBuf.trim();
  if (tail.length > 0) {
    try {
      const parsed = JSON.parse(tail) as Record<string, unknown>;
      messages.push(parsed);
      if (parsed.type === 'result') {
        result = parsed as unknown as SDKResultLike;
      }
      if (shouldEmit) {
        emitFromSDKMessage(parsed as never, toolStarts, thinkingCtx);
      }
    } catch {
      // ignore
    }
  }

  // Финальный flush thinking — sub-agent закончил со «свежей» мыслью.
  if (thinkingCtx !== undefined && thinkingCtx.buffer.value.length > 0) {
    void emit({
      type: 'assistant.thinking',
      workerId: thinkingCtx.workerId,
      text: thinkingCtx.buffer.value.slice(-280),
      done: true,
    });
  }

  const durationMs = Date.now() - startedAt;

  // Если subprocess не дошёл до result event (упал/timeout) — возвращаем
  // result=null, без записи spend. Caller (investigate/solve) сам решает,
  // что с этим делать (как и в Agent-SDK-пути, где SDK тоже даёт result=null
  // при abort).
  let spendRecordId: string | null = null;
  if (result !== null && !timedOut) {
    const usage = normalizeUsage((result as SDKResultLike).usage);
    const recordedUsd = transport.mode === 'oauth' ? 0 : (result as SDKResultLike).total_cost_usd;
    spendRecordId = await recordSpend(
      {
        promptId: opts.promptId,
        model: opts.model,
        modelRequested: opts.model,
        usage,
        usd: recordedUsd,
        // CLI считает cost сам; pricingAsOf=0 — маркер «cost не из config/pricing.md».
        pricingAsOf: 0,
        cycleParentId: opts.cycleParentId ?? null,
        routineId: opts.routineId ?? null,
        transport: transport.mode,
      },
      db,
    );
    if (shouldEmit) {
      // Bridge live-feed: тот же dual-write, что в subagent.ts.
      void emit({
        type: 'audit.spend',
        recordId: spendRecordId,
        promptId: opts.promptId,
        model: opts.model,
        usd: recordedUsd,
      });
    }
  }

  // Если был stderr и result=null — эмитим tool.error для видимости в Bridge.
  // Не throw'им: SubagentRunResult должен оставаться happy-path.
  if (shouldEmit && result === null && stderrChunks.length > 0 && !timedOut) {
    const errText = stderrChunks.join('').slice(0, 800);
    if (errText.trim().length > 0) {
      void emit({
        type: 'tool.error',
        toolId: `cli-exit-${exitInfo.code ?? 'unknown'}`,
        error: errText,
      });
    }
  }

  return {
    messages: messages as never,
    result,
    spendRecordId,
    durationMs,
    timedOut,
  };
}
