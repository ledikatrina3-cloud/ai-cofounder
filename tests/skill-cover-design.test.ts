// Тесты для skills/cover-design/scripts/generate.ts.
//
// Стратегия:
//   * `escapeXml`, `renderTemplate` — pure, тестируем напрямую.
//   * `generateCover` — DI'м readTemplate + writeFile, проверяем что
//     title подставлен и записан в правильное место.

import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  escapeXml,
  generateCover,
  renderTemplate,
} from '../skills/cover-design/scripts/generate.js';

const templatesDir = new URL('../skills/cover-design/assets/templates/', import.meta.url);

describe('escapeXml', () => {
  it('экранирует <, >, &, ", \'', () => {
    expect(escapeXml(`a<b>c&d"e'f`)).toBe('a&lt;b&gt;c&amp;d&quot;e&#39;f');
  });
  it('не трогает обычные символы', () => {
    expect(escapeXml('Простой текст с кириллицей 123')).toBe('Простой текст с кириллицей 123');
  });
});

describe('renderTemplate', () => {
  it('подставляет {{TITLE}}', () => {
    const tpl = '<svg>{{TITLE}}</svg>';
    expect(renderTemplate(tpl, 'Hello')).toBe('<svg>Hello</svg>');
  });
  it('подставляет все вхождения', () => {
    const tpl = '<svg>{{TITLE}} - {{TITLE}}</svg>';
    expect(renderTemplate(tpl, 'X')).toBe('<svg>X - X</svg>');
  });
  it('экранирует XML-спецсимволы в title', () => {
    const tpl = '<svg>{{TITLE}}</svg>';
    expect(renderTemplate(tpl, '<bold>')).toBe('<svg>&lt;bold&gt;</svg>');
  });
  it('заменяет foreignObject-title на native SVG text для PNG-конвертации', () => {
    const tpl = `<svg>
      <foreignObject x="80" y="180" width="1040" height="280">
        <div xmlns="http://www.w3.org/1999/xhtml" style="font-family: -apple-system, system-ui, sans-serif; color: #F8FAFC; font-size: 60px; line-height: 1.18; font-weight: 700; word-wrap: break-word;">
          {{TITLE}}
        </div>
      </foreignObject>
    </svg>`;
    const rendered = renderTemplate(tpl, 'Skills over prompts');
    expect(rendered).not.toContain('<foreignObject');
    expect(rendered).toContain('<text ');
    expect(rendered).toContain('<tspan');
    expect(rendered).toContain('Skills over prompts');
  });

  it('переносит русский title с запасом для PNG-превью', () => {
    const tpl = `<svg>
      <foreignObject x="80" y="180" width="1040" height="280">
        <div xmlns="http://www.w3.org/1999/xhtml" style="font-family: -apple-system, system-ui, sans-serif; color: #F8FAFC; font-size: 60px; line-height: 1.18; font-weight: 700; word-wrap: break-word;">
          {{TITLE}}
        </div>
      </foreignObject>
    </svg>`;
    const rendered = renderTemplate(
      tpl,
      'Табель: как автоматизация делает 3 ошибки регулярными',
    );

    expect(rendered).toContain('<tspan x="80" dy="0">Табель: как</tspan>');
    expect(rendered).toContain('>автоматизация делает 3</tspan>');
    expect(rendered).toContain('>ошибки регулярными</tspan>');
  });
});

