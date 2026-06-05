// article-writing/scripts/word-count-check.ts
//
// Считает слова и символы в markdown-файле, сравнивает с диапазоном (по
// умолчанию 1000–3000 слов) и печатает JSON последней строкой stdout:
//   {wordCount, charCount, status: 'ok'|'too-short'|'too-long', min, max, path}
//
// Использование:
//   pnpm exec tsx skills/article-writing/scripts/word-count-check.ts <path> [--min N] [--max M]
//
// Ничего не вызывает кроме fs.readFile — детерминированная проверка.

import { readFile } from 'node:fs/promises';

interface Output {
  path: string;
  wordCount: number;
  charCount: number;
  status: 'ok' | 'too-short' | 'too-long' | 'failed';
  min: number;
  max: number;
  errors: string[];
}

const DEFAULT_MIN = 1000;
const DEFAULT_MAX = 3000;

function parseArgs(argv: string[]): { path: string | null; min: number; max: number } {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flags = argv.filter((a) => a.startsWith('--'));
  const path = positional[0] ?? null;
  let min = DEFAULT_MIN;
  let max = DEFAULT_MAX;
  for (const f of flags) {
    if (f.startsWith('--min=')) {
      const v = Number.parseInt(f.slice('--min='.length), 10);
      if (Number.isFinite(v) && v > 0) min = v;
    } else if (f.startsWith('--max=')) {
      const v = Number.parseInt(f.slice('--max='.length), 10);
      if (Number.isFinite(v) && v > 0) max = v;
    }
  }
  return { path, min, max };
}

function emit(out: Output): void {
  console.log(JSON.stringify(out));
}

/**
 * Считает слова в тексте. Стрипает frontmatter (--- ... ---), markdown-разметку
 * (заголовки, списки, ссылки), оставляет «реальный» текст для подсчёта.
 *
 * Экспортируется для unit-тестов.
 */
export function countWords(source: string): { wordCount: number; charCount: number } {
  // 1. Стрипаем frontmatter.
  let text = source;
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 4);
    if (end !== -1) {
      text = text.slice(end + 4);
    }
  }
  // 2. Стрипаем код-блоки (``` ... ```). Считаются один блок ≈ 1 слово (не
  //    раздуваем счёт кодом).
  text = text.replace(/```[\s\S]*?```/g, ' codeblock ');
  text = text.replace(/`[^`]*`/g, ' inline ');
  // 3. Стрипаем markdown-разметку: заголовки #, списки -/*, ссылки [x](y).
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/^[-*+]\s+/gm, '');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  text = text.replace(/[*_~]+/g, '');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  // 4. Считаем слова: split по любому whitespace, фильтр пустых.
  const words = text.split(/\s+/).filter((w) => w.trim().length > 0);
  return { wordCount: words.length, charCount: source.length };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.path === null) {
    emit({
      path: '',
      wordCount: 0,
      charCount: 0,
      status: 'failed',
      min: args.min,
      max: args.max,
      errors: ['нет аргумента <path>'],
    });
    process.exit(1);
  }
  let source: string;
  try {
    source = await readFile(args.path, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({
      path: args.path,
      wordCount: 0,
      charCount: 0,
      status: 'failed',
      min: args.min,
      max: args.max,
      errors: [`readFile: ${msg}`],
    });
    process.exit(1);
    return;
  }
  const { wordCount, charCount } = countWords(source);
  let status: Output['status'];
  if (wordCount < args.min) status = 'too-short';
  else if (wordCount > args.max) status = 'too-long';
  else status = 'ok';
  emit({
    path: args.path,
    wordCount,
    charCount,
    status,
    min: args.min,
    max: args.max,
    errors: [],
  });
}

// Запускаем main только когда скрипт исполняется напрямую через tsx — не при
// импорте из тестов.
import { fileURLToPath } from 'node:url';
const isMainEntry = fileURLToPath(import.meta.url) === process.argv[1];
if (isMainEntry) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    emit({
      path: '',
      wordCount: 0,
      charCount: 0,
      status: 'failed',
      min: DEFAULT_MIN,
      max: DEFAULT_MAX,
      errors: [`uncaught: ${msg}`],
    });
    process.exit(1);
  });
}
