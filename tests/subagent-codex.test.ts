import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertSchemaInvariants } from '../src/db/invariants-check.js';
import { type SpawnImpl, runSubagentViaCodex } from '../src/llm/subagent-codex.js';
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
  pushStderr: (s: string) => void;
  close: (code: number) => void;
} {
  const emitter = new EventEmitter() as FakeChild;
  const stdin = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  const stdout = new Readable({
    encoding: 'utf-8',
    read() {},
  });
  const stderr = new Readable({
    encoding: 'utf-8',
    read() {},
  });
  emitter.stdin = stdin;
  emitter.stdout = stdout;
  emitter.stderr = stderr;
  emitter.killed = false;
  emitter.kill = (signal?: NodeJS.Signals) => {
    if (signal !== undefined) {
      // no-op: recorder wraps this method.
    }
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
      setImmediate(() => emitter.emit('close', code, null));
    },
  };
}

function makeSpawnMock(recorder: SpawnRecorder, fake: { child: FakeChild }): SpawnImpl {
  return ((command, args, options) => {
    recorder.command = command;
    recorder.args = args;
    recorder.cwd = options.cwd as string | undefined;
    const stdin = fake.child.stdin;
    const origWrite = stdin.write.bind(stdin);
    stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === 'string') recorder.stdinWritten.push(chunk);
      else if (Buffer.isBuffer(chunk)) recorder.stdinWritten.push(chunk.toString('utf-8'));
      // biome-ignore lint/suspicious/noExplicitAny: ???????? mock-shim
      return origWrite(chunk as any, ...(rest as any[]));
    }) as typeof stdin.write;
    const origKill = fake.child.kill;
    fake.child.kill = (sig?: NodeJS.Signals) => {
      if (sig !== undefined) recorder.killCalls.push(sig);
      return origKill(sig);
    };
    return fake.child as unknown as ChildProcess;
  }) as SpawnImpl;
}

async function waitForSpawn(recorder: SpawnRecorder, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (recorder.command === undefined) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitForSpawn: spawn ?? ????????? ? ??????? ????????');
    }
    await new Promise((r) => setImmediate(r));
  }
  await new Promise((r) => setImmediate(r));
}

function unsetEnv(key: string): void {
  delete process.env[key];
}

function makeOpts(overrides: Partial<SubagentRunOptions> = {}): SubagentRunOptions {
  return {
    promptId: `test:subagent-codex-${ulid()}`,
    prompt: '?????? ?????: ok-codex',
    systemPrompt: '?? ??????????? smoke-agent.',
    model: 'claude-haiku-4-5',
    cwd: process.cwd(),
    allowedTools: [],
    timeoutMs: 5_000,
    maxTurns: 3,
    emitToolEvents: false,
    limitsOverride: {
      perCycle: { inputTokens: 10_000_000 },
      daily: { usd: 1_000_000 },
      monthly: { usd: 1_000_000 },
    },
    ...overrides,
  };
}

