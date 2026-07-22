// Конвертер markdown -> Osnova blocks JSON для vc.ru API.
//
// vc.ru использует свой формат блоков (НЕ Editor.js paragraph/header):
// - type: "text"   - параграф, data.text обёрнут в <p>...</p>
// - type: "header" - data.text + data.style ("h2"/"h3"/...)
// - type: "code"   - data.text + data.lang
// - type: "list"   - data.type ("UL"/"OL") + data.items[]
// - type: "quote"  - data.text + data.subline1 + data.subline2
// - type: "image"  - data.items[].image.data.uuid (для cover)
//
// Каждый блок имеет верхнеуровневые поля: cover, hidden, anchor.
//
// Inline-форматирование в data.text - HTML-строка (<b>, <i>, <a>, <code>).

export interface OsnovaBlock {
  type: string;
  data: Record<string, unknown>;
  cover: boolean;
  hidden: boolean;
  anchor: string;
}

export interface OsnovaConvertResult {
  /** Первый H1 - title (отдельно от blocks). */
  title: string;
  blocks: OsnovaBlock[];
}

const HEADER_RE = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_RE = /^```(\w*)\s*$/;
const QUOTE_RE = /^>\s?(.*)$/;
const ULIST_RE = /^[-*]\s+(.+)$/;
const OLIST_RE = /^\d+\.\s+(.+)$/;
const TABLE_ROW_RE = /^\|(.+)\|\s*$/;
const TABLE_SEPARATOR_RE = /^\|[\s\-:|]+\|\s*$/;

/**
 * Парсит markdown и возвращает title + Osnova-блоки.
 *
 * Поддержка:
 * - # h1 (title) / ## h2 / ### h3 ...
 * - ```lang code ```
 * - > quote
 * - - / 1. lists
 * - **bold** / *italic* / `code` / [link](url) - inline HTML
 */
export function markdownToOsnova(md: string): OsnovaConvertResult {
  const lines = md.split('\n');
  const blocks: OsnovaBlock[] = [];
  let title = '';
  let titleSeen = false;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      i++;
      continue;
    }

    // Code fence.
    const fenceMatch = FENCE_RE.exec(trimmed);
    if (fenceMatch !== null) {
      const lang = fenceMatch[1] ?? '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i] ?? '';
        if (FENCE_RE.test(next.trim())) {
          i++;
          break;
        }
        codeLines.push(next);
        i++;
      }
      blocks.push(makeBlock('code', { text: codeLines.join('\n'), lang }));
      continue;
    }

    // Header.
    const headerMatch = HEADER_RE.exec(line);
    if (headerMatch !== null) {
      const hashes = headerMatch[1] ?? '';
      const text = (headerMatch[2] ?? '').trim();
      const level = hashes.length;
      if (level === 1 && !titleSeen) {
        title = stripInline(text);
        titleSeen = true;
        i++;
        continue;
      }
      const safeLevel = Math.min(Math.max(level, 2), 4);
      blocks.push(makeBlock('header', { text: stripInline(text), style: `h${safeLevel}` }));
      i++;
      continue;
    }

    // Table: detection - текущая строка `| ... |`, СЛЕДУЮЩАЯ `|---|---|...|`.
    // vc.ru Osnova не имеет native "table" блока. Конвертим в list-blocks:
    // - Header (2-я строка с разделителями игнорируется)
    // - 1-ю строку (заголовки) НЕ выводим (их инфо ушло в header выше / контекст)
    // - Каждый data-row → list-item "<b>col1</b> — col2. col3."
    if (TABLE_ROW_RE.test(line) && TABLE_SEPARATOR_RE.test(lines[i + 1] ?? '')) {
      // Skip header row (1-я) и separator (2-я).
      i += 2;
      const items: string[] = [];
      while (i < lines.length) {
        const next = lines[i] ?? '';
        const m = TABLE_ROW_RE.exec(next);
        if (m === null) break;
        const cells = (m[1] ?? '')
          .split('|')
          .map((c) => c.trim())
          .filter((c) => c.length > 0);
        if (cells.length === 0) {
          i++;
          continue;
        }
        // first cell = label (bold), остальные склеиваем как описание через ". ".
        const label = renderInline(cells[0] ?? '');
        const rest = cells
          .slice(1)
          .map((c) => renderInline(c))
          .filter((s) => s.length > 0)
          .join('. ');
        items.push(rest.length > 0 ? `<b>${label}</b> - ${rest}` : `<b>${label}</b>`);
        i++;
      }
      if (items.length > 0) {
        blocks.push(makeBlock('list', { type: 'UL', items }));
      }
      continue;
    }

    // Blockquote.
    if (QUOTE_RE.test(line)) {
      const parts: string[] = [];
      while (i < lines.length) {
        const m = QUOTE_RE.exec(lines[i] ?? '');
        if (m === null) break;
        parts.push(m[1] ?? '');
        i++;
      }
      blocks.push(
        makeBlock('quote', {
          text: renderInline(parts.join(' ').trim()),
          subline1: '',
          subline2: '',
          type: '',
          text_size: '',
          image: null,
        }),
      );
      continue;
    }

    // Unordered list.
    if (ULIST_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = ULIST_RE.exec(lines[i] ?? '');
        if (m === null) break;
        items.push(renderInline((m[1] ?? '').trim()));
        i++;
      }
      blocks.push(makeBlock('list', { type: 'UL', items }));
      continue;
    }

    // Ordered list.
    if (OLIST_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = OLIST_RE.exec(lines[i] ?? '');
        if (m === null) break;
        items.push(renderInline((m[1] ?? '').trim()));
        i++;
      }
      blocks.push(makeBlock('list', { type: 'OL', items }));
      continue;
    }

    // Paragraph.
    const paraLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i] ?? '';
      const t = next.trim();
      if (t.length === 0) break;
      if (HEADER_RE.test(next)) break;
      if (FENCE_RE.test(t)) break;
      if (QUOTE_RE.test(next)) break;
      if (ULIST_RE.test(next)) break;
      if (OLIST_RE.test(next)) break;
      if (TABLE_ROW_RE.test(next)) break;
      paraLines.push(next);
      i++;
    }
    const text = renderInline(paraLines.join(' ').trim());
    blocks.push(makeBlock('text', { text: `<p>${text}</p>` }));
  }

  // Pre-publish validation: остатков markdown-table не должно быть в тексте.
  validateNoMarkdownLeftovers(blocks);

  return { title, blocks };
}

/**
 * Защита от утечки markdown-разметки в опубликованный пост.
 * Throws если в каком-то блоке остался литеральный pipe-table или разделитель.
 */
function validateNoMarkdownLeftovers(blocks: OsnovaBlock[]): void {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b) continue;
    // Только text-блоки проверяем (header/code/list/quote получают чистый текст).
    if (b.type !== 'text') continue;
    const text = String((b.data as { text?: string }).text ?? '');
    // Литеральная таблица: "| col | col |" в одну строку.
    if (/\|\s+\S+.*\|\s+\S+.*\|/.test(text)) {
      throw new Error(`block #${i}: остатки markdown-таблицы в text: "${text.slice(0, 200)}..."`);
    }
    // Разделители "|---|---|".
    if (/\|---+\|/.test(text) || /\|\s+:?-+:?\s+\|/.test(text)) {
      throw new Error(`block #${i}: остатки table-separator в text: "${text.slice(0, 200)}..."`);
    }
  }
}

