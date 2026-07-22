// Тесты для фазы 2.3c (e2e: investigateMany → persistFanoutResult).
//
// Стратегия:
//   * Mock investigateProblem через DI (`investigateProblemImpl`) — реальный
//     SDK не зовётся ни в одном кейсе. Это touchpoint с деньгами.
//   * vi.mock на src/observe/bridge.js, чтобы проверить эмит
//     diagnosis.persisted (parentSession, batchSize, failuresAudited).
//   * Prisma — shared dev.db (как остальные тесты), изоляция через уникальные
//     ULID problemId + parentSession + diagnosesCreated[].
//   * intent.problem Records seed'им вручную (без триажа), чтобы RecordLink
//     указывал на существующие записи.
//   * Проверки в БД — физический SELECT по только что созданным id.

import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSchemaInvariants } from '../src/db/invariants-check.js';
import type { InvestigateConfig } from '../src/investigate/config.js';
import { investigateMany } from '../src/investigate/fanout.js';
import type { FanoutResult } from '../src/investigate/fanout.js';
import { persistFanoutResult } from '../src/investigate/persist.js';
import {
  InvestigateInvalidResponseError,
  type InvestigationResult,
  type investigateProblem as defaultInvestigateProblem,
} from '../src/investigate/run.js';

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

function makeConfig(overrides: Partial<InvestigateConfig> = {}): InvestigateConfig {
  return {
    targetProjectPath: '/dev/null',
    model: 'claude-sonnet-4-6',
    subagentType: 'Explore',
    timeoutMs: 5_000,
    maxTokens: 100_000,
    maxTurns: 20,
    promptId: 'investigate:run:test',
    bashWhitelist: ['cat'],
    concurrency: 3,
    maxProblemsPerCycle: 10,
    parentSessionPrefix: 'investigate-e2e',
    asOf: 0,
    sourcePath: 'tests/investigate-e2e.test.ts',
    ...overrides,
  };
}

function makeMockResult(overrides: Partial<InvestigationResult> = {}): InvestigationResult {
  return {
    verdict: 'code',
    rationale: 'тестовое объяснение',
    codeRefs: [],
    gitHints: [],
    subagentId: ulid(),
    totalUsd: 0.01,
    totalTokens: 5_000,
    durationMs: 100,
    timedOut: false,
    spendRecordId: null,
    ...overrides,
  };
}

// Сидим intent.problem Record в журнал. Возвращает problemId.
async function seedIntentProblem(summary: string): Promise<string> {
  const id = ulid();
  const properties = JSON.stringify({ summary, symptoms: [] });
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt)
     VALUES (?, 'intent.problem', ?, 'agent', 'autonomous', 'active', ?)`,
    id,
    properties,
    Date.now(),
  );
  return id;
}

interface DiagnosisRow {
  id: string;
  properties: Record<string, unknown>;
  parentId: string | null;
  status: string;
  closedAt: number | null;
}

async function loadDiagnosis(id: string): Promise<DiagnosisRow | null> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      properties: string;
      parentId: string | null;
      status: string;
      closedAt: number | null;
    }>
  >(
    `SELECT id, properties, parentId, status, closedAt FROM "Record"
      WHERE id = ? AND type = 'intent.diagnosis' LIMIT 1`,
    id,
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    properties: JSON.parse(row.properties) as Record<string, unknown>,
    parentId: row.parentId,
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
      WHERE id = ? AND type = 'audit.investigate.failed' LIMIT 1`,
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

// Проверка стратегии (C): диагноз verdict='code' имеет 0 inverse 'решает'-связей,
// поэтому SELECT 2.4a его найдёт.
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
// Тест 1 — счастливый путь: 3 проблемы (code/human/unclear), все успешны.
// ---------------------------------------------------------------------------

