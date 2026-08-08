// cover-design/scripts/generate.ts
//
// Генерирует обложку из SVG-шаблона с подстановкой title.
//
// Использование:
//   pnpm exec tsx skills/cover-design/scripts/generate.ts \
//     --title "Заголовок" \
//     --template gradient \
//     --out content/drafts/master/2026-05-21-cover.svg
//
// Контракт stdout (последняя строка):
//   {status: 'ok'|'failed', svgPath: '...', pngPath: '...'|null, errors: []}
//
// Если sharp установлен — конвертит SVG → PNG (1200x630). Иначе только SVG.
// LLM-вызовы запрещены (anti-goal #5).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Output {
  status: 'ok' | 'failed';
  svgPath: string | null;
  pngPath: string | null;
  template: string | null;
  errors: string[];
}

function emit(out: Output): void {
  console.log(JSON.stringify(out));
}

interface Args {
  title: string | null;
  template: string;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  let title: string | null = null;
  let template = 'gradient';
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--title') {
      title = argv[++i] ?? null;
    } else if (arg.startsWith('--title=')) {
      title = arg.slice('--title='.length);
    } else if (arg === '--template') {
      template = argv[++i] ?? 'gradient';
    } else if (arg.startsWith('--template=')) {
      template = arg.slice('--template='.length);
    } else if (arg === '--out') {
      out = argv[++i] ?? null;
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length);
    }
  }
  return { title, template, out };
}

/**
 * Escape для XML/SVG-content: `<`, `>`, `&`, `'`, `"`. Экспортируется для
 * unit-тестов.
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Применяет title к SVG-шаблону. Заменяет все вхождения `{{TITLE}}`.
 * Экспортируется для unit-тестов.
 */
export function renderTemplate(templateSvg: string, title: string): string {
  const nativeTextSvg = replaceTitleForeignObject(templateSvg, title);
  return nativeTextSvg.replace(/\{\{TITLE\}\}/g, escapeXml(title));
}

interface NativeTextBox {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  lineHeight: number;
}

const TITLE_FOREIGN_OBJECT_RE =
  /<foreignObject\b([^>]*)>([\s\S]*?\{\{TITLE\}\}[\s\S]*?)<\/foreignObject>/g;

function replaceTitleForeignObject(templateSvg: string, title: string): string {
  return templateSvg.replace(TITLE_FOREIGN_OBJECT_RE, (_match, attrs: string, body: string) => {
    const style = parseStyle(body);
    const fontSize = parseCssPx(style['font-size'], 60);
    const lineHeight = parseLineHeight(style['line-height'], fontSize);
    const box: NativeTextBox = {
      x: parseSvgNumberAttr(attrs, 'x', 80),
      y: parseSvgNumberAttr(attrs, 'y', 180),
      width: parseSvgNumberAttr(attrs, 'width', 1040),
      height: parseSvgNumberAttr(attrs, 'height', 280),
      fill: style.color ?? '#F8FAFC',
      fontFamily: style['font-family'] ?? '-apple-system, system-ui, sans-serif',
      fontSize,
      fontWeight: style['font-weight'] ?? '700',
      lineHeight,
    };
    return renderNativeText(title, box);
  });
}

function parseSvgNumberAttr(attrs: string, name: string, fallback: number): number {
  const re = new RegExp(`\\b${name}="([^"]+)"`);
  const raw = re.exec(attrs)?.[1];
  if (raw === undefined) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function parseStyle(body: string): Record<string, string> {
  const styleAttr = /style="([^"]*)"/.exec(body)?.[1] ?? '';
  const style: Record<string, string> = {};
  for (const part of styleAttr.split(';')) {
    const [rawKey, ...rawValue] = part.split(':');
    const key = rawKey?.trim().toLowerCase();
    const value = rawValue.join(':').trim();
    if (key && value) style[key] = value;
  }
  return style;
}

