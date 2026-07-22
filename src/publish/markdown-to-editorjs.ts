// Конвертер markdown -> Editor.js blocks JSON.
//
// Зачем: vc.ru использует Editor.js. Paste-handler strip'ает HTML-форматирование.
// Поэтому контент вставляем через `editor.blocks.render({ blocks })` -
// native programmatic API сохраняет формат 100%.
//
// Поддержка (минимальная, под формат build-vc-spoke):
// - # h1 / ## h2 / ### h3      -> header (level 1-6)
// - ```lang\ncode\n```         -> code (с lang)
// - > text                     -> quote
// - - item / 1. item           -> list (unordered/ordered)
// - [text](url)                -> inline <a>
// - **text**                   -> inline <b>
// - *text* / _text_            -> inline <i>
// - `code`                     -> inline <code>
// - blank line                 -> разделитель абзацев
//
// Inline-форматирование живёт ВНУТРИ `data.text` как HTML-строка - это
// native Editor.js формат (см. editorjs.io/saving-data).

export interface EditorJsBlock {
  type: string;
  data: Record<string, unknown>;
}

export interface ConvertOptions {
  /** Дефолтный язык для code-блоков без ```lang. */
  defaultCodeLang?: string;
}

export interface ConvertResult {
  /** Первый H1 - title (отдельно от blocks). */
  title: string;
  /** Тело без первого H1. */
  blocks: EditorJsBlock[];
}

const HEADER_RE = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_RE = /^```(\w*)\s*$/;
const QUOTE_RE = /^>\s?(.*)$/;
const ULIST_RE = /^[-*]\s+(.+)$/;
const OLIST_RE = /^\d+\.\s+(.+)$/;

/**
 * Парсит markdown и возвращает title + blocks.
 *
 * - Первый встретившийся H1 идёт в `title` и не попадает в blocks.
 * - Все остальные блоки идут в `blocks` в порядке появления.
 * - Пустые строки между блоками игнорируются.
 */
export function markdownToEditorJs(md: string, opts: ConvertOptions = {}): ConvertResult {
  const defaultLang = opts.defaultCodeLang ?? '';
  const lines = md.split('\n');
  const blocks: EditorJsBlock[] = [];
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
      const lang = fenceMatch[1] ?? defaultLang;
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
      blocks.push({
        type: 'code',
        data: { code: codeLines.join('\n'), lang },
      });
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
      blocks.push({
        type: 'header',
        data: { text: renderInline(text), level },
      });
      i++;
      continue;
    }

    // Blockquote (collect contiguous > lines).
    if (QUOTE_RE.test(line)) {
      const parts: string[] = [];
      while (i < lines.length) {
        const m = QUOTE_RE.exec(lines[i] ?? '');
        if (m === null) break;
        parts.push(m[1] ?? '');
        i++;
      }
      blocks.push({
        type: 'quote',
        data: {
          text: renderInline(parts.join(' ').trim()),
          caption: '',
          alignment: 'left',
        },
      });
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
      blocks.push({
        type: 'list',
        data: { style: 'unordered', items },
      });
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
      blocks.push({
        type: 'list',
        data: { style: 'ordered', items },
      });
      continue;
    }

    // Paragraph - collect contiguous non-empty, non-special lines.
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
      paraLines.push(next);
      i++;
    }
    blocks.push({
      type: 'paragraph',
      data: { text: renderInline(paraLines.join(' ').trim()) },
    });
  }

  return { title, blocks };
}

/**
 * Рендерит inline-markdown в HTML-строку, которую Editor.js принимает в `data.text`.
 * Порядок: code в placeholder (защищает от bold/italic), потом link, bold, italic,
 * потом placeholder обратно в <code>.
 */
export function renderInline(text: string): string {
  let s = escapeHtml(text);

  // Extract inline `code` в placeholder, чтобы не трогать его дальнейшими regex'ами.
  // Placeholder использует Unicode PUA символы (private use area) - они не
  // встретятся в реальном markdown и не парсятся как контрольные.
  const codeStash: string[] = [];
  s = s.replace(/`([^`\n]+?)`/g, (_, code) => {
    const idx = codeStash.length;
    codeStash.push(code);
    return `CODE${idx}`;
  });

  // Links [text](url) - до bold/italic, чтобы `*` в URL не ловить.
  s = s.replace(/\[([^\]]+?)\]\(([^)]+?)\)/g, (_, txt, url) => {
    const safeUrl = url.replace(/"/g, '&quot;');
    return `<a href="${safeUrl}">${txt}</a>`;
  });

  // Bold **text** (двойные звёздочки).
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, (_, txt) => `<b>${txt}</b>`);

  // Italic *text* и _text_.
  s = s.replace(/(?<![*\w])\*([^*\n]+?)\*(?!\w)/g, (_, txt) => `<i>${txt}</i>`);
  s = s.replace(/(?<![_\w])_([^_\n]+?)_(?!\w)/g, (_, txt) => `<i>${txt}</i>`);

  // Restore code-стэш.
  s = s.replace(/CODE(\d+)/g, (_, idx) => `<code>${codeStash[Number(idx)] ?? ''}</code>`);

  return s;
}

/**
 * Strip всего inline-форматирования - для title (Editor.js title не парсит HTML).
 */
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