function makeBlock(type: string, data: Record<string, unknown>): OsnovaBlock {
  return { type, data, cover: false, hidden: false, anchor: '' };
}

/**
 * Inline HTML rendering: <b>, <i>, <code>, <a>. Code-spans защищены
 * placeholder'ом от вложенных regex.
 */
export function renderInline(text: string): string {
  let s = escapeHtml(text);

  const codeStash: string[] = [];
  const placeholderKey = `OSPH${Math.floor(Math.random() * 1e9).toString(36)}`;
  s = s.replace(/`([^`\n]+?)`/g, (_, code) => {
    const idx = codeStash.length;
    codeStash.push(code);
    return `${placeholderKey}${idx}END`;
  });

  s = s.replace(/\[([^\]]+?)\]\(([^)]+?)\)/g, (_, txt, url) => {
    const wrapped = wrapInternalLinkForVc(url);
    const safeUrl = wrapped.replace(/"/g, '&quot;');
    return `<a href="${safeUrl}">${txt}</a>`;
  });

  s = s.replace(/\*\*([^*\n]+?)\*\*/g, (_, txt) => `<b>${txt}</b>`);
  s = s.replace(/(?<![*\w])\*([^*\n]+?)\*(?!\w)/g, (_, txt) => `<i>${txt}</i>`);
  s = s.replace(/(?<![_\w])_([^_\n]+?)_(?!\w)/g, (_, txt) => `<i>${txt}</i>`);

  const restoreRe = new RegExp(`${placeholderKey}(\\d+)END`, 'g');
  s = s.replace(restoreRe, (_, idx) => `<code>${codeStash[Number(idx)] ?? ''}</code>`);

  return s;
}

export function stripInline(text: string): string {
  return text
    .replace(/`([^`\n]+?)`/g, '$1')
    .replace(/\[([^\]]+?)\]\([^)]+?\)/g, '$1')
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    .replace(/(?<![*\w])\*([^*\n]+?)\*(?!\w)/g, '$1')
    .replace(/(?<![_\w])_([^_\n]+?)_(?!\w)/g, '$1');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Домен твоего downstream-проекта, чьи внутренние ссылки нужно «защитить»
 * от Osnova-парсера vc.ru (см. ниже). Переопредели через env
 * `INTERNAL_LINK_DOMAIN`; иначе — пример `acme.example.com`.
 */