function parseCssPx(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function parseLineHeight(raw: string | undefined, fontSize: number): number {
  if (raw === undefined) return fontSize * 1.18;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fontSize * 1.18;
  return raw.trim().endsWith('px') ? value : value * fontSize;
}

function renderNativeText(title: string, box: NativeTextBox): string {
  const maxChars = Math.max(8, Math.floor(box.width / (box.fontSize * 0.72)));
  const lines = wrapTitle(title, maxChars);
  const totalHeight = box.fontSize + (lines.length - 1) * box.lineHeight;
  const startY = box.y + Math.max(0, (box.height - totalHeight) / 2) + box.fontSize;
  const tspans = lines
    .map((line, index) => {
      const dy = index === 0 ? 0 : box.lineHeight;
      return `<tspan x="${box.x}" dy="${dy}">${escapeXml(line)}</tspan>`;
    })
    .join('');

  return `<text x="${box.x}" y="${round(startY)}" fill="${escapeXml(box.fill)}" font-family="${escapeXml(
    box.fontFamily,
  )}" font-size="${box.fontSize}" font-weight="${escapeXml(box.fontWeight)}">${tspans}</text>`;
}

function wrapTitle(title: string, maxChars: number): string[] {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current.length === 0 ? word : `${current} ${word}`;
    if (next.length <= maxChars || current.length === 0) {
      current = next;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const TEMPLATES_DIR_REL = '../assets/templates';
// Template name должно быть kebab-case (без `..`, `/`, `\`). Защита от
// `--template ../../../etc/passwd` — даже если pipeline.yml/routine
// передаст маликс template — мы не прочитаем за пределы assets/templates/.
const TEMPLATE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

function templatesDir(): string {
  // __dirname под ESM не доступен; считаем относительно текущего модуля.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, TEMPLATES_DIR_REL);
}

export interface GenerateOptions {
  title: string;
  template: string;
  outPath: string;
  /** DI для тестов: подменить чтение шаблона. */
  readTemplate?: (path: string) => Promise<string>;
  /** DI для тестов: подменить запись файла. */
  writeFile?: (path: string, content: string) => Promise<void>;
  /** DI для тестов: подменить PNG-конвертер. По умолчанию пытается sharp. */
  toPng?: (svg: string) => Promise<Buffer | null>;
}

export async function generateCover(opts: GenerateOptions): Promise<Output> {
  // Path-traversal guard: template должно быть простым именем kebab-case.
  if (!TEMPLATE_NAME_RE.test(opts.template)) {
    return {
      status: 'failed',
      svgPath: null,
      pngPath: null,
      template: opts.template,
      errors: [
        `template '${opts.template}' должен быть kebab-case (^[a-z0-9][a-z0-9-]*$). '..', '/' и '\\' запрещены.`,
      ],
    };
  }
  // Path-traversal guard для outPath: defense-in-depth поверх bash-whitelist'а
  // (который уже блокирует `--out=../foo` / `--out=/etc/foo`). Если кто-то
  // вызвал скрипт напрямую — мы всё равно не позволим записать вне cwd.
  if (
    opts.outPath.startsWith('/') ||
    opts.outPath.startsWith('~') ||
    /(?:^|[\/\\])\.\.(?:[\/\\]|$)/.test(opts.outPath)
  ) {
    return {
      status: 'failed',
      svgPath: null,
      pngPath: null,
      template: opts.template,
      errors: [
        `outPath '${opts.outPath}' содержит абсолютный путь или '..' — запрещено (write только в cwd).`,
      ],
    };
  }
  const templatePath = join(templatesDir(), `${opts.template}.svg`);
  const read = opts.readTemplate ?? ((p: string) => readFile(p, 'utf8'));
  const write = opts.writeFile ?? ((p: string, c: string) => writeFile(p, c, 'utf8'));

  let templateSvg: string;
  try {
    templateSvg = await read(templatePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'failed',
      svgPath: null,
      pngPath: null,
      template: opts.template,
      errors: [`не нашёл template '${opts.template}' (${templatePath}): ${msg}`],
    };
  }

  const svg = renderTemplate(templateSvg, opts.title);

  // Резолвим .svg-output. Если outPath не оканчивается на .svg/.png — добавляем .svg.
  let svgPath: string;
  let pngPath: string | null;
  if (opts.outPath.endsWith('.png')) {
    pngPath = opts.outPath;
    svgPath = `${opts.outPath.slice(0, -4)}.svg`;
  } else if (opts.outPath.endsWith('.svg')) {
    svgPath = opts.outPath;
    pngPath = `${opts.outPath.slice(0, -4)}.png`;
  } else {
    svgPath = `${opts.outPath}.svg`;
    pngPath = `${opts.outPath}.png`;
  }

  try {
    await mkdir(dirname(svgPath), { recursive: true });
    await write(svgPath, svg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'failed',
      svgPath: null,
      pngPath: null,
      template: opts.template,
      errors: [`write svg: ${msg}`],
    };
  }

  // PNG конверсия — best-effort. Если sharp не установлен, пропускаем.
  let pngBuffer: Buffer | null = null;
  try {
    const converter = opts.toPng ?? defaultSharpConvert;
    pngBuffer = await converter(svg);
  } catch {
    pngBuffer = null;
  }
  if (pngBuffer !== null && pngPath !== null) {
    try {
      await mkdir(dirname(pngPath), { recursive: true });
      // writeFile DI для тестов принимает string; для бинарника используем fs напрямую.
      await writeFile(pngPath, pngBuffer);
    } catch {
      pngPath = null;
    }
  } else {
    pngPath = null;
  }

  return {
    status: 'ok',
    svgPath,
    pngPath,
    template: opts.template,
    errors: [],
  };
}

async function defaultSharpConvert(svg: string): Promise<Buffer | null> {
  try {
    // Динамический импорт — не падаем если sharp не установлен.
    const sharpModule = await import('sharp');
    const sharp = sharpModule.default ?? sharpModule;
    const buf = await sharp(Buffer.from(svg)).resize(1200, 630, { fit: 'cover' }).png().toBuffer();
    return buf;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.title === null || args.title.trim() === '') {
    emit({
      status: 'failed',
      svgPath: null,
      pngPath: null,
      template: args.template,
      errors: ['нет --title'],
    });
    process.exit(1);
  }
  if (args.out === null || args.out.trim() === '') {
    emit({
      status: 'failed',
      svgPath: null,
      pngPath: null,
      template: args.template,
      errors: ['нет --out'],
    });
    process.exit(1);
  }
  const result = await generateCover({
    title: args.title as string,
    template: args.template,
    outPath: args.out as string,
  });
  emit(result);
  if (result.status === 'failed') process.exit(1);
}

const isMainEntry = fileURLToPath(import.meta.url) === process.argv[1];
if (isMainEntry) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    emit({
      status: 'failed',
      svgPath: null,
      pngPath: null,
      template: null,
      errors: [`uncaught: ${msg}`],
    });
    process.exit(1);
  });
}
