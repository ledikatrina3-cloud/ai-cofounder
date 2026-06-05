// Тесты tool authorization per routine (фаза 3.2).
//
// Стратегия:
//   * isolated-db (template.db + cp на тест) — каждый тест видит чистую БД.
//   * buildCanUseTool тестируется напрямую (экспортируется из runtime.ts).
//   * Проверяем: возврат 'allow'/'deny' + наличие/отсутствие audit.security.tool.deny в БД.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCanUseTool } from '../src/routines/runtime.js';
import {
  type IsolatedDb,
  type TemplateHandle,
  createIsolatedDb,
  setupTemplateDb,
} from './fixtures/isolated-db.js';

// ---------------------------------------------------------------------------
// DB isolation.
// ---------------------------------------------------------------------------

let template: TemplateHandle;
let iso: IsolatedDb;

beforeAll(() => {
  template = setupTemplateDb();
});

afterAll(() => {
  template.dispose();
});

beforeEach(async () => {
  iso = await createIsolatedDb(template);
});

afterEach(async () => {
  await iso.dispose();
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Возвращает все audit.security.tool.deny Records из БД. */
async function fetchDenyRecords(
  db: IsolatedDb['prisma'],
): Promise<Array<{ id: string; properties: string }>> {
  return db.$queryRawUnsafe<Array<{ id: string; properties: string }>>(
    `SELECT id, properties FROM "Record" WHERE type = 'audit.security.tool.deny'`,
  );
}

/**
 * Минимальный ctx-объект для вызова canUseTool в тестах.
 * SDK требует signal + toolUseID как обязательные поля.
 */
function makeCtx(): Parameters<ReturnType<typeof buildCanUseTool>>[2] {
  return {
    signal: new AbortController().signal,
    toolUseID: 'test-tool-use-id',
  };
}

// ---------------------------------------------------------------------------
// Тест 1: tool в sdkTools → 'allow', без audit.
// ---------------------------------------------------------------------------

describe('buildCanUseTool', () => {
  it('tool в sdkTools → allow, audit.security.tool.deny не создан', async () => {
    const canUseTool = buildCanUseTool(['Read'], 'test-routine', iso.prisma);

    const result = await canUseTool('Read', {}, makeCtx());

    expect(result.behavior).toBe('allow');

    const records = await fetchDenyRecords(iso.prisma);
    expect(records).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Тест 2: tool НЕ в sdkTools → 'deny', audit создан.
  // ---------------------------------------------------------------------------

  it('tool не в sdkTools → deny, audit.security.tool.deny создан', async () => {
    const canUseTool = buildCanUseTool(['Read'], 'test-routine-2', iso.prisma);

    const result = await canUseTool('Bash', { command: 'ls' }, makeCtx());

    expect(result.behavior).toBe('deny');

    const records = await fetchDenyRecords(iso.prisma);
    expect(records).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Тест 3: Bash в sdkTools, whitelist OK → 'allow'.
  // ---------------------------------------------------------------------------

  it("sdkTools=['Bash'], команда 'ls -la' (whitelist OK) → allow", async () => {
    const canUseTool = buildCanUseTool(['Bash'], 'test-routine-3', iso.prisma);

    const result = await canUseTool('Bash', { command: 'ls -la' }, makeCtx());

    expect(result.behavior).toBe('allow');

    const records = await fetchDenyRecords(iso.prisma);
    expect(records).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Тест 4: Bash в sdkTools, команда заблокирована → 'deny', audit создан.
  // ---------------------------------------------------------------------------

  it("sdkTools=['Bash'], команда 'rm -rf /' (blocked) → deny, audit создан", async () => {
    const canUseTool = buildCanUseTool(['Bash'], 'test-routine-4', iso.prisma);

    const result = await canUseTool('Bash', { command: 'rm -rf /' }, makeCtx());

    expect(result.behavior).toBe('deny');

    const records = await fetchDenyRecords(iso.prisma);
    expect(records).toHaveLength(1);
    const props = JSON.parse(records[0]!.properties) as Record<string, unknown>;
    expect(props.reason).toBe('bash-whitelist-violation');
  });

  // ---------------------------------------------------------------------------
  // Тест 5: Audit record содержит правильный routineId в properties.
  // ---------------------------------------------------------------------------

  it('audit record содержит правильный routineId', async () => {
    const routineId = 'my-special-routine';
    const canUseTool = buildCanUseTool(['Read'], routineId, iso.prisma);

    await canUseTool('Bash', { command: 'rm -rf /' }, makeCtx());

    const records = await fetchDenyRecords(iso.prisma);
    expect(records).toHaveLength(1);
    const props = JSON.parse(records[0]!.properties) as Record<string, unknown>;
    expect(props.routineId).toBe(routineId);
  });

  // ---------------------------------------------------------------------------
  // Тест 6: reason='tool-not-in-routine-declaration' для неизвестного tool.
  // ---------------------------------------------------------------------------

  it("reason='tool-not-in-routine-declaration' для tool не в sdkTools", async () => {
    const canUseTool = buildCanUseTool(['Read'], 'test-routine-6', iso.prisma);

    await canUseTool('Write', { file_path: '/tmp/x', content: 'data' }, makeCtx());

    const records = await fetchDenyRecords(iso.prisma);
    expect(records).toHaveLength(1);
    const props = JSON.parse(records[0]!.properties) as Record<string, unknown>;
    expect(props.reason).toBe('tool-not-in-routine-declaration');
    expect(props.toolName).toBe('Write');
  });

  // ---------------------------------------------------------------------------
  // Тест 7: routine с расширенным bashWhitelist может вызвать 'pnpm publish vc'.
  // ---------------------------------------------------------------------------

  it("расширенный bashWhitelist разрешает 'pnpm publish vc'", async () => {
    const extendedWhitelist = ['cat', 'ls', 'grep', 'pnpm publish vc'];
    const canUseTool = buildCanUseTool(['Bash'], 'marketer-vc', iso.prisma, extendedWhitelist);

    const result = await canUseTool(
      'Bash',
      { command: 'pnpm publish vc content/drafts/vc/foo.md --yes' },
      makeCtx(),
    );

    expect(result.behavior).toBe('allow');
    const records = await fetchDenyRecords(iso.prisma);
    expect(records).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Тест 8: даже с расширенным whitelist, FORBIDDEN_SUBSTRINGS блокируют инъекции.
  // ---------------------------------------------------------------------------

  it('расширенный whitelist НЕ ослабляет защиту от pipe/redirect/&&', async () => {
    const extendedWhitelist = ['cat', 'ls', 'grep', 'pnpm publish vc'];
    const canUseTool = buildCanUseTool(['Bash'], 'marketer-vc-2', iso.prisma, extendedWhitelist);

    const result = await canUseTool(
      'Bash',
      { command: 'pnpm publish vc foo.md && rm -rf /' },
      makeCtx(),
    );

    expect(result.behavior).toBe('deny');
    const records = await fetchDenyRecords(iso.prisma);
    expect(records).toHaveLength(1);
    const props = JSON.parse(records[0]!.properties) as Record<string, unknown>;
    expect(props.reason).toBe('bash-whitelist-violation');
  });

  // ---------------------------------------------------------------------------
  // Тест 9: без расширения whitelist 'pnpm publish' блокируется.
  // ---------------------------------------------------------------------------

  it("без bashWhitelist-расширения 'pnpm publish' блокируется", async () => {
    const canUseTool = buildCanUseTool(['Bash'], 'no-extension', iso.prisma);

    const result = await canUseTool(
      'Bash',
      { command: 'pnpm publish vc content/drafts/vc/foo.md --yes' },
      makeCtx(),
    );

    expect(result.behavior).toBe('deny');
  });
});
