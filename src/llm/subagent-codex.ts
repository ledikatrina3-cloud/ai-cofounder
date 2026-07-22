// Sub-agent ????? Codex CLI (`codex exec --json`).
//
// ??? ?????? ??????? ??? ?????????, ??? AI-Cofounder ????????? ?? ?? macOS ?
// Claude Code, ? ?? VPS ? ??? ?????????????? Codex CLI. ?? ????????? ????????
// SubagentRunOptions -> SubagentRunResult: caller'? routines/dispatcher ?????
// ??? ?? shape, ??? ? ? Claude SDK/CLI ?????.

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

const SIGKILL_GRACE_MS = 2_000;

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface SubagentCodexDeps {
  spawnImpl?: SpawnImpl;
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

export async function runSubagentViaCodex(
  opts: SubagentRunOptions,
  db: PrismaClient = getPrisma(),
  deps: SubagentCodexDeps = {},
): Promise<SubagentRunResult> {
  loadEnv();

  const limits = opts.limitsOverride ?? (await loadBudgetLimits());
  const current = await computeCurrentSpend(db);
  await guardOrDeny(current, limits, opts, db);

  const transport = getTransport();
  const cliPath = transport.codexCliPath ?? 'codex';
  const spawnImpl = deps.spawnImpl ?? (spawn as unknown as SpawnImpl);

  const args: string[] = [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '-C',
    opts.cwd,
    ...(transport.codexModel !== undefined ? ['-m', transport.codexModel] : []),
    '-',
  ];

  const startedAt = Date.now();
  const messages: unknown[] = [];
  let result: SDKResultLike | null = null;
  let timedOut = false;
  let turnCount = 0;

  const child = spawnImpl(cliPath, args, {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

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

  if (child.stdin) {
    child.stdin.write(`${buildCodexPrompt(opts)}\n`);
    child.stdin.end();
  }

  const toolStarts = new Map<string, number>();
  const shouldEmit = opts.emitToolEvents !== false;
  const thinkingCtx =
    shouldEmit && opts.routineId !== undefined && opts.routineId !== null
      ? { workerId: opts.routineId, buffer: { value: '' } }
      : undefined;

  let stdoutBuf = '';
  const stderrChunks: string[] = [];

  const handleEvent = (event: Record<string, unknown>): void => {
    const normalized = normalizeCodexEvent(event, Date.now() - startedAt, ++turnCount);
    messages.push(normalized);
    if (shouldEmit) {
      emitFromSDKMessage(normalized as never, toolStarts, thinkingCtx);
    }
    if ((normalized as Record<string, unknown>).type === 'result') {
      result = normalized as unknown as SDKResultLike;
    }
  };

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
          handleEvent(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // Codex --json should be JSONL, but non-JSON diagnostics are ignored.
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

  const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('close', (code, signal) => {
        resolve({ code, signal });
      });
      child.once('error', () => {
        resolve({ code: null, signal: null });
      });
    },
  );

  clearTimeout(timeoutHandle);

  const tail = stdoutBuf.trim();
  if (tail.length > 0) {
    try {
      handleEvent(JSON.parse(tail) as Record<string, unknown>);
    } catch {
      // ignore
    }
  }

  if (thinkingCtx !== undefined && thinkingCtx.buffer.value.length > 0) {
    void emit({
      type: 'assistant.thinking',
      workerId: thinkingCtx.workerId,
      text: thinkingCtx.buffer.value.slice(-280),
      done: true,
    });
  }

  const durationMs = Date.now() - startedAt;

  let spendRecordId: string | null = null;
  const finalResult = result as SDKResultLike | null;
  if (finalResult !== null && !timedOut) {
    const usage = normalizeUsage(finalResult.usage);
    spendRecordId = await recordSpend(
      {
        promptId: opts.promptId,
        model: transport.codexModel ?? 'codex-default',
        modelRequested: opts.model,
        usage,
        usd: 0,
        pricingAsOf: 0,
        cycleParentId: opts.cycleParentId ?? null,
        routineId: opts.routineId ?? null,
        transport: 'codex',
      },
      db,
    );
    if (shouldEmit) {
      void emit({
        type: 'audit.spend',
        recordId: spendRecordId,
        promptId: opts.promptId,
        model: transport.codexModel ?? 'codex-default',
        usd: 0,
      });
    }
  }

  if (shouldEmit && result === null && stderrChunks.length > 0 && !timedOut) {
    const errText = stderrChunks.join('').slice(0, 800);
    if (errText.trim().length > 0) {
      void emit({
        type: 'tool.error',
        toolId: `codex-exit-${exitInfo.code ?? 'unknown'}`,
        error: errText,
      });
    }
  }

  return {
    messages: messages as never,
    result: finalResult,
    spendRecordId,
    durationMs,
    timedOut,
  };
}

function buildCodexPrompt(opts: SubagentRunOptions): string {
  const parts: string[] = [];
  if (opts.systemPrompt !== undefined && opts.systemPrompt.trim() !== '') {
    parts.push('## System instructions');
    parts.push(opts.systemPrompt.trim());
  }
  parts.push('## Task');
  parts.push(opts.prompt.trim());
  return parts.join('\n\n');
}

function normalizeCodexEvent(
  event: Record<string, unknown>,
  durationMs: number,
  turnNumber: number,
): Record<string, unknown> {
  if (event.type === 'item.completed') {
    const item = event.item as Record<string, unknown> | undefined;
    if (item?.type === 'agent_message' && typeof item.text === 'string') {
      return {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: item.text }],
        },
      };
    }
    return event;
  }

  if (event.type === 'turn.completed') {
    const usage = normalizeCodexUsage(event.usage as CodexUsage | undefined);
    return {
      type: 'result',
      subtype: 'success',
      duration_ms: durationMs,
      is_error: false,
      num_turns: turnNumber,
      total_cost_usd: 0,
      usage,
    };
  }

  if (event.type === 'turn.failed') {
    return {
      type: 'result',
      subtype: 'error',
      duration_ms: durationMs,
      is_error: true,
      num_turns: turnNumber,
      total_cost_usd: 0,
      usage: normalizeCodexUsage(undefined),
    };
  }

  return event;
}

function normalizeCodexUsage(usage: CodexUsage | undefined): SDKResultLike['usage'] {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_read_input_tokens: usage?.cached_input_tokens ?? 0,
    cache_creation_input_tokens: usage?.cache_write_input_tokens ?? 0,
  };
}
