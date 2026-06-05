// Analytics KPI alerts (Фаза 8 плана 2026-05-21-skills-architecture-v3, D).
//
// Проверяет три условия раз в день (cron):
//   1. cost-spike    — текущая неделя по cost > предыдущей × 1.5;
//   2. traffic-drop  — текущая неделя по views < предыдущей × 0.5
//                      (только если в предыдущей было реально что мерить);
//   3. kpi-floor     — posts-per-week == 0 (нет публикаций за неделю).
//
// Алёрт → Telegram (через тот же путь, что health-alert), а также Bridge event
// `analytics.alert`. Дедупликация per-день per-condition: для каждого
// сочетания (condition, UTC-day) пишем `audit.analytics.alert` Record; при
// повторном вызове в тот же день — skip.

import { ulid } from 'ulid';
import { type PrismaClient, getPrisma } from '../db/client.js';
import { emit } from '../observe/bridge.js';
import { getAllowlist, getBotToken } from '../telegram/secrets.js';
import { getCostTrend, getPostsPerWeek, getTrafficTrend } from './queries.js';

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export type AlertCondition = 'cost-spike' | 'traffic-drop' | 'kpi-floor';

export interface AlertItem {
  condition: AlertCondition;
  message: string;
  /** Снимок цифр для контекста (current/prev/factor и т.п.). */
  context: Record<string, number>;
}

export interface CheckKpiAlertsResult {
  /** Всё, что мы реально отправили (после дедупа). */
  sent: AlertItem[];
  /** Что было заглушено дедупом (уже отправили сегодня). */
  skippedAsDuplicate: AlertItem[];
  /** Что прошло проверку, но не сработало (для тестов/диагностики). */
  evaluated: { condition: AlertCondition; triggered: boolean; context: Record<string, number> }[];
}

// ---------------------------------------------------------------------------
// DI.
// ---------------------------------------------------------------------------

export interface CheckKpiAlertsOptions {
  db?: PrismaClient;
  now?: () => Date;
  /** DI для тестов: подмена sendMessage (по умолчанию — grammy). */
  sendMessage?: (chatId: string, text: string) => Promise<void>;
  /** DI для тестов: подмена loadAllowlist. */
  loadAllowlist?: () => Promise<string[]>;
  /** DI для тестов: подмена loadToken. */
  loadToken?: () => Promise<string>;
  /** DI для тестов: подменить emit. */
  emitFn?: typeof emit;
  /** DI для тестов: override thresholds. */
  thresholds?: {
    costSpikeFactor?: number;
    trafficDropFactor?: number;
  };
}

const DEFAULT_COST_SPIKE_FACTOR = 1.5;
const DEFAULT_TRAFFIC_DROP_FACTOR = 0.5;

// ---------------------------------------------------------------------------
// checkKpiAlerts — основная точка входа.
// ---------------------------------------------------------------------------

