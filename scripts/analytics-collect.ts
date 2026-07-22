// scripts/analytics-collect.ts — собирает аналитику для опубликованных постов.
//
// Использование:
//   pnpm analytics:collect
//
// Что делает:
//   1. Через src/analytics/collector.collectAnalyticsForPublished() находит
//      все опубликованные посты (по content/published/<platform>/*.md +
//      pipeline.state fallback), вызывает skills/analytics-traffic/scripts/collect.ts
//      на каждую платформу и пишет результаты как signal.metric Records.
//   2. Дедуп per-day гарантирован collector'ом.
//   3. Печатает JSON-сводку. Exit 0 даже если 0 постов — это валидный кейс.

import { collectAnalyticsForPublished } from '../src/analytics/collector.js';
import { disposePrisma } from '../src/db/client.js';

async function main(): Promise<void> {
  const summary = await collectAnalyticsForPublished();
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void disposePrisma();
  });
