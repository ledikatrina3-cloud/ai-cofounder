// Тест workaround'а для регрессии vc.ru (см. wrapInternalLinkForVc).
//
// vc.ru теряет домен и query из inline <a href="https://acme.example.com/..."> внутри
// text-блоков. Обходим оборачивая URL в api.vc.ru/v2.8/redirect — vc.ru уже
// обёрнутые ссылки не трогает.

import { describe, expect, it } from 'vitest';
import {
  markdownToOsnova,
  renderInline,
  wrapInternalLinkForVc,
} from '../src/publish/markdown-to-osnova.js';

describe('wrapInternalLinkForVc', () => {
  it('оборачивает acme.example.com ссылку в vc.ru redirect', () => {
    const result = wrapInternalLinkForVc('https://acme.example.com/guides/plan-mode-overview');
    expect(result).toBe(
      'https://api.vc.ru/v2.8/redirect?to=https%3A%2F%2Facme.example.com%2Fguides%2Fplan-mode-overview',
    );
  });

  it('сохраняет utm-параметры через encode (включая &)', () => {
    const result = wrapInternalLinkForVc(
      'https://acme.example.com/guides/x?utm_source=vc&utm_campaign=spoke',
    );
    expect(result).toContain(
      'to=https%3A%2F%2Facme.example.com%2Fguides%2Fx%3Futm_source%3Dvc%26utm_campaign%3Dspoke',
    );
  });

  it('декодирует &amp; в url ДО encodeURIComponent (renderInline-pipeline)', () => {
    // Симулируем: renderInline уже превратил & → &amp;
    const result = wrapInternalLinkForVc(
      'https://acme.example.com/guides/x?utm_source=vc&amp;utm_campaign=spoke',
    );
    // В query должно быть %26 (escaped &), НЕ %26amp%3B (двойной escape).
    expect(result).toContain('%26utm_campaign');
    expect(result).not.toContain('%26amp%3B');
  });

  it('игнорирует внешние домены (anthropic, github и т.д.)', () => {
    expect(wrapInternalLinkForVc('https://anthropic.com/x')).toBe('https://anthropic.com/x');
    expect(wrapInternalLinkForVc('https://github.com/x')).toBe('https://github.com/x');
  });

  it('игнорирует vc.ru-ссылки', () => {
    expect(wrapInternalLinkForVc('https://vc.ru/ai/123456-test')).toBe(
      'https://vc.ru/ai/123456-test',
    );
  });

  it('не оборачивает уже обёрнутый URL дважды', () => {
    const wrapped = 'https://api.vc.ru/v2.8/redirect?to=https%3A%2F%2Facme.example.com%2Fx';
    expect(wrapInternalLinkForVc(wrapped)).toBe(wrapped);
  });

  it('обрабатывает www.acme.example.com тоже', () => {
    const result = wrapInternalLinkForVc('https://www.acme.example.com/guides/x');
    expect(result).toContain('api.vc.ru/v2.8/redirect');
  });

  it('достраивает относительный /guides/<slug> до полного example-URL и оборачивает', () => {
    const result = wrapInternalLinkForVc('/guides/plan-mode-overview');
    expect(result).toBe(
      'https://api.vc.ru/v2.8/redirect?to=https%3A%2F%2Facme.example.com%2Fguides%2Fplan-mode-overview',
    );
  });

  it('достраивает /topics/<slug> и /course тоже', () => {
    expect(wrapInternalLinkForVc('/topics/claude-code')).toContain(
      'to=https%3A%2F%2Facme.example.com%2Ftopics%2Fclaude-code',
    );
    expect(wrapInternalLinkForVc('/course')).toContain(
      'to=https%3A%2F%2Facme.example.com%2Fcourse',
    );
  });

  it('игнорирует vc.ru-локальные пути (/tag, /money и т.д.) и mailto', () => {
    expect(wrapInternalLinkForVc('/tag/general')).toBe('/tag/general');
    expect(wrapInternalLinkForVc('/ai/123456-foo')).toBe('/ai/123456-foo');
    expect(wrapInternalLinkForVc('mailto:x@y.com')).toBe('mailto:x@y.com');
  });
});

describe('renderInline + example wrap', () => {
  it('inline markdown-ссылка на example выходит обёрнутой в href', () => {
    const html = renderInline(
      'Подробно в [гайде](https://acme.example.com/guides/x?utm_source=vc&utm_campaign=y) — там матрица.',
    );
    expect(html).toContain('href="https://api.vc.ru/v2.8/redirect?to=');
    expect(html).toContain('acme.example.com');
    // Внешние escape-правила HTML тоже должны выжить: & в финальном href должен
    // быть &amp; (атрибут), но to=<encoded> внутри должен иметь %26 для исходного &.
    expect(html).not.toContain('%26amp%3B');
  });

  it('inline ссылка на anthropic не оборачивается (vc.ru обернёт сам)', () => {
    const html = renderInline('See [docs](https://anthropic.com/x).');
    expect(html).toContain('href="https://anthropic.com/x"');
    expect(html).not.toContain('api.vc.ru/v2.8/redirect');
  });
});

describe('markdownToOsnova end-to-end', () => {
  it('параграф с example-ссылкой → text-блок с обёрнутым href', () => {
    const md =
      '# Заголовок\n\nЧитай [гайд](https://acme.example.com/guides/plan-mode-overview?utm_source=vc) подробнее.';
    const { title, blocks } = markdownToOsnova(md);
    expect(title).toBe('Заголовок');
    const textBlock = blocks.find((b) => b.type === 'text');
    expect(textBlock).toBeDefined();
    const text = String((textBlock?.data as { text?: string }).text ?? '');
    expect(text).toContain('href="https://api.vc.ru/v2.8/redirect?to=');
  });
});
