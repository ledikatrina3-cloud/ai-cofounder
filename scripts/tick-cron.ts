// Cron-тик утреннего детектива — то, что зовёт launchd в 07:00 локального времени мака
// (infrastructure/launchd/com.ai-cofounder.morning-detective.plist).
// idempotencyKey = morning-detective:YYYY-MM-DD; повторный запуск в ту же дату → audit.repeat.

import { checkKpiAlerts } from '../src/analytics/alerts.js';
import { collectAnalyticsForPublished } from '../src/analytics/collector.js';
import { runIteration } from '../src/core/loop.js';
import { triggerCronMorning } from '../src/core/triggers.js';
import { disposePrisma, getPrisma } from '../src/db/client.js';
import { recoverPipelines } from '../src/pipelines/recover.js';

async function main(): Promise<void> {
  const db = getPrisma();
  try {
    // Фаза 5: при cron-tick'е проверяем, есть ли «зависшие» pipeline'ы
    // (мак уснул посреди работы, бот перезагрузился). recover.ts продолжит
    // их с того же места. best-effort: ошибки логируем, но дальнейший
    // runIteration не блокируем.
    try {
      const rec = await recoverPipelines();
      if (rec.recovered > 0) {
        console.log(`[tick:cron] recovered ${rec.recovered} pipelines (${JSON.stringify(rec)})`);
      }
    } catch (err) {
      console.error('[tick:cron] recoverPipelines failed (best-effort):', err);
    }

    const result = await runIteration(triggerCronMorning(), { db });
    console.log(JSON.stringify(result));

    // Фаза 8 (analytics): раз в день, при том же утреннем тике, собираем
    // метрики опубликованных постов и проверяем KPI alerts. Best-effort:
    // если что-то упало — основной runIteration уже отработал и важных побочных
    // эффектов от analytics никто не ждёт.
    try {
      const ac = await collectAnalyticsForPublished({ db });
      console.log(`[tick:cron] analytics:collect ${JSON.stringify(ac)}`);
    } catch (err) {
      console.error('[tick:cron] analytics:collect failed (best-effort):', err);
    }
    try {
      const ak = await checkKpiAlerts({ db });
      console.log(
        `[tick:cron] analytics:check sent=${ak.sent.length} skipped=${ak.skippedAsDuplicate.length}`,
      );
    } catch (err) {
      console.error('[tick:cron] analytics:check failed (best-effort):', err);
    }
  } finally {
    await disposePrisma();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
