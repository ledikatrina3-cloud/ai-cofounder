// Тесты конвертера markdown -> Editor.js blocks.
//
// Покрываем кейсы, которые точно встречаются в build-vc-spoke output:
// - title-через-H1, body-после
// - bold/italic/code/links inline
// - code-блоки с lang
// - blockquotes
// - lists ordered/unordered
//
// Покрываем edge-кейсы которые ломали 11 итераций Playwright:
// - **bold** должен стать <b>bold</b>, а не литералом `**bold**`
// - ```lang code блоки должны стать code-block (не paragraph build-by-line)

import { describe, expect, it } from 'vitest';
import {
  markdownToEditorJs,
  renderInline,
  stripInline,
} from '../src/publish/markdown-to-editorjs.js';

describe('markdownToEditorJs', () => {
  it('извлекает первый H1 как title и не кладёт его в blocks', () => {
    const r = markdownToEditorJs('# Заголовок\n\nТекст');
    expect(r.title).toBe('Заголовок');
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]?.type).toBe('paragraph');
  });

  it('H2/H3/H4 -> header-block с правильным level', () => {
    const r = markdownToEditorJs('## H2\n\n### H3\n\n#### H4');
    expect(r.title).toBe('');
    expect(r.blocks).toEqual([
      { type: 'header', data: { text: 'H2', level: 2 } },
      { type: 'header', data: { text: 'H3', level: 3 } },
      { type: 'header', data: { text: 'H4', level: 4 } },
    ]);
  });

  it('code-блок с lang -> code block, не paragraph build-by-line', () => {
    const md = '```typescript\nconst x = 1;\nconsole.log(x);\n```';
    const r = markdownToEditorJs(md);
    expect(r.blocks).toEqual([
      { type: 'code', data: { code: 'const x = 1;\nconsole.log(x);', lang: 'typescript' } },
    ]);
  });

  it('code-блок без lang -> code-block с пустым lang', () => {
    const md = '```\necho hi\n```';
    const r = markdownToEditorJs(md);
    expect(r.blocks[0]?.type).toBe('code');
    expect((r.blocks[0]?.data as { lang: string }).lang).toBe('');
  });

  it('паттерн **bold** -> <b>bold</b> (не литерал **bold**)', () => {
    expect(renderInline('тест **жирный** конец')).toBe('тест <b>жирный</b> конец');
  });

  it('паттерн *italic* и _italic_ -> <i>italic</i>', () => {
    expect(renderInline('а *курсив* б')).toBe('а <i>курсив</i> б');
    expect(renderInline('а _курсив_ б')).toBe('а <i>курсив</i> б');
  });

  it('inline `code` -> <code>code</code>', () => {
    expect(renderInline('значение `x = 1` это')).toBe('значение <code>x = 1</code> это');
  });

  it('link [text](url) -> <a href="url">text</a>', () => {
    expect(renderInline('см [тут](https://vc.ru)')).toBe('см <a href="https://vc.ru">тут</a>');
  });

  it('escape HTML в обычном тексте (< > &)', () => {
    expect(renderInline('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('inline-форматирование не пересекается: код внутри ссылки сохраняется', () => {
    // Edge case: code-tag не должен парсить markdown внутри.
    expect(renderInline('`**не bold**`')).toBe('<code>**не bold**</code>');
  });

  it('blockquote -> quote-block', () => {
    const md = '> Цитата\n> вторая строка';
    const r = markdownToEditorJs(md);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]?.type).toBe('quote');
    expect((r.blocks[0]?.data as { text: string }).text).toBe('Цитата вторая строка');
  });

  it('unordered list -> list-block unordered', () => {
    const r = markdownToEditorJs('- Первый\n- Второй');
    expect(r.blocks[0]).toEqual({
      type: 'list',
      data: { style: 'unordered', items: ['Первый', 'Второй'] },
    });
  });

  it('ordered list -> list-block ordered', () => {
    const r = markdownToEditorJs('1. Раз\n2. Два');
    expect(r.blocks[0]).toEqual({
      type: 'list',
      data: { style: 'ordered', items: ['Раз', 'Два'] },
    });
  });

  it('paragraph: соседние строки склеиваются в один paragraph', () => {
    const md = 'Первая строка\nвторая строка\n\nновый абзац';
    const r = markdownToEditorJs(md);
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks[0]?.type).toBe('paragraph');
    expect((r.blocks[0]?.data as { text: string }).text).toBe('Первая строка вторая строка');
  });

  it('реалистичный микс: title + H2 + bold + code + list + link', () => {
    const md = [
      '# Главный заголовок',
      '',
      '## Подзаголовок',
      '',
      'Текст с **bold** и `inline code` и [ссылкой](https://example.com).',
      '',
      '```javascript',
      'const x = 1;',
      '```',
      '',
      '- Первый пункт',
      '- Второй пункт',
    ].join('\n');
    const r = markdownToEditorJs(md);
    expect(r.title).toBe('Главный заголовок');
    expect(r.blocks).toHaveLength(4);
    expect(r.blocks[0]).toEqual({ type: 'header', data: { text: 'Подзаголовок', level: 2 } });
    expect(r.blocks[1]?.type).toBe('paragraph');
    expect((r.blocks[1]?.data as { text: string }).text).toContain('<b>bold</b>');
    expect((r.blocks[1]?.data as { text: string }).text).toContain('<code>inline code</code>');
    expect((r.blocks[1]?.data as { text: string }).text).toContain(
      '<a href="https://example.com">ссылкой</a>',
    );
    expect(r.blocks[2]?.type).toBe('code');
    expect((r.blocks[2]?.data as { lang: string }).lang).toBe('javascript');
    expect(r.blocks[3]?.type).toBe('list');
  });

  it('stripInline убирает форматирование (для title)', () => {
    expect(stripInline('Заголовок с **bold**')).toBe('Заголовок с bold');
    expect(stripInline('С [ссылкой](url)')).toBe('С ссылкой');
    expect(stripInline('Inline `code`')).toBe('Inline code');
  });
});
