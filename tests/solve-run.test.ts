// Тесты для фазы 2.4a (обёртка sub-agent-решателя).
//
// Стратегия:
//   * Mock subagent через DI (`runSubagentImpl`). Реальный @anthropic-ai/claude-agent-sdk
//     не зовётся — это touchpoint с Anthropic API.
//   * vi.mock на src/observe/bridge.js, чтобы проверить эмит solve.start/end.
//   * Prisma — shared dev.db, изоляция через RUN_ID-префикс в id'шниках.
//   * Fixture-репо: `tests/fixtures/sample-project/` копируется в tempdir.
//     Re-используем тот же fixture, что у 2.3a — он подходит и для решателя.
//   * Реальный API-кейс: `it.skip` без ANTHROPIC_API_KEY (паттерн budget/triage/investigate).

import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSchemaInvariants } from '../src/db/invariants-check.js';
import type {
  SDKResultLike,
  SubagentRunOptions,
  SubagentRunResult,
  runSubagent as defaultRunSubagent,
} from '../src/llm/subagent.js';
import type { SolveConfig } from '../src/solve/config.js';
import {
  SolveConfigError,
  SolveInvalidResponseError,
  type SolveResult,
  SolveTimeoutError,
  solveDiagnosis,
} from '../src/solve/run.js';

vi.mock('../src/observe/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/observe/bridge.js')>();
  return {
    ...actual,
    emit: vi.fn().mockResolvedValue(undefined),
  };
});

import { emit } from '../src/observe/bridge.js';

const RUN_ID = ulid().slice(0, 8);
const FIXTURE_SRC = resolve(process.cwd(), 'tests/fixtures/sample-project');

const prisma = new PrismaClient();

