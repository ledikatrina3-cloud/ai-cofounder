// Тесты для фазы 2.3a (обёртка sub-agent-исследователя).
//
// Стратегия:
//   * Mock-Agent SDK через DI (`runSubagentImpl`). Реальный @anthropic-ai/claude-agent-sdk
//     не зовётся — это touchpoint с Anthropic API, который должен идти только
//     по явному `it_` (skip без ANTHROPIC_API_KEY).
//   * Prisma — shared dev.db, изоляция через RUN_ID-префикс в id'шниках.
//   * Fixture-репо: `tests/fixtures/sample-project/` копируется в tempdir,
//     `git init` + один коммит — программно в setUp. Никаких вложенных `.git/`
//     в самом репо AI-Cofounder.
//   * Реальный API-кейс: `it.skip` без ANTHROPIC_API_KEY (как в budget/triage).

import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertSchemaInvariants } from '../src/db/invariants-check.js';
import type { InvestigateConfig } from '../src/investigate/config.js';
import {
  InvestigateConfigError,
  InvestigateInvalidResponseError,
  type InvestigationResult,
  investigateProblem,
} from '../src/investigate/run.js';
import type {
  SDKResultLike,
  SubagentRunOptions,
  SubagentRunResult,
  runSubagent as defaultRunSubagent,
} from '../src/llm/subagent.js';

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

// ---------------------------------------------------------------------------
// Helpers — fixture-tempdir с git init.
// ---------------------------------------------------------------------------

interface Fixture {
  cwd: string;
  cleanup(): void;
}