export async function checkKpiAlerts(
  opts: CheckKpiAlertsOptions = {},
): Promise<CheckKpiAlertsResult> {
  const db = opts.db ?? getPrisma();
  const nowFn = opts.now ?? (() => new Date());
  const emitFn = opts.emitFn ?? emit;
  const costSpikeFactor = opts.thresholds?.costSpikeFactor ?? DEFAULT_COST_SPIKE_FACTOR;
  const trafficDropFactor = opts.thresholds?.trafficDropFactor ?? DEFAULT_TRAFFIC_DROP_FACTOR;

  // 1. Забираем последние 2 недели по cost / traffic / posts.
  const [costWeeks, trafficWeeks, postWeeks] = await Promise.all([
    getCostTrend({ db, weeks: 2, now: opts.now }),
    getTrafficTrend({ db, weeks: 2, now: opts.now }),
    getPostsPerWeek({ db, weeks: 2, now: opts.now }),
  ]);

  const evaluated: CheckKpiAlertsResult['evaluated'] = [];
  const fired: AlertItem[] = [];

  // Cost spike.
  const costPrev = costWeeks[0]?.totalUsd ?? 0;
  const costCur = costWeeks[1]?.totalUsd ?? 0;
  const costSpiked = costPrev > 0 && costCur > costPrev * costSpikeFactor;
  evaluated.push({
    condition: 'cost-spike',
    triggered: costSpiked,
    context: { current: costCur, previous: costPrev, factor: costSpikeFactor },
  });
  if (costSpiked) {
    fired.push({
      condition: 'cost-spike',
      message: `⚠️ Cost spike: $${costCur.toFixed(2)} за неделю против $${costPrev.toFixed(2)} прошлой (×${(costCur / costPrev).toFixed(2)}). Проверь, что не глючит routine.`,
      context: { current: costCur, previous: costPrev },
    });
  }

  // Traffic drop.
  const trafficPrev = trafficWeeks[0]?.totalViews ?? 0;
  const trafficCur = trafficWeeks[1]?.totalViews ?? 0;
  const trafficDropped = trafficPrev > 0 && trafficCur < trafficPrev * trafficDropFactor;
  evaluated.push({
    condition: 'traffic-drop',
    triggered: trafficDropped,
    context: { current: trafficCur, previous: trafficPrev, factor: trafficDropFactor },
  });
  if (trafficDropped) {
    fired.push({
      condition: 'traffic-drop',
      message: `⚠️ Traffic drop: ${trafficCur} views за неделю против ${trafficPrev} прошлой (×${(trafficCur / trafficPrev).toFixed(2)}). Темы перестали заходить?`,
      context: { current: trafficCur, previous: trafficPrev },
    });
  }

  // KPI floor.
  const postsCur = postWeeks[1]?.count ?? 0;
  const postsFloor = postsCur < 1;
  evaluated.push({
    condition: 'kpi-floor',
    triggered: postsFloor,
    context: { current: postsCur },
  });
  if (postsFloor) {
    fired.push({
      condition: 'kpi-floor',
      message:
        '⚠️ Нет публикаций за неделю. Маркетинговый pipeline молчит — проверь researcher/writer/publisher.',
      context: { current: postsCur },
    });
  }

  // 2. Дедуп per (condition, day) через audit.analytics.alert.
  // ВАЖНО: окно чтения и штамп записи берём из ОДНОГО инъецированного часа
  // (nowFn), иначе запись на реальном Date.now() приземлится вне queried-окна
  // и дедуп молча перестанет ловить дубли (баг на границе UTC-суток + ломал
  // тесты с фиксированным NOW).
  const sent: AlertItem[] = [];
  const skippedAsDuplicate: AlertItem[] = [];
  const nowMs = nowFn().getTime();
  const dayStartMs = startOfUtcDay(new Date(nowMs));
  const dayEndMs = dayStartMs + 86_400_000;
  for (const alert of fired) {
    const already = await hasAlertForToday(db, alert.condition, dayStartMs, dayEndMs);
    if (already) {
      skippedAsDuplicate.push(alert);
      continue;
    }

    // 3. Telegram (best-effort: если бот не настроен — лог, но Bridge event всё равно эмитим).
    try {
      await sendToFounder(alert.message, opts);
    } catch (err) {
      console.warn('[analytics:alert] sendToFounder failed:', (err as Error).message);
    }

    // 4. Bridge event.
    try {
      await emitFn({
        type: 'audit.spend',
        recordId: 'analytics-alert',
        promptId: `analytics.alert.${alert.condition}`,
        model: 'n/a',
        usd: 0,
      });
    } catch {
      // никогда не падать на эмите
    }

    // 5. Запишем audit Record для дедупа (тем же часом, что окно чтения).
    await insertAlertAudit(db, alert, nowMs);
    sent.push(alert);
  }

  return { sent, skippedAsDuplicate, evaluated };
}

// ---------------------------------------------------------------------------
// Telegram helper (копия логики из health-alert.ts, но без зависимости от
// HealthCheckResult — формат у нас другой).
// ---------------------------------------------------------------------------

async function sendToFounder(text: string, opts: CheckKpiAlertsOptions): Promise<void> {
  const loadAllowlist = opts.loadAllowlist ?? (async () => getAllowlist());
  const loadToken = opts.loadToken ?? (async () => getBotToken());

  let chatIds: string[];
  try {
    chatIds = await loadAllowlist();
  } catch (err) {
    console.warn('[analytics:alert] failed to load allowlist:', (err as Error).message);
    return;
  }
  if (chatIds.length === 0) return;

  let sender = opts.sendMessage;
  if (sender === undefined) {
    let token: string;
    try {
      token = await loadToken();
    } catch {
      console.info('[analytics:alert] telegram bot not configured (skip alert)');
      return;
    }
    // Ленивый импорт grammy — тесты, которые пробрасывают sendMessage, его не
    // подгружают.
    const { Bot } = await import('grammy');
    const bot = new Bot(token);
    sender = async (chatId, msg) => {
      await bot.api.sendMessage(chatId, msg);
    };
  }

  for (const chatId of chatIds) {
    try {
      await sender(chatId, text);
    } catch (err) {
      console.warn(
        `[analytics:alert] sendMessage failed for chatId=${chatId}:`,
        (err as Error).message,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Дедуп.
// ---------------------------------------------------------------------------

async function hasAlertForToday(
  db: PrismaClient,
  condition: AlertCondition,
  dayStartMs: number,
  dayEndMs: number,
): Promise<boolean> {
  // count(*) → BigInt в SQLite через Prisma — приводим через Number.
  const rows = await db.$queryRawUnsafe<{ c: number | bigint }[]>(
    `SELECT count(*) as c FROM "Record"
      WHERE type = 'audit.analytics.alert'
        AND createdAt >= ? AND createdAt < ?
        AND json_extract(properties, '$.condition') = ?`,
    dayStartMs,
    dayEndMs,
    condition,
  );
  return Number(rows[0]?.c ?? 0) > 0;
}

async function insertAlertAudit(db: PrismaClient, alert: AlertItem, nowMs: number): Promise<void> {
  const id = ulid();
  const now = nowMs;
  const props = JSON.stringify({
    condition: alert.condition,
    message: alert.message,
    context: alert.context,
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "Record" (id, type, properties, actorKind, visibility, status, closedAt, createdAt)
     VALUES (?, 'audit.analytics.alert', ?, 'agent', 'autonomous', 'closed', ?, ?)`,
    id,
    props,
    now,
    now,
  );
}

function startOfUtcDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}
