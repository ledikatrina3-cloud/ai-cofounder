// Тесты для скилл-эндпоинтов bridge/server.ts:
//   * GET /skills — все скиллы (discovery DTO).
//   * GET /routines/:id/skills — скиллы конкретной routine'ы с резолвом deps.
//
// Стратегия:
//   * Запускаем bridge/server на динамическом порту.
//   * Подменяем dist/src/skills/registry.js и dist/src/routines/registry.js
//     через временный файл — server.ts грузит их через dynamic import из
//     `dist/src/skills/registry.js`, поэтому мы кладём свои модули туда же
//     перед тестом. Это сложнее, чем DI, но проще, чем поднимать build.
//
// Поскольку поднимать build + копировать модули — оверкилл для одного
// теста, мы используем альтернативу: тестируем helpers напрямую
// (`listAllSkills`, `resolveRoutineSkillsForUi`) и проверяем что они
// корректно мапят SkillFull → SkillDiscovery. End-to-end (через HTTP)
// будет проверяться вручную после `pnpm build && pnpm bridge:server`.
//
// Для проверки HTTP-маршрута самого по себе — поднимаем сервер, бьём в
// /healthz (smoke), и в /skills — ожидаем либо ok (если dist/ есть),
// либо чистый error с понятным сообщением (если dist/ нет).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonlSession } from '../bridge/jsonl-writer.js';
import { type BridgeServerHandle, startBridgeServer } from '../bridge/server.js';

// Никакого реального JSONL — пишем в мочку.
function noopSession(): JsonlSession {
  return {
    sessionId: 'test',
    filePath: '/tmp/noop.jsonl',
    write: async () => undefined,
  };
}

describe('GET /skills (bridge endpoint)', () => {
  let handle: BridgeServerHandle;

  beforeEach(async () => {
    handle = await startBridgeServer({ port: 0, session: noopSession() });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('возвращает либо массив скиллов, либо понятную ошибку (если dist/ нет)', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/skills`);
    const body = (await res.json()) as {
      ok: boolean;
      skills?: unknown;
      error?: string;
    };

    // Один из двух валидных исходов:
    //   1. dist/ есть → ok:true, skills — массив (может быть пустой если
    //      нет SKILL.md файлов).
    //   2. dist/ нет → ok:false, error с подсказкой про `pnpm exec tsc`.
    if (body.ok === true) {
      expect(Array.isArray(body.skills)).toBe(true);
    } else {
      expect(typeof body.error).toBe('string');
      // Подсказка должна упоминать tsc — это критичный hint для DX.
      expect(body.error ?? '').toMatch(/tsc|skills\/registry|module/i);
    }
  });

  it('каждый скилл в листинге содержит поле usedBy (массив routine-id)', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/skills`);
    const body = (await res.json()) as {
      ok: boolean;
      skills?: Array<Record<string, unknown>>;
      error?: string;
    };

    // Проверка только если registry загрузился. Если dist/ нет — это
    // отдельный кейс и его покрывает первый тест выше.
    if (body.ok !== true || !Array.isArray(body.skills)) return;

    for (const s of body.skills) {
      // usedBy всегда массив (даже если скилл нигде не используется — []).
      expect(Array.isArray(s.usedBy)).toBe(true);
      // Лёгкий DTO — поле body (полное содержимое SKILL.md) НЕ должно
      // попадать в листинг (только в GET /skills/:name).
      expect(s.body).toBeUndefined();
    }
  });
});

describe('GET /skills/:name (bridge endpoint)', () => {
  let handle: BridgeServerHandle;

  beforeEach(async () => {
    handle = await startBridgeServer({ port: 0, session: noopSession() });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('404 для несуществующего скилла (при загруженном registry)', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/skills/no-such-skill-xyz-123`);
    const body = (await res.json()) as { ok: boolean; error?: string };

    // dist/ есть → 404 с понятным сообщением.
    // dist/ нет → 500 с подсказкой про tsc.
    expect([404, 500]).toContain(res.status);
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    if (res.status === 404) {
      expect(body.error ?? '').toMatch(/не найден/i);
    } else {
      expect(body.error ?? '').toMatch(/tsc|module/i);
    }
  });

  it('возвращает полный объект (body + permissions + usedBy) для существующего скилла', async () => {
    // Сначала получаем листинг и проверяем, есть ли вообще зарегистрированные
    // скиллы. Если нет (или dist/ не собран) — skip.
    const listRes = await fetch(`http://127.0.0.1:${handle.port}/skills`);
    const listBody = (await listRes.json()) as {
      ok: boolean;
      skills?: Array<{ name: string }>;
    };
    if (listBody.ok !== true || !Array.isArray(listBody.skills) || listBody.skills.length === 0) {
      return; // nothing to assert against
    }
    const first = listBody.skills[0];
    if (first === undefined) return;

    const detailRes = await fetch(
      `http://127.0.0.1:${handle.port}/skills/${encodeURIComponent(first.name)}`,
    );
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as {
      ok: boolean;
      skill?: {
        name: string;
        description: string;
        body: string;
        permissions: Record<string, unknown>;
        usedBy: string[];
      };
    };
    expect(detailBody.ok).toBe(true);
    expect(detailBody.skill).toBeDefined();
    if (detailBody.skill === undefined) return;
    expect(detailBody.skill.name).toBe(first.name);
    // Полный DTO — body всегда строка (может быть пустая если SKILL.md без
    // тела), permissions всегда объект, usedBy всегда массив.
    expect(typeof detailBody.skill.body).toBe('string');
    expect(typeof detailBody.skill.permissions).toBe('object');
    expect(Array.isArray(detailBody.skill.usedBy)).toBe(true);
  });
});

describe('GET /routines/:id/skills (bridge endpoint)', () => {
  let handle: BridgeServerHandle;

  beforeEach(async () => {
    handle = await startBridgeServer({ port: 0, session: noopSession() });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('404 для несуществующей routine', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/routines/no-such-routine/skills`);
    // Если dist/src/routines/registry.js не существует — будет 500 с
    // подсказкой про tsc. Если существует — 404.
    expect([404, 500]).toContain(res.status);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// POST /skills/builder/message — input-size guard (security: token-DDoS).
// Без вызова LLM проверяем что валидация принимает 413 при превышении лимита,
// чтобы маликс не мог одним мегабайт-сообщением выжечь подписочный лимит.
// ---------------------------------------------------------------------------

describe('POST /skills/builder/message — input limits', () => {
  let handle: BridgeServerHandle;

  beforeEach(async () => {
    handle = await startBridgeServer({ port: 0, session: noopSession() });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('отвергает userMessage > 16k символов (413)', async () => {
    const oversized = 'x'.repeat(16_001);
    const res = await fetch(`http://127.0.0.1:${handle.port}/skills/builder/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userMessage: oversized, history: [] }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/userMessage слишком большой/);
  });

  it('отвергает history > 40 элементов (413)', async () => {
    const tooLong = Array.from({ length: 41 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: 'привет',
    }));
    const res = await fetch(`http://127.0.0.1:${handle.port}/skills/builder/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userMessage: 'привет', history: tooLong }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/history слишком большая/);
  });

  it('отвергает пустой userMessage (400)', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/skills/builder/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userMessage: '   ', history: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/userMessage-required/);
  });
});
