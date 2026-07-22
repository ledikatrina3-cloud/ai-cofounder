// Тесты для src/report/render.ts (фаза 3.3).
//
// Без I/O, без БД: файловый ридер подменяется DI-моком.
// Тесты покрывают: дефолтный шаблон, overflow split, кастомный шаблон,
// статусы failed/timeout, подстановку плейсхолдеров.

import { describe, expect, it } from 'vitest';
import { renderRoutineOutput, splitForTelegram } from '../src/report/render.js';

// ---------------------------------------------------------------------------
// Хелперы.
// ---------------------------------------------------------------------------

/** Мок-ридер, который всегда бросает ENOENT (шаблонов нет → дефолт). */
async function noTemplateReader(_path: string): Promise<string> {
  throw new Error('ENOENT: no such file or directory');
}

/** Мок-ридер, который возвращает фиксированный шаблон. */
function fixedTemplateReader(content: string) {
  return async (_path: string): Promise<string> => content;
}

/** Мок-ридер для тестирования поиска по routineId: первый запрос бросает, второй возвращает шаблон. */
function firstMissSecondHit(templateContent: string) {
  let called = 0;
  return async (_path: string): Promise<string> => {
    called++;
    if (called === 1) throw new Error('ENOENT: no such file');
    return templateContent;
  };
}

function makeRoutine(
  overrides: Partial<{ id: string; description: string; outputType: string }> = {},
) {
  return {
    id: 'example-noop',
    description: 'Ночной детектив',
    outputType: 'telegram-thread',
    ...overrides,
  };
}

