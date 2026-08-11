// `/деньги` отчёт. Транспорт-зависим.
//
// См. src/llm/transport.ts
// и plans/ (фаза 4.2).
//
// Два режима:
//   * `apikey` — старый отчёт по USD из audit.spend (как было).
//   * `oauth`  — отчёт по квоте подписки (5h/7d окна из gateway /v1/usage)
//                + статистика по токенам/звонкам из audit.spend (usd=0).
//
// Контракт getMoneyReportData/getMoneyReport одинаков: вызывающий код в bot.ts
// не меняется. Внутри функция смотрит транспорт и переключает рендер.

import type { PrismaClient } from '../db/client.js';
import { getPrisma } from '../db/client.js';
import { loadBudgetLimits } from './budget.js';
import { getTransport } from './transport.js';

export interface QuotaSnapshot {
  fiveHour: { utilization: number; resetUnix: number } | null;
  sevenDay: { utilization: number; resetUnix: number } | null;
  representativeClaim: string;
  status: string;
  observedAtUnix: number;
  fallback: boolean;
}

export interface MoneyReportRow {
  transport: 'oauth' | 'apikey' | 'codex';
  daily: {
    usd: number; // в oauth-режиме всегда 0 (биллинг идёт по квоте подписки)
    cap: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
  };
  monthly: {
    usd: number;
    cap: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
  };
  recentDeny: { count: number; lastAt: number | null; lastReason: string | null };
  byRoutine: Array<{ routineId: string; usd: number; calls: number }>;
  // Только в oauth-режиме. null если gateway недоступен либо квота ещё не наблюдалась.
  quota: QuotaSnapshot | null;
}

export interface GetMoneyReportDataDeps {
  // Тестовый DI для fetch'а к gateway. Прод — globalThis.fetch.
  fetchImpl?: typeof fetch;
}

export async function getMoneyReportData(
  db: PrismaClient = getPrisma(),
  now: Date = new Date(),
  deps: GetMoneyReportDataDeps = {},
): Promise<MoneyReportRow> {
  const transport = getTransport();
  const limits = await loadBudgetLimits();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const denyWindowStart = now.getTime() - 24 * 60 * 60 * 1000;

  const [day, month, deny] = await Promise.all([
    db.$queryRawUnsafe<{ properties: string }[]>(
      `SELECT properties FROM "Record" WHERE type = 'audit.spend' AND createdAt >= ?`,
      dayStart,
    ),
    db.$queryRawUnsafe<{ properties: string }[]>(
      `SELECT properties FROM "Record" WHERE type = 'audit.spend' AND createdAt >= ?`,
      monthStart,
    ),
    db.$queryRawUnsafe<{ properties: string; createdAt: number }[]>(
      `SELECT properties, createdAt FROM "Record" WHERE type = 'audit.budget.deny' AND createdAt >= ? ORDER BY createdAt DESC`,
      denyWindowStart,
    ),
  ]);

  const lastDeny = deny[0];
  const lastReason = lastDeny ? safeParseLimit(lastDeny.properties) : null;

  const quota = transport.mode === 'oauth' ? await fetchQuota(transport.baseURL, deps) : null;

  return {
    transport: transport.mode,
    daily: {
      usd: sumUsd(day),
      cap: limits.daily.usd,
      calls: day.length,
      inputTokens: sumTokens(day, 'inputTokens'),
      outputTokens: sumTokens(day, 'outputTokens'),
    },
    monthly: {
      usd: sumUsd(month),
      cap: limits.monthly.usd,
      calls: month.length,
      inputTokens: sumTokens(month, 'inputTokens'),
      outputTokens: sumTokens(month, 'outputTokens'),
    },
    recentDeny: {
      count: deny.length,
      lastAt: lastDeny ? Number(lastDeny.createdAt) : null,
      lastReason,
    },
    byRoutine: aggregateByRoutine(day),
    quota,
  };
}

