#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const args = process.argv.slice(2);
const candidateArg = args.find((arg) => !arg.startsWith('--'));

if (!candidateArg) {
  console.error(
    'Usage: node scripts/article-business-readability-check.mjs content/<slug>.md [--lead-chars 1500] [--json]',
  );
  process.exit(2);
}

function readOption(name, fallback) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) {
    return args[index + 1];
  }

  return fallback;
}

const candidatePath = resolve(candidateArg);
const leadChars = Number.parseInt(readOption('--lead-chars', '1500'), 10);
const jsonOutput = args.includes('--json');

function normalize(text) {
  return text.toLowerCase().replace(/ё/g, 'е');
}

function stripFrontMatter(markdown) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
}

function stripMarkdown(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[[^\]]+\]\([^)]+\)/g, '$1')
    .replace(/[|*_>~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function h1(markdown) {
  return markdown
    .split(/\r?\n/)
    .find((line) => /^#\s+/.test(line))
    ?.replace(/^#\s+/, '')
    .trim();
}

function h2(markdown) {
  return markdown
    .split(/\r?\n/)
    .filter((line) => /^##\s+/.test(line))
    .map((line) => line.replace(/^##\s+/, '').trim());
}

function contentAfterH1(markdown) {
  const lines = markdown.split(/\r?\n/);
  const h1Index = lines.findIndex((line) => /^#\s+/.test(line));
  return lines.slice(h1Index >= 0 ? h1Index + 1 : 0).join('\n');
}

function firstParagraph(markdown) {
  return (
    contentAfterH1(markdown)
      .split(/\r?\n\s*\r?\n/)
      .map((paragraph) => paragraph.trim())
      .find((paragraph) => paragraph && !paragraph.startsWith('#') && !paragraph.startsWith('|')) ??
    ''
  );
}

const BUSINESS_PATTERNS = [
  'клиент[а-яa-z-]*',
  'покупател[а-яa-z-]*',
  'заявк[а-яa-z-]*',
  'заказ[а-яa-z-]*',
  'продаж[а-яa-z-]*',
  'выручк[а-яa-z-]*',
  'деньг[а-яa-z-]*',
  'оплат[а-яa-z-]*',
  'срок[а-яa-z-]*',
  'обещан[а-яa-z-]*',
  'довер[а-яa-z-]*',
  'скидк[а-яa-z-]*',
  'менеджер[а-яa-z-]*',
  'руководител[а-яa-z-]*',
  'сотрудник[а-яa-z-]*',
  'команд[а-яa-z-]*',
  'склад[а-яa-z-]*',
  'товар[а-яa-z-]*',
  'чат[а-яa-z-]*',
  'звон[а-яa-z-]*',
  'ручн[а-яa-z-]*',
  'таблиц[а-яa-z-]*',
  'час[а-яa-z-]*',
  'врем[а-яa-z-]*',
];

const CONSEQUENCE_PATTERNS = [
  'теря[а-яa-z-]*',
  'потер[а-яa-z-]*',
  'деньг[а-яa-z-]*',
  'выручк[а-яa-z-]*',
  'продаж[а-яa-z-]*',
  'оплат[а-яa-z-]*',
  'прибыл[а-яa-z-]*',
  'марж[а-яa-z-]*',
  'штраф[а-яa-z-]*',
  'возврат[а-яa-z-]*',
  'скидк[а-яa-z-]*',
  'довер[а-яa-z-]*',
  'репутац[а-яa-z-]*',
  'срок[а-яa-z-]*',
  'задерж[а-яa-z-]*',
  'жд[а-яa-z-]*',
  'раздраж[а-яa-z-]*',
  'забыт[а-яa-z-]*',
  'ошиб[а-яa-z-]*',
  'отмен[а-яa-z-]*',
  'риск[а-яa-z-]*',
];

const HUMAN_SCENE_PATTERNS = [
  'клиент[а-яa-z-]*',
  'покупател[а-яa-z-]*',
  'менеджер[а-яa-z-]*',
  'руководител[а-яa-z-]*',
  'сотрудник[а-яa-z-]*',
  'команд[а-яa-z-]*',
  'коллег[а-яa-z-]*',
  'поставщик[а-яa-z-]*',
  'склад[а-яa-z-]*',
  'заявк[а-яa-z-]*',
  'заказ[а-яa-z-]*',
  'счет[а-яa-z-]*',
  'оплат[а-яa-z-]*',
  'чат[а-яa-z-]*',
  'звон[а-яa-z-]*',
  'утр[а-яa-z-]*',
  'вечер[а-яa-z-]*',
  'обед[а-яa-z-]*',
];

const TECHNICAL_PATTERNS = [
  'автоматизац[а-яa-z-]*',
  'интеграц[а-яa-z-]*',
  'crm',
  'бот[а-яa-z-]*',
  'систем[а-яa-z-]*',
  'сервис[а-яa-z-]*',
  'скрипт[а-яa-z-]*',
  'алгоритм[а-яa-z-]*',
  'процесс[а-яa-z-]*',
  'сценари[а-яa-z-]*',
  'маршрут[а-яa-z-]*',
  'статус[а-яa-z-]*',
  'правил[а-яa-z-]*',
  'исключ[а-яa-z-]*',
  'пилот[а-яa-z-]*',
  'карточк[а-яa-z-]*',
  'очеред[а-яa-z-]*',
  'владел[а-яa-z-]*',
  'эскалац[а-яa-z-]*',
  'пол[ея][а-яa-z-]*',
  'данн[а-яa-z-]*',
  'передач[а-яa-z-]*',
  'событи[а-яa-z-]*',
];

const TOOL_SUBJECTS = [
  'crm',
  'бот',
  'система',
  'сервис',
  'платформа',
  'программа',
  'таблица',
  'интеграция',
  'скрипт',
  'алгоритм',
  'модуль',
  'форма',
];

const TOOL_AGENCY_VERBS = [
  'умеет',
  'умеют',
  'понимает',
  'понимают',
  'знает',
  'знают',
  'помнит',
  'помнят',
  'решает',
  'решают',
  'договаривается',
  'договариваются',
  'думает',
  'думают',
  'видит',
  'видят',
  'замечает',
  'замечают',
];

function countPatterns(text, patterns) {
  const normalizedText = normalize(text);
  return patterns.reduce((total, pattern) => {
    return total + (normalizedText.match(new RegExp(pattern, 'giu')) ?? []).length;
  }, 0);
}

function wordCount(text) {
  return (normalize(text).match(/[а-яa-z0-9]+/giu) ?? []).length;
}

function startsAsWorkshop(paragraph) {
  return /^(проведите|возьмите|выпишите|отметьте|найдите|соберите|опишите|проверьте|разберите)(?=$|[\s:,.!?])/iu.test(
    normalize(paragraph.trim()),
  );
}

function includesToolBeforePain(paragraph) {
  const normalizedParagraph = normalize(paragraph);
  const toolTerms = countPatterns(normalizedParagraph, [
    'автоматизац[а-яa-z-]*',
    'интеграц[а-яa-z-]*',
    'crm',
    'бот[а-яa-z-]*',
    'систем[а-яa-z-]*',
    'процесс[а-яa-z-]*',
    'статус[а-яa-z-]*',
    'правил[а-яa-z-]*',
    'очеред[а-яa-z-]*',
  ]);
  const consequences = countPatterns(normalizedParagraph, CONSEQUENCE_PATTERNS);

  return toolTerms >= 2 && consequences < 2;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findToolAgencyPhrases(text) {
  const normalizedText = normalize(text);
  const subjectPattern = TOOL_SUBJECTS.map(escapeRegExp).join('|');
  const verbPattern = TOOL_AGENCY_VERBS.map(escapeRegExp).join('|');
  const pattern = new RegExp(
    `(?:^|[^а-яa-z0-9])(${subjectPattern})(?:\\s+\\S+){0,3}\\s+(${verbPattern})(?=$|[^а-яa-z0-9])`,
    'giu',
  );
  const matches = [];
  let match;
  // biome-ignore lint/suspicious/noAssignInExpressions: classic regex iterate loop
  while ((match = pattern.exec(normalizedText)) !== null) {
    matches.push(match[0].trim().replace(/\s+/g, ' '));
    if (matches.length >= 8) break;
  }
  return matches;
}

function articleInfo(filePath) {
  const markdown = stripFrontMatter(readFileSync(filePath, 'utf8'));
  const cleanText = stripMarkdown(markdown);
  const afterH1 = contentAfterH1(markdown);
  const earlyText = stripMarkdown(afterH1).slice(0, leadChars);
  const first = firstParagraph(markdown);
  const secondLevelHeadings = h2(markdown);
  const normalizedHeadings = secondLevelHeadings.map(normalize);
  const technicalHeadingCount = normalizedHeadings.filter(
    (heading) => countPatterns(heading, TECHNICAL_PATTERNS) > 0,
  ).length;
  const businessHeadingCount = normalizedHeadings.filter(
    (heading) => countPatterns(heading, BUSINESS_PATTERNS) > 0,
  ).length;
  const totalWords = wordCount(cleanText);
  const totalTechnicalTerms = countPatterns(cleanText, TECHNICAL_PATTERNS);
  const toolAgencyPhrases = findToolAgencyPhrases(cleanText);

  const metrics = {
    early: {
      chars: earlyText.length,
      businessSignals: countPatterns(earlyText, BUSINESS_PATTERNS),
      consequenceSignals: countPatterns(earlyText, CONSEQUENCE_PATTERNS),
      humanSceneSignals: countPatterns(earlyText, HUMAN_SCENE_PATTERNS),
      technicalTerms: countPatterns(earlyText, TECHNICAL_PATTERNS),
    },
    firstParagraph: {
      chars: first.length,
      businessSignals: countPatterns(first, BUSINESS_PATTERNS),
      consequenceSignals: countPatterns(first, CONSEQUENCE_PATTERNS),
      technicalTerms: countPatterns(first, TECHNICAL_PATTERNS),
      startsAsWorkshop: startsAsWorkshop(first),
      toolBeforePain: includesToolBeforePain(first),
    },
    headings: {
      h2Count: secondLevelHeadings.length,
      technicalHeadingCount,
      businessHeadingCount,
    },
    article: {
      wordCount: totalWords,
      technicalTerms: totalTechnicalTerms,
      technicalTermsPerThousandWords:
        totalWords > 0 ? Math.round((totalTechnicalTerms / totalWords) * 1000) : 0,
      toolAgencyPhrases,
    },
  };

  const issues = [];

  if (metrics.firstParagraph.startsAsWorkshop) {
    issues.push({
      code: 'lead_starts_with_workshop_instruction',
      message:
        'The opening starts with a process instruction instead of a business scene or consequence.',
    });
  }

  if (metrics.firstParagraph.toolBeforePain) {
    issues.push({
      code: 'tool_before_business_pain',
      message:
        'The first paragraph introduces automation/tool/process terms before making the business pain clear.',
    });
  }

  if (
    metrics.early.businessSignals < 8 ||
    metrics.early.consequenceSignals < 3 ||
    metrics.early.humanSceneSignals < 3
  ) {
    issues.push({
      code: 'weak_business_lead',
      message:
        'The first 1500 characters need more customers, money/time/sales consequences, and recognizable human scene.',
    });
  }

  if (
    metrics.early.technicalTerms >= 8 &&
    metrics.early.technicalTerms >= metrics.early.businessSignals
  ) {
    issues.push({
      code: 'technical_lead_density',
      message: 'The opening is dominated by process/tool vocabulary instead of business language.',
    });
  }

  if (
    metrics.headings.h2Count >= 4 &&
    metrics.headings.technicalHeadingCount >= 3 &&
    metrics.headings.technicalHeadingCount >= Math.ceil(metrics.headings.h2Count / 2)
  ) {
    issues.push({
      code: 'technical_heading_spine',
      message:
        'Too many H2 headings are built around statuses, rules, exceptions, pilots, queues, or similar process terms.',
    });
  }

  if (metrics.article.wordCount >= 700 && metrics.article.technicalTermsPerThousandWords > 55) {
    issues.push({
      code: 'technical_article_density',
      message: 'The article overall uses too much process/automation vocabulary per 1000 words.',
    });
  }

  if (metrics.article.toolAgencyPhrases.length > 0) {
    issues.push({
      code: 'tool_agency_phrasing',
      message:
        'Tools should not be described with human-skill verbs like "умеет"; rewrite as "в CRM можно...", "настройка позволяет...", or name the human/process action.',
      examples: metrics.article.toolAgencyPhrases,
    });
  }

  return {
    pass: issues.length === 0,
    candidate: {
      path: filePath,
      title: h1(markdown) ?? basename(filePath),
    },
    metrics,
    issues,
  };
}

const result = articleInfo(candidatePath);

if (jsonOutput) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.pass) {
  console.log(`Business readability gate passed for ${result.candidate.title}`);
} else {
  console.error(`Business readability gate failed for ${result.candidate.title}`);
  for (const issue of result.issues) {
    console.error(`- ${issue.code}: ${issue.message}`);
  }
}

process.exit(result.pass ? 0 : 1);
