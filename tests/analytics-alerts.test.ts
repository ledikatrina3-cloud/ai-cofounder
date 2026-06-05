// Тесты для src/analytics/alerts.ts.
//
// Стратегия:
//   * Изолированная БД, заливаем фикстуры spend/signal.metric.
//   * Мокаем sendMessage, loadAllowlist (один фейк chatId), emitFn.
//   * Проверяем три условия: cost-spike, traffic-drop, kpi-floor.
//   * Дедуп per-day: вызвав checkKpiAlerts дважды — алёрт уходит только
//     первый раз.

import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkKpiAlerts } from '../src/analytics/alerts.js';
import {
  type IsolatedDb,
  type TemplateHandle,
  createIsolatedDb,
  setupTemplateDb,
} from './fixtures/isolated-db.js';

let template: TemplateHandle;

beforeAll(() => {
  template = setupTemplateDb();
}, 90_000);

afterAll(() => {
  template.dispose();
});

let db: IsolatedDb;
const NOW = new Date('2026-05-21T08:00:00Z');

beforeEach(async () => {
  db = await createIsolatedDb(template);
});

afterEach(async () => {
  await db.dispose();
});

async function insertSpend(usd: number, daysAgo: number): Promise<void> {
  const id = ulid();
  const t = NOW.getTime() - daysAgo * 86_400_000;
  const props = JSON.stringify({
    promptId: 'test:p',
    model: 'claude-sonnet-4-6',
    modelRequested: 'claude-sonnet-4-6',
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    usd,
    pricingAsOf: t,
  });
  await db.prisma.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.spend', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    props,
    t,
    t,
  );
}

async function insertSignalMetric(postUrl: string, views: number, daysAgo: number): Promise<void> {
  const id = ulid();
  const t = NOW.getTime() - daysAgo * 86_400_000;
  const props = JSON.stringify({
    platform: 'vc',
    postUrl,
    views,
    comments: 0,
    likes: 0,
    source: 'analytics-traffic',
  });
  await db.prisma.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'signal.metric', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    props,
    t,
    t,
  );
}

describe('checkKpiAlerts: cost-spike', () => {
  it('срабатывает когда текущая неделя cost > предыдущей × 1.5', async () => {
    // Прошлая неделя: $1
    await insertSpend(1.0, 10);
    // Текущая неделя: $5 (×5 — выше threshold'а ×1.5)
    await insertSpend(5.0, 2);
    // Чтобы не сработал traffic-drop / kpi-floor — кладём пост на текущей.
    await insertSignalMetric('https://vc.ru/u/a', 100, 2);

    const sendMessage = vi.fn(async () => {});
    const result = await checkKpiAlerts({
      db: db.prisma,
      now: () => NOW,
      sendMessage,
      loadAllowlist: async () => ['123'],
      loadToken: async () => 'fake-token',
    });

    expect(result.sent.some((a) => a.condition === 'cost-spike')).toBe(true);
    expect(sendMessage).toHaveBeenCalled();
  });

  it('не срабатывает на нормальном росте', async () => {
    await insertSpend(1.0, 10);
    await insertSpend(1.2, 2); // ×1.2 — ниже threshold
    await insertSignalMetric('https://vc.ru/u/a', 100, 2);

    const sendMessage = vi.fn(async () => {});
    const result = await checkKpiAlerts({
      db: db.prisma,
      now: () => NOW,
      sendMessage,
      loadAllowlist: async () => ['123'],
      loadToken: async () => 'fake',
    });
    expect(result.sent.some((a) => a.condition === 'cost-spike')).toBe(false);
  });
});

describe('checkKpiAlerts: kpi-floor', () => {
  it('срабатывает когда posts-per-week == 0', async () => {
    // Никаких signal.metric за неделю.
    const sendMessage = vi.fn(async () => {});
    const result = await checkKpiAlerts({
      db: db.prisma,
      now: () => NOW,
      sendMessage,
      loadAllowlist: async () => ['123'],
      loadToken: async () => 'fake',
    });
    expect(result.sent.some((a) => a.condition === 'kpi-floor')).toBe(true);
  });

  it('не срабатывает когда есть публикация', async () => {
    await insertSignalMetric('https://vc.ru/u/a', 10, 2);
    const sendMessage = vi.fn(async () => {});
    const result = await checkKpiAlerts({
      db: db.prisma,
      now: () => NOW,
      sendMessage,
      loadAllowlist: async () => ['123'],
      loadToken: async () => 'fake',
    });
    expect(result.sent.some((a) => a.condition === 'kpi-floor')).toBe(false);
  });
});

describe('checkKpiAlerts: traffic-drop', () => {
  it('срабатывает когда current views < prev × 0.5', async () => {
    // Прошлая неделя — публикация с 1000 views (daysAgo=10).
    await insertSignalMetric('https://vc.ru/u/prev', 1000, 10);
    // Текущая — публикация с 100 views (далеко ниже половины).
    await insertSignalMetric('https://vc.ru/u/cur', 100, 2);

    const sendMessage = vi.fn(async () => {});
    const result = await checkKpiAlerts({
      db: db.prisma,
      now: () => NOW,
      sendMessage,
      loadAllowlist: async () => ['123'],
      loadToken: async () => 'fake',
    });
    expect(result.sent.some((a) => a.condition === 'traffic-drop')).toBe(true);
  });
});

describe('checkKpiAlerts: дедуп per-day', () => {
  it('второй вызов в тот же UTC-день — не дублирует Telegram-отправку', async () => {
    // Гарантируем kpi-floor — нет метрик.
    const sendMessage = vi.fn(async () => {});
    const opts = {
      db: db.prisma,
      now: () => NOW,
      sendMessage,
      loadAllowlist: async () => ['123'],
      loadToken: async () => 'fake',
    };

    const first = await checkKpiAlerts(opts);
    expect(first.sent.length).toBeGreaterThan(0);
    const firstCallCount = sendMessage.mock.calls.length;

    const second = await checkKpiAlerts(opts);
    // Тот же alert должен быть в skippedAsDuplicate, не в sent.
    expect(second.sent.some((a) => a.condition === 'kpi-floor')).toBe(false);
    expect(second.skippedAsDuplicate.some((a) => a.condition === 'kpi-floor')).toBe(true);
    // sendMessage не вызывался повторно.
    expect(sendMessage.mock.calls.length).toBe(firstCallCount);
  });
});