export async function getMoneyReport(
  db: PrismaClient = getPrisma(),
  now: Date = new Date(),
  deps: GetMoneyReportDataDeps = {},
): Promise<string> {
  const data = await getMoneyReportData(db, now, deps);

  if (data.transport === 'oauth') {
    return renderOauthReport(data, now);
  }
  return renderApikeyReport(data);
}

// ---------------------------------------------------------------------------
// Рендеры.
// ---------------------------------------------------------------------------

function renderApikeyReport(data: MoneyReportRow): string {
  const dayPct = pct(data.daily.usd, data.daily.cap);
  const monthPct = pct(data.monthly.usd, data.monthly.cap);
  const lines = [
    '💸 Бюджет AI-Cofounder',
    `Сегодня: $${fmt(data.daily.usd)} из $${fmt(data.daily.cap)} (${dayPct}%) · ${data.daily.calls} вызов(а)`,
    `Месяц:   $${fmt(data.monthly.usd)} из $${fmt(data.monthly.cap)} (${monthPct}%) · ${data.monthly.calls} вызов(а)`,
  ];
  appendDenyAndRoutines(lines, data);
  return lines.join('\n');
}

function renderOauthReport(data: MoneyReportRow, now: Date): string {
  const lines = ['💸 Бюджет AI-Cofounder (подписка)'];
  if (data.quota === null) {
    lines.push('⚠️ gateway недоступен — квота не показана. См. `launchctl list | grep gateway`.');
  } else {
    const q = data.quota;
    if (q.observedAtUnix === 0 && q.fiveHour === null && q.sevenDay === null) {
      lines.push('📊 Квота: ещё нет данных (ни одного запроса через gateway за сессию).');
    } else {
      if (q.fiveHour !== null) {
        lines.push(
          `📊 5h-окно: ${fmtPct(q.fiveHour.utilization)} (reset ${fmtReset(q.fiveHour.resetUnix, now)})`,
        );
      }
      if (q.sevenDay !== null) {
        lines.push(
          `📊 7d-окно: ${fmtPct(q.sevenDay.utilization)} (reset ${fmtReset(q.sevenDay.resetUnix, now)})`,
        );
      }
      if (q.status !== '' && q.status !== 'allowed') {
        lines.push(
          `Статус подписки: ${q.status}${q.representativeClaim ? ` (${q.representativeClaim})` : ''}`,
        );
      }
      if (q.fallback) {
        lines.push(
          'ℹ️ Квота — fallback-оценка (Anthropic не вернул rate-limit headers в последнем ответе).',
        );
      }
    }
  }
  lines.push(
    `Сегодня: ${data.daily.calls} вызов(а), ${fmtTokens(data.daily.inputTokens)} in + ${fmtTokens(data.daily.outputTokens)} out`,
    `Месяц:   ${data.monthly.calls} вызов(а), ${fmtTokens(data.monthly.inputTokens)} in + ${fmtTokens(data.monthly.outputTokens)} out`,
  );
  appendDenyAndRoutines(lines, data);
  return lines.join('\n');
}

