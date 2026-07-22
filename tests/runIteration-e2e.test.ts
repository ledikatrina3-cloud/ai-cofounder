// E2E-тесты сшивки runIteration (фаза 2.5).
//
// Стратегия:
//   * Mock на ВСЕХ границах pipeline'а: fetchSupportMessages, extractProblems,
//     mergeProblems, investigateMany, persistFanoutResult, runSolveBatch,
//     buildReport-зависимости (через rootDir + реальные шаблоны), sendReport.
//     Реальные SDK не зовутся ни в одном тесте — деньги/Telegram-сеть не трогаем.
//   * src/core/loop.ts тестируется как есть, без моков. Это и есть «сшивка».
//   * Изолированная БД через mkdtempSync → копия template.db. Один прогон тестов
//     5 раз подряд должен быть зелёным (фикс flake'а из ретро 2.3c).
//   * vi.mock на src/observe/bridge.js — проверяем эмиты runIteration.start/step/end.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runIteration } from '../src/core/loop.js';
import { triggerCronMorning, triggerManual } from '../src/core/triggers.js';
import { _resetTemplateCache } from '../src/report/morning.js';
import type { TelegramMessage } from '../src/report/morning.js';
import {
  type IsolatedDb,
  type TemplateHandle,
  createIsolatedDb,
  setupTemplateDb,
} from './fixtures/isolated-db.js';

vi.mock('../src/observe/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/observe/bridge.js')>();
  return {
    ...actual,
    emit: vi.fn().mockResolvedValue(undefined),
  };
});

import { emit } from '../src/observe/bridge.js';

// ---------------------------------------------------------------------------
// Test rig.
// ---------------------------------------------------------------------------

let template: TemplateHandle;
let isolated: IsolatedDb;

beforeAll(() => {
  template = setupTemplateDb();
});

afterAll(() => {
  template.dispose();
});

beforeEach(async () => {
  vi.mocked(emit).mockClear();
  _resetTemplateCache();
  isolated = await createIsolatedDb(template);
});

afterEach(async () => {
  await isolated.dispose();
});

// ---------------------------------------------------------------------------
// Helpers — моки pipeline'а.
// ---------------------------------------------------------------------------

interface MockSupport {
  id: string;
  text: string;
}

