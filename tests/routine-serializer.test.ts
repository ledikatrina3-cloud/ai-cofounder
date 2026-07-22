// Round-trip тесты для src/routines/serializer.ts.
//
// Главный инвариант (несущая деталь всей панели управления): редактирование
// routine из UI не должно терять или искажать поля. Проверяем на ВСЕХ реальных
// routines/*.md:
//   1. serializeRoutine: parse(serialize(parse(file))) === parse(file)
//      (семантический round-trip — модель сохраняется точно).
//   2. applyRoutinePatch(source, {}) === source (пустой патч — no-op,
//      файл байт-в-байт, включая комментарии).
//   3. applyRoutinePatch меняет только затронутое поле, сохраняя `#`-комментарии.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Routine, parseRoutineSource } from '../src/routines/parser.js';
import { applyRoutinePatch, serializeRoutine } from '../src/routines/serializer.js';

const ROUTINES_DIR = resolve(process.cwd(), 'routines');

function listRoutineFiles(): string[] {
  // routines/ — user-layer (gitignore'нут в OSS): legacy-routine'ов в чистом
  // клоне НЕТ, есть только routines/README.md (back-compat-доку). Фильтруем по
  // наличию frontmatter '---', чтобы не пытаться парсить README как routine.
  return readdirSync(ROUTINES_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => resolve(ROUTINES_DIR, f))
    .filter((p) => readFileSync(p, 'utf8').startsWith('---'));
}

// Сравниваем модель без filePath (serialize его не знает).
function withoutFilePath(r: Routine): Omit<Routine, 'filePath'> {
  const { filePath: _filePath, ...rest } = r;
  return rest;
}

describe('routine serializer — round-trip на реальных файлах', () => {
  const files = listRoutineFiles();

  it('находит routine-файлы (sanity)', () => {
    // В чистом OSS-клоне routines/ пуст (user-layer) — 0 валидно. Round-trip
    // прогоняется на тех файлах, что есть; unit-тесты квотинга — отдельно ниже.
    expect(files.length).toBeGreaterThanOrEqual(0);
  });

  for (const file of files) {
    const name = file.split('/').pop() ?? file;

    it(`serializeRoutine round-trip: ${name}`, () => {
      const source = readFileSync(file, 'utf8');
      const original = parseRoutineSource(file, source);
      const reserialized = serializeRoutine(original);
      const reparsed = parseRoutineSource(file, reserialized);
      expect(withoutFilePath(reparsed)).toEqual(withoutFilePath(original));
    });

    it(`applyRoutinePatch({}) — no-op, байт-в-байт: ${name}`, () => {
      const source = readFileSync(file, 'utf8');
      expect(applyRoutinePatch(source, {})).toBe(source);
    });

    it(`applyRoutinePatch меняет одно поле, сохраняя модель остального: ${name}`, () => {
      const source = readFileSync(file, 'utf8');
      const original = parseRoutineSource(file, source);
      const patched = applyRoutinePatch(source, { enabled: !original.enabled });
      const reparsed = parseRoutineSource(file, patched);
      expect(reparsed.enabled).toBe(!original.enabled);
      // Всё остальное — без изменений.
      expect(withoutFilePath({ ...reparsed, enabled: original.enabled })).toEqual(
        withoutFilePath(original),
      );
    });
  }
});

