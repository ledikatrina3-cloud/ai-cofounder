import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface BudgetLimits {
  perCycle: { inputTokens: number };
  daily: { usd: number };
  monthly: { usd: number };
}

const BUDGET_PATH = 'config/budget.md';
// Движковый дефолт. config/budget.md — user-слой (gitignore), материализуется
// /setup. До /setup (свежий форк) его нет — откатываемся на tracked example,
// чтобы движок и тесты работали из коробки. Аналогично graceful-загрузке
// config/projects.md в src/projects/registry.ts.
const BUDGET_EXAMPLE_PATH = 'config/budget.example.md';

export async function loadBudgetLimits(rootDir: string = process.cwd()): Promise<BudgetLimits> {
  let absPath = resolve(rootDir, BUDGET_PATH);
  let body: string;
  try {
    body = await readFile(absPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // budget.md отсутствует (форк до /setup) — берём движковый example.
    absPath = resolve(rootDir, BUDGET_EXAMPLE_PATH);
    body = await readFile(absPath, 'utf-8');
  }
  const match = body.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match || match[1] === undefined) {
    throw new Error(`${absPath}: не найден json-блок с лимитами.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${absPath}: json-блок не парсится: ${reason}`);
  }
  return normalize(parsed, absPath);
}

function normalize(raw: unknown, path: string): BudgetLimits {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${path}: ожидался объект с полями perCycle/daily/monthly.`);
  }
  const obj = raw as Record<string, unknown>;
  const perCycleInput = readNumber(obj.perCycle, 'inputTokens', `${path}:perCycle.inputTokens`);
  const dailyUsd = readNumber(obj.daily, 'usd', `${path}:daily.usd`);
  const monthlyUsd = readNumber(obj.monthly, 'usd', `${path}:monthly.usd`);
  if (perCycleInput <= 0 || dailyUsd <= 0 || monthlyUsd <= 0) {
    throw new Error(`${path}: все лимиты должны быть строго положительными.`);
  }
  return {
    perCycle: { inputTokens: perCycleInput },
    daily: { usd: dailyUsd },
    monthly: { usd: monthlyUsd },
  };
}

function readNumber(parent: unknown, field: string, label: string): number {
  if (!parent || typeof parent !== 'object') {
    throw new Error(`${label}: parent must be an object.`);
  }
  const value = (parent as Record<string, unknown>)[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label}: должно быть числом, получено ${String(value)}.`);
  }
  return value;
}
