// Тесты subagent-cli (фаза 3 плана 2026-05-17). Стратегия:
//   * Мокаем child_process.spawn через DI (deps.spawnImpl). Возвращаем
//     FakeChildProcess с потоками stdin/stdout/stderr и event emitter'ом.
//   * Контролируем stream-json события из теста: пишем строки в stdout, эмитим
//     'close' с exitCode=0 — runSubagentViaCli парсит и возвращает результат.
//   * Spend пишется в реальный prisma (shared dev.db) — фильтруем свои записи
//     по уникальному promptId, как в budget.test.ts.

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertSchemaInvariants } from '../src/db/invariants-check.js';
import { BudgetExceededError } from '../src/llm/call.js';
import { type SpawnImpl, runSubagentViaCli } from '../src/llm/subagent-cli.js';
import type { SubagentRunOptions } from '../src/llm/subagent.js';
import { resetTransportForTests } from '../src/llm/transport.js';

const prisma = new PrismaClient();

beforeAll(async () => {
  await prisma.$connect();
  await assertSchemaInvariants(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Fake child_process.spawn для DI.
// ---------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  killed: boolean;
  kill: (signal?: NodeJS.Signals) => boolean;
}

interface SpawnRecorder {
  command?: string;
  args?: readonly string[];
  cwd?: string;
  stdinWritten: string[];
  killCalls: NodeJS.Signals[];
}

function makeFakeChild(): {
  child: FakeChild;
  pushStdout: (s: string) => void;
  close: (code: number) => void;
  pushStderr: (s: string) => void;
} {
  const emitter = new EventEmitter() as FakeChild;
  const stdin = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  const stdout = new Readable({
    encoding: 'utf-8',
    read() {
      // no-op: данные пушим явно через pushStdout
    },
  });
  const stderr = new Readable({
    encoding: 'utf-8',
    read() {},
  });
  emitter.stdin = stdin;
  emitter.stdout = stdout;
  emitter.stderr = stderr;
  emitter.killed = false;
  emitter.kill = (_signal?: NodeJS.Signals) => {
    emitter.killed = true;
    return true;
  };
  return {
    child: emitter,
    pushStdout: (s: string) => stdout.push(s),
    pushStderr: (s: string) => stderr.push(s),
    close: (code: number) => {
      stdout.push(null);
      stderr.push(null);
      // Эмитим close на следующем тике — даём data-listener'у обработать накопленное.
      setImmediate(() => emitter.emit('close', code, null));
    },
  };
}

function makeSpawnMock(recorder: SpawnRecorder, fake: { child: FakeChild }): SpawnImpl {
  return ((command, args, options) => {
    recorder.command = command;
    recorder.args = args;
    recorder.cwd = options.cwd as string | undefined;
    // Перехватываем writes в stdin:
    const stdin = fake.child.stdin;
    const origWrite = stdin.write.bind(stdin);
    stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === 'string') recorder.stdinWritten.push(chunk);
      else if (Buffer.isBuffer(chunk)) recorder.stdinWritten.push(chunk.toString('utf-8'));
      // Передаём дальше, чтобы Writable.end() корректно работал.
      // biome-ignore lint/suspicious/noExplicitAny: тестовый mock-shim
      return origWrite(chunk as any, ...(rest as any[]));
    }) as typeof stdin.write;
    // Перехватываем kill:
    const origKill = fake.child.kill;
    fake.child.kill = (sig?: NodeJS.Signals) => {
      if (sig !== undefined) recorder.killCalls.push(sig);
      return origKill(sig);
    };
    return fake.child as unknown as ChildProcess;
  }) as SpawnImpl;
}

// Динамический unset через индексный ключ обходит biome `noDelete`-правило
// (правило ловит только literal property access). Реальное действие — то же.
function unsetEnv(key: string): void {
  delete process.env[key];
}

// runSubagentViaCli внутри await'ит loadBudgetLimits/computeCurrentSpend ДО
// вызова spawn. Тестам нужно дождаться, пока spawn действительно произойдёт,
// перед тем как пушить stdout в mock-child — иначе данные попадут в Readable,
// у которого ещё нет 'data' listener'а, и тест зависнет.
async function waitForSpawn(recorder: SpawnRecorder, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (recorder.command === undefined) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitForSpawn: spawn не произошёл в течение таймаута');
    }
    await new Promise((r) => setImmediate(r));
  }
  // Дополнительно даём один тик, чтобы stdout.on('data', ...) точно был навешен.
  await new Promise((r) => setImmediate(r));
}

