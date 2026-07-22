// seo-audit/scripts/audit.ts
//
// Структурный SEO-аудит markdown-draft. Парсит markdown, проверяет
// набор правил (H1/H2/lead/links/title/meta), возвращает JSON со списком
// issues + score 0–100.
//
// Использование:
//   pnpm exec tsx skills/seo-audit/scripts/audit.ts <path>
//
// Контракт stdout (последняя строка):
//   {path, issues: [{severity, rule, message}], score, frontmatter}
//
// LLM-вызовы запрещены (anti-goal #5).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export type Severity = 'error' | 'warning' | 'info';

export interface AuditIssue {
  severity: Severity;
  rule: string;
  message: string;
}

export interface AuditOutput {
  path: string;
  issues: AuditIssue[];
  score: number;
  frontmatter: Record<string, string>;
  errors: string[];
}

const TITLE_MIN = 40;
const TITLE_MAX = 70;
const LEAD_MIN = 100;
const LEAD_MAX = 250;
const META_MIN = 140;
const META_MAX = 160;
const H2_MIN = 2;

function parseArgs(argv: string[]): { path: string | null } {
  const positional = argv.filter((a) => !a.startsWith('--'));
  return { path: positional[0] ?? null };
}

function emit(out: AuditOutput): void {
  console.log(JSON.stringify(out));
}

interface MarkdownParts {
  frontmatter: Record<string, string>;
  body: string;
}

/**
 * Минимальный frontmatter-парсер: `key: value` пары до второго `---`. Без
 * вложенных структур и массивов. Этого достаточно для title/description.
 */
function splitFrontmatter(source: string): MarkdownParts {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) {
    return { frontmatter: {}, body: source };
  }
  const lines = source.split('\n');
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return { frontmatter: {}, body: source };
  const fm: Record<string, string> = {};
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trim = line.trim();
    if (trim === '' || trim.startsWith('#')) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(trim);
    if (m === null || m[1] === undefined || m[2] === undefined) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    fm[m[1]] = v;
  }
  const body = lines
    .slice(endIdx + 1)
    .join('\n')
    .trim();
  return { frontmatter: fm, body };
}

/** Извлекает первый абзац (lead) — текст до первого H1/H2 или blank-blank. */
function extractLead(body: string): string {
  // Уберём первый H1 в начале (если есть) — lead идёт после него.
  let working = body;
  const h1 = /^#\s+.+\n+/.exec(working);
  if (h1 !== null) working = working.slice(h1[0].length);
  // Lead — до первого пустого блока или следующего заголовка.
  const lead: string[] = [];
  const lines = working.split('\n');
  for (const ln of lines) {
    if (/^#{1,6}\s+/.test(ln)) break;
    if (ln.trim() === '' && lead.length > 0) break;
    if (ln.trim() === '') continue;
    lead.push(ln);
  }
  return lead.join(' ').trim();
}

/**
 * Главная функция аудита. Экспортируется для unit-тестов.
 */
export function auditMarkdown(source: string, path: string): AuditOutput {
  const issues: AuditIssue[] = [];
  const { frontmatter, body } = splitFrontmatter(source);

  // 1. H1: exactly one. Считаем строки начинающиеся с `# ` (но не `##`).
  const h1Matches = body.match(/^# [^\n]+/gm) ?? [];
  if (h1Matches.length === 0) {
    issues.push({
      severity: 'error',
      rule: 'h1-count',
      message: 'Нет H1 (# Заголовок). Должен быть ровно один.',
    });
  } else if (h1Matches.length > 1) {
    issues.push({
      severity: 'error',
      rule: 'h1-count',
      message: `Найдено ${h1Matches.length} H1. Должен быть ровно один.`,
    });
  }

  // 2. H2: ≥ H2_MIN
  const h2Matches = body.match(/^## [^\n]+/gm) ?? [];
  if (h2Matches.length < H2_MIN) {
    issues.push({
      severity: 'warning',
      rule: 'h2-count',
      message: `Найдено ${h2Matches.length} H2, нужно минимум ${H2_MIN} для структуры.`,
    });
  }

  // 3. Lead: длина 100–250 символов
  const lead = extractLead(body);
  if (lead.length === 0) {
    issues.push({
      severity: 'error',
      rule: 'lead-missing',
      message: 'Нет lead-параграфа (текст между H1 и первым H2).',
    });
  } else if (lead.length < LEAD_MIN) {
    issues.push({
      severity: 'warning',
      rule: 'lead-length',
      message: `Lead слишком короткий (${lead.length} символов, нужно ${LEAD_MIN}–${LEAD_MAX}).`,
    });
  } else if (lead.length > LEAD_MAX) {
    issues.push({
      severity: 'warning',
      rule: 'lead-length',
      message: `Lead слишком длинный (${lead.length} символов, нужно ${LEAD_MIN}–${LEAD_MAX}).`,
    });
  }

  // 4. Internal links: хотя бы одна markdown-ссылка вида [text](url).
  const links = body.match(/\[[^\]]+\]\([^)]+\)/g) ?? [];
  if (links.length === 0) {
    issues.push({
      severity: 'warning',
      rule: 'internal-links',
      message: 'Нет ни одной ссылки. Добавь хотя бы 1–2 внутренние/внешние.',
    });
  }

  // 5. Title (frontmatter): длина 40–70.
  const title = frontmatter.title;
  if (title === undefined || title.trim() === '') {
    issues.push({
      severity: 'info',
      rule: 'title-missing',
      message: 'Нет поля title во frontmatter.',
    });
  } else {
    if (title.length < TITLE_MIN) {
      issues.push({
        severity: 'warning',
        rule: 'title-length',
        message: `Title слишком короткий (${title.length} символов, нужно ${TITLE_MIN}–${TITLE_MAX}).`,
      });
    } else if (title.length > TITLE_MAX) {
      issues.push({
        severity: 'warning',
        rule: 'title-length',
        message: `Title слишком длинный (${title.length} символов, нужно ${TITLE_MIN}–${TITLE_MAX}).`,
      });
    }
  }

  // 6. Meta description (frontmatter): если задан — 140–160.
  const desc = frontmatter.description ?? frontmatter.meta;
  if (desc !== undefined && desc.trim() !== '') {
    if (desc.length < META_MIN) {
      issues.push({
        severity: 'info',
        rule: 'meta-length',
        message: `Meta description короче ${META_MIN} символов (${desc.length}).`,
      });
    } else if (desc.length > META_MAX) {
      issues.push({
        severity: 'info',
        rule: 'meta-length',
        message: `Meta description длиннее ${META_MAX} символов (${desc.length}).`,
      });
    }
  }

  // 7. Score: 100 - 25*errors - 10*warnings - 2*info, clamp [0, 100].
  let score = 100;
  for (const i of issues) {
    if (i.severity === 'error') score -= 25;
    else if (i.severity === 'warning') score -= 10;
    else score -= 2;
  }
  if (score < 0) score = 0;
  if (score > 100) score = 100;

  return {
    path,
    issues,
    score,
    frontmatter,
    errors: [],
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.path === null) {
    emit({
      path: '',
      issues: [],
      score: 0,
      frontmatter: {},
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
      issues: [],
      score: 0,
      frontmatter: {},
      errors: [`readFile: ${msg}`],
    });
    process.exit(1);
    return;
  }
  emit(auditMarkdown(source, args.path));
}

const isMainEntry = fileURLToPath(import.meta.url) === process.argv[1];
if (isMainEntry) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    emit({
      path: '',
      issues: [],
      score: 0,
      frontmatter: {},
      errors: [`uncaught: ${msg}`],
    });
    process.exit(1);
  });
}