const INTERNAL_LINK_DOMAIN = process.env.INTERNAL_LINK_DOMAIN || 'acme.example.com';

/**
 * Workaround регрессии vc.ru от 2026-05-28 ~22:00: Osnova-парсер начал терять
 * домен и query из inline <a href="https://<твой-домен>/..."> внутри text-блоков.
 * Ссылка превращается в "/guides/<slug>", браузер резолвит на vc.ru/guides/...
 * → 404. Для внешних доменов (anthropic.com и т.д.) vc.ru сам оборачивает
 * URL в https://api.vc.ru/v2.8/redirect?to=<encoded>, и они работают. Делаем
 * этот же wrap сами для внутреннего домена — vc.ru не трогает уже обёрнутый URL.
 *
 * Наблюдение: обёрнутая через redirect ссылка остаётся кликабельной, а
 * необёрнутая на тот же внутренний домен теряет домен/query.
 *
 * `&amp;`-escape применяется НИЖЕ в renderInline через escapeHtml, поэтому
 * исходные `&` в query сохраняем как есть — иначе в encoded-параметре `to=`
 * получим двойной escape.
 */
export function wrapInternalLinkForVc(url: string): string {
  if (url.includes('api.vc.ru/v2.8/redirect')) return url;

  // Случай 1 — генератор написал относительный путь к внутреннему гайду
  // (`[анкор](/guides/<slug>)`). На твоём домене это работает, на vc.ru
  // резолвится на vc.ru/guides/... → 404. Достраиваем до полного URL.
  // Прецедент: vc.ru ломал относительные ссылки на guides внутри text-блока.
  // Покрываем известные публичные секции downstream-проекта.
  const internalRelativeRe = /^\/(guides|topics|course|tutorials|tariffs)\b/i;
  if (internalRelativeRe.test(url)) {
    const absolute = `https://${INTERNAL_LINK_DOMAIN}${url}`;
    return `https://api.vc.ru/v2.8/redirect?to=${encodeURIComponent(absolute)}`;
  }

  // Случай 2 — абсолютная ссылка на внутренний домен. Vc.ru стирает домен и
  // query из таких inline href внутри text-блока. Оборачиваем сами в
  // api.vc.ru/v2.8/redirect — обёрнутые URL vc.ru не трогает.
  const internalAbsoluteRe = new RegExp(
    `^https?://(?:www\\.)?${INTERNAL_LINK_DOMAIN.replace(/\./g, '\\.')}/`,
    'i',
  );
  if (internalAbsoluteRe.test(url)) {
    // renderInline экранирует & → &amp; ДО запуска link-regex, поэтому
    // url может прийти с literal "&amp;" в query. Откатываем перед encode.
    const decoded = url.replace(/&amp;/g, '&');
    return `https://api.vc.ru/v2.8/redirect?to=${encodeURIComponent(decoded)}`;
  }

  return url;
}