function appendDenyAndRoutines(lines: string[], data: MoneyReportRow): void {
  if (data.recentDeny.count > 0) {
    lines.push(
      `⚠️ За последние 24ч: ${data.recentDeny.count} отказ(ов)${data.recentDeny.lastReason ? ` — последний: ${data.recentDeny.lastReason}` : ''}`,
    );
  }
  if (data.byRoutine.length > 0) {
    lines.push('По routines (сегодня):');
    for (const r of data.byRoutine) {
      // В oauth-режиме r.usd=0 — показываем число вызовов, без сумм.
      if (data.transport === 'oauth') {
        lines.push(`  ${r.routineId}: ${r.calls} вызов(а)`);
      } else {
        lines.push(`  ${r.routineId}: $${fmt(r.usd)} (${r.calls} вызов(а))`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Источники данных.
// ---------------------------------------------------------------------------

async function fetchQuota(
  baseURL: string | undefined,
  deps: GetMoneyReportDataDeps,
): Promise<QuotaSnapshot | null> {
  if (baseURL === undefined) return null;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  try {
    const res = await fetchImpl(`${baseURL}/v1/usage`, {
      method: 'GET',
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as Record<string, unknown>;
    return {
      fiveHour: parseUsageWindow(raw.five_hour),
      sevenDay: parseUsageWindow(raw.seven_day),
      representativeClaim:
        typeof raw.representative_claim === 'string' ? raw.representative_claim : '',
      status: typeof raw.status === 'string' ? raw.status : '',
      observedAtUnix: typeof raw.observed_at_unix === 'number' ? raw.observed_at_unix : 0,
      fallback: raw.fallback === true,
    };
  } catch {
    // Gateway down / timeout / битый JSON — null. Рендер покажет «недоступен».
    return null;
  }
}

function parseUsageWindow(raw: unknown): { utilization: number; resetUnix: number } | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const u = obj.utilization;
  const r = obj.reset_unix;
  if (typeof u !== 'number' || typeof r !== 'number') return null;
  return { utilization: u, resetUnix: r };
}

// Экспортируется для unit-тестов (tests/money-report-routine.test.ts).
export function aggregateByRoutine(
  rows: { properties: string }[],
): Array<{ routineId: string; usd: number; calls: number }> {
  const map = new Map<string, { usd: number; calls: number }>();
  for (const row of rows) {
    try {
      const props = JSON.parse(row.properties) as Record<string, unknown>;
      const routineId = typeof props.routineId === 'string' ? props.routineId : null;
      if (routineId === null) continue;
      const usd = typeof props.usd === 'number' && Number.isFinite(props.usd) ? props.usd : 0;
      const existing = map.get(routineId);
      if (existing) {
        existing.usd += usd;
        existing.calls += 1;
      } else {
        map.set(routineId, { usd, calls: 1 });
      }
    } catch {
      // Битый JSON — пропускаем, не роняем отчёт.
    }
  }
  return Array.from(map.entries())
    .map(([routineId, v]) => ({ routineId, usd: v.usd, calls: v.calls }))
    .sort((a, b) => b.usd - a.usd || b.calls - a.calls)
    .slice(0, 5);
}

function sumUsd(rows: { properties: string }[]): number {
  let total = 0;
  for (const row of rows) {
    try {
      const props = JSON.parse(row.properties) as Record<string, unknown>;
      const value = props.usd;
      if (typeof value === 'number' && Number.isFinite(value)) total += value;
    } catch {
      // см. spend.ts: битый JSON — отдельная боль, не повод убить отчёт.
    }
  }
  return total;
}

function sumTokens(rows: { properties: string }[], field: 'inputTokens' | 'outputTokens'): number {
  let total = 0;
  for (const row of rows) {
    try {
      const props = JSON.parse(row.properties) as Record<string, unknown>;
      const value = props[field];
      if (typeof value === 'number' && Number.isFinite(value)) total += value;
    } catch {
      // битый JSON — пропускаем
    }
  }
  return total;
}

function safeParseLimit(properties: string): string | null {
  try {
    const props = JSON.parse(properties) as Record<string, unknown>;
    const limit = typeof props.limit === 'string' ? props.limit : '?';
    const current = typeof props.current === 'number' ? props.current : 0;
    const cap = typeof props.cap === 'number' ? props.cap : 0;
    return `${limit} (${current}/${cap})`;
  } catch {
    return null;
  }
}

function fmt(n: number): string {
  return n.toFixed(2);
}

function pct(current: number, cap: number): string {
  if (cap === 0) return '∞';
  return Math.round((current / cap) * 100).toString();
}

function fmtPct(u: number): string {
  return `${Math.round(u * 100)}%`;
}

function fmtReset(unix: number, now: Date): string {
  if (unix <= 0) return 'неизвестно';
  const diffMs = unix * 1000 - now.getTime();
  if (diffMs <= 0) return 'уже';
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `через ${minutes}мин`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `через ${hours}ч`;
  const days = Math.round(hours / 24);
  return `через ${days}д`;
}

function fmtTokens(n: number): string {
  if (n < 1_000) return n.toString();
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
