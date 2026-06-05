// run-pipeline — ручной запуск executePipeline для department.
//
// Использование:
//   pnpm exec tsx scripts/run-pipeline.ts <dept-id>
//
// Загружает department из departments/<dept-id>/, генерит runId через ulid,
// вызывает executePipeline(dept, runId). Логирует Bridge events в stdout.
//
// НЕ заменяет launchd / cron — это ручная кнопка для smoke-теста и
// dev-итераций. В продакшене pipeline'ы запускаются по schedule из
// pipeline.yml (через src/pipelines/scheduler — TODO в следующих фазах).

import { fileURLToPath } from 'node:url';
import { ulid } from 'ulid';
import { getDepartment } from '../src/departments/registry.js';
import { executePipeline } from '../src/pipelines/executor.js';

async function main(): Promise<void> {
  const deptId = process.argv[2];
  if (deptId === undefined || deptId === '') {
    console.error('Usage: pnpm exec tsx scripts/run-pipeline.ts <dept-id>');
    console.error('  e.g. pnpm exec tsx scripts/run-pipeline.ts marketing-content');
    process.exit(1);
  }

  const dept = await getDepartment(deptId);
  if (dept === null) {
    console.error(`✗ department '${deptId}' не найден в departments/.`);
    console.error(`  Возможно, нужно: pnpm dept:instantiate ${deptId}`);
    process.exit(2);
  }

  const runId = ulid();
  console.log(`▶ Pipeline '${deptId}' runId=${runId}`);
  console.log(`  Nodes: ${dept.pipeline.nodes.length}`);
  console.log('');

  try {
    const result = await executePipeline(dept, runId);
    console.log('');
    console.log(`✓ Pipeline завершён. Status: ${result.status}`);
    console.log(`  Длительность: ${Math.round((result.endedAt - result.startedAt) / 1000)}s`);
    console.log('  Node statuses:');
    for (const [nodeId, status] of Object.entries(result.nodeStatuses)) {
      console.log(`    ${nodeId}: ${status}`);
    }
    console.log('  Artifacts:');
    for (const [k, v] of Object.entries(result.artifacts)) {
      console.log(`    ${k}: ${v}`);
    }
    process.exit(result.status === 'success' ? 0 : 1);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗ Pipeline упал: ${msg}`);
    process.exit(1);
  }
}

const isMainEntry = fileURLToPath(import.meta.url) === process.argv[1];
if (isMainEntry) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
