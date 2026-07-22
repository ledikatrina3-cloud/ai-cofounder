// Идемпотентный init для sqlite-vec virtual table `vec_intent_problem`.
//
// Почему отдельный скрипт, а не миграция Prisma:
//   * `prisma migrate deploy` запускает SQL через свой sqlite-driver, в котором
//     `SELECT load_extension(...)` не разрешён (`sqlite3_enable_load_extension`
//     отключён). Любая миграция с `CREATE VIRTUAL TABLE ... USING vec0(...)`
//     упадёт на applied-этапе.
//   * Если бы и работала — Prisma считала бы virtual table drift'ом схемы и
//     пыталась её «починить» при следующем `prisma db push`.
//   * `CREATE VIRTUAL TABLE IF NOT EXISTS` идемпотентен; запуск 100 раз подряд
//     ничего не ломает.
//
// Когда вызывается:
//   1) Из `pnpm db:reset` — сразу после `prisma migrate reset`.
//   2) Из `pnpm db:migrate` — после `prisma migrate deploy`.
//   3) В тестах через `initVecSchema(vecClient, dim)` — без CLI-обёртки.
//   4) Опционально — на старте процесса (idempotent) для self-heal'а после
//      ручной правки БД. Сейчас не подключено в runIteration; добавим в 2.5.

import { type VecDatabase, disposeVecClient, getVecClient } from '../src/db/client.js';
import { loadEmbeddingsConfig } from '../src/embeddings/config.js';

export function initVecSchema(db: VecDatabase, table: string, dim: number): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new Error(`init-vec: невалидное имя таблицы '${table}'.`);
  }
  if (!Number.isInteger(dim) || dim <= 0 || dim > 4096) {
    throw new Error(`init-vec: dim должна быть положительным целым ≤ 4096 (получено ${dim}).`);
  }
  // distance_metric=cosine фиксируем здесь, чтобы не тащить ещё один параметр
  // в config. Дедуп по семантике — единственное использование таблицы; cosine
  // — каноничный выбор для текстовых embedding'ов.
  // Имя таблицы и dim подставляются через интерполяцию (не bind), потому что
  // CREATE VIRTUAL TABLE не поддерживает bind-параметры. Имя проверено regex'ом
  // выше; dim — целочисленной проверкой.
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(embedding float[${dim}] distance_metric=cosine)`,
  );
}

async function main(): Promise<void> {
  const config = await loadEmbeddingsConfig();
  const db = getVecClient();
  initVecSchema(db, config.vecTable, config.dim);
  // sanity: если таблица была создана с другим dim в прошлом — IF NOT EXISTS
  // её не пересоздаст. Проверим, что vec-extension умеет читать таблицу,
  // и предупредим, если не умеет.
  const row = db.prepare('SELECT vec_version() as v').get() as { v: string } | undefined;
  if (row === undefined) {
    throw new Error('init-vec: vec_version() недоступна — sqlite-vec не загрузился.');
  }
  // Sanity-INSERT/DELETE отдельным временным rowid'ом, чтобы убедиться что
  // dim совпадает. Если не совпадает — sqlite-vec падает на INSERT.
  const sentinelRowid = -1n;
  const empty = new Float32Array(config.dim);
  try {
    db.prepare(`INSERT INTO ${config.vecTable}(rowid, embedding) VALUES (?, ?)`).run(
      sentinelRowid,
      Buffer.from(empty.buffer),
    );
    db.prepare(`DELETE FROM ${config.vecTable} WHERE rowid = ?`).run(sentinelRowid);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `init-vec: dim mismatch для ${config.vecTable} — ожидался ${config.dim}, но vec-таблица его не принимает (${msg}). Пересоздай БД: pnpm db:reset (требует PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION).`,
    );
  }
  // CHECKPOINT(TRUNCATE) сбрасывает WAL → основной файл. Без этого процесс
  // выходит, оставляя -wal/-shm; следующий запуск Prisma может видеть
  // несогласованное состояние.
  db.pragma('wal_checkpoint(TRUNCATE)');
  disposeVecClient();
  // eslint-disable-next-line no-console
  console.log(`✓ vec_version=${row.v}, table=${config.vecTable}, dim=${config.dim}, metric=cosine`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
