// Тесты для фазы 2.2b (семантический мердж проблем триажа).
//
// Стратегия мокинга:
//   * Embeddings — детерминированный мок по строке (нет загрузки модели,
//     никакой сети). Одинаковые строки → одинаковые векторы → cosine
//     distance = 0 → MERGE. Разные строки → почти ортогональные
//     векторы → MERGE не срабатывает → CREATE.
//   * Vec DB — in-memory better-sqlite3 на каждый тест. Не пересекается
//     с другими тестами.
//   * Prisma — isolated-db (template.db + cp на каждый тест, фаза 3.5).
//     Раньше: shared dev.db с RUN_ID-префиксом; это порождало race condition,
//     когда mergeProblems находил intent.problem из других тестов в 7-дневном
//     окне поиска → флейк «expected 1 but got 2» / «expected 2 but got 1».

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initVecSchema } from '../scripts/init-vec.js';
import type { VecDatabase } from '../src/db/client.js';
import type { EmbeddingsConfig } from '../src/embeddings/config.js';
import type { EmbeddingsClient } from '../src/embeddings/local.js';
import type { TriageResult } from '../src/triage/extract.js';
import { mergeProblems } from '../src/triage/merge.js';
import {
  type IsolatedDb,
  type TemplateHandle,
  createIsolatedDb,
  setupTemplateDb,
} from './fixtures/isolated-db.js';

// RUN_ID — только для vecTable-имени. Prisma теперь через isolated-db.
const RUN_ID = ulid().slice(0, 8);

const TEST_CONFIG: EmbeddingsConfig = {
  provider: 'xenova-local',
  model: 'test-mock-embedder',
  // 64-dim (не прод-значение): с независимыми компонентами cosine между
  // разными строками имеет std ≈ 1/√dim ≈ 0.125, порог 0.85 недостижим →
  // ноль флейка. См. makeMockEmbeddings.
  dim: 64,
  mergeThreshold: 0.85,
  mergeWindowDays: 7,
  vecTable: `vec_test_${RUN_ID}`,
  asOf: 0,
  sourcePath: 'tests/triage-merge.test.ts',
};

let template: TemplateHandle;
let isolated: IsolatedDb;

beforeAll(() => {
  template = setupTemplateDb();
});

afterAll(() => {
  template.dispose();
});

beforeEach(async () => {
  isolated = await createIsolatedDb(template);
});

afterEach(async () => {
  await isolated.dispose();
});

// Вспомогательный геттер — код тестов обращается к prisma через getter, а не
// через module-level var, чтобы всегда взять свежий isolated.prisma.
function db() {
  return isolated.prisma;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function makeFreshVec(): VecDatabase {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  initVecSchema(db, TEST_CONFIG.vecTable, TEST_CONFIG.dim);
  return db;
}

// Детерминированный embedder. Одинаковая строка → одинаковый вектор (cosine 1.0
// → MERGE). Разные строки → почти ортогональные векторы (cosine ≈ 0 → CREATE).
//
// ВАЖНО: каждое из dim измерений генерируется НЕЗАВИСИМОЙ splitmix32-мешалкой
// (base-hash смешивается с индексом измерения). Раньше все измерения шли из
// одного скаляра h через sin/cos арифметической прогрессии — это давало
// эффективно ~1 степень свободы, и разные строки регулярно пересекали порог
// mergeThreshold (0.85), что флейкало «expected 1 merged, got 2» (summary
// содержат случайный RUN_ID → коллизии выпадали от прогона к прогону). 16
// независимых компонент дают cosine между разными строками с std ≈ 1/√dim,
// который порога 0.85 практически не достигает.
function makeMockEmbeddings(): EmbeddingsClient {
  return {
    async embedText(text: string): Promise<Float32Array> {
      const v = new Float32Array(TEST_CONFIG.dim);
      let base = 2166136261 >>> 0; // FNV-1a базовый seed по всей строке
      for (let i = 0; i < text.length; i++) {
        base ^= text.charCodeAt(i);
        base = Math.imul(base, 16777619) >>> 0;
      }
      for (let i = 0; i < TEST_CONFIG.dim; i++) {
        // splitmix32: декоррелированная компонента на каждое измерение.
        let z = (base + Math.imul(i + 1, 0x9e3779b9)) >>> 0;
        z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
        z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
        z = (z ^ (z >>> 15)) >>> 0;
        v[i] = z / 0xffffffff - 0.5; // ~uniform[-0.5, 0.5], независимо по dim
      }
      // L2-normalize
      let norm = 0;
      for (let i = 0; i < TEST_CONFIG.dim; i++) norm += (v[i] ?? 0) * (v[i] ?? 0);
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < TEST_CONFIG.dim; i++) v[i] = (v[i] ?? 0) / norm;
      }
      return v;
    },
    async dim(): Promise<number> {
      return TEST_CONFIG.dim;
    },
  };
}