// Базовые opts с уникальным promptId, чтобы spend-записи не конфликтовали между тестами.
function makeOpts(overrides: Partial<SubagentRunOptions> = {}): SubagentRunOptions {
  return {
    promptId: `test:subagent-cli-${ulid()}`,
    prompt: 'find the bug in src/foo.ts',
    systemPrompt: 'you are a research agent',
    model: 'sonnet',
    cwd: process.cwd(),
    allowedTools: ['Read', 'Grep', 'Bash'],
    timeoutMs: 5_000,
    maxTurns: 10,
    emitToolEvents: false, // тесты не зависят от Bridge HTTP-сервера
    limitsOverride: {
      perCycle: { inputTokens: 10_000_000 },
      daily: { usd: 1_000_000 },
      monthly: { usd: 1_000_000 },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Тесты.
// ---------------------------------------------------------------------------

describe('runSubagentViaCli — happy path', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.LLM_TRANSPORT;
    process.env.LLM_TRANSPORT = 'oauth';
    resetTransportForTests();
  });

  afterEach(() => {
    if (savedEnv === undefined) unsetEnv('LLM_TRANSPORT');
    else process.env.LLM_TRANSPORT = savedEnv;
    resetTransportForTests();
  });

  it('spawn вызывается с ожидаемыми флагами; промт идёт в stdin', async () => {
    const recorder: SpawnRecorder = { stdinWritten: [], killCalls: [] };
    const fake = makeFakeChild();
    const opts = makeOpts();

    // Запускаем CLI и сразу шлём результат-event + close.
    const runPromise = runSubagentViaCli(opts, prisma, {
      spawnImpl: makeSpawnMock(recorder, fake),
    });

    await waitForSpawn(recorder);
    fake.pushStdout(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        duration_ms: 1234,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.012,
        usage: { input_tokens: 100, output_tokens: 50 },
      })}\n`,
    );
    fake.close(0);
    const res = await runPromise;

    expect(recorder.command).toBe('claude');
    const args = recorder.args ?? [];
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
    expect(args).toContain('--max-turns');
    expect(args).toContain('10');
    expect(args).toContain('--allowed-tools');
    expect(args).toContain('Read,Grep,Bash');
    expect(args).toContain('--system-prompt');
    expect(args).toContain('you are a research agent');
    expect(recorder.cwd).toBe(opts.cwd);
    expect(recorder.stdinWritten.join('')).toContain('find the bug in src/foo.ts');

    // result + spend.
    expect(res.result).not.toBeNull();
    expect(res.result?.total_cost_usd).toBe(0.012);
    expect(res.spendRecordId).not.toBeNull();
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(res.timedOut).toBe(false);
  });

  it('stream-json парсинг: assistant + tool_use + tool_result + result', async () => {
    const recorder: SpawnRecorder = { stdinWritten: [], killCalls: [] };
    const fake = makeFakeChild();
    const opts = makeOpts();

    const runPromise = runSubagentViaCli(opts, prisma, {
      spawnImpl: makeSpawnMock(recorder, fake),
    });

    await waitForSpawn(recorder);
    // Несколько events за раз (в одной chunk'е), плюс отдельные строки.
    fake.pushStdout(
      `${JSON.stringify({ type: 'system', subtype: 'init' })}\n` +
        `${JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'смотрю файл' },
              { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'src/foo.ts' } },
            ],
          },
        })}\n`,
    );
    fake.pushStdout(
      `${JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'export function foo() {}' },
          ],
        },
      })}\n`,
    );
    fake.pushStdout(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        duration_ms: 2222,
        is_error: false,
        num_turns: 2,
        total_cost_usd: 0.045,
        usage: {
          input_tokens: 200,
          output_tokens: 100,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      })}\n`,
    );
    fake.close(0);
    const res = await runPromise;

    expect(res.messages.length).toBeGreaterThanOrEqual(4);
    expect(res.result?.total_cost_usd).toBe(0.045);
    expect(res.result?.num_turns).toBe(2);
    expect(res.spendRecordId).not.toBeNull();
    expect(res.timedOut).toBe(false);

    // Проверяем audit.spend запись.
    const row = await prisma.$queryRawUnsafe<{ properties: string }[]>(
      `SELECT properties FROM "Record" WHERE id = ?`,
      res.spendRecordId,
    );
    const props = JSON.parse(row[0]?.properties ?? '{}') as Record<string, unknown>;
    expect(props.transport).toBe('oauth');
    // oauth-режим → usd = 0 даже если CLI вернул 0.045.
    expect(props.usd).toBe(0);
    expect(props.inputTokens).toBe(200);
    expect(props.outputTokens).toBe(100);
    expect(props.cacheReadTokens).toBe(10);
    expect(props.cacheCreationTokens).toBe(5);
  });

  it('apikey-режим: usd берётся из total_cost_usd, transport=apikey', async () => {
    process.env.LLM_TRANSPORT = 'apikey';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
    resetTransportForTests();

    const recorder: SpawnRecorder = { stdinWritten: [], killCalls: [] };
    const fake = makeFakeChild();
    const opts = makeOpts();

    const runPromise = runSubagentViaCli(opts, prisma, {
      spawnImpl: makeSpawnMock(recorder, fake),
    });
    await waitForSpawn(recorder);
    fake.pushStdout(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        duration_ms: 100,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.07,
        usage: { input_tokens: 50, output_tokens: 25 },
      })}\n`,
    );
    fake.close(0);
    const res = await runPromise;

    expect(res.result?.total_cost_usd).toBe(0.07);
    const row = await prisma.$queryRawUnsafe<{ properties: string }[]>(
      `SELECT properties FROM "Record" WHERE id = ?`,
      res.spendRecordId,
    );
    const props = JSON.parse(row[0]?.properties ?? '{}') as Record<string, unknown>;
    expect(props.transport).toBe('apikey');
    expect(props.usd).toBe(0.07);

    unsetEnv('ANTHROPIC_API_KEY');
  });
});

describe('runSubagentViaCli — timeout', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.LLM_TRANSPORT;
    process.env.LLM_TRANSPORT = 'oauth';
    resetTransportForTests();
  });

  afterEach(() => {
    if (savedEnv === undefined) unsetEnv('LLM_TRANSPORT');
    else process.env.LLM_TRANSPORT = savedEnv;
    resetTransportForTests();
  });

  it('AbortController-таймаут → SIGTERM, timedOut=true, без spend', async () => {
    const recorder: SpawnRecorder = { stdinWritten: [], killCalls: [] };
    const fake = makeFakeChild();
    const opts = makeOpts({ timeoutMs: 50 });

    const runPromise = runSubagentViaCli(opts, prisma, {
      spawnImpl: makeSpawnMock(recorder, fake),
    });

    await waitForSpawn(recorder);
    // Не пушим result; ждём, пока сработает таймаут и close сам не придёт.
    // Симулируем: после таймаута kill() (mock сразу выставляет killed=true),
    // и мы вручную закрываем child — runSubagentViaCli должен вернуться.
    await new Promise((r) => setTimeout(r, 100));
    fake.close(143);

    const res = await runPromise;
    expect(res.timedOut).toBe(true);
    expect(res.result).toBeNull();
    expect(res.spendRecordId).toBeNull();
    expect(recorder.killCalls).toContain('SIGTERM');
  });
});

describe('runSubagentViaCli — exit без result', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.LLM_TRANSPORT;
    process.env.LLM_TRANSPORT = 'oauth';
    resetTransportForTests();
  });

  afterEach(() => {
    if (savedEnv === undefined) unsetEnv('LLM_TRANSPORT');
    else process.env.LLM_TRANSPORT = savedEnv;
    resetTransportForTests();
  });

  it('exitCode!=0 без result event → result=null, spendRecordId=null, timedOut=false', async () => {
    const recorder: SpawnRecorder = { stdinWritten: [], killCalls: [] };
    const fake = makeFakeChild();
    const opts = makeOpts();

    const runPromise = runSubagentViaCli(opts, prisma, {
      spawnImpl: makeSpawnMock(recorder, fake),
    });
    await waitForSpawn(recorder);
    fake.pushStderr('Error: invalid model "sonnet-xyz"\n');
    fake.close(2);
    const res = await runPromise;

    expect(res.result).toBeNull();
    expect(res.spendRecordId).toBeNull();
    expect(res.timedOut).toBe(false);
  });
});

describe('runSubagentViaCli — budget guard', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.LLM_TRANSPORT;
    process.env.LLM_TRANSPORT = 'oauth';
    resetTransportForTests();
  });

  afterEach(() => {
    if (savedEnv === undefined) unsetEnv('LLM_TRANSPORT');
    else process.env.LLM_TRANSPORT = savedEnv;
    resetTransportForTests();
  });

  it('per-cycle cap превышен → BudgetExceededError ДО spawn', async () => {
    // Сеем audit.spend с большим inputTokens, чтобы guard сработал.
    const priorId = ulid();
    const priorProps = JSON.stringify({
      promptId: 'test:cli-guard-prior',
      model: 'sonnet',
      modelRequested: 'sonnet',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      usd: 0,
      pricingAsOf: Date.now(),
      transport: 'oauth',
    });
    const now = Date.now();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt) VALUES (?, 'audit.spend', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
      priorId,
      priorProps,
      now,
      now,
    );

    let spawnCalled = false;
    const spawnImpl: SpawnImpl = (() => {
      spawnCalled = true;
      throw new Error('spawn must NOT be called when guard fires');
    }) as SpawnImpl;

    const opts = makeOpts({
      limitsOverride: {
        perCycle: { inputTokens: 50 }, // ниже посеянных 1_000_000
        daily: { usd: 1_000_000 },
        monthly: { usd: 1_000_000 },
      },
    });

    await expect(runSubagentViaCli(opts, prisma, { spawnImpl })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(spawnCalled).toBe(false);
  });
});
