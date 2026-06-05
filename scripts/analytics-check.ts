// scripts/analytics-check.ts — проверяет KPI alerts (cost spike / traffic drop /
// kpi floor) и шлёт фаундеру алёрт через Telegram (best-effort) и Bridge event.
//
// Использование:
//   pnpm analytics:check
//
// Запускается на cron вместе с pnpm analytics:collect (например, ежедневно в 8:00).
// Дедуп per-condition per-day сделан в checkKpiAlerts.

import { checkKpiAlerts } from '../src/analytics/alerts.js';
import { disposePrisma } from '../src/db/client.js';

async function main(): Promise<void> {
  const result = await checkKpiAlerts();
  console.log(JSON.stringify(result, null, 2));
  if (result.sent.length > 0) {
    process.exitCode = 0;
  }
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void disposePrisma();
  });
