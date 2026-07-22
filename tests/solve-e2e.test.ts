// Тесты для фазы 2.4b (e2e: solveMany → persistSolveFanout, обёртка
// runSolveBatch + snapshot-тест на shape intent.proposal).
//
// Стратегия:
//   * Mock solveDiagnosis через DI (`solveDiagnosisImpl`) — реальный SDK не зовётся.
//   * vi.mock на src/observe/bridge.js, чтобы проверить эмит proposal.persisted.
//   * Prisma — shared dev.db, изоляция через уникальные ULID diagnosisId +
//     parentSession + proposalsCreated[].
//   * intent.diagnosis Records seed'им вручную (без исследователя), чтобы
//     RecordLink linkType='решает' указывала на существующие записи.
//   * Snapshot — критерий «сделано» из плана. Зафиксируем shape
//     intent.proposal.properties для 2.5.

import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSchemaInvariants } from '../src/db/invariants-check.js';
import type { SolveConfig } from '../src/solve/config.js';
import { solveMany } from '../src/solve/fanout.js';
import type { SolveFanoutResult } from '../src/solve/fanout.js';
import { runSolveBatch } from '../src/solve/index.js';
import { persistSolveFanout } from '../src/solve/persist.js';
import {
  type SolveResult,
  SolveTimeoutError,
  type solveDiagnosis as defaultSolveDiagnosis,
} from '../src/solve/run.js';

vi.mock('../src/observe/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/observe/bridge.js')>();
  return {
    ...actual,
    emit: vi.fn().mockResolvedValue(undefined),
  };
});

import { emit } from '../src/observe/bridge.js';

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
// Helpers.
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<SolveConfig> = {}): SolveConfig {
  return {
    targetProjectPath: '/dev/null',
    model: 'claude-sonnet-4-6',
    subagentType: 'Plan',
    timeoutMs: 5_000,
    maxTokens: 100_000,
    maxTurns: 20,
    promptId: 'solve:propose:test',
    bashWhitelist: ['cat'],
    concurrency: 3,
    maxProblemsPerCycle: 10,
    parentSessionPrefix: 'solve-e2e',
    asOf: 0,
    sourcePath: 'tests/solve-e2e.test.ts',
    ...overrides,
  };
}

function makeMockResult(overrides: Partial<SolveResult> = {}): SolveResult {
  return {
    asIs: 'как сейчас — тестовый абзац для решения.',
    problem: 'почему это проблема — тестовый абзац.',
    asWillBe: 'как будет после правки — тестовый абзац.',
    files: [{ path: 'src/test.ts', action: 'edit' }],
    estimateMinutes: 30,
    subagentId: ulid(),
    totalUsd: 0.02,
    totalTokens: 6_000,
    durationMs: 200,
    timedOut: false,
    spendRecordId: null,
    ...overrides,
  };
}

