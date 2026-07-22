// Дропает sqlite-vec virtual table перед `prisma migrate reset`.
//
// Без этого Prisma migrate reset пытается DROP TABLE vec_intent_problem через
// свой sqlite-driver, который не имеет sqlite-vec extension'а — DROP падает
// и оставляет файл в состоянии "database disk image is malformed".
//
// Скрипт идемпотентен: если БД пустая или таблицы нет — выходит без ошибки.
// Если БД отсутствует физически — тоже не падает (нечего дропать).

import { existsSync } from 'node:fs';
import {
  type VecDatabase,
  disposeVecClient,
  getVecClient,
  resolveSqliteFilePath,
} from '../src/db/client.js';
import { loadEmbeddingsConfig } from '../src/embeddings/config.js';

export function dropVecTable(db: VecDatabase, table: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new Error(`drop-vec: невалидное имя таблицы '${table}'.`);
  }
  // DROP TABLE virtual умеет только vec-aware connection. Через sqlite-driver
  // без extension'а это падает с "no such module" или "malformed disk image".
  db.exec(`DROP TABLE IF EXISTS ${table}`);
  // Сопутствующая map-table — обычная, можно дропнуть тем же клиентом.
  db.exec('DROP TABLE IF EXISTS IntentProblemVec');
}

async function main(): Promise<void> {
  const config = await loadEmbeddingsConfig();
  const filePath = resolveSqliteFilePath();
  if (!existsSync(filePath)) {
    // eslint-disable-next-line no-console
    console.log(`✓ drop-vec: ${filePath} не существует, нечего дропать`);
    return;
  }
  const db = getVecClient();
  dropVecTable(db, config.vecTable);
  // CHECKPOINT(TRUNCATE) сбрасывает WAL в основной файл и обнуляет журнал.
  // Без этого Prisma migrate reset, который идёт следующим в db:reset, видит
  // оставленный -wal и падает с "database disk image is malformed".
  db.pragma('wal_checkpoint(TRUNCATE)');
  disposeVecClient();
  // eslint-disable-next-line no-console
  console.log(`✓ drop-vec: dropped ${config.vecTable} и IntentProblemVec`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
