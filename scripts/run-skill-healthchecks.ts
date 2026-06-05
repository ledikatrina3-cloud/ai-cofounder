// scripts/run-skill-healthchecks.ts — CLI запускающий health-check для всех
// скиллов, у которых в permissions.md задано поле `healthCheck`.
//
// Используется:
//   * Локально: `pnpm health:run`
//   * launchd (один cron на всю пачку, см. install-skill-healthchecks-launchd.ts).
//
// Что делает:
//   1. listSkills() → фильтр по permissions.healthCheck != undefined.
//   2. Для каждого — runHealthCheck() (taймаут 30s внутри).
//   3. saveHealthCheck() → INSERT Record('skill.health.check').
//   4. alertFounderOnFailure() если status='failed' — Telegram alert.
//   5. Печатает сводку в stdout.
//
// Exit code: 0 если все ok/skipped, 1 если есть хоть один failed (это влияет
// на launchd retry-семантику, но мы запускаем по фикс-расписанию — exit-code
// важен только для CI/ручной отладки).

import { disposePrisma } from '../src/db/client.js';
import { alertFounderOnFailure } from '../src/skills/health-alert.js';
import { saveHealthCheck } from '../src/skills/health-store.js';
import { runHealthCheck } from '../src/skills/health.js';
import { listSkills } from '../src/skills/registry.js';

async function main(): Promise<void> {
  const all = await listSkills();
  const withHealthCheck = all.filter((s) => s.permissions.healthCheck !== undefined);

  if (withHealthCheck.length === 0) {
    console.log('Нет скиллов с healthCheck. Нечего запускать.');
    return;
  }

  console.log(`Запускаю health-check для ${withHealthCheck.length} скилл(ов):`);
  for (const s of withHealthCheck) {
    console.log(`  - ${s.name} (schedule: ${s.permissions.healthCheck?.schedule})`);
  }
  console.log('');

  let failedCount = 0;

  // Последовательно, не параллельно. Health-check'и обычно открывают
  // browser (vc-publishing) и параллелить их — проиграть в надёжности
  // ради экономии секунд.
  for (const skill of withHealthCheck) {
    const startedAt = Date.now();
    process.stdout.write(`▶ ${skill.name} … `);
    const result = await runHealthCheck(skill.name);
    const duration = Date.now() - startedAt;

    try {
      await saveHealthCheck(result);
    } catch (err) {
      console.error(`\n[save] ${skill.name}: ${(err as Error).message}`);
    }

    if (result.status === 'failed') {
      failedCount++;
      console.log(`✗ ${result.error ?? 'failed'} (${duration}ms)`);
      try {
        await alertFounderOnFailure(result);
      } catch (err) {
        console.error(`[alert] ${skill.name}: ${(err as Error).message}`);
      }
    } else if (result.status === 'ok') {
      console.log(`✓ ok (${duration}ms)`);
    } else {
      console.log(`- skipped: ${result.reason ?? 'no health-check'}`);
    }
  }

  console.log('');
  console.log(`Готово. failed=${failedCount}, total=${withHealthCheck.length}`);

  if (failedCount > 0) {
    process.exitCode = 1;
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