async function insertSupportMessage(id: string): Promise<void> {
  const now = Date.now();
  const properties = JSON.stringify({
    chatId: `merge-${RUN_ID}`,
    messageId: Math.floor(Math.random() * 1_000_000_000),
    userId: '1001',
    username: `user-${RUN_ID}`,
    text: 'тестовое сообщение',
    attachments: [],
    timestamp: now,
  });
  await db().$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt, idempotencyKey)
     VALUES (?, 'event.support.message', ?, 'external', 'autonomous', 'active', ?, ?)`,
    id,
    properties,
    now,
    `merge-test:${RUN_ID}:${id}`,
  );
}

// audit.spend — нужен для FK audit.triage.merge.parentId.
async function insertFakeSpend(spendId: string): Promise<void> {
  const now = Date.now();
  const properties = JSON.stringify({
    promptId: 'triage:extract',
    model: 'claude-sonnet-4-6',
    modelRequested: 'claude-sonnet-4-6',
    inputTokens: 1500,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheCreationTokens: 1200,
    usd: 0.005,
    pricingAsOf: now,
  });
  await db().$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.spend', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    spendId,
    properties,
    now,
    now,
  );
}

interface SeedProblemArgs {
  vec: VecDatabase;
  embeddings: EmbeddingsClient;
  summary: string;
  symptoms: string[];
  ageMs?: number;
}

async function seedExistingProblem(args: SeedProblemArgs): Promise<string> {
  const problemId = ulid();
  const createdAt = Date.now() - (args.ageMs ?? 0);
  const properties = JSON.stringify({
    summary: args.summary,
    symptoms: args.symptoms,
  });
  await db().$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, createdAt)
     VALUES (?, 'intent.problem', ?, 'agent', 'autonomous', 'active', ?)`,
    problemId,
    properties,
    createdAt,
  );
  const vector = await args.embeddings.embedText(args.summary);
  await db().$executeRawUnsafe(
    `INSERT INTO "Embedding" (recordId, model, vector, createdAt) VALUES (?, ?, ?, ?)`,
    problemId,
    TEST_CONFIG.model,
    Buffer.from(vector.buffer),
    createdAt,
  );
  // Имитируем то, что делает createIntentProblem: запись в map-table + INSERT в vec.
  args.vec.exec(
    'CREATE TABLE IF NOT EXISTS IntentProblemVec (recordId TEXT PRIMARY KEY, rowid INTEGER UNIQUE NOT NULL)',
  );
  args.vec
    .prepare(
      'INSERT INTO IntentProblemVec (recordId, rowid) VALUES (?, (SELECT COALESCE(MAX(rowid), 0) + 1 FROM IntentProblemVec))',
    )
    .run(problemId);
  const row = args.vec
    .prepare('SELECT rowid FROM IntentProblemVec WHERE recordId = ?')
    .get(problemId) as { rowid: number | bigint };
  args.vec
    .prepare(`INSERT INTO ${TEST_CONFIG.vecTable}(rowid, embedding) VALUES (?, ?)`)
    .run(BigInt(row.rowid), Buffer.from(vector.buffer));
  return problemId;
}

function buildTriage(problems: TriageResult['problems'], spendRecordId: string): TriageResult {
  return {
    problems,
    spendRecordId,
    usd: 0.005,
    durationMs: 100,
  };
}