async function seedSupport(prisma: PrismaClient, count: number): Promise<MockSupport[]> {
  const out: MockSupport[] = [];
  const baseTs = Date.now();
  for (let i = 0; i < count; i++) {
    const id = ulid();
    const properties = JSON.stringify({
      chatId: 'test-chat',
      messageId: 1000 + i,
      userId: '42',
      username: `user${i}`,
      text: `support message #${i}`,
      attachments: [],
      timestamp: baseTs + i,
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt)
       VALUES (?, 'event.support.message', ?, 'external', 'autonomous', 'active', ?)`,
      id,
      properties,
      baseTs + i,
    );
    out.push({ id, text: `support message #${i}` });
  }
  return out;
}

interface MockSendCall {
  chatId: string | number;
  text: string;
  parseMode?: 'Markdown' | 'HTML';
  replyToMessageId?: number;
}

function makeMockSendReport(calls: MockSendCall[], options: { failOnSend?: boolean } = {}) {
  return async (messages: TelegramMessage[]) => {
    if (options.failOnSend === true) {
      throw new Error('mock telegram network error');
    }
    const ids: number[] = [];
    for (const m of messages) {
      const msgId = 50_000 + calls.length;
      calls.push({
        chatId: 'test-founder',
        text: m.text,
        parseMode: m.parseMode,
        replyToMessageId: m.kind === 'item' ? 50_000 : undefined,
      });
      ids.push(msgId);
    }
    return {
      sentMessageIds: ids,
      messages,
      founderChatId: 'test-founder',
    };
  };
}

// rootDir для buildReport: тесты используют корень проекта (там лежат templates
// и config/report.md). Все остальные пути runIteration не трогает.
const PROJECT_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. Happy path: 12 messages → 3 problems → 3 diagnoses (2 code + 1 human) →
//    2 proposals → 4 Telegram messages (1 header + 3 items).
// ---------------------------------------------------------------------------

describe('runIteration — happy path: 12 → 3 → 3 → 2 → 4', () => {
  it('собирает шапку и 3 item-сообщения с правильным shape', async () => {
    const support = await seedSupport(isolated.prisma, 12);

    // Mock fetcher — возвращает 12 «новых» сообщений (мы их уже seed'нули в БД,
    // fetcher только обновит since/until и emit'нёт start/end).
    const fetchSupportMessages = vi.fn(async () => ({
      messagesFound: 12,
      messagesInserted: 12,
      messagesDeduplicated: 0,
      since: null,
      until: new Date(),
      chatIds: ['test-chat'],
      auditRecordId: ulid(),
    }));

    // Mock триаж — 3 проблемы.
    const problemSummaries = ['payment fails', 'docs misread', 'intermittent slow'];
    const extractProblems = vi.fn(async () => ({
      problems: problemSummaries.map((s, i) => ({
        summary: s,
        symptoms: [`симптом ${i}`],
        supportMessageIds: [support[i * 4]?.id ?? '', support[i * 4 + 1]?.id ?? ''],
      })),
      spendRecordId: ulid(),
      usd: 0.01,
      durationMs: 100,
    }));

    // Mock мердж — все 3 новые (CREATE).
    const newProblemIds = [ulid(), ulid(), ulid()];
    // Сидим intent.problem'ы в БД, чтобы summary корректно подгрузился в assembleItems.
    for (let i = 0; i < newProblemIds.length; i++) {
      const pid = newProblemIds[i];
      const summary = problemSummaries[i];
      if (pid === undefined || summary === undefined) continue;
      await isolated.prisma.$executeRawUnsafe(
        `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt)
         VALUES (?, 'intent.problem', ?, 'agent', 'autonomous', 'active', ?)`,
        pid,
        JSON.stringify({ summary, symptoms: [] }),
        Date.now(),
      );
    }
    const mergeProblems = vi.fn(async () => ({
      created: newProblemIds.map((id, i) => ({
        problemId: id,
        summary: problemSummaries[i] ?? '',
        supportMessageIds: [],
      })),
      merged: [],
      auditRecordId: ulid(),
      durationMs: 50,
    }));

    // Mock fan-out исследователя — 2 code + 1 human.
    const verdicts: Array<'code' | 'human' | 'unclear'> = ['code', 'code', 'human'];
    const investigateMany = vi.fn(async (problemIds: string[]) => ({
      results: problemIds.map((pid, i) => ({
        problemId: pid,
        verdict: (verdicts[i] ?? 'unclear') as 'code' | 'human' | 'unclear',
        rationale: `вердикт для ${pid.slice(-6)}`,
        codeRefs: [],
        gitHints: [],
        subagentId: ulid(),
        totalUsd: 0.05,
        totalTokens: 12_000,
        durationMs: 200,
        timedOut: false,
        spendRecordId: null,
      })),
      failures: [],
      deferred: [],
      parentSession: `investigate-${ulid()}`,
      totalUsd: 0.15,
      totalTokens: 36_000,
      durationMs: 600,
      auditRecordId: ulid(),
    }));

    // Mock persist-investigate — 3 diagnosis.
    const diagnosisIds = [ulid(), ulid(), ulid()];
    const persistFanoutResult = vi.fn(async (fanout: { results: { problemId: string }[] }) => {
      // Сидим intent.diagnosis в БД, чтобы canonical 2.4a-SQL фильтр их нашёл.
      for (let i = 0; i < fanout.results.length; i++) {
        const did = diagnosisIds[i];
        const result = fanout.results[i];
        if (did === undefined || result === undefined) continue;
        const verdict = verdicts[i] ?? 'unclear';
        await isolated.prisma.$executeRawUnsafe(
          `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt)
           VALUES (?, 'intent.diagnosis', ?, 'agent', 'autonomous', 'active', ?)`,
          did,
          JSON.stringify({ verdict, rationale: 'r', codeRefs: [], gitHints: [] }),
          Date.now(),
        );
      }
      return {
        diagnosesCreated: diagnosisIds,
        failuresAuditedAs: [],
        deferredAlreadyAudited: 0,
      };
    });

    // Mock solve — 2 proposals на 2 code-диагноза.
    const proposalIds = [ulid(), ulid()];
    const runSolveBatch = vi.fn(async (codeDiagIds: string[]) => ({
      fanout: {
        results: codeDiagIds.map((did) => ({
          diagnosisId: did,
          asIs: 'как сейчас — баг в payment.ts',
          problem: 'почему это проблема — try/catch глушит ошибки',
          asWillBe: 'как будет — log + retry',
          files: [{ path: 'src/payment.ts', action: 'edit' as const }],
          estimateMinutes: 30,
          subagentId: ulid(),
          totalUsd: 0.08,
          totalTokens: 18_000,
          durationMs: 400,
          timedOut: false,
          spendRecordId: null,
        })),
        failures: [],
        deferred: [],
        parentSession: `solve-${ulid()}`,
        totalUsd: 0.16,
        totalTokens: 36_000,
        durationMs: 800,
        auditRecordId: ulid(),
      },
      persist: {
        proposalsCreated: proposalIds,
        failuresAuditedAs: [],
        deferredAlreadyAudited: 0,
      },
    }));

    const sendCalls: MockSendCall[] = [];
    const sendReport = makeMockSendReport(sendCalls);

    const result = await runIteration(triggerCronMorning(new Date('2026-05-01T07:00:00Z')), {
      db: isolated.prisma,
      fetchSupportMessages,
      extractProblems,
      mergeProblems,
      investigateMany,
      persistFanoutResult,
      runSolveBatch,
      sendReport,
      rootDir: PROJECT_ROOT,
    });

    expect(result.outcome).toBe('ok');
    expect(result.totalUsdSpent).toBeCloseTo(0.32);
    expect(result.totalTokensSpent).toBe(72_000);

    // 4 сообщения: 1 header + 3 items.
    expect(sendCalls).toHaveLength(4);
    expect(sendCalls[0]?.text).toMatch(
      /🌅 Утро\. 3 проблемы за ночь: 2 в коде, 1 по людям, 0 непонятно/,
    );
    expect(sendCalls[0]?.text).toMatch(/Бюджет: \$0\.32 из \$10\.00/);
    expect(sendCalls[0]?.replyToMessageId).toBeUndefined();

    // Все item-сообщения отправлены как reply на шапку.
    expect(sendCalls[1]?.replyToMessageId).toBe(50_000);
    expect(sendCalls[2]?.replyToMessageId).toBe(50_000);
    expect(sendCalls[3]?.replyToMessageId).toBe(50_000);

    // 2 code-сообщения с правильным shape.
    const codeMessages = sendCalls.slice(1).filter((c) => c.text.includes('🛠'));
    expect(codeMessages).toHaveLength(2);
    expect(codeMessages[0]?.text).toMatchInlineSnapshot(`
      "🛠 payment fails

      **Как сейчас:** как сейчас — баг в payment.ts

      **Проблема:** почему это проблема — try/catch глушит ошибки

      **Как будет:** как будет — log + retry

      **Файлы:**
      - \`src/payment.ts\` [edit]

      **Оценка:** 30 мин"
    `);

    // 1 human-сообщение.
    const humanMessages = sendCalls.slice(1).filter((c) => c.text.includes('🧑‍💻'));
    expect(humanMessages).toHaveLength(1);
    expect(humanMessages[0]?.text).toMatch(/🧑‍💻 Человеческий фактор: intermittent slow/);

    // audit.report.sent записан с correctными mentioned*Ids.
    const audit = await isolated.prisma.$queryRawUnsafe<Array<{ properties: string }>>(
      `SELECT properties FROM "Record" WHERE type = 'audit.report.sent' AND parentId = ?`,
      result.triggerRecordId,
    );
    expect(audit).toHaveLength(1);
    const props = JSON.parse(audit[0]?.properties ?? '{}') as Record<string, unknown>;
    expect(props.problemsTotal).toBe(3);
    expect(props.problemsByVerdict).toEqual({ code: 2, human: 1, unclear: 0, failure: 0 });
    expect(props.messagesCount).toBe(4);
    expect(props.totalUsdSpent).toBeCloseTo(0.32);
    expect(props.mentionedProblemIds).toEqual(newProblemIds);
    expect(props.mentionedDiagnosisIds).toEqual(diagnosisIds);
    expect(props.mentionedProposalIds).toEqual(proposalIds);
    expect(props.telegramMessageIds).toEqual([50_000, 50_001, 50_002, 50_003]);

    // Bridge events: runIteration.start + 8 steps + runIteration.end ok.
    const calls = vi.mocked(emit).mock.calls;
    const types = calls.map((c) => c[0].type);
    expect(types).toContain('runIteration.start');
    expect(types).toContain('runIteration.end');
    const stepEvents = calls
      .map((c) => c[0])
      .filter((e) => e.type === 'runIteration.step') as Array<{
      type: 'runIteration.step';
      step: string;
      eventTriggerId: string;
    }>;
    const stepNames = stepEvents.map((e) => e.step);
    expect(stepNames).toEqual([
      'fetch',
      'triage',
      'merge',
      'investigate',
      'persist-investigate',
      'solve',
      'report',
    ]);

    // status='ok'
    const endEvent = calls.map((c) => c[0]).find((e) => e.type === 'runIteration.end') as
      | { type: 'runIteration.end'; status: string }
      | undefined;
    expect(endEvent?.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// 2. Empty input — 0 непрочитанных + 0 pending.
// ---------------------------------------------------------------------------

describe('runIteration — empty input', () => {
  it('1 telegram message + audit.report.empty + status=empty', async () => {
    const fetchSupportMessages = vi.fn(async () => ({
      messagesFound: 0,
      messagesInserted: 0,
      messagesDeduplicated: 0,
      since: null,
      until: new Date(),
      chatIds: [],
      auditRecordId: ulid(),
    }));

    const sendCalls: MockSendCall[] = [];
    const sendReport = makeMockSendReport(sendCalls);

    const result = await runIteration(triggerCronMorning(new Date('2026-05-02T07:00:00Z')), {
      db: isolated.prisma,
      fetchSupportMessages,
      sendReport,
      rootDir: PROJECT_ROOT,
    });

    expect(result.outcome).toBe('empty');
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.text).toMatch(/🌅 Нечего разбирать сегодня\./);

    const audit = await isolated.prisma.$queryRawUnsafe<Array<{ properties: string }>>(
      `SELECT properties FROM "Record" WHERE type = 'audit.report.empty' AND parentId = ?`,
      result.triggerRecordId,
    );
    expect(audit).toHaveLength(1);

    const calls = vi.mocked(emit).mock.calls;
    const endEvent = calls.map((c) => c[0]).find((e) => e.type === 'runIteration.end') as
      | { type: 'runIteration.end'; status: string }
      | undefined;
    expect(endEvent?.status).toBe('empty');
  });
});

// ---------------------------------------------------------------------------
// 3. Идемпотентность — повторный запуск с тем же idempotencyKey.
// ---------------------------------------------------------------------------

describe('runIteration — idempotency', () => {
  it('повторный idempotencyKey → audit.repeat, БЕЗ второго отчёта', async () => {
    const trigger = triggerCronMorning(new Date('2026-05-03T07:00:00Z'));
    const fetchSupportMessages = vi.fn(async () => ({
      messagesFound: 0,
      messagesInserted: 0,
      messagesDeduplicated: 0,
      since: null,
      until: new Date(),
      chatIds: [],
      auditRecordId: ulid(),
    }));
    const sendCalls: MockSendCall[] = [];
    const sendReport = makeMockSendReport(sendCalls);

    // Первый прогон — empty, отправит «нечего разбирать».
    const first = await runIteration(trigger, {
      db: isolated.prisma,
      fetchSupportMessages,
      sendReport,
      rootDir: PROJECT_ROOT,
    });
    expect(first.outcome).toBe('empty');
    expect(sendCalls).toHaveLength(1);

    // Второй прогон с тем же idempotencyKey — audit.repeat, без отправки.
    const second = await runIteration(trigger, {
      db: isolated.prisma,
      fetchSupportMessages,
      sendReport,
      rootDir: PROJECT_ROOT,
    });
    expect(second.outcome).toBe('repeat');
    expect(second.repeatRecordId).toBeDefined();
    expect(second.triggerRecordId).toBe(first.triggerRecordId);
    expect(sendCalls).toHaveLength(1); // без второго отчёта

    // Никакого второго runIteration.start/step/end после repeat'а.
    const repeatEvents = vi
      .mocked(emit)
      .mock.calls.map((c) => c[0])
      .filter((e) => e.type === 'audit.repeat');
    expect(repeatEvents).toHaveLength(1);

    // event.trigger всё ещё ровно один (UNIQUE сработал).
    const triggers = await isolated.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "Record" WHERE type = 'event.trigger' AND idempotencyKey = ?`,
      trigger.idempotencyKey,
    );
    expect(triggers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Fail в середине — investigateMany бросает.
// ---------------------------------------------------------------------------

describe('runIteration — fail-fast на investigate', () => {
  it('audit.runIteration.failed + error-report в Telegram, БЕЗ обычного отчёта', async () => {
    await seedSupport(isolated.prisma, 3);
    const fetchSupportMessages = vi.fn(async () => ({
      messagesFound: 3,
      messagesInserted: 3,
      messagesDeduplicated: 0,
      since: null,
      until: new Date(),
      chatIds: ['test-chat'],
      auditRecordId: ulid(),
    }));
    const extractProblems = vi.fn(async () => ({
      problems: [{ summary: 'p1', symptoms: [], supportMessageIds: [] }],
      spendRecordId: ulid(),
      usd: 0.01,
      durationMs: 50,
    }));
    const newProblemId = ulid();
    await isolated.prisma.$executeRawUnsafe(
      `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt)
       VALUES (?, 'intent.problem', ?, 'agent', 'autonomous', 'active', ?)`,
      newProblemId,
      JSON.stringify({ summary: 'p1', symptoms: [] }),
      Date.now(),
    );
    const mergeProblems = vi.fn(async () => ({
      created: [{ problemId: newProblemId, summary: 'p1', supportMessageIds: [] }],
      merged: [],
      auditRecordId: ulid(),
      durationMs: 30,
    }));
    const investigateMany = vi.fn(async () => {
      throw new Error('mock investigate boom');
    });

    const sendCalls: MockSendCall[] = [];
    const sendReport = makeMockSendReport(sendCalls);

    const result = await runIteration(triggerManual(), {
      db: isolated.prisma,
      fetchSupportMessages,
      extractProblems,
      mergeProblems,
      investigateMany,
      sendReport,
      rootDir: PROJECT_ROOT,
    });

    expect(result.outcome).toBe('failed');
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.text).toMatch(/❌ runIteration упал на `investigate`/);

    // audit.runIteration.failed записан с stack и step='investigate'.
    const audit = await isolated.prisma.$queryRawUnsafe<Array<{ properties: string }>>(
      `SELECT properties FROM "Record" WHERE type = 'audit.runIteration.failed' AND parentId = ?`,
      result.triggerRecordId,
    );
    expect(audit).toHaveLength(1);
    const props = JSON.parse(audit[0]?.properties ?? '{}') as Record<string, unknown>;
    expect(props.step).toBe('investigate');
    expect(props.message).toBe('mock investigate boom');
    expect(props.errorClass).toBe('Error');

    // Никакого audit.report.sent.
    const reportSent = await isolated.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "Record" WHERE type = 'audit.report.sent' AND parentId = ?`,
      result.triggerRecordId,
    );
    expect(reportSent).toHaveLength(0);

    // status='failed' в end-event.
    const endEvent = vi
      .mocked(emit)
      .mock.calls.map((c) => c[0])
      .find((e) => e.type === 'runIteration.end') as
      | { type: 'runIteration.end'; status: string }
      | undefined;
    expect(endEvent?.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// 5. Длинное сообщение >4096 → обрезка + Page.
// ---------------------------------------------------------------------------

describe('runIteration — overflow 4096', () => {
  it('обрезка + Page journal/proposals/<ulid>.md создан с полным текстом', async () => {
    await seedSupport(isolated.prisma, 1);
    const fetchSupportMessages = vi.fn(async () => ({
      messagesFound: 1,
      messagesInserted: 1,
      messagesDeduplicated: 0,
      since: null,
      until: new Date(),
      chatIds: ['test-chat'],
      auditRecordId: ulid(),
    }));
    const extractProblems = vi.fn(async () => ({
      problems: [{ summary: 'big issue', symptoms: [], supportMessageIds: [] }],
      spendRecordId: ulid(),
      usd: 0.01,
      durationMs: 50,
    }));
    const problemId = ulid();
    await isolated.prisma.$executeRawUnsafe(
      `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt)
       VALUES (?, 'intent.problem', ?, 'agent', 'autonomous', 'active', ?)`,
      problemId,
      JSON.stringify({ summary: 'big issue', symptoms: [] }),
      Date.now(),
    );
    const mergeProblems = vi.fn(async () => ({
      created: [{ problemId, summary: 'big issue', supportMessageIds: [] }],
      merged: [],
      auditRecordId: ulid(),
      durationMs: 30,
    }));
    const diagnosisId = ulid();
    const investigateMany = vi.fn(async () => ({
      results: [
        {
          problemId,
          verdict: 'code' as const,
          rationale: 'r',
          codeRefs: [],
          gitHints: [],
          subagentId: ulid(),
          totalUsd: 0.05,
          totalTokens: 12_000,
          durationMs: 200,
          timedOut: false,
          spendRecordId: null,
        },
      ],
      failures: [],
      deferred: [],
      parentSession: 'investigate-test',
      totalUsd: 0.05,
      totalTokens: 12_000,
      durationMs: 200,
      auditRecordId: ulid(),
    }));
    const persistFanoutResult = vi.fn(async () => {
      await isolated.prisma.$executeRawUnsafe(
        `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt)
         VALUES (?, 'intent.diagnosis', ?, 'agent', 'autonomous', 'active', ?)`,
        diagnosisId,
        JSON.stringify({ verdict: 'code', rationale: 'r', codeRefs: [], gitHints: [] }),
        Date.now(),
      );
      return { diagnosesCreated: [diagnosisId], failuresAuditedAs: [], deferredAlreadyAudited: 0 };
    });
    const proposalId = ulid();
    // Огромный asIs/problem/asWillBe — итоговое сообщение сильно > 4096.
    const longText = 'X'.repeat(2_000);
    const runSolveBatch = vi.fn(async () => ({
      fanout: {
        results: [
          {
            diagnosisId,
            asIs: longText,
            problem: longText,
            asWillBe: longText,
            files: [{ path: 'src/big.ts', action: 'edit' as const }],
            estimateMinutes: 60,
            subagentId: ulid(),
            totalUsd: 0.1,
            totalTokens: 20_000,
            durationMs: 400,
            timedOut: false,
            spendRecordId: null,
          },
        ],
        failures: [],
        deferred: [],
        parentSession: 'solve-test',
        totalUsd: 0.1,
        totalTokens: 20_000,
        durationMs: 400,
        auditRecordId: ulid(),
      },
      persist: { proposalsCreated: [proposalId], failuresAuditedAs: [], deferredAlreadyAudited: 0 },
    }));

    const sendCalls: MockSendCall[] = [];
    const sendReport = makeMockSendReport(sendCalls);

    // Используем кастомный rootDir внутри tempdir, чтобы перехватить запись
    // overflow Page-файла без загрязнения проекта.
    const overflowRoot = `${isolated.filePath}-overflow-root`;
    mkdirSync(overflowRoot, { recursive: true });
    // Скопируем config + templates, чтобы buildReport нашёл их в rootDir.
    const configDir = join(overflowRoot, 'config');
    const tplDir = join(overflowRoot, 'src/report/templates');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(tplDir, { recursive: true });
    writeFileSync(
      join(configDir, 'report.md'),
      readFileSync(join(PROJECT_ROOT, 'config/report.md'), 'utf-8'),
      'utf-8',
    );
    for (const tpl of [
      'header.md',
      'empty.md',
      'code.md',
      'code-no-proposal.md',
      'human.md',
      'unclear.md',
      'failure.md',
      'error.md',
    ]) {
      writeFileSync(
        join(tplDir, tpl),
        readFileSync(join(PROJECT_ROOT, 'src/report/templates', tpl), 'utf-8'),
        'utf-8',
      );
    }

    const result = await runIteration(triggerManual(), {
      db: isolated.prisma,
      fetchSupportMessages,
      extractProblems,
      mergeProblems,
      investigateMany,
      persistFanoutResult,
      runSolveBatch,
      sendReport,
      rootDir: overflowRoot,
    });

    expect(result.outcome).toBe('ok');
    expect(sendCalls).toHaveLength(2); // header + 1 item

    const itemMsg = sendCalls[1];
    expect(itemMsg?.text.length).toBeLessThanOrEqual(4096);
    expect(itemMsg?.text).toMatch(/… ещё в `journal\/proposals\/[0-9A-HJKMNP-TV-Z]{26}\.md`/);

    // Page Record создан + файл лежит на диске с полным текстом.
    const pageRows = await isolated.prisma.$queryRawUnsafe<Array<{ path: string; type: string }>>(
      `SELECT path, type FROM "Page" WHERE path LIKE 'journal/proposals/%'`,
    );
    expect(pageRows).toHaveLength(1);
    const pagePath = pageRows[0]?.path ?? '';
    expect(pagePath).toMatch(/journal\/proposals\/[0-9A-HJKMNP-TV-Z]{26}\.md/);

    const pageContent = readFileSync(join(overflowRoot, pagePath), 'utf-8');
    expect(pageContent.length).toBeGreaterThan(4096);
    expect(pageContent).toContain(longText);
  });
});