beforeAll(async () => {
  await prisma.$connect();
  await assertSchemaInvariants(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  vi.mocked(emit).mockClear();
});

// ---------------------------------------------------------------------------
// Helpers — fixture-tempdir с git init.
// ---------------------------------------------------------------------------

interface Fixture {
  cwd: string;
  cleanup(): void;
}

function setupFixture(): Fixture {
  const cwd = mkdtempSync(join(tmpdir(), 'solve-test-'));
  cpSync(FIXTURE_SRC, cwd, { recursive: true });
  execSync('git init -q', { cwd, stdio: 'pipe' });
  execSync('git -c user.email=t@t -c user.name=t add -A', { cwd, stdio: 'pipe' });
  execSync('git -c user.email=t@t -c user.name=t commit -q -m "initial fixture"', {
    cwd,
    stdio: 'pipe',
  });
  return {
    cwd,
    cleanup: () => {
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function makeConfig(targetProjectPath: string): SolveConfig {
  return {
    targetProjectPath,
    model: 'claude-sonnet-4-6',
    subagentType: 'Plan',
    timeoutMs: 5_000,
    maxTokens: 100_000,
    maxTurns: 20,
    promptId: 'solve:propose:test',
    bashWhitelist: ['git log', 'git show', 'cat', 'ls', 'find', 'grep', 'rg'],
    concurrency: 3,
    maxProblemsPerCycle: 10,
    parentSessionPrefix: 'solve-test',
    asOf: 0,
    sourcePath: 'tests/solve-run.test.ts',
  };
}

function makeSuccessResult(usd = 0.0234, inputTokens = 7_000): SDKResultLike {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 3_000,
    is_error: false,
    num_turns: 5,
    total_cost_usd: usd,
    usage: {
      inputTokens,
      outputTokens: 1_200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  };
}

function makeMessagesWithJsonText(json: unknown): unknown[] {
  return [
    { type: 'system', subtype: 'init' },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: `Я посмотрел src/payment.ts:6 и вот предложение.\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``,
          },
        ],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers — seed intent.diagnosis (с verdict='code') + intent.problem +
// event.support.message + RecordLink цепочки.
// ---------------------------------------------------------------------------

interface SeededDiagnosis {
  diagnosisId: string;
  problemId: string;
  supportMessageIds: string[];
}

interface SeedOptions {
  verdict?: 'code' | 'human' | 'unclear';
  rationale?: string;
  codeRefs?: Array<{ path: string; line?: number; snippet?: string }>;
  gitHints?: string[];
  summary: string;
  symptoms: string[];
  messages: Array<{ text: string; username: string | null }>;
}

async function seedDiagnosisChain(opts: SeedOptions): Promise<SeededDiagnosis> {
  const now = Date.now();
  // intent.problem
  const problemId = ulid();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt)
     VALUES (?, 'intent.problem', ?, 'agent', 'autonomous', 'active', ?)`,
    problemId,
    JSON.stringify({ summary: opts.summary, symptoms: opts.symptoms }),
    now,
  );

  // event.support.message + RecordLink linkType='породило'
  const supportMessageIds: string[] = [];
  for (const m of opts.messages) {
    const msgId = ulid();
    const msgProps = JSON.stringify({
      chatId: `solve-${RUN_ID}`,
      messageId: Math.floor(Math.random() * 1_000_000_000),
      userId: '3003',
      username: m.username,
      text: m.text,
      attachments: [],
      timestamp: now,
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt, idempotencyKey)
       VALUES (?, 'event.support.message', ?, 'external', 'autonomous', 'active', ?, ?)`,
      msgId,
      msgProps,
      now,
      `solve-test:${RUN_ID}:${msgId}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "RecordLink" (id, fromRecordId, toRecordId, toPagePath, linkType, createdAt)
       VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM "RecordLink"), ?, ?, NULL, 'породило', ?)`,
      msgId,
      problemId,
      now,
    );
    supportMessageIds.push(msgId);
  }

  // intent.diagnosis (verdict + rationale + codeRefs)
  const diagnosisId = ulid();
  const verdict = opts.verdict ?? 'code';
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt)
     VALUES (?, 'intent.diagnosis', ?, 'agent', 'autonomous', 'active', ?)`,
    diagnosisId,
    JSON.stringify({
      verdict,
      rationale: opts.rationale ?? 'тестовое обоснование исследователя',
      codeRefs: opts.codeRefs ?? [],
      gitHints: opts.gitHints ?? [],
      totalUsd: 0.05,
      totalTokens: 12_000,
      durationMs: 3_000,
      subagentId: ulid(),
      timedOut: false,
      spendRecordId: null,
    }),
    now,
  );
  // RecordLink linkType='заключение' от диагноза к проблеме (контракт 2.3c)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "RecordLink" (id, fromRecordId, toRecordId, toPagePath, linkType, createdAt)
     VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM "RecordLink"), ?, ?, NULL, 'заключение', ?)`,
    diagnosisId,
    problemId,
    now,
  );
  return { diagnosisId, problemId, supportMessageIds };
}

// ---------------------------------------------------------------------------
// Тесты.
// ---------------------------------------------------------------------------

describe('solveDiagnosis — happy path (mock SDK, verdict=code)', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('возвращает SolveResult с тремя абзацами + files + estimateMinutes', async () => {
    const seeded = await seedDiagnosisChain({
      verdict: 'code',
      rationale: 'В src/payment.ts:6 try/catch проглатывает ошибку оплаты.',
      codeRefs: [{ path: 'src/payment.ts', line: 6, snippet: 'catch { return { ok: false } }' }],
      gitHints: ['initial fixture commit'],
      summary: 'клиенты жалуются на оплату',
      symptoms: ['оплата зависает'],
      messages: [
        { text: 'нажимаю кнопку оплаты, ничего не происходит', username: 'kolya' },
        { text: 'оплата висит, не понимаю что делать', username: 'masha' },
      ],
    });

    const stubResult = makeSuccessResult();
    const stubMessages = makeMessagesWithJsonText({
      asIs: 'Сейчас в src/payment.ts:6 блок catch молча возвращает {ok:false} без указания причины. UI получает только флаг и не видит, что именно сломалось.',
      problem:
        'Из-за этого клиент жмёт «оплатить», получает молчаливый отказ и думает, что приложение зависло. Деньги не списываются, но и понятной причины он не видит.',
      asWillBe:
        'В src/payment.ts:6 catch будет логировать оригинальную ошибку и возвращать структурированный результат {ok:false, reason}. UI отрендерит понятный текст клиенту вместо «ничего не произошло».',
      files: [
        {
          path: 'src/payment.ts',
          action: 'edit',
          oldSnippet: 'catch { return { ok: false } }',
          newSnippet:
            'catch (err) { logger.error(err); return { ok: false, reason: explain(err) } }',
        },
      ],
      estimateMinutes: 30,
    });

    let runSubagentCalledWith: SubagentRunOptions | null = null;
    const fakeRunSubagent: typeof defaultRunSubagent = async (options) => {
      runSubagentCalledWith = options;
      return {
        messages: stubMessages as never,
        result: stubResult,
        spendRecordId: ulid(),
        durationMs: stubResult.duration_ms,
        timedOut: false,
      } satisfies SubagentRunResult;
    };

    const result: SolveResult = await solveDiagnosis(seeded.diagnosisId, {
      db: prisma,
      configOverride: makeConfig(fixture.cwd),
      runSubagentImpl: fakeRunSubagent,
      parentSession: 'test-session-001',
    });

    // Три абзаца — содержательные.
    expect(result.asIs.length).toBeGreaterThan(20);
    expect(result.problem.length).toBeGreaterThan(20);
    expect(result.asWillBe.length).toBeGreaterThan(20);
    expect(result.asIs).toMatch(/payment\.ts/);
    // files
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('src/payment.ts');
    expect(result.files[0]?.action).toBe('edit');
    expect(result.files[0]?.oldSnippet).toMatch(/catch/);
    expect(result.files[0]?.newSnippet).toMatch(/explain/);
    // estimate
    expect(result.estimateMinutes).toBe(30);
    // субагент-метаданные
    expect(result.subagentId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.timedOut).toBe(false);
    expect(result.totalUsd).toBe(stubResult.total_cost_usd);
    expect(result.totalTokens).toBeGreaterThan(0);

    // sub-agent получил ровно те параметры, которых мы ждали.
    expect(runSubagentCalledWith).not.toBeNull();
    const opts = runSubagentCalledWith as SubagentRunOptions | null;
    expect(opts?.cwd).toBe(fixture.cwd);
    expect(opts?.model).toBe('claude-sonnet-4-6');
    expect(opts?.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    expect(opts?.cycleParentId).toBe(seeded.diagnosisId);
    expect(opts?.timeoutMs).toBe(5_000);
    expect(opts?.systemPrompt).toContain('решатель');
    // user-prompt должен содержать диагноз, summary, оба сообщения, codeRef и упоминание tool'а.
    expect(opts?.prompt).toContain(seeded.diagnosisId);
    expect(opts?.prompt).toContain('клиенты жалуются на оплату');
    expect(opts?.prompt).toContain('нажимаю кнопку оплаты');
    expect(opts?.prompt).toContain('оплата висит');
    expect(opts?.prompt).toContain('src/payment.ts:6');
    expect(opts?.prompt).toContain('finish_proposal');

    // Bridge: эмит solve.start (с parentSession) и solve.end.
    const calls = vi.mocked(emit).mock.calls;
    const startEvents = calls.map((c) => c[0]).filter((e) => e.type === 'solve.start');
    const endEvents = calls.map((c) => c[0]).filter((e) => e.type === 'solve.end');
    expect(startEvents).toHaveLength(1);
    expect(endEvents).toHaveLength(1);
    const start = startEvents[0] as {
      type: 'solve.start';
      subagentId: string;
      diagnosisId: string;
      parentSession?: string;
    };
    expect(start.subagentId).toBe(result.subagentId);
    expect(start.diagnosisId).toBe(seeded.diagnosisId);
    expect(start.parentSession).toBe('test-session-001');
    const end = endEvents[0] as {
      type: 'solve.end';
      subagentId: string;
      durationMs: number;
      totalUsd: number;
      totalTokens: number;
      timedOut: boolean;
    };
    expect(end.subagentId).toBe(result.subagentId);
    expect(end.totalUsd).toBe(stubResult.total_cost_usd);
    expect(end.timedOut).toBe(false);
  });
});

describe('solveDiagnosis — invalid response throws', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('schema-mismatch (без asIs) → SolveInvalidResponseError(schema-mismatch)', async () => {
    const seeded = await seedDiagnosisChain({
      verdict: 'code',
      summary: 'битый ответ решателя',
      symptoms: [],
      messages: [{ text: 'жалоба', username: null }],
    });

    const fakeRunSubagent: typeof defaultRunSubagent = async () => ({
      messages: makeMessagesWithJsonText({
        // asIs отсутствует
        problem: 'есть только problem',
        asWillBe: 'и asWillBe',
        files: [],
        estimateMinutes: 10,
      }) as never,
      result: makeSuccessResult(),
      spendRecordId: ulid(),
      durationMs: 100,
      timedOut: false,
    });

    await expect(
      solveDiagnosis(seeded.diagnosisId, {
        db: prisma,
        configOverride: makeConfig(fixture.cwd),
        runSubagentImpl: fakeRunSubagent,
      }),
    ).rejects.toMatchObject({
      name: 'SolveInvalidResponseError',
      reason: 'schema-mismatch',
    });
  });

  it('нет JSON-блока вообще → SolveInvalidResponseError(no-tool-use)', async () => {
    const seeded = await seedDiagnosisChain({
      verdict: 'code',
      summary: 'sub-agent забыл вернуть JSON',
      symptoms: [],
      messages: [{ text: 'жалоба', username: null }],
    });

    const messagesWithoutJson = [
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'я тут что-то поковырялся, но ничего не предложил' }],
        },
      },
    ];

    const fakeRunSubagent: typeof defaultRunSubagent = async () => ({
      messages: messagesWithoutJson as never,
      result: makeSuccessResult(),
      spendRecordId: ulid(),
      durationMs: 100,
      timedOut: false,
    });

    await expect(
      solveDiagnosis(seeded.diagnosisId, {
        db: prisma,
        configOverride: makeConfig(fixture.cwd),
        runSubagentImpl: fakeRunSubagent,
      }),
    ).rejects.toMatchObject({
      name: 'SolveInvalidResponseError',
      reason: 'no-tool-use',
    });
  });
});

describe('solveDiagnosis — timeout', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('timedOut=true → SolveTimeoutError (без fake-результата)', async () => {
    const seeded = await seedDiagnosisChain({
      verdict: 'code',
      summary: 'sub-agent висит',
      symptoms: [],
      messages: [{ text: 'жалоба', username: null }],
    });

    const fakeRunSubagent: typeof defaultRunSubagent = async () => ({
      messages: [],
      result: null,
      spendRecordId: null,
      durationMs: 5_000,
      timedOut: true,
    });

    await expect(
      solveDiagnosis(seeded.diagnosisId, {
        db: prisma,
        configOverride: makeConfig(fixture.cwd),
        runSubagentImpl: fakeRunSubagent,
      }),
    ).rejects.toBeInstanceOf(SolveTimeoutError);

    // Bridge: solve.end эмитнут с timedOut=true (start был бы первым, end —
    // прямо перед throw).
    const endEvents = vi
      .mocked(emit)
      .mock.calls.map((c) => c[0])
      .filter((e) => e.type === 'solve.end') as Array<{
      type: 'solve.end';
      timedOut: boolean;
    }>;
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0]?.timedOut).toBe(true);
  });
});

describe('solveDiagnosis — config errors', () => {
  it('verdict=human → SolveConfigError(verdict-not-code)', async () => {
    const fixture = setupFixture();
    try {
      const seeded = await seedDiagnosisChain({
        verdict: 'human',
        summary: 'клиент не понял UI',
        symptoms: [],
        messages: [{ text: 'жалоба', username: null }],
      });

      await expect(
        solveDiagnosis(seeded.diagnosisId, {
          db: prisma,
          configOverride: makeConfig(fixture.cwd),
          runSubagentImpl: async () => {
            throw new Error('sub-agent не должен запуститься на human-вердикте');
          },
        }),
      ).rejects.toMatchObject({
        name: 'SolveConfigError',
        reason: 'verdict-not-code',
      });
    } finally {
      fixture.cleanup();
    }
  });

  it('intent.diagnosis с неизвестным id → SolveConfigError(no-diagnosis-record)', async () => {
    const fixture = setupFixture();
    try {
      await expect(
        solveDiagnosis('01ABCDEFGHJKMNPQRSTVWXYZ00', {
          db: prisma,
          configOverride: makeConfig(fixture.cwd),
          runSubagentImpl: async () => {
            throw new Error('sub-agent не должен запуститься на отсутствующем диагнозе');
          },
        }),
      ).rejects.toMatchObject({
        name: 'SolveConfigError',
        reason: 'no-diagnosis-record',
      });
    } finally {
      fixture.cleanup();
    }
  });

  it('targetProjectPath не существует → SolveConfigError(no-target-project)', async () => {
    const seeded = await seedDiagnosisChain({
      verdict: 'code',
      summary: 'неважно',
      symptoms: [],
      messages: [{ text: 'жалоба', username: null }],
    });

    const config = makeConfig('/nonexistent/path/example-project-тут-нет');

    await expect(
      solveDiagnosis(seeded.diagnosisId, {
        db: prisma,
        configOverride: config,
        runSubagentImpl: async () => {
          throw new Error('sub-agent не должен запуститься');
        },
      }),
    ).rejects.toMatchObject({
      name: 'SolveConfigError',
      reason: 'no-target-project',
    });
  });
});

describe('solveDiagnosis — default config (parses config/solve.md)', () => {
  it('loadSolveConfig читает реальный файл и shape валиден', async () => {
    const { loadSolveConfig } = await import('../src/solve/config.js');
    const config = await loadSolveConfig();
    expect(typeof config.targetProjectPath).toBe('string');
    expect(config.targetProjectPath.length).toBeGreaterThan(0);
    expect(typeof config.model).toBe('string');
    expect(config.subagentType).toBe('Plan');
    expect(config.timeoutMs).toBeGreaterThan(0);
    expect(config.maxTokens).toBeGreaterThan(0);
    expect(config.bashWhitelist.length).toBeGreaterThan(0);
    // Sanity: ни один whitelist-prefix не содержит запрещённых команд.
    for (const cmd of config.bashWhitelist) {
      expect(cmd).not.toMatch(/\b(rm|mv|push|reset|checkout|commit|edit|write)\b/);
    }
  });

  // Гарантируем, что класс ошибок экспортирован — 2.4b будет на него ловиться
  // при неудачном предложении.
  it('SolveConfigError экспортируется и работает как Error', () => {
    const err = new SolveConfigError('test', 'verdict-not-code');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SolveConfigError');
    expect(err.reason).toBe('verdict-not-code');
  });
});

describe('solveDiagnosis — реальный API (skip без ANTHROPIC_API_KEY)', () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const it_ = apiKey ? it : it.skip;

  let fixture: Fixture;

  beforeEach(() => {
    fixture = setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  // Долгий тест с реальным sub-agent. Запускается только если ANTHROPIC_API_KEY
  // выставлен и фаундер хочет потратить ~$0.05-$0.20 на проверку.
  it_(
    'на fixture-репо реальный sub-agent возвращает валидный SolveResult',
    async () => {
      const seeded = await seedDiagnosisChain({
        verdict: 'code',
        rationale: 'В src/payment.ts try/catch проглатывает ошибку оплаты.',
        codeRefs: [{ path: 'src/payment.ts', line: 6, snippet: 'catch { return { ok: false } }' }],
        gitHints: [],
        summary: 'клиенты жалуются на оплату',
        symptoms: ['оплата зависает', 'нет статуса'],
        messages: [{ text: 'нажал оплатить — пустота, что делать?', username: 'real-test-user' }],
      });

      const result = await solveDiagnosis(seeded.diagnosisId, {
        db: prisma,
        configOverride: makeConfig(fixture.cwd),
      });

      expect(result.asIs.length).toBeGreaterThan(0);
      expect(result.problem.length).toBeGreaterThan(0);
      expect(result.asWillBe.length).toBeGreaterThan(0);
      expect(typeof result.estimateMinutes).toBe('number');
      expect(result.totalUsd).toBeGreaterThan(0);
      expect(result.totalTokens).toBeGreaterThan(0);
    },
    10 * 60 * 1000,
  );
});