function makeResult(
  overrides: Partial<{ status: string; output: string; totalUsd: number; durationMs: number }> = {},
) {
  return {
    status: 'ok',
    output: 'Всё работает штатно.',
    totalUsd: 0.0012,
    durationMs: 1234,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. renderRoutineOutput с дефолтным шаблоном.
// ---------------------------------------------------------------------------

describe('renderRoutineOutput — дефолтный шаблон', () => {
  it('возвращает сообщение, содержащее description, status, usd, output', async () => {
    const routine = makeRoutine({ description: 'Ночной детектив' });
    const result = makeResult({
      status: 'ok',
      output: 'Всё ок',
      totalUsd: 0.0055,
      durationMs: 500,
    });

    const messages = await renderRoutineOutput(routine, result, { readTemplate: noTemplateReader });

    expect(messages.length).toBeGreaterThanOrEqual(1);
    const fullText = messages.map((m) => m.text).join('\n\n');
    expect(fullText).toContain('Ночной детектив');
    expect(fullText).toContain('ok');
    expect(fullText).toContain('0.0055');
    expect(fullText).toContain('Всё ок');
  });

  it('содержит durationMs в итоговом тексте', async () => {
    const routine = makeRoutine();
    const result = makeResult({ durationMs: 9999 });

    const messages = await renderRoutineOutput(routine, result, { readTemplate: noTemplateReader });
    const fullText = messages.map((m) => m.text).join('\n\n');
    expect(fullText).toContain('9999');
  });
});

// ---------------------------------------------------------------------------
// 2. Длинный output > 4096 → несколько TelegramMessage.
// ---------------------------------------------------------------------------

describe('renderRoutineOutput — overflow', () => {
  it('output длиннее 4096 → возвращает >1 TelegramMessage', async () => {
    const longOutput = 'A'.repeat(5000);
    const routine = makeRoutine();
    const result = makeResult({ output: longOutput });

    const messages = await renderRoutineOutput(routine, result, { readTemplate: noTemplateReader });
    expect(messages.length).toBeGreaterThan(1);
    for (const msg of messages) {
      expect(msg.text.length).toBeLessThanOrEqual(4096);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. splitForTelegram — 5000 символов → 2 части, обе ≤ 4096.
// ---------------------------------------------------------------------------

describe('splitForTelegram', () => {
  it('строка 5000 символов → split на 2 части, обе ≤ 4096', () => {
    const text = 'X'.repeat(5000);
    const parts = splitForTelegram(text);
    expect(parts.length).toBe(2);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(4096);
    }
  });

  it('строка 100 символов → 1 часть', () => {
    const text = 'Hello world'.repeat(5); // 55 символов
    const parts = splitForTelegram(text);
    expect(parts.length).toBe(1);
    expect(parts[0]).toBe(text);
  });

  it('строка ровно 4096 символов → 1 часть', () => {
    const text = 'Z'.repeat(4096);
    const parts = splitForTelegram(text);
    expect(parts.length).toBe(1);
  });

  it('строка 4097 символов → 2 части', () => {
    const text = 'Z'.repeat(4097);
    const parts = splitForTelegram(text);
    expect(parts.length).toBe(2);
  });

  it('разбивает по абзацам если возможно', () => {
    // Два абзаца по 2048 символов: объединённый (4096 + 2 для \n\n) = 4098 > 4096.
    const paragraph = 'A'.repeat(2048);
    const text = `${paragraph}\n\n${paragraph}`;
    // 4098 символов — чуть больше лимита 4096.
    const parts = splitForTelegram(text, 4096);
    expect(parts.length).toBe(2);
    expect(parts[0]).toBe(paragraph);
    expect(parts[1]).toBe(paragraph);
  });
});

// ---------------------------------------------------------------------------
// 4. Статусы failed и timeout.
// ---------------------------------------------------------------------------

describe('renderRoutineOutput — статусы', () => {
  it("status='timeout' → первое сообщение содержит 'timeout'", async () => {
    const routine = makeRoutine();
    const result = makeResult({ status: 'timeout' });

    const messages = await renderRoutineOutput(routine, result, { readTemplate: noTemplateReader });
    expect(messages[0]?.text).toContain('timeout');
  });

  it("status='failed' → содержит 'failed'", async () => {
    const routine = makeRoutine();
    const result = makeResult({ status: 'failed' });

    const messages = await renderRoutineOutput(routine, result, { readTemplate: noTemplateReader });
    const fullText = messages.map((m) => m.text).join('\n\n');
    expect(fullText).toContain('failed');
  });
});

// ---------------------------------------------------------------------------
// 5. Template placeholders подставляются корректно.
// ---------------------------------------------------------------------------

describe('renderRoutineOutput — кастомный шаблон', () => {
  it('подставляет {{output}}, {{usd}}, {{durationMs}} из шаблона', async () => {
    const template = 'Вывод: {{output}} | Стоимость: {{usd}} | Время: {{durationMs}}ms';
    const routine = makeRoutine({ id: 'my-routine' });
    const result = makeResult({ output: 'Финальный отчёт', totalUsd: 0.0099, durationMs: 777 });

    const messages = await renderRoutineOutput(routine, result, {
      readTemplate: fixedTemplateReader(template),
    });

    const text = messages.map((m) => m.text).join('\n\n');
    expect(text).toContain('Финальный отчёт');
    expect(text).toContain('0.0099');
    expect(text).toContain('777ms');
  });

  it('подставляет {{description}} и {{routineId}}', async () => {
    const template = 'id={{routineId}} desc={{description}}';
    const routine = makeRoutine({ id: 'test-id', description: 'Мой тест' });
    const result = makeResult();

    const messages = await renderRoutineOutput(routine, result, {
      readTemplate: fixedTemplateReader(template),
    });

    const text = messages[0]?.text ?? '';
    expect(text).toContain('test-id');
    expect(text).toContain('Мой тест');
  });

  it('если routine-специфичный шаблон отсутствует, но default.md есть — использует default', async () => {
    const defaultTemplate = 'default: {{status}} — {{description}}';
    // Первый вызов (routineId.md) бросает, второй (default.md) возвращает шаблон.
    const routine = makeRoutine({ id: 'some-routine', description: 'Описание' });
    const result = makeResult({ status: 'ok' });

    const messages = await renderRoutineOutput(routine, result, {
      readTemplate: firstMissSecondHit(defaultTemplate),
    });

    const text = messages[0]?.text ?? '';
    expect(text).toContain('ok');
    expect(text).toContain('Описание');
  });
});
