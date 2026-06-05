// CLI-точка входа для `pnpm bridge:server` — поднимает только Hono без Electron.
// План 1.5a (критерий «сделано»): curl -X POST localhost:3737/event/test ... должен
// проходить без открытия GUI-окна. Это и есть форма smoke-теста сервера, которую
// агент 1.5a проверяет сам, не запуская Electron.

import { startBridgeServer } from './server.js';

async function main(): Promise<void> {
  const handle = await startBridgeServer();
  console.log(`[bridge.server] listening on http://127.0.0.1:${handle.port}`);
  console.log(`[bridge.server] sessionId=${handle.sessionId}`);
  console.log(`[bridge.server] jsonl=${handle.jsonlPath}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[bridge.server] received ${signal}, closing...`);
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[bridge.server] fatal:', err);
  process.exit(1);
});
