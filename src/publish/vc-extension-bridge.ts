// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE ADAPTER (не ядро движка). Опциональный мост под vc.ru-публикацию
// через Chrome Extension. Дефолт AI-Cofounder — self-contained вывод в content/;
// внешняя публикация подключается только через agents/<id>/target.yml.
// ─────────────────────────────────────────────────────────────────────────────
// HTTP-мост ai-cofounder <-> Chrome Extension vc-publisher.
//
// API:
//   GET  /health           -> { ok: true }
//   GET  /queue/next       -> { has_work: bool, taskId?, title, blocks, cover_data_url, category, tags }
//   POST /queue/enqueue    -> body { title, blocks, cover_path, category, tags } -> { taskId }
//   POST /result           -> body { taskId, result } -> { ok: true }
//   GET  /result/:taskId   -> { status: 'pending'|'success'|'error', url?, error? }
//
// Контракт с Extension:
// - Extension polls /queue/next каждые 30 сек (chrome.alarms).
// - При has_work=true - открывает vc.ru/?modal=editor и публикует через content-main.
// - Постит /result с url или error.
//
// Контракт с ai-cofounder routine:
// - Routine генерит draft (build-vc-spoke) -> кладёт в очередь POST /queue/enqueue.
// - Получает taskId -> опрашивает GET /result/:taskId раз в N секунд до 5 минут.
// - На success -> UPDATE GuideExternalPublication.

import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { ulid } from 'ulid';
import type { EditorJsBlock } from './markdown-to-editorjs.js';

export interface PublishTask {
  taskId: string;
  title: string;
  blocks: EditorJsBlock[];
  cover_data_url: string | null;
  category: string | null;
  tags: string[];
  /** Когда создана задача. Для cleanup старых. */
  createdAt: number;
}

export interface PublishResultRecord {
  taskId: string;
  status: 'pending' | 'success' | 'error';
  url?: string;
  error?: string;
  finishedAt?: number;
}

export class PublishQueue {
  private readonly tasks: PublishTask[] = [];
  private readonly results = new Map<string, PublishResultRecord>();
  /** Tasks, отданные в /queue/next и ещё не завершённые. */
  private readonly inFlight = new Set<string>();

  enqueue(task: Omit<PublishTask, 'taskId' | 'createdAt'>): string {
    const taskId = `vc-${ulid()}`;
    this.tasks.push({ ...task, taskId, createdAt: Date.now() });
    this.results.set(taskId, { taskId, status: 'pending' });
    return taskId;
  }

  /** Вернуть следующую задачу для extension'а. */
  nextTask(): PublishTask | null {
    while (this.tasks.length > 0) {
      const t = this.tasks.shift();
      if (t === undefined) return null;
      if (this.inFlight.has(t.taskId)) continue;
      this.inFlight.add(t.taskId);
      return t;
    }
    return null;
  }

  /** Записать результат от extension'а. */
  saveResult(taskId: string, payload: { success?: boolean; url?: string; error?: string }): void {
    this.inFlight.delete(taskId);
    if (payload.success === true && typeof payload.url === 'string') {
      this.results.set(taskId, {
        taskId,
        status: 'success',
        url: payload.url,
        finishedAt: Date.now(),
      });
    } else {
      this.results.set(taskId, {
        taskId,
        status: 'error',
        error: payload.error ?? 'unknown',
        finishedAt: Date.now(),
      });
    }
  }

  getResult(taskId: string): PublishResultRecord | null {
    return this.results.get(taskId) ?? null;
  }

  /** Все pending задачи (для UI отладки). */
  snapshot(): { pending: PublishTask[]; inFlight: string[]; results: PublishResultRecord[] } {
    return {
      pending: [...this.tasks],
      inFlight: [...this.inFlight],
      results: [...this.results.values()],
    };
  }
}

export interface BridgeOptions {
  queue?: PublishQueue;
  /** DI для тестов / для асинхронной загрузки файла обложки. */
  readFile?: (path: string) => Promise<Buffer>;
}

export function createBridge(opts: BridgeOptions = {}): {
  app: Hono;
  queue: PublishQueue;
} {
  const queue = opts.queue ?? new PublishQueue();
  const reader = opts.readFile ?? readFile;
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }));

  app.get('/queue/next', (c) => {
    const t = queue.nextTask();
    if (t === null) return c.json({ has_work: false });
    return c.json({
      has_work: true,
      taskId: t.taskId,
      title: t.title,
      blocks: t.blocks,
      cover_data_url: t.cover_data_url,
      category: t.category,
      tags: t.tags,
    });
  });

  app.post('/queue/enqueue', async (c) => {
    const body = (await c.req.json()) as {
      title: string;
      blocks: EditorJsBlock[];
      cover_path?: string | null;
      category?: string | null;
      tags?: string[];
    };
    if (!body.title || !Array.isArray(body.blocks)) {
      return c.json({ error: 'title and blocks[] required' }, 400);
    }

    let cover_data_url: string | null = null;
    if (body.cover_path) {
      try {
        const buf = await reader(body.cover_path);
        const mime =
          body.cover_path.toLowerCase().endsWith('.jpg') ||
          body.cover_path.toLowerCase().endsWith('.jpeg')
            ? 'image/jpeg'
            : 'image/png';
        cover_data_url = `data:${mime};base64,${buf.toString('base64')}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: `cover read failed: ${msg}` }, 400);
      }
    }

    const taskId = queue.enqueue({
      title: body.title,
      blocks: body.blocks,
      cover_data_url,
      category: body.category ?? null,
      tags: body.tags ?? [],
    });
    return c.json({ taskId });
  });

  app.post('/result', async (c) => {
    const body = (await c.req.json()) as {
      taskId: string;
      result?: {
        success?: boolean;
        url?: string;
        error?: string;
        skipped?: boolean;
        reason?: string;
      };
    };
    if (!body.taskId) return c.json({ error: 'taskId required' }, 400);
    if (body.result?.skipped) {
      // Tab закрылась / no work - не помечаем как failed.
      return c.json({ ok: true, skipped: true });
    }
    queue.saveResult(body.taskId, body.result ?? {});
    return c.json({ ok: true });
  });

  app.get('/result/:taskId', (c) => {
    const r = queue.getResult(c.req.param('taskId'));
    if (r === null) return c.json({ error: 'not found' }, 404);
    return c.json(r);
  });

  app.get('/debug/snapshot', (c) => c.json(queue.snapshot()));

  // Diagnostic dumps от content-main для отладки.
  const diagDumps: Array<{ ts: number; payload: unknown }> = [];
  app.post('/diag', async (c) => {
    const payload = await c.req.json().catch(() => ({}));
    diagDumps.push({ ts: Date.now(), payload });
    if (diagDumps.length > 50) diagDumps.shift();
    console.log('[bridge:diag]', JSON.stringify(payload).slice(0, 800));
    return c.json({ ok: true });
  });
  app.get('/diag', (c) => c.json(diagDumps));

  return { app, queue };
}