function setupFixture(): Fixture {
  const cwd = mkdtempSync(join(tmpdir(), 'investigate-test-'));
  cpSync(FIXTURE_SRC, cwd, { recursive: true });
  // Программный git init: ноль вложенных .git/ в репозитории AI-Cofounder.
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

function makeConfig(targetProjectPath: string): InvestigateConfig {
  return {
    targetProjectPath,
    model: 'claude-sonnet-4-6',
    subagentType: 'Explore',
    timeoutMs: 5_000,
    maxTokens: 100_000,
    maxTurns: 20,
    promptId: 'investigate:run:test',
    bashWhitelist: ['git log', 'git show', 'cat', 'ls', 'find', 'grep', 'rg'],
    concurrency: 3,
    maxProblemsPerCycle: 10,
    parentSessionPrefix: 'investigate-test',
    asOf: 0,
    sourcePath: 'tests/investigate-run.test.ts',
  };
}

// Стандартный mock-result для счастливого пути.
function makeSuccessResult(usd = 0.0123, inputTokens = 5_000): SDKResultLike {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 2_345,
    is_error: false,
    num_turns: 4,
    total_cost_usd: usd,
    usage: {
      inputTokens,
      outputTokens: 800,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  };
}

// Делает SDK-message-список с одним assistant-text, содержащим JSON-блок.
function makeMessagesWithJsonText(json: unknown): unknown[] {
  return [
    {
      type: 'system',
      subtype: 'init',
    },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: `Я посмотрел src/payment.ts:6, там try/catch проглатывает.\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``,
          },
        ],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers — seed intent.problem + event.support.message + RecordLink.
// ---------------------------------------------------------------------------

interface SeededProblem {
  problemId: string;
  supportMessageIds: string[];
}

async function seedProblemWithMessages(opts: {
  summary: string;
  symptoms: string[];
  messages: Array<{ text: string; username: string | null }>;
}): Promise<SeededProblem> {
  const problemId = ulid();
  const now = Date.now();
  const props = JSON.stringify({ summary: opts.summary, symptoms: opts.symptoms });
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt)
     VALUES (?, 'intent.problem', ?, 'agent', 'autonomous', 'active', ?)`,
    problemId,
    props,
    now,
  );
  const supportMessageIds: string[] = [];
  for (const m of opts.messages) {
    const msgId = ulid();
    const msgProps = JSON.stringify({
      chatId: `inv-${RUN_ID}`,
      messageId: Math.floor(Math.random() * 1_000_000_000),
      userId: '2002',
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
      `inv-test:${RUN_ID}:${msgId}`,
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
  return { problemId, supportMessageIds };
}

// ---------------------------------------------------------------------------
// Тесты.
// ---------------------------------------------------------------------------

describe('investigateProblem — happy path (mock SDK, verdict=code)', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('возвращает InvestigationResult с verdict=code и codeRefs', async () => {
    const seeded = await seedProblemWithMessages({
      summary: 'клиенты жалуются на оплату',
      symptoms: ['нажимаю «оплатить» — ничего не происходит', 'деньги не списываются'],
      messages: [
        { text: 'нажимаю кнопку оплаты, ничего не происходит', username: 'kolya' },
        { text: 'оплата висит, не понимаю что делать', username: 'masha' },
      ],
    });

    const stubResult: SDKResultLike = makeSuccessResult();
    const stubMessages = makeMessagesWithJsonText({
      verdict: 'code',
      rationale:
        'В src/payment.ts:6 try/catch молча проглатывает ошибку оплаты — UI получает {ok:false} без указания причины. Поэтому клиент видит «ничего не происходит».',
      codeRefs: [{ path: 'src/payment.ts', line: 6, snippet: 'catch { return { ok: false } }' }],
      gitHints: ['initial fixture commit'],
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

    const result = await investigateProblem(seeded.problemId, {
      db: prisma,
      configOverride: makeConfig(fixture.cwd),
      runSubagentImpl: fakeRunSubagent,
    });

    expect(result.verdict).toBe('code');
    expect(result.rationale.length).toBeGreaterThan(10);
    expect(result.codeRefs).toHaveLength(1);
    expect(result.codeRefs[0]?.path).toBe('src/payment.ts');
    expect(result.codeRefs[0]?.line).toBe(6);
    expect(result.gitHints).toEqual(['initial fixture commit']);
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
    expect(opts?.cycleParentId).toBe(seeded.problemId);
    expect(opts?.timeoutMs).toBe(5_000);
    expect(opts?.systemPrompt).toContain('исследователь');
    // user-prompt должен содержать оба сообщения и summary.
    expect(opts?.prompt).toContain('клиенты жалуются на оплату');
    expect(opts?.prompt).toContain('нажимаю кнопку оплаты');
    expect(opts?.prompt).toContain('оплата висит');
    expect(opts?.prompt).toContain('finish_investigation');
  });
});

describe('investigateProblem — invalid response throws', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('schema-mismatch (verdict=garbage) → InvestigateInvalidResponseError', async () => {
    const seeded = await seedProblemWithMessages({
      summary: 'битый вердикт',
      symptoms: [],
      messages: [{ text: 'жалоба', username: null }],
    });

    const fakeRunSubagent: typeof defaultRunSubagent = async () => ({
      messages: makeMessagesWithJsonText({
        verdict: 'garbage', // невалидный enum
        rationale: 'что-то',
      }) as never,
      result: makeSuccessResult(),
      spendRecordId: ulid(),
      durationMs: 100,
      timedOut: false,
    });

    await expect(
      investigateProblem(seeded.problemId, {
        db: prisma,
        configOverride: makeConfig(fixture.cwd),
        runSubagentImpl: fakeRunSubagent,
      }),
    ).rejects.toBeInstanceOf(InvestigateInvalidResponseError);
  });

  it('нет JSON-блока вообще → InvestigateInvalidResponseError(no-tool-use)', async () => {
    const seeded = await seedProblemWithMessages({
      summary: 'sub-agent забыл вернуть JSON',
      symptoms: [],
      messages: [{ text: 'жалоба', username: null }],
    });

    const messagesWithoutJson = [
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'я тут что-то поковырялся, но не нашёл' }],
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
      investigateProblem(seeded.problemId, {
        db: prisma,
        configOverride: makeConfig(fixture.cwd),
        runSubagentImpl: fakeRunSubagent,
      }),
    ).rejects.toMatchObject({
      name: 'InvestigateInvalidResponseError',
      reason: 'no-tool-use',
    });
  });
});

describe('investigateProblem — timeout', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = setupFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('timedOut=true → verdict=unclear, rationale содержит «тайм-аут»', async () => {
    const seeded = await seedProblemWithMessages({
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

    const config = makeConfig(fixture.cwd);
    config.timeoutMs = 5 * 60 * 1000; // 5 минут — для проверки округления

    const result = await investigateProblem(seeded.problemId, {
      db: prisma,
      configOverride: config,
      runSubagentImpl: fakeRunSubagent,
    });

    expect(result.verdict).toBe('unclear');
    expect(result.rationale).toMatch(/тайм-аут/);
    expect(result.rationale).toMatch(/5 мин/);
    expect(result.timedOut).toBe(true);
    expect(result.codeRefs).toEqual([]);
    expect(result.gitHints).toEqual([]);
  });
});

describe('investigateProblem — config errors', () => {
  it('targetProjectPath не существует → InvestigateConfigError(no-target-project)', async () => {
    const seeded = await seedProblemWithMessages({
      summary: 'неважно',
      symptoms: [],
      messages: [{ text: 'жалоба', username: null }],
    });

    const config = makeConfig('/nonexistent/path/example-project-тут-нет');

    await expect(
      investigateProblem(seeded.problemId, {
        db: prisma,
        configOverride: config,
        runSubagentImpl: async () => {
          throw new Error('sub-agent не должен запуститься');
        },
      }),
    ).rejects.toMatchObject({
      name: 'InvestigateConfigError',
      reason: 'no-target-project',
    });
  });

  it('intent.problem с неизвестным id → InvestigateConfigError(no-problem-record)', async () => {
    const fixture = setupFixture();
    try {
      await expect(
        investigateProblem('01ABCDEFGHJKMNPQRSTVWXYZ00', {
          db: prisma,
          configOverride: makeConfig(fixture.cwd),
          runSubagentImpl: async () => {
            throw new Error('sub-agent не должен запуститься');
          },
        }),
      ).rejects.toMatchObject({
        name: 'InvestigateConfigError',
        reason: 'no-problem-record',
      });
    } finally {
      fixture.cleanup();
    }
  });
});

describe('investigateProblem — default config (parses config/investigate.md)', () => {
  it('loadInvestigateConfig читает реальный файл и shape валиден', async () => {
    const { loadInvestigateConfig } = await import('../src/investigate/config.js');
    const config = await loadInvestigateConfig();
    expect(typeof config.targetProjectPath).toBe('string');
    expect(typeof config.model).toBe('string');
    expect(config.timeoutMs).toBeGreaterThan(0);
    expect(config.maxTokens).toBeGreaterThan(0);
    expect(config.bashWhitelist.length).toBeGreaterThan(0);
    // Sanity: ни один whitelist-prefix не содержит запрещённых команд.
    for (const cmd of config.bashWhitelist) {
      expect(cmd).not.toMatch(/\b(rm|mv|push|reset|checkout|commit)\b/);
    }
  });
});

describe('investigateProblem — реальный API (skip без ANTHROPIC_API_KEY)', () => {
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
  // выставлен и фаундер хочет потратить ~$0.05-$0.20 на проверку. По умолчанию
  // skip — CI и локальный `pnpm test` не должны бить в Anthropic API.
  it_(
    'на fixture-репо реальный sub-agent возвращает валидный verdict',
    async () => {
      const seeded = await seedProblemWithMessages({
        summary: 'клиент жалуется: оплата не работает, нажимаю — тишина',
        symptoms: [
          'кнопка «оплатить» нажата, но ничего не меняется',
          'статус оплаты не отображается',
        ],
        messages: [{ text: 'нажал оплатить — пустота, что делать?', username: 'real-test-user' }],
      });

      const result: InvestigationResult = await investigateProblem(seeded.problemId, {
        db: prisma,
        configOverride: makeConfig(fixture.cwd),
      });

      expect(['code', 'human', 'unclear']).toContain(result.verdict);
      expect(result.rationale.length).toBeGreaterThan(0);
      expect(result.totalUsd).toBeGreaterThan(0);
      expect(result.totalTokens).toBeGreaterThan(0);
    },
    10 * 60 * 1000, // 10 минут — sub-agent + сеть
  );
});
