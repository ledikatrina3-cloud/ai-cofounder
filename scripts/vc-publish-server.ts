#!/usr/bin/env tsx
// CLI launcher для HTTP bridge AI-Cofounder <-> vc.ru Chrome Extension.
//
// Запуск: pnpm tsx scripts/vc-publish-server.ts
//
// Слушает на http://localhost:7777. См. src/publish/vc-extension-bridge.ts
// для контракта API.

import { serve } from '@hono/node-server';
import { createBridge } from '../src/publish/vc-extension-bridge.js';

const PORT = Number(process.env.VC_BRIDGE_PORT ?? 7777);

const { app, queue } = createBridge();

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' });

console.log(`[vc-publish-server] listening on http://localhost:${PORT}`);
console.log('[vc-publish-server] endpoints:');
console.log('  GET  /health');
console.log('  GET  /queue/next          - extension polls');
console.log('  POST /queue/enqueue       - routine enqueues');
console.log('  POST /result              - extension reports');
console.log('  GET  /result/:taskId      - routine polls');
console.log('  GET  /debug/snapshot');
console.log('');
console.log(
  '[vc-publish-server] ready. Запусти extension в Chrome и нажми "Опубликовать следующее".',
);

// Не даём queue быть unused (только для возможного экспонирования через CLI).
void queue;

// Graceful shutdown.
process.on('SIGINT', () => {
  console.log('\n[vc-publish-server] shutting down');
  process.exit(0);
});