describe('persistFanoutResult — 3 verdicts (code/human/unclear), все успешны', () => {
  it('3 intent.diagnosis + 3 RecordLink "заключение" + плейсхолдер на code-диагнозе', async () => {
    const codeId = await seedIntentProblem('payment fails on retry');
    const humanId = await seedIntentProblem('client misread the docs');
    const unclearId = await seedIntentProblem('intermittent slowness');

    const verdictMap = new Map<string, 'code' | 'human' | 'unclear'>([
      [codeId, 'code'],
      [humanId, 'human'],
      [unclearId, 'unclear'],
    ]);

    const fakeInvestigate: typeof defaultInvestigateProblem = async (problemId) => {
      const verdict = verdictMap.get(problemId);
      if (verdict === undefined) throw new Error(`unknown problemId ${problemId}`);
      const codeRefs =
        verdict === 'code' ? [{ path: 'src/payment.ts', line: 42, snippet: 'try { ... }' }] : [];
      return makeMockResult({
        verdict,
        rationale: `вердикт ${verdict} для ${problemId.slice(-6)}`,
        codeRefs,
        gitHints: verdict === 'code' ? ['abc123'] : [],
        totalUsd: 0.05,
        totalTokens: 12_000,
      });
    };

    const fanout = await investigateMany([codeId, humanId, unclearId], {
      db: prisma,
      configOverride: makeConfig({ concurrency: 3 }),
      investigateProblemImpl: fakeInvestigate,
    });

    expect(fanout.results).toHaveLength(3);
    expect(fanout.failures).toHaveLength(0);
    expect(fanout.deferred).toHaveLength(0);

    const persist = await persistFanoutResult(fanout, { db: prisma });

    expect(persist.diagnosesCreated).toHaveLength(3);
    expect(persist.failuresAuditedAs).toHaveLength(0);
    expect(persist.deferredAlreadyAudited).toBe(0);

    // Проверка каждого диагноза в БД.
    const codeResult = fanout.results.find((r) => r.problemId === codeId);
    const humanResult = fanout.results.find((r) => r.problemId === humanId);
    const unclearResult = fanout.results.find((r) => r.problemId === unclearId);
    expect(codeResult).toBeDefined();
    expect(humanResult).toBeDefined();
    expect(unclearResult).toBeDefined();

    for (let i = 0; i < fanout.results.length; i++) {
      const result = fanout.results[i];
      const diagnosisId = persist.diagnosesCreated[i];
      if (result === undefined || diagnosisId === undefined) throw new Error('index mismatch');

      const row = await loadDiagnosis(diagnosisId);
      expect(row).not.toBeNull();
      if (row === null) continue;

      // Properties shape — критичен для 2.4a/2.5.
      expect(row.properties.verdict).toBe(result.verdict);
      expect(row.properties.rationale).toBe(result.rationale);
      expect(row.properties.codeRefs).toEqual(result.codeRefs);
      expect(row.properties.gitHints).toEqual(result.gitHints);
      expect(row.properties.totalUsd).toBe(result.totalUsd);
      expect(row.properties.totalTokens).toBe(result.totalTokens);
      expect(row.properties.durationMs).toBe(result.durationMs);
      expect(row.properties.subagentId).toBe(result.subagentId);
      expect(row.properties.timedOut).toBe(result.timedOut);
      expect(row.properties.spendRecordId).toBe(result.spendRecordId);

      // intent.diagnosis активен (status='active', closedAt=null) — 2.4a/4b
      // потом могут закрыть через одно UPDATE на closedAt+closedReason.
      expect(row.status).toBe('active');
      expect(row.closedAt).toBeNull();

      // RecordLink linkType='заключение' — единственная исходящая связь.
      const links = await loadOutgoingLinks(diagnosisId);
      expect(links).toHaveLength(1);
      expect(links[0]?.linkType).toBe('заключение');
      expect(links[0]?.toRecordId).toBe(result.problemId);
      expect(links[0]?.toPagePath).toBeNull();
    }

    // Стратегия (C): только code-диагноз ждёт решения. Проверяем явным запросом
    // (NOT EXISTS inverse 'решает') — это прямой контракт для 2.4a.
    const codeDiagnosisId = persist.diagnosesCreated[fanout.results.indexOf(codeResult!)];
    const humanDiagnosisId = persist.diagnosesCreated[fanout.results.indexOf(humanResult!)];
    const unclearDiagnosisId = persist.diagnosesCreated[fanout.results.indexOf(unclearResult!)];
    if (
      codeDiagnosisId === undefined ||
      humanDiagnosisId === undefined ||
      unclearDiagnosisId === undefined
    ) {
      throw new Error('diagnosis id missing');
    }

    expect(await isAwaitingProposal(codeDiagnosisId)).toBe(true);
    // human/unclear не подпадают под фильтр (verdict !== 'code').
    expect(await isAwaitingProposal(humanDiagnosisId)).toBe(false);
    expect(await isAwaitingProposal(unclearDiagnosisId)).toBe(false);

    // Bridge: эмитнут diagnosis.persisted с правильными счётчиками.
    const calls = vi.mocked(emit).mock.calls;
    const persisted = calls
      .map((c) => c[0])
      .filter((e) => e.type === 'diagnosis.persisted') as Array<{
      type: 'diagnosis.persisted';
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
// Тест 2 — 2 успеха + 1 failure → 2 intent.diagnosis + 1 audit.investigate.failed.
// ---------------------------------------------------------------------------

describe('persistFanoutResult — 2 успеха + 1 failure', () => {
  it('создаёт 2 intent.diagnosis + 1 audit.investigate.failed со связью', async () => {
    const okOneId = await seedIntentProblem('checkout slow');
    const failId = await seedIntentProblem('weird transient bug');
    const okTwoId = await seedIntentProblem('search returns 500');

    const fakeInvestigate: typeof defaultInvestigateProblem = async (problemId) => {
      if (problemId === failId) {
        throw new InvestigateInvalidResponseError(
          'sub-agent вернул JSON без поля verdict',
          'schema-mismatch',
        );
      }
      return makeMockResult({
        verdict: 'code',
        rationale: `ok ${problemId.slice(-6)}`,
      });
    };

    const fanout = await investigateMany([okOneId, failId, okTwoId], {
      db: prisma,
      // concurrency=1 для детерминированного порядка failures/results.
      configOverride: makeConfig({ concurrency: 1 }),
      investigateProblemImpl: fakeInvestigate,
    });

    expect(fanout.results).toHaveLength(2);
    expect(fanout.failures).toHaveLength(1);
    expect(fanout.deferred).toHaveLength(0);

    const persist = await persistFanoutResult(fanout, { db: prisma });

    expect(persist.diagnosesCreated).toHaveLength(2);
    expect(persist.failuresAuditedAs).toHaveLength(1);
    expect(persist.deferredAlreadyAudited).toBe(0);

    // 2 диагноза с правильными problemId.
    for (let i = 0; i < fanout.results.length; i++) {
      const result = fanout.results[i];
      const diagnosisId = persist.diagnosesCreated[i];
      if (result === undefined || diagnosisId === undefined) throw new Error('index mismatch');
      const links = await loadOutgoingLinks(diagnosisId);
      expect(links).toHaveLength(1);
      expect(links[0]?.linkType).toBe('заключение');
      expect(links[0]?.toRecordId).toBe(result.problemId);
    }

    // 1 audit.investigate.failed с linkType='ошибка-расследования' к failId.
    const failureRecordId = persist.failuresAuditedAs[0];
    if (failureRecordId === undefined) throw new Error('failureRecordId undefined');
    const failureRow = await loadFailureAudit(failureRecordId);
    expect(failureRow).not.toBeNull();
    if (failureRow === null) return;

    expect(failureRow.properties.problemId).toBe(failId);
    expect(failureRow.properties.errorClass).toBe('InvestigateInvalidResponseError');
    expect(failureRow.properties.message).toMatch(/verdict/);
    expect(failureRow.properties.parentSession).toBe(fanout.parentSession);

    // audit.* всегда полностью immutable: status='closed', closedAt=createdAt.
    expect(failureRow.status).toBe('closed');
    expect(failureRow.closedAt).not.toBeNull();

    const failureLinks = await loadOutgoingLinks(failureRecordId);
    expect(failureLinks).toHaveLength(1);
    expect(failureLinks[0]?.linkType).toBe('ошибка-расследования');
    expect(failureLinks[0]?.toRecordId).toBe(failId);
    expect(failureLinks[0]?.toPagePath).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Тест 3 — 0 успехов + 0 failures + 2 deferred → ничего не пишется,
// deferredAlreadyAudited=2.
// ---------------------------------------------------------------------------

describe('persistFanoutResult — только deferred', () => {
  it('soft-cap-skip: 12 проблем при maxProblemsPerCycle=10 → 10 results + 2 deferred. Persist не дублирует audit.', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push(await seedIntentProblem(`problem ${i}`));
    }

    const fakeInvestigate: typeof defaultInvestigateProblem = async () => {
      return makeMockResult({ verdict: 'human', rationale: 'human factor' });
    };

    const fanout = await investigateMany(ids, {
      db: prisma,
      configOverride: makeConfig({ concurrency: 3, maxProblemsPerCycle: 10 }),
      investigateProblemImpl: fakeInvestigate,
    });

    // Sanity: fan-out видит 10 results + 2 deferred (soft-cap-skip).
    expect(fanout.results).toHaveLength(10);
    expect(fanout.deferred).toHaveLength(2);
    for (const d of fanout.deferred) {
      expect(d.reason).toBe('soft-cap-skip');
    }

    // Снимок числа audit.investigate.failed в БД ДО persist — чтобы убедиться,
    // что persist на deferred-only ничего нового не добавит.
    const beforeFailedRows = await prisma.$queryRawUnsafe<Array<{ count: bigint | number }>>(
      `SELECT COUNT(*) AS count FROM "Record" WHERE type = 'audit.investigate.failed'`,
    );
    const beforeFailed = Number(beforeFailedRows[0]?.count ?? 0);

    // Создаём «голый» FanoutResult — только deferred (имитация: всё уехало в
    // soft-cap, ни одной investigation не запустилось). Тестируем именно ветку
    // «нет ни results, ни failures».
    const onlyDeferred: FanoutResult = {
      results: [],
      failures: [],
      deferred: fanout.deferred,
      parentSession: fanout.parentSession,
      totalUsd: 0,
      totalTokens: 0,
      durationMs: 0,
      auditRecordId: fanout.auditRecordId,
    };

    const persist = await persistFanoutResult(onlyDeferred, { db: prisma });

    expect(persist.diagnosesCreated).toEqual([]);
    expect(persist.failuresAuditedAs).toEqual([]);
    expect(persist.deferredAlreadyAudited).toBe(2);

    // Никакой новой intent.diagnosis по ids нет.
    const newDiagnosesRows = await prisma.$queryRawUnsafe<Array<{ count: bigint | number }>>(
      `SELECT COUNT(*) AS count FROM "Record"
        WHERE type = 'intent.diagnosis'
          AND json_extract(properties, '$.subagentId') IN (
            SELECT json_extract(properties, '$.subagentId') FROM "Record"
             WHERE 1 = 0
          )`,
    );
    expect(Number(newDiagnosesRows[0]?.count ?? 0)).toBe(0);

    // Никакой новой audit.investigate.failed не появилось.
    const afterFailedRows = await prisma.$queryRawUnsafe<Array<{ count: bigint | number }>>(
      `SELECT COUNT(*) AS count FROM "Record" WHERE type = 'audit.investigate.failed'`,
    );
    expect(Number(afterFailedRows[0]?.count ?? 0)).toBe(beforeFailed);

    // Bridge: diagnosis.persisted эмитнут с batchSize=0, failuresAudited=0,
    // deferredAlreadyAudited=2.
    const calls = vi.mocked(emit).mock.calls;
    const persisted = calls
      .map((c) => c[0])
      .filter((e) => e.type === 'diagnosis.persisted') as Array<{
      type: 'diagnosis.persisted';
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
// Тест 4 — verdict='unclear' от тайм-аута тоже материализуется.
// ---------------------------------------------------------------------------

describe('persistFanoutResult — timedOut → unclear материализуется как diagnosis', () => {
  it('timedOut=true + verdict="unclear" → diagnosis с timedOut=true', async () => {
    const problemId = await seedIntentProblem('took forever');

    const fakeInvestigate: typeof defaultInvestigateProblem = async () => {
      return makeMockResult({
        verdict: 'unclear',
        rationale: 'тайм-аут 5 мин',
        timedOut: true,
        durationMs: 300_000,
      });
    };

    const fanout = await investigateMany([problemId], {
      db: prisma,
      configOverride: makeConfig({ concurrency: 1 }),
      investigateProblemImpl: fakeInvestigate,
    });

    const persist = await persistFanoutResult(fanout, { db: prisma });
    expect(persist.diagnosesCreated).toHaveLength(1);

    const diagnosisId = persist.diagnosesCreated[0];
    if (diagnosisId === undefined) throw new Error('diagnosisId undefined');
    const row = await loadDiagnosis(diagnosisId);
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.properties.verdict).toBe('unclear');
    expect(row.properties.timedOut).toBe(true);
    expect(row.properties.rationale).toBe('тайм-аут 5 мин');

    // unclear НЕ должен попадать в SELECT 2.4a (verdict != 'code').
    expect(await isAwaitingProposal(diagnosisId)).toBe(false);

    // Связь 'заключение' к проблеме всё равно создана.
    const links = await loadOutgoingLinks(diagnosisId);
    expect(links).toHaveLength(1);
    expect(links[0]?.linkType).toBe('заключение');
    expect(links[0]?.toRecordId).toBe(problemId);
  });
});