describe('generateCover', () => {
  it('читает шаблон, подставляет title, пишет SVG', async () => {
    const readTemplate = vi.fn(async () => '<svg>{{TITLE}}</svg>');
    const writeFile = vi.fn(async () => undefined);
    const result = await generateCover({
      title: 'My Title',
      template: 'gradient',
      outPath: 'tmp/x.svg',
      readTemplate,
      writeFile,
      toPng: async () => null, // не пытаемся PNG
    });
    expect(result.status).toBe('ok');
    expect(result.svgPath).toBe('tmp/x.svg');
    expect(result.pngPath).toBeNull();
    expect(writeFile).toHaveBeenCalledWith('tmp/x.svg', '<svg>My Title</svg>');
  });

  it('возвращает failed если шаблона нет', async () => {
    const readTemplate = vi.fn(async () => {
      throw new Error('ENOENT');
    });
    const result = await generateCover({
      title: 'x',
      template: 'nope',
      outPath: 'tmp/x.svg',
      readTemplate,
      writeFile: async () => undefined,
      toPng: async () => null,
    });
    expect(result.status).toBe('failed');
    expect(result.errors[0]).toMatch(/template/);
  });

  it('подставляет .svg если outPath без расширения', async () => {
    const readTemplate = vi.fn(async () => '<svg>{{TITLE}}</svg>');
    const writeFile = vi.fn(async () => undefined);
    const result = await generateCover({
      title: 'x',
      template: 'gradient',
      outPath: 'tmp/y',
      readTemplate,
      writeFile,
      toPng: async () => null,
    });
    expect(result.svgPath).toBe('tmp/y.svg');
  });

  it('экранирует XML-спецсимволы в title', async () => {
    const readTemplate = vi.fn(async () => '<svg>{{TITLE}}</svg>');
    const writeFile = vi.fn(async () => undefined);
    await generateCover({
      title: '<script>alert(1)</script>',
      template: 'gradient',
      outPath: 'tmp/x.svg',
      readTemplate,
      writeFile,
      toPng: async () => null,
    });
    const calls = writeFile.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const firstCall = calls[0] as unknown as [string, string];
    const written = firstCall[1];
    expect(written).toContain('&lt;script&gt;');
    expect(written).not.toContain('<script>');
  });

  it('отвергает path-traversal в template (../../etc/passwd)', async () => {
    const readTemplate = vi.fn(async () => '<svg>{{TITLE}}</svg>');
    const writeFile = vi.fn(async () => undefined);
    const result = await generateCover({
      title: 'x',
      template: '../../etc/passwd',
      outPath: 'tmp/x.svg',
      readTemplate,
      writeFile,
      toPng: async () => null,
    });
    expect(result.status).toBe('failed');
    expect(result.errors[0]).toMatch(/kebab-case/);
    expect(readTemplate).not.toHaveBeenCalled();
  });

  it('отвергает template со слешем (../assets)', async () => {
    const result = await generateCover({
      title: 'x',
      template: 'a/b',
      outPath: 'tmp/x.svg',
      readTemplate: async () => '<svg/>',
      writeFile: async () => undefined,
      toPng: async () => null,
    });
    expect(result.status).toBe('failed');
    expect(result.errors[0]).toMatch(/kebab-case/);
  });

  // Regression: Phase 8 security review добавил защиту outPath от
  // абсолютных путей и path-traversal. Defense-in-depth поверх
  // bash-whitelist'а — если кто-то вызвал generateCover напрямую,
  // мы не позволим записать вне cwd.
  it('отвергает абсолютный outPath (/etc/foo)', async () => {
    const result = await generateCover({
      title: 'x',
      template: 'gradient',
      outPath: '/etc/foo.svg',
      readTemplate: async () => '<svg/>',
      writeFile: async () => undefined,
      toPng: async () => null,
    });
    expect(result.status).toBe('failed');
    expect(result.errors[0]).toMatch(/абсолютный|outPath/);
  });

  it('отвергает path-traversal в outPath (../foo)', async () => {
    const result = await generateCover({
      title: 'x',
      template: 'gradient',
      outPath: '../../private/secrets.svg',
      readTemplate: async () => '<svg/>',
      writeFile: async () => undefined,
      toPng: async () => null,
    });
    expect(result.status).toBe('failed');
    expect(result.errors[0]).toMatch(/\.\.|outPath/);
  });

  it('отвергает outPath начинающийся с ~ (home expansion)', async () => {
    const result = await generateCover({
      title: 'x',
      template: 'gradient',
      outPath: '~/secrets.svg',
      readTemplate: async () => '<svg/>',
      writeFile: async () => undefined,
      toPng: async () => null,
    });
    expect(result.status).toBe('failed');
  });
});

describe('cover templates', () => {
  it('не содержат hardcoded placeholder-домены', async () => {
    const files = await readdir(templatesDir);
    const svgFiles = files.filter((file) => file.endsWith('.svg'));
    expect(svgFiles.length).toBeGreaterThan(0);

    for (const file of svgFiles) {
      const content = await readFile(new URL(file, templatesDir), 'utf8');
      expect(content, file).not.toMatch(/\b(?:acme\.)?example\.com\b/i);
    }
  });

  it('dark-stripe использует брендовые цвета вместо старой blue/orange палитры', async () => {
    const content = await readFile(new URL('dark-stripe.svg', templatesDir), 'utf8');

    expect(content).toContain('#141413');
    expect(content).toContain('#d97757');
    expect(content).toContain('#ede9e3');
    expect(content).not.toContain('#0F172A');
    expect(content).not.toContain('#F59E0B');
    expect(content).not.toContain('#F8FAFC');
  });
});