describe('runSubagentViaCodex', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      LLM_TRANSPORT: process.env.LLM_TRANSPORT,
      CODEX_CLI_PATH: process.env.CODEX_CLI_PATH,
      CODEX_MODEL: process.env.CODEX_MODEL,
      CODEX_SANDBOX_NETWORK_ACCESS: process.env.CODEX_SANDBOX_NETWORK_ACCESS,
      CODEX_NETWORK_ACCESS: process.env.CODEX_NETWORK_ACCESS,
    };
    process.env.LLM_TRANSPORT = 'codex';
    process.env.CODEX_CLI_PATH = '/usr/local/bin/codex-test';
    process.env.CODEX_MODEL = 'gpt-5-codex';
    process.env.CODEX_SANDBOX_NETWORK_ACCESS = 'false';
    unsetEnv('CODEX_NETWORK_ACCESS');
    resetTransportForTests();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) unsetEnv(key);
      else process.env[key] = value;
    }
    resetTransportForTests();
  });

  it('spawn ???????? codex exec, ?????? JSONL ? ????? audit.spend transport=codex', async () => {
    const recorder: SpawnRecorder = { stdinWritten: [], killCalls: [] };
    const fake = makeFakeChild();
    const opts = makeOpts();

    const runPromise = runSubagentViaCodex(opts, prisma, {
      spawnImpl: makeSpawnMock(recorder, fake),
    });

    await waitForSpawn(recorder);
    fake.pushStdout(`${JSON.stringify({ type: 'thread.started', thread_id: 't_1' })}\n`);
    fake.pushStdout(
      `${JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_1', type: 'agent_message', text: 'ok-codex' },
      })}\n`,
    );
    fake.pushStdout(
      `${JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 120,
          cached_input_tokens: 40,
          cache_write_input_tokens: 5,
          output_tokens: 9,
          reasoning_output_tokens: 3,
        },
      })}\n`,
    );
    fake.close(0);

    const res = await runPromise;

    expect(recorder.command).toBe('/usr/local/bin/codex-test');
    expect(recorder.args).toEqual([
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      '-C',
      opts.cwd,
      '-m',
      'gpt-5-codex',
      '-',
    ]);
    expect(recorder.cwd).toBe(opts.cwd);
    expect(recorder.stdinWritten.join('')).toContain('?? ??????????? smoke-agent.');
    expect(recorder.stdinWritten.join('')).toContain('?????? ?????: ok-codex');

    expect(res.result).not.toBeNull();
    expect(res.result?.is_error).toBe(false);
    expect(res.result?.usage.input_tokens).toBe(120);
    expect(res.result?.usage.cache_read_input_tokens).toBe(40);
    expect(res.result?.usage.cache_creation_input_tokens).toBe(5);
    expect(res.result?.usage.output_tokens).toBe(9);
    expect(res.messages).toHaveLength(3);
    expect(res.spendRecordId).not.toBeNull();

    const row = await prisma.$queryRawUnsafe<{ properties: string }[]>(
      `SELECT properties FROM "Record" WHERE id = ?`,
      res.spendRecordId,
    );
    const props = JSON.parse(row[0]?.properties ?? '{}') as Record<string, unknown>;
    expect(props.transport).toBe('codex');
    expect(props.usd).toBe(0);
    expect(props.inputTokens).toBe(120);
    expect(props.cacheReadTokens).toBe(40);
    expect(props.cacheCreationTokens).toBe(5);
    expect(props.outputTokens).toBe(9);
  });

  it('passes network access config to codex exec when enabled', async () => {
    process.env.CODEX_SANDBOX_NETWORK_ACCESS = 'true';
    resetTransportForTests();
    const recorder: SpawnRecorder = { stdinWritten: [], killCalls: [] };
    const fake = makeFakeChild();
    const opts = makeOpts();

    const runPromise = runSubagentViaCodex(opts, prisma, {
      spawnImpl: makeSpawnMock(recorder, fake),
    });

    await waitForSpawn(recorder);
    fake.pushStdout(
      `${JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 1, output_tokens: 1 },
      })}\n`,
    );
    fake.close(0);

    await runPromise;

    expect(recorder.args).toEqual([
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '-c',
      'sandbox_workspace_write.network_access=true',
      '--sandbox',
      'workspace-write',
      '-C',
      opts.cwd,
      '-m',
      'gpt-5-codex',
      '-',
    ]);
  });

  it('exit ??? turn.completed ?????????? result=null ? ?? ????? spend', async () => {
    const recorder: SpawnRecorder = { stdinWritten: [], killCalls: [] };
    const fake = makeFakeChild();
    const opts = makeOpts();

    const runPromise = runSubagentViaCodex(opts, prisma, {
      spawnImpl: makeSpawnMock(recorder, fake),
    });
    await waitForSpawn(recorder);
    fake.pushStderr('codex failed\n');
    fake.close(1);

    const res = await runPromise;

    expect(res.result).toBeNull();
    expect(res.spendRecordId).toBeNull();
    expect(res.timedOut).toBe(false);
  });
});
