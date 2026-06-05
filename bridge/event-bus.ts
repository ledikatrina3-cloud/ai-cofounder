// Event-bus в Main-процессе Bridge (мостик.md L233 «eventemitter3»).
// Все источники (HTTP-приёмник /event/*, в будущем — Electron preload IPC,
// SDK driver для DEMO-режима) публикуют в эту шину; Renderer/JSONL-writer
// слушают. Один разделяемый singleton — никаких локальных шин «по компоненту»,
// иначе Replay/JSONL и Renderer увидят разные потоки.

import { EventEmitter } from 'eventemitter3';
import type { BridgeEvent } from './events.js';

export interface BridgeBusEvents {
  event: (event: BridgeEvent) => void;
}

class BridgeBus extends EventEmitter<BridgeBusEvents> {
  publish(event: BridgeEvent): void {
    this.emit('event', event);
  }
}

let cached: BridgeBus | null = null;

export function getBridgeBus(): BridgeBus {
  if (cached === null) cached = new BridgeBus();
  return cached;
}

// Только для тестов: позволить горячий reset шины между прогонами.
export function resetBridgeBusForTesting(): void {
  cached?.removeAllListeners();
  cached = null;
}
