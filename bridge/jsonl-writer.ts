// Append-only JSONL-запись событий сессии Bridge.
// Путь: ~/Library/Application Support/AI-Cofounder/sessions/<sessionUlid>.jsonl.
// Каждый старт Bridge генерирует свой sessionUlid → новый файл; старые остаются
// (требование плана 1.5a: «Перезапуск Bridge не теряет старые JSONL»).
//
// MVP: открываем-пишем-закрываем на каждой записи через fs.appendFile.
// Это синхронизуется с диском при возврате promise (Node делает write+close).
// Для будущей оптимизации (M3, когда событий 20+/сек) — можно держать fd
// открытым; сейчас простота важнее. Запись fail-soft в лог, не throw — потеря
// одного события в JSONL не должна обрушить Bridge во время эфира.

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { sessionsDir } from './config.js';
import type { BridgeEvent } from './events.js';

export interface JsonlSession {
  sessionId: string;
  filePath: string;
  write(event: BridgeEvent): Promise<void>;
}

// Один Bridge-процесс = одна сессия. Имя файла = sessionUlid.jsonl.
// Возвращаем объект с методом write — у вызывающего нет доступа к state и
// не может случайно перезаписать filePath.
export async function startJsonlSession(): Promise<JsonlSession> {
  const sessionId = ulid();
  const dir = sessionsDir();
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);

  return {
    sessionId,
    filePath,
    async write(event: BridgeEvent): Promise<void> {
      const line = `${JSON.stringify(event)}\n`;
      try {
        await appendFile(filePath, line, { encoding: 'utf8' });
      } catch (err) {
        // Не валим Bridge из-за одной строки. Печатаем в stderr, чтобы оператор
        // увидел проблему (диск переполнен, нет прав), но дальше работаем.
        console.error(`[bridge.jsonl] не удалось записать событие в ${filePath}:`, err);
      }
    },
  };
}