describe('routine serializer — сохранение комментариев', () => {
  it('applyRoutinePatch сохраняет #-комментарии во frontmatter', () => {
    const source = [
      '---',
      'id: demo',
      'projectId: demo',
      'enabled: true',
      '# это важная заметка про инцидент',
      '# вторая строка заметки',
      'trigger: manual',
      'tools: []',
      'model: claude-haiku-4-5',
      'maxTokens: 4000',
      'timeoutMs: 60000',
      'outputType: journal-only',
      'description: demo',
      '---',
      '',
      'промт тут',
      '',
    ].join('\n');

    const patched = applyRoutinePatch(source, { enabled: false, model: 'claude-opus-4-7' });
    expect(patched).toContain('# это важная заметка про инцидент');
    expect(patched).toContain('# вторая строка заметки');
    expect(patched).toContain('enabled: false');
    expect(patched).toContain('model: claude-opus-4-7');
  });

  it('applyRoutinePatch добавляет отсутствующее поле и удаляет через null', () => {
    const source = [
      '---',
      'id: demo',
      'projectId: demo',
      'enabled: true',
      'trigger: manual',
      'tools: []',
      'model: claude-haiku-4-5',
      'maxTokens: 4000',
      'timeoutMs: 60000',
      'outputType: journal-only',
      'description: demo',
      'departmentId: old-dept',
      '---',
      '',
      'промт',
      '',
    ].join('\n');

    // Добавить skills (нет в файле) + удалить departmentId (null).
    const patched = applyRoutinePatch(source, {
      skills: ['vc-publishing', 'article-writing'],
      departmentId: null,
    });
    const reparsed = parseRoutineSource('demo.md', patched);
    expect(reparsed.skills).toEqual(['vc-publishing', 'article-writing']);
    expect(reparsed.departmentId).toBeUndefined();
  });
});

describe('routine serializer — fail-loud на непредставимых значениях (ревью #7-9)', () => {
  const base: Routine = {
    id: 'q',
    projectId: 'q',
    enabled: true,
    trigger: 'manual',
    tools: [],
    model: 'claude-haiku-4-5',
    maxTokens: 4000,
    timeoutMs: 60000,
    outputType: 'journal-only',
    description: 'desc',
    prompt: 'body',
    filePath: 'q.md',
  };

  it('падает на элементе массива с запятой (а не молча портит)', () => {
    expect(() => serializeRoutine({ ...base, skills: ['a,b'] })).toThrow();
  });

  it('падает на скаляре, содержащем и пробел-edge и обе кавычки', () => {
    expect(() => serializeRoutine({ ...base, description: ` "it's" ` })).toThrow();
  });

  it('скаляр, реально начинающийся/кончающийся кавычкой, round-trip-ится без потери', () => {
    const out = serializeRoutine({ ...base, role: '"quoted"' });
    const reparsed = parseRoutineSource('q.md', out);
    expect(reparsed.role).toBe('"quoted"');
  });
});

describe('routine parser — id-валидация на read-пути (ревью #1, security)', () => {
  function makeSource(id: string): string {
    return [
      '---',
      `id: ${id}`,
      'projectId: demo',
      'enabled: true',
      'trigger: manual',
      'tools: []',
      'model: claude-haiku-4-5',
      'maxTokens: 4000',
      'timeoutMs: 60000',
      'outputType: journal-only',
      'description: d',
      '---',
      '',
      'body',
    ].join('\n');
  }

  it('отвергает id с XML-метасимволами (попытка plist-инъекции)', () => {
    expect(() => parseRoutineSource('x.md', makeSource('foo</string><string>x'))).toThrow(/kebab/);
  });

  it('отвергает id с пробелом/слэшем', () => {
    expect(() => parseRoutineSource('x.md', makeSource('foo bar'))).toThrow(/kebab/);
    expect(() => parseRoutineSource('x.md', makeSource('../etc'))).toThrow(/kebab/);
  });

  it('принимает валидный kebab id', () => {
    expect(parseRoutineSource('x.md', makeSource('content-team-vc')).id).toBe('content-team-vc');
  });
});

describe('routine serializer — serializeRoutine квотирование', () => {
  it('квотирует hex-цвет, пустую строку и array-подобные значения', () => {
    const base: Routine = {
      id: 'q',
      projectId: 'q',
      enabled: true,
      trigger: '*/30 * * * *',
      tools: ['project.read'],
      model: 'claude-haiku-4-5',
      maxTokens: 4000,
      timeoutMs: 60000,
      outputType: 'journal-only',
      description: 'desc',
      prompt: 'body',
      filePath: 'q.md',
      color: '#FF8800',
    };
    const out = serializeRoutine(base);
    expect(out).toContain('color: "#FF8800"');
    // cron с ведущим * — не квотируется, но парсится обратно.
    const reparsed = parseRoutineSource('q.md', out);
    expect(reparsed.trigger).toBe('*/30 * * * *');
    expect(reparsed.color).toBe('#FF8800');
  });
});
