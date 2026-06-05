import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';

let loaded = false;

// Известные env-переменные (документация — не валидация):
//   * ANTHROPIC_API_KEY — ключ Anthropic API. Обязателен только при LLM_TRANSPORT=apikey.
//   * LLM_TRANSPORT — `apikey` (дефолт) | `oauth` (экспериментальный).
//     См. src/llm/transport.ts. Переключает оба пути (call.ts и subagent.ts) на
//     API-key либо на gateway-маршрут.
//   * LLM_GATEWAY_URL — base URL локального gateway'а (дефолт
//     `http://127.0.0.1:8787`). Активен только при oauth.
//   * CLAUDE_CLI_PATH — путь к бинарю `claude` (дефолт ищем в PATH).
//     Активен только при oauth — используется в src/llm/subagent-cli.ts.
//   * DATABASE_URL — путь к SQLite-файлу для Prisma.

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  // .env.local перекрывает .env. Загружаем .env.local первым: dotenv не перетирает уже выставленные переменные.
  // Конвенция стека: dev-секреты в .env.local (CLAUDE.md:32), .env — DATABASE_URL и публичные дефолты.
  for (const file of ['.env.local', '.env']) {
    const path = resolve(process.cwd(), file);
    if (existsSync(path)) {
      config({ path });
    }
  }
}
