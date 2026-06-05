// Изолированный prisma+vec клиент для e2e-тестов 2.5 (см. ретро 2.5).
//
// Стратегия:
//   * beforeAll создаёт template.db в системном tmp через `prisma migrate deploy`
//     + `init-vec.ts` — это даёт чистую миграционную базу с правильно
//     настроенным sqlite-vec virtual table. Делается один раз на файл теста.
//   * beforeEach копирует template.db → test-<ulid>.db и подключает свежий
//     PrismaClient с `datasourceUrl=file:<test-path>`. Затраты: copyFileSync
//     <1ms + Prisma connect ~50ms.
//   * afterEach отключает Prisma и удаляет tempdir.
//   * afterAll удаляет template tempdir.
//
// Это поднимает существующий flake (тесты делят prisma/dev.db через
// `new PrismaClient()` на module level): когда один тест оставляет «живые»
// active intent.problem без diagnosis в окне 7 дней, следующий тест на
// `runIteration` может их подхватить через `selectPendingProblemIds`. С
// изолированной БД на тест — этого не происходит.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { type VecDatabase, getVecClient } from '../../src/db/client.js';

export interface IsolatedDb {
  prisma: PrismaClient;
  // vec клиент для теста (если нужен; multi-tests — без vec кроме merge-теста).
  // Загружается лениво: createIsolatedVecDb(filePath).
  filePath: string;
  dispose: () => Promise<void>;
}

export interface TemplateHandle {
  templatePath: string;
  templateDir: string;
  dispose: () => void;
}

// ---------------------------------------------------------------------------
// Установка template.db. Один раз на файл теста (beforeAll).
// ---------------------------------------------------------------------------

export function setupTemplateDb(): TemplateHandle {
  const templateDir = mkdtempSync(join(tmpdir(), 'cofounder-tmpl-'));
  const templatePath = join(templateDir, 'template.db');
  const env = { ...process.env, DATABASE_URL: `file:${templatePath}` };

  // Шаг 1. prisma migrate deploy — создаёт схему + триггеры + индексы.
  const deploy = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  if (deploy.status !== 0) {
    throw new Error(
      `setupTemplateDb: prisma migrate deploy failed (status=${deploy.status}). stderr=${deploy.stderr ?? ''}`,
    );
  }

  // Шаг 2. init-vec — virtual table sqlite-vec.
  const init = spawnSync('pnpm', ['exec', 'tsx', 'scripts/init-vec.ts'], {
    env,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  if (init.status !== 0) {
    throw new Error(
      `setupTemplateDb: init-vec failed (status=${init.status}). stderr=${init.stderr ?? ''}`,
    );
  }

  return {
    templatePath,
    templateDir,
    dispose: () => {
      try {
        rmSync(templateDir, { recursive: true, force: true });
      } catch {
        // best-effort, нечего больше делать
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Свежая БД на тест (beforeEach). Копирует template → tempdir/<ulid>.db.
// ---------------------------------------------------------------------------

export async function createIsolatedDb(template: TemplateHandle): Promise<IsolatedDb> {
  const dir = mkdtempSync(join(tmpdir(), 'cofounder-test-'));
  const filePath = join(dir, `${ulid()}.db`);
  copyFileSync(template.templatePath, filePath);
  // sqlite-wal/shm у template'а может присутствовать (CHECKPOINT(TRUNCATE) в
  // init-vec их сбрасывает, но защитимся): копируем при наличии. На copyFileSync
  // несуществующего файла — try/catch без эффекта.
  for (const suffix of ['-wal', '-shm']) {
    try {
      copyFileSync(`${template.templatePath}${suffix}`, `${filePath}${suffix}`);
    } catch {
      // suffix-файл не существует — норма после CHECKPOINT(TRUNCATE).
    }
  }

  const prisma = new PrismaClient({ datasourceUrl: `file:${filePath}` });
  await prisma.$connect();

  return {
    prisma,
    filePath,
    dispose: async () => {
      await prisma.$disconnect();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

// ---------------------------------------------------------------------------
// vec-клиент привязан к конкретному filePath. Не кэшируется в client.ts при
// явном filePath — getVecClient({ filePath }) каждый раз даёт свежий коннект.
// Используется только тестами, которым нужен sqlite-vec (merge — у нас на 2.5
// это mock'и, vec не нужен).
// ---------------------------------------------------------------------------

export function openVec(filePath: string): VecDatabase {
  return getVecClient({ filePath });
}