async function countLinks(fromId: string, toId: string): Promise<number> {
  const rows = await db().$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n FROM "RecordLink"
      WHERE fromRecordId = ? AND toRecordId = ? AND linkType = 'породило'`,
    fromId,
    toId,
  );
  return Number(rows[0]?.n ?? 0n);
}

async function countAuditMerge(parentSpendId: string): Promise<number> {
  const rows = await db().$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n FROM "Record"
      WHERE type = 'audit.triage.merge' AND parentId = ?`,
    parentSpendId,
  );
  return Number(rows[0]?.n ?? 0n);
}

// ---------------------------------------------------------------------------
// Кейсы.
// ---------------------------------------------------------------------------

let vec: VecDatabase;
let embeddings: EmbeddingsClient;

beforeEach(() => {
  vec = makeFreshVec();
  embeddings = makeMockEmbeddings();
});

describe('mergeProblems', () => {
  it('новые проблемы (нет похожих) → CREATE для каждой, intent.problem + Embedding + RecordLink в БД', async () => {
    const supportA = `${RUN_ID}-support-${ulid()}`;
    const supportB = `${RUN_ID}-support-${ulid()}`;
    await insertSupportMessage(supportA);
    await insertSupportMessage(supportB);
    const spendId = `spend-${RUN_ID}-${ulid()}`;
    await insertFakeSpend(spendId);

    const triage = buildTriage(
      [
        {
          summary: `${RUN_ID} проблема оплаты A`,
          symptoms: ['не проходит карта'],
          supportMessageIds: [supportA],
        },
        {
          summary: `${RUN_ID} проблема логина B`,
          symptoms: ['не приходит код'],
          supportMessageIds: [supportB],
        },
      ],
      spendId,
    );

    const result = await mergeProblems(triage, {
      prisma: db(),
      vec,
      embeddings,
      configOverride: TEST_CONFIG,
    });

    expect(result.created).toHaveLength(2);
    expect(result.merged).toHaveLength(0);

    const first = result.created[0]!;
    const second = result.created[1]!;
    expect(first.summary).toBe(`${RUN_ID} проблема оплаты A`);
    expect(second.summary).toBe(`${RUN_ID} проблема логина B`);
    expect(first.supportMessageIds).toEqual([supportA]);
    expect(second.supportMessageIds).toEqual([supportB]);

    // Embedding записан 1:1 c Record.
    const embRows = await db().$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) AS n FROM "Embedding" WHERE recordId IN (?, ?)`,
      first.problemId,
      second.problemId,
    );
    expect(Number(embRows[0]?.n ?? 0n)).toBe(2);

    expect(await countLinks(supportA, first.problemId)).toBe(1);
    expect(await countLinks(supportB, second.problemId)).toBe(1);
    expect(await countAuditMerge(spendId)).toBe(1);
  });

  it('дубль (similarity ≥ threshold) → MERGE, 0 новых intent.problem, +1 RecordLink', async () => {
    const sharedSummary = `${RUN_ID} проблема дубликат`;
    const existingProblemId = await seedExistingProblem({
      vec,
      embeddings,
      summary: sharedSummary,
      symptoms: ['старый симптом'],
    });

    const newSupport = `${RUN_ID}-support-${ulid()}`;
    await insertSupportMessage(newSupport);
    const spendId = `spend-${RUN_ID}-${ulid()}`;
    await insertFakeSpend(spendId);

    const triage = buildTriage(
      [
        {
          summary: sharedSummary,
          symptoms: ['новый симптом'],
          supportMessageIds: [newSupport],
        },
      ],
      spendId,
    );

    const result = await mergeProblems(triage, {
      prisma: db(),
      vec,
      embeddings,
      configOverride: TEST_CONFIG,
    });

    expect(result.created).toHaveLength(0);
    expect(result.merged).toHaveLength(1);
    const merged0 = result.merged[0]!;
    expect(merged0.existingProblemId).toBe(existingProblemId);
    expect(merged0.newSupportMessageIds).toEqual([newSupport]);
    expect(merged0.distance).toBeLessThanOrEqual(1 - TEST_CONFIG.mergeThreshold);

    expect(await countLinks(newSupport, existingProblemId)).toBe(1);

    // Запустим merge ещё раз с тем же сообщением — должно быть 0 новых links
    // (UNIQUE conflict ловится и превращает в noop).
    const secondRun = await mergeProblems(
      buildTriage(
        [
          {
            summary: sharedSummary,
            symptoms: ['новый симптом'],
            supportMessageIds: [newSupport],
          },
        ],
        spendId,
      ),
      { prisma: db(), vec, embeddings, configOverride: TEST_CONFIG },
    );
    expect(secondRun.created).toHaveLength(0);
    expect(secondRun.merged).toHaveLength(1);
    expect(secondRun.merged[0]!.newSupportMessageIds).toEqual([]);
    expect(await countLinks(newSupport, existingProblemId)).toBe(1); // всё ещё 1
  });

  it('частичное пересечение: 1 дубль + 2 новых → 2 created, 1 merged', async () => {
    const sharedSummary = `${RUN_ID} проблема смешанная`;
    const existingProblemId = await seedExistingProblem({
      vec,
      embeddings,
      summary: sharedSummary,
      symptoms: ['ранее замечено'],
    });

    const supportShared = `${RUN_ID}-support-${ulid()}`;
    const supportNew1 = `${RUN_ID}-support-${ulid()}`;
    const supportNew2 = `${RUN_ID}-support-${ulid()}`;
    await insertSupportMessage(supportShared);
    await insertSupportMessage(supportNew1);
    await insertSupportMessage(supportNew2);
    const spendId = `spend-${RUN_ID}-${ulid()}`;
    await insertFakeSpend(spendId);

    const triage = buildTriage(
      [
        {
          summary: sharedSummary,
          symptoms: ['та же проблема'],
          supportMessageIds: [supportShared],
        },
        {
          summary: `${RUN_ID} проблема ABSOLUTELY DIFFERENT one`,
          symptoms: ['новые симптомы'],
          supportMessageIds: [supportNew1],
        },
        {
          summary: `${RUN_ID} проблема SOMETHING UNRELATED entirely`,
          symptoms: ['ещё симптомы'],
          supportMessageIds: [supportNew2],
        },
      ],
      spendId,
    );

    const result = await mergeProblems(triage, {
      prisma: db(),
      vec,
      embeddings,
      configOverride: TEST_CONFIG,
    });

    expect(result.merged).toHaveLength(1);
    expect(result.merged[0]!.existingProblemId).toBe(existingProblemId);
    expect(result.created).toHaveLength(2);

    expect(await countLinks(supportShared, existingProblemId)).toBe(1);
    expect(await countLinks(supportNew1, result.created[0]!.problemId)).toBe(1);
    expect(await countLinks(supportNew2, result.created[1]!.problemId)).toBe(1);
  });

  it('intent.problem за окном (старше windowDays) → НЕ мерджится, создаётся новая', async () => {
    const sharedSummary = `${RUN_ID} проблема старая`;
    const oldProblemId = await seedExistingProblem({
      vec,
      embeddings,
      summary: sharedSummary,
      symptoms: ['старое'],
      ageMs: (TEST_CONFIG.mergeWindowDays + 1) * 86_400_000,
    });

    const support = `${RUN_ID}-support-${ulid()}`;
    await insertSupportMessage(support);
    const spendId = `spend-${RUN_ID}-${ulid()}`;
    await insertFakeSpend(spendId);

    const result = await mergeProblems(
      buildTriage(
        [
          {
            summary: sharedSummary,
            symptoms: ['свежее'],
            supportMessageIds: [support],
          },
        ],
        spendId,
      ),
      { prisma: db(), vec, embeddings, configOverride: TEST_CONFIG },
    );

    expect(result.merged).toHaveLength(0);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.problemId).not.toBe(oldProblemId);
  });

  it('физический конфликт: повторный INSERT Embedding для того же intent.problem.id → SQLite UNIQUE error', async () => {
    const summary = `${RUN_ID} проблема для unique-конфликта`;
    const problemId = await seedExistingProblem({
      vec,
      embeddings,
      summary,
      symptoms: ['x'],
    });

    const vector = await embeddings.embedText(summary);
    // Embedding.recordId — PK, повторный INSERT падает.
    await expect(
      db().$executeRawUnsafe(
        `INSERT INTO "Embedding" (recordId, model, vector, createdAt) VALUES (?, ?, ?, ?)`,
        problemId,
        TEST_CONFIG.model,
        Buffer.from(vector.buffer),
        Date.now(),
      ),
    ).rejects.toThrow(/UNIQUE constraint failed|PRIMARY KEY/i);
  });
});