// Сидим intent.problem + intent.diagnosis с указанным verdict.
async function seedDiagnosisRecord(
  verdict: 'code' | 'human' | 'unclear' = 'code',
): Promise<{ diagnosisId: string; problemId: string }> {
  const now = Date.now();
  const problemId = ulid();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt)
     VALUES (?, 'intent.problem', ?, 'agent', 'autonomous', 'active', ?)`,
    problemId,
    JSON.stringify({ summary: `seeded problem ${problemId.slice(-6)}`, symptoms: [] }),
    now,
  );
  const diagnosisId = ulid();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt)
     VALUES (?, 'intent.diagnosis', ?, 'agent', 'autonomous', 'active', ?)`,
    diagnosisId,
    JSON.stringify({
      verdict,
      rationale: 'тестовое объяснение',
      codeRefs: [],
      gitHints: [],
      totalUsd: 0.05,
      totalTokens: 12_000,
      durationMs: 3_000,
      subagentId: ulid(),
      timedOut: false,
      spendRecordId: null,
    }),
    now,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "RecordLink" (id, fromRecordId, toRecordId, toPagePath, linkType, createdAt)
     VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM "RecordLink"), ?, ?, NULL, 'заключение', ?)`,
    diagnosisId,
    problemId,
    now,
  );
  return { diagnosisId, problemId };
}

interface ProposalRow {
  id: string;
  properties: Record<string, unknown>;
  status: string;
  closedAt: number | null;
}

async function loadProposal(id: string): Promise<ProposalRow | null> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ id: string; properties: string; status: string; closedAt: number | null }>
  >(
    `SELECT id, properties, status, closedAt FROM "Record"
      WHERE id = ? AND type = 'intent.proposal' LIMIT 1`,
    id,
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    properties: JSON.parse(row.properties) as Record<string, unknown>,
    status: row.status,
    closedAt: row.closedAt,
  };
}

interface RecordLinkRow {
  fromRecordId: string;
  toRecordId: string | null;
  toPagePath: string | null;
  linkType: string;
}

async function loadOutgoingLinks(fromRecordId: string): Promise<RecordLinkRow[]> {
  return prisma.$queryRawUnsafe<RecordLinkRow[]>(
    `SELECT fromRecordId, toRecordId, toPagePath, linkType FROM "RecordLink"
      WHERE fromRecordId = ?`,
    fromRecordId,
  );
}

interface FailureAuditRow {
  id: string;
  properties: Record<string, unknown>;
  status: string;
  closedAt: number | null;
}

async function loadFailureAudit(id: string): Promise<FailureAuditRow | null> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ id: string; properties: string; status: string; closedAt: number | null }>
  >(
    `SELECT id, properties, status, closedAt FROM "Record"
      WHERE id = ? AND type = 'audit.solve.failed' LIMIT 1`,
    id,
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    properties: JSON.parse(row.properties) as Record<string, unknown>,
    status: row.status,
    closedAt: row.closedAt,
  };
}

// Прямой 2.3c-запрос «диагнозы, ждущие решения». После создания intent.proposal
// со связью linkType='решает' этот запрос НЕ должен возвращать диагноз.
async function isAwaitingProposal(diagnosisId: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ verdict: string; status: string; resolvedCount: bigint | number }>
  >(
    `SELECT json_extract(d.properties, '$.verdict') AS verdict,
            d.status AS status,
            (SELECT COUNT(*) FROM "RecordLink" rl
              WHERE rl.toRecordId = d.id AND rl.linkType = 'решает') AS resolvedCount
       FROM "Record" d
      WHERE d.id = ? AND d.type = 'intent.diagnosis'
      LIMIT 1`,
    diagnosisId,
  );
  const row = rows[0];
  if (row === undefined) return false;
  const resolved =
    typeof row.resolvedCount === 'bigint' ? row.resolvedCount : BigInt(row.resolvedCount);
  return row.verdict === 'code' && row.status === 'active' && resolved === 0n;
}

// ---------------------------------------------------------------------------
// Тест 1 — 3 success → 3 intent.proposal + 3 RecordLink linkType='решает'.
// ---------------------------------------------------------------------------

describe('persistSolveFanout — 3 success → 3 intent.proposal со связью', () => {
  it('создаёт 3 intent.proposal + 3 RecordLink "решает", диагнозы выпадают из awaiting-фильтра', async () => {
    const seeded = [
      await seedDiagnosisRecord('code'),
      await seedDiagnosisRecord('code'),
      await seedDiagnosisRecord('code'),
    ];
    const ids = seeded.map((s) => s.diagnosisId);

    const fakeSolve: typeof defaultSolveDiagnosis = async (diagnosisId) => {
      return makeMockResult({
        asIs: `как сейчас в ${diagnosisId.slice(-6)} — есть проблема.`,
        problem: `почему это проблема ${diagnosisId.slice(-6)}.`,
        asWillBe: `как будет после правки ${diagnosisId.slice(-6)}.`,
        files: [{ path: `src/${diagnosisId.slice(-4)}.ts`, action: 'edit' }],
      });
    };

    const fanout = await solveMany(ids, {
      db: prisma,
      configOverride: makeConfig({ concurrency: 3 }),
      solveDiagnosisImpl: fakeSolve,
    });

    expect(fanout.results).toHaveLength(3);
    expect(fanout.failures).toHaveLength(0);
    expect(fanout.deferred).toHaveLength(0);

    // До persist — все 3 диагноза awaiting.
    for (const id of ids) {
      expect(await isAwaitingProposal(id)).toBe(true);
    }

    const persist = await persistSolveFanout(fanout, { db: prisma });

    expect(persist.proposalsCreated).toHaveLength(3);
    expect(persist.failuresAuditedAs).toHaveLength(0);
    expect(persist.deferredAlreadyAudited).toBe(0);

    // Проверяем каждый proposal.
    for (let i = 0; i < fanout.results.length; i++) {
      const result = fanout.results[i];
      const proposalId = persist.proposalsCreated[i];
      if (result === undefined || proposalId === undefined) throw new Error('index mismatch');

      const row = await loadProposal(proposalId);
      expect(row).not.toBeNull();
      if (row === null) continue;

      // Properties — критичен для 2.5 (отчёт читает asIs/problem/asWillBe/files).
      expect(row.properties.asIs).toBe(result.asIs);
      expect(row.properties.problem).toBe(result.problem);
      expect(row.properties.asWillBe).toBe(result.asWillBe);
      expect(row.properties.files).toEqual(result.files);
      expect(row.properties.estimateMinutes).toBe(result.estimateMinutes);
      expect(row.properties.totalUsd).toBe(result.totalUsd);
      expect(row.properties.totalTokens).toBe(result.totalTokens);
      expect(row.properties.durationMs).toBe(result.durationMs);
      expect(row.properties.subagentId).toBe(result.subagentId);
      expect(row.properties.spendRecordId).toBe(result.spendRecordId);
      expect(row.properties.parentSession).toBe(fanout.parentSession);

      // intent.proposal остаётся active до M3.1 (audit.{approval|rejection}).
      expect(row.status).toBe('active');
      expect(row.closedAt).toBeNull();

      // RecordLink linkType='решает' — единственная исходящая связь.
      const links = await loadOutgoingLinks(proposalId);
      expect(links).toHaveLength(1);
      expect(links[0]?.linkType).toBe('решает');
      expect(links[0]?.toRecordId).toBe(result.diagnosisId);
      expect(links[0]?.toPagePath).toBeNull();
    }

    // После persist — все 3 диагноза НЕ awaiting (стратегия (C) сработала).
    for (const id of ids) {
      expect(await isAwaitingProposal(id)).toBe(false);
    }

    // Bridge: эмитнут proposal.persisted с правильными счётчиками.
    const calls = vi.mocked(emit).mock.calls;
    const persisted = calls
      .map((c) => c[0])
      .filter((e) => e.type === 'proposal.persisted') as Array<{
      type: 'proposal.persisted';
      parentSession: string;
      batchSize: number;
      failuresAudited: number;
      deferredAlreadyAudited: number;
    }>;
    expect(persisted).toHaveLength(1);
    const event = persisted[0];
    expect(event?.parentSession).toBe(fanout.parentSession);
    expect(event?.batchSize).toBe(3);
    expect(event?.failuresAudited).toBe(0);
    expect(event?.deferredAlreadyAudited).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Тест 2 — 2 success + 1 failure (Timeout) → 2 intent.proposal + 1 audit.solve.failed.
// ---------------------------------------------------------------------------

describe('persistSolveFanout — 2 успеха + 1 failure', () => {
  it('создаёт 2 intent.proposal + 1 audit.solve.failed со связью linkType="ошибка-решения"', async () => {
    const okOne = await seedDiagnosisRecord('code');
    const fail = await seedDiagnosisRecord('code');
    const okTwo = await seedDiagnosisRecord('code');

    const fakeSolve: typeof defaultSolveDiagnosis = async (diagnosisId) => {
      if (diagnosisId === fail.diagnosisId) {
        throw new SolveTimeoutError(5_000);
      }
      return makeMockResult();
    };

    const fanout = await solveMany([okOne.diagnosisId, fail.diagnosisId, okTwo.diagnosisId], {
      db: prisma,
      // concurrency=1 для детерминированного порядка.
      configOverride: makeConfig({ concurrency: 1 }),
      solveDiagnosisImpl: fakeSolve,
    });

    expect(fanout.results).toHaveLength(2);
    expect(fanout.failures).toHaveLength(1);
    expect(fanout.deferred).toHaveLength(0);

    const persist = await persistSolveFanout(fanout, { db: prisma });

    expect(persist.proposalsCreated).toHaveLength(2);
    expect(persist.failuresAuditedAs).toHaveLength(1);
    expect(persist.deferredAlreadyAudited).toBe(0);

    // 2 proposal с правильными diagnosisId.
    for (let i = 0; i < fanout.results.length; i++) {
      const result = fanout.results[i];
      const proposalId = persist.proposalsCreated[i];
      if (result === undefined || proposalId === undefined) throw new Error('index mismatch');
      const links = await loadOutgoingLinks(proposalId);
      expect(links).toHaveLength(1);
      expect(links[0]?.linkType).toBe('решает');
      expect(links[0]?.toRecordId).toBe(result.diagnosisId);
    }

    // 1 audit.solve.failed → linkType='ошибка-решения' к fail.diagnosisId.
    const failureRecordId = persist.failuresAuditedAs[0];
    if (failureRecordId === undefined) throw new Error('failureRecordId undefined');
    const failureRow = await loadFailureAudit(failureRecordId);
    expect(failureRow).not.toBeNull();
    if (failureRow === null) return;

    expect(failureRow.properties.diagnosisId).toBe(fail.diagnosisId);
    expect(failureRow.properties.errorClass).toBe('SolveTimeoutError');
    expect(failureRow.properties.message).toMatch(/тайм-аут|5000/);
    expect(failureRow.properties.parentSession).toBe(fanout.parentSession);

    // audit.* immutable: status='closed', closedAt=createdAt.
    expect(failureRow.status).toBe('closed');
    expect(failureRow.closedAt).not.toBeNull();

    const failureLinks = await loadOutgoingLinks(failureRecordId);
    expect(failureLinks).toHaveLength(1);
    expect(failureLinks[0]?.linkType).toBe('ошибка-решения');
    expect(failureLinks[0]?.toRecordId).toBe(fail.diagnosisId);
    expect(failureLinks[0]?.toPagePath).toBeNull();

    // failed-диагноз остался awaiting (нет связи 'решает').
    expect(await isAwaitingProposal(fail.diagnosisId)).toBe(true);
    // 2 success — больше не awaiting.
    expect(await isAwaitingProposal(okOne.diagnosisId)).toBe(false);
    expect(await isAwaitingProposal(okTwo.diagnosisId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Тест 3 — 0 success + 2 deferred → ничего не пишется, deferredAlreadyAudited=2.
// ---------------------------------------------------------------------------

describe('persistSolveFanout — только deferred', () => {
  it('soft-cap-skip: 12 диагнозов при maxProblemsPerCycle=10 → 10 results + 2 deferred. Persist не дублирует audit.', async () => {
    const seeded: string[] = [];
    for (let i = 0; i < 12; i++) {
      const s = await seedDiagnosisRecord('code');
      seeded.push(s.diagnosisId);
    }

    const fakeSolve: typeof defaultSolveDiagnosis = async () => makeMockResult();

    const fanout = await solveMany(seeded, {
      db: prisma,
      configOverride: makeConfig({ concurrency: 3, maxProblemsPerCycle: 10 }),
      solveDiagnosisImpl: fakeSolve,
    });

    expect(fanout.results).toHaveLength(10);
    expect(fanout.deferred).toHaveLength(2);
    for (const d of fanout.deferred) {
      expect(d.reason).toBe('soft-cap-skip');
    }

    // Снимок числа audit.solve.failed ДО persist.
    const beforeFailedRows = await prisma.$queryRawUnsafe<Array<{ count: bigint | number }>>(
      `SELECT COUNT(*) AS count FROM "Record" WHERE type = 'audit.solve.failed'`,
    );
    const beforeFailed = Number(beforeFailedRows[0]?.count ?? 0);

    // Снимок числа intent.proposal ДО persist.
    const beforeProposalsRows = await prisma.$queryRawUnsafe<Array<{ count: bigint | number }>>(
      `SELECT COUNT(*) AS count FROM "Record" WHERE type = 'intent.proposal'`,
    );
    const beforeProposals = Number(beforeProposalsRows[0]?.count ?? 0);

    // «Голый» FanoutResult — только deferred, results=[]/failures=[].
    const onlyDeferred: SolveFanoutResult = {
      results: [],
      failures: [],
      deferred: fanout.deferred,
      parentSession: fanout.parentSession,
      totalUsd: 0,
      totalTokens: 0,
      durationMs: 0,
      auditRecordId: fanout.auditRecordId,
    };

    const persist = await persistSolveFanout(onlyDeferred, { db: prisma });

    expect(persist.proposalsCreated).toEqual([]);
    expect(persist.failuresAuditedAs).toEqual([]);
    expect(persist.deferredAlreadyAudited).toBe(2);

    // Никаких новых proposal/failed-Records.
    const afterProposalsRows = await prisma.$queryRawUnsafe<Array<{ count: bigint | number }>>(
      `SELECT COUNT(*) AS count FROM "Record" WHERE type = 'intent.proposal'`,
    );
    expect(Number(afterProposalsRows[0]?.count ?? 0)).toBe(beforeProposals);

    const afterFailedRows = await prisma.$queryRawUnsafe<Array<{ count: bigint | number }>>(
      `SELECT COUNT(*) AS count FROM "Record" WHERE type = 'audit.solve.failed'`,
    );
    expect(Number(afterFailedRows[0]?.count ?? 0)).toBe(beforeFailed);

    // Bridge: proposal.persisted с batchSize=0, failuresAudited=0,
    // deferredAlreadyAudited=2.
    const calls = vi.mocked(emit).mock.calls;
    const persisted = calls
      .map((c) => c[0])
      .filter((e) => e.type === 'proposal.persisted') as Array<{
      type: 'proposal.persisted';
      batchSize: number;
      failuresAudited: number;
      deferredAlreadyAudited: number;
    }>;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.batchSize).toBe(0);
    expect(persisted[0]?.failuresAudited).toBe(0);
    expect(persisted[0]?.deferredAlreadyAudited).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Тест 4 — runSolveBatch обёртка прокидывает результаты.
// ---------------------------------------------------------------------------

describe('runSolveBatch — высокоуровневая обёртка для 2.5', () => {
  it('runSolveBatch(ids) → { fanout, persist } с правильными счётчиками', async () => {
    const seeded = [await seedDiagnosisRecord('code'), await seedDiagnosisRecord('code')];
    const ids = seeded.map((s) => s.diagnosisId);

    const fakeSolve: typeof defaultSolveDiagnosis = async () => makeMockResult();

    const outcome = await runSolveBatch(ids, {
      fanoutDeps: {
        db: prisma,
        configOverride: makeConfig({ concurrency: 2 }),
        solveDiagnosisImpl: fakeSolve,
      },
      persistDeps: { db: prisma },
    });

    expect(outcome.fanout.results).toHaveLength(2);
    expect(outcome.persist.proposalsCreated).toHaveLength(2);

    // Snapshot пара эмитов: solve.batch.start/end + proposal.persisted.
    const calls = vi.mocked(emit).mock.calls;
    const types = calls.map((c) => c[0].type);
    expect(types).toEqual(['solve.batch.start', 'solve.batch.end', 'proposal.persisted']);
  });
});

// ---------------------------------------------------------------------------
// Тест 5 — snapshot-тест на shape intent.proposal.properties.
// Это критерий «сделано» из плана: «Snapshot-тест на shape».
// Контракт — для 2.5: отчёт парсит ровно эти поля.
// ---------------------------------------------------------------------------

describe('persistSolveFanout — snapshot shape intent.proposal.properties', () => {
  it('один SolveResult → один intent.proposal со зафиксированной структурой properties', async () => {
    const seeded = await seedDiagnosisRecord('code');

    const fixedSubagentId = '01HXY8GZ7ZSNAPSHOT0001';
    const fixedSpendId = '01HXY8GZ7ZSNAPSHOTSPEND01';

    const fakeSolve: typeof defaultSolveDiagnosis = async () => ({
      asIs: 'Сейчас в src/payment.ts:6 catch молча возвращает {ok:false}, и UI не видит причины.',
      problem:
        'Из-за этого клиент не понимает, почему оплата не прошла, и думает, что всё зависло.',
      asWillBe: 'В src/payment.ts:6 catch будет логировать ошибку и возвращать {ok:false, reason}.',
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
      subagentId: fixedSubagentId,
      totalUsd: 0.0234,
      totalTokens: 8_200,
      durationMs: 3_000,
      timedOut: false,
      spendRecordId: fixedSpendId,
    });

    const fanout = await solveMany([seeded.diagnosisId], {
      db: prisma,
      configOverride: makeConfig({ concurrency: 1, parentSessionPrefix: 'solve-snap' }),
      solveDiagnosisImpl: fakeSolve,
    });

    const persist = await persistSolveFanout(fanout, { db: prisma });
    expect(persist.proposalsCreated).toHaveLength(1);

    const proposalId = persist.proposalsCreated[0];
    if (proposalId === undefined) throw new Error('proposalId undefined');
    const row = await loadProposal(proposalId);
    expect(row).not.toBeNull();
    if (row === null) return;

    // Snapshot — точный shape для контракта 2.5. parentSession рандомный
    // (ULID), нормализуем перед сравнением; всё остальное зафиксировано.
    const props = row.properties as Record<string, unknown>;
    const normalized = { ...props };
    expect(typeof normalized.parentSession).toBe('string');
    expect(normalized.parentSession).toMatch(/^solve-snap-[0-9A-HJKMNP-TV-Z]{26}$/);
    normalized.parentSession = '<parentSession-ulid>';

    expect(normalized).toMatchInlineSnapshot(`
      {
        "asIs": "Сейчас в src/payment.ts:6 catch молча возвращает {ok:false}, и UI не видит причины.",
        "asWillBe": "В src/payment.ts:6 catch будет логировать ошибку и возвращать {ok:false, reason}.",
        "durationMs": 3000,
        "estimateMinutes": 30,
        "files": [
          {
            "action": "edit",
            "newSnippet": "catch (err) { logger.error(err); return { ok: false, reason: explain(err) } }",
            "oldSnippet": "catch { return { ok: false } }",
            "path": "src/payment.ts",
          },
        ],
        "parentSession": "<parentSession-ulid>",
        "problem": "Из-за этого клиент не понимает, почему оплата не прошла, и думает, что всё зависло.",
        "spendRecordId": "01HXY8GZ7ZSNAPSHOTSPEND01",
        "subagentId": "01HXY8GZ7ZSNAPSHOT0001",
        "totalTokens": 8200,
        "totalUsd": 0.0234,
      }
    `);

    // Дополнительно — sanity на статус/связь.
    expect(row.status).toBe('active');
    expect(row.closedAt).toBeNull();
    const links = await loadOutgoingLinks(proposalId);
    expect(links).toHaveLength(1);
    expect(links[0]?.linkType).toBe('решает');
    expect(links[0]?.toRecordId).toBe(seeded.diagnosisId);
  });
});
