#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const candidateArg = args.find((arg) => !arg.startsWith('--'));

function readOption(name, fallback) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);

  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function normalizedReferenceUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname.toLowerCase() === 't.me') {
      const parts = url.pathname.split('/').filter(Boolean);
      const channel = parts[0] === 's' ? parts[1] : parts[0];
      if (channel) {
        url.pathname = `/s/${channel}`;
        url.search = '';
        url.hash = '';
      }
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return rawUrl;
  }
}

function registryUrls(markdown) {
  return [...markdown.matchAll(/^\|\s*(https:\/\/[^|\s]+)\s*\|/gm)].map((match) =>
    normalizedReferenceUrl(match[1]),
  );
}

const genericValues = new Set([
  'прочитано',
  'применено',
  'прочитано/применено',
  'готово',
  'не применено',
  'использовано',
]);

function validateTextField(issues, value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ code: 'field_required', path, message: `${path} must be a non-empty string.` });
    return;
  }
  if (genericValues.has(normalize(value))) {
    issues.push({
      code: 'field_too_generic',
      path,
      message: `${path} must describe concrete evidence, not a completion marker.`,
    });
  }
}

function validateMasterySource(issues, value, path) {
  validateTextField(issues, value, path);
  if (typeof value !== 'string' || !/^mastery\/.+\.md$/i.test(value.replace(/\\/g, '/'))) {
    issues.push({
      code: 'mastery_source_invalid',
      path,
      message: `${path} must point to a Markdown file under mastery/.`,
    });
  }
}

export function validateEditorialEvidence(evidence, enabledReferenceUrls, phase = 'complete') {
  const issues = [];
  const references = Array.isArray(evidence?.references) ? evidence.references : [];
  const expected = enabledReferenceUrls.map(normalizedReferenceUrl);
  const attempts = new Map();

  for (const [index, item] of references.entries()) {
    const path = `references[${index}]`;
    validateTextField(issues, item?.url, `${path}.url`);
    const url = normalizedReferenceUrl(item?.url ?? '');
    attempts.set(url, (attempts.get(url) ?? 0) + 1);
    if (item?.status !== 'opened' && item?.status !== 'failed') {
      issues.push({
        code: 'reference_status_invalid',
        path: `${path}.status`,
        message: 'status must be opened or failed.',
      });
    }
    if (item?.status === 'opened') {
      const before = issues.length;
      validateTextField(issues, item?.observed_pattern, `${path}.observed_pattern`);
      if (
        issues.length > before &&
        (typeof item?.observed_pattern !== 'string' || item.observed_pattern.trim() === '')
      ) {
        issues.push({
          code: 'reference_observed_pattern_required',
          path: `${path}.observed_pattern`,
          message: 'Opened references require an observed pattern.',
        });
      }
    }
    validateTextField(issues, item?.article_decision, `${path}.article_decision`);
    validateTextField(issues, item?.accessed_at, `${path}.accessed_at`);
    if (typeof item?.accessed_at === 'string' && !Number.isFinite(Date.parse(item.accessed_at))) {
      issues.push({
        code: 'reference_accessed_at_invalid',
        path: `${path}.accessed_at`,
        message: 'accessed_at must be an ISO date.',
      });
    }
  }

  for (const url of expected) {
    const count = attempts.get(url) ?? 0;
    if (count === 0)
      issues.push({
        code: 'reference_missing_attempt',
        url,
        message: `No attempt recorded for ${url}.`,
      });
    if (count > 1)
      issues.push({
        code: 'reference_duplicate_attempt',
        url,
        message: `More than one attempt recorded for ${url}.`,
      });
  }
  for (const [url, count] of attempts) {
    if (!expected.includes(url))
      issues.push({
        code: 'reference_not_enabled',
        url,
        message: `${url} is not enabled in the registry.`,
      });
    if (count > 1 && !expected.includes(url))
      issues.push({
        code: 'reference_duplicate_attempt',
        url,
        message: `More than one attempt recorded for ${url}.`,
      });
  }

  const preDraft = Array.isArray(evidence?.mastery?.pre_draft) ? evidence.mastery.pre_draft : [];
  if (preDraft.length === 0)
    issues.push({
      code: 'mastery_pre_draft_required',
      path: 'mastery.pre_draft',
      message: 'At least one pre-draft mastery decision is required.',
    });
  for (const [index, item] of preDraft.entries()) {
    const path = `mastery.pre_draft[${index}]`;
    validateMasterySource(issues, item?.source, `${path}.source`);
    for (const field of ['method', 'problem', 'location', 'rejected_alternative']) {
      validateTextField(issues, item?.[field], `${path}.${field}`);
    }
  }

  const postDraft = Array.isArray(evidence?.mastery?.post_draft) ? evidence.mastery.post_draft : [];
  if (phase !== 'pre' && postDraft.length === 0)
    issues.push({
      code: 'mastery_post_draft_required',
      path: 'mastery.post_draft',
      message: 'At least one post-draft mastery edit is required.',
    });
  for (const [index, item] of postDraft.entries()) {
    const path = `mastery.post_draft[${index}]`;
    validateMasterySource(issues, item?.source, `${path}.source`);
    for (const field of ['method', 'before', 'after', 'reason']) {
      validateTextField(issues, item?.[field], `${path}.${field}`);
    }
    if (
      typeof item?.before === 'string' &&
      normalize(item.before) === normalize(item?.after ?? '')
    ) {
      issues.push({
        code: 'mastery_edit_unchanged',
        path,
        message: 'before and after must describe an actual edit.',
      });
    }
  }

  return { pass: issues.length === 0, issues };
}

const evidencePathArg = readOption('--validate-evidence', null);
if (evidencePathArg) {
  const registryPath = resolve(readOption('--registry', 'org/reference-blogs.md'));
  let result;
  try {
    const evidence = JSON.parse(readFileSync(resolve(evidencePathArg), 'utf8'));
    const phase = readOption('--phase', 'complete');
    if (phase !== 'pre' && phase !== 'complete') {
      throw new Error('--phase must be pre or complete');
    }
    result = validateEditorialEvidence(
      evidence,
      registryUrls(readFileSync(registryPath, 'utf8')),
      phase,
    );
  } catch (error) {
    result = {
      pass: false,
      issues: [
        {
          code: 'evidence_read_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
}

if (!candidateArg) {
  console.error(
    'Usage: node scripts/article-editorial-context.mjs content/<slug>.md [--content-dir content] [--recent 5] or --validate-evidence evidence.json [--registry org/reference-blogs.md]',
  );
  process.exit(2);
}

const candidatePath = resolve(candidateArg);
const contentDir = resolve(readOption('--content-dir', dirname(candidatePath)));
const parsedRecent = Number.parseInt(readOption('--recent', '5'), 10);
const recentLimit = Number.isFinite(parsedRecent) && parsedRecent >= 0 ? parsedRecent : 5;

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isArticleMarkdown(file) {
  if (extname(file).toLowerCase() !== '.md') return false;
  return !/[.](research|checklist|qa|plan|service)(?:[.][^.]+)?[.]md$/i.test(file);
}

function headings(markdown, level) {
  const prefix = '#'.repeat(level);
  return markdown
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`${prefix} `) && !line.startsWith(`${prefix}#`))
    .map((line) => line.slice(level + 1).trim());
}

function h1Formula(title) {
  const value = normalize(title).replace(/[?!.,:;]+$/g, '');
  if (/^.+\s+начина(?:ется|ются)\s+с\s+.+$/.test(value)) return 'x начинается с y';
  if (/^.+\s+скрыва(?:ет|ют)\s+.+$/.test(value)) return 'x скрывает y';
  if (/^почему\s+.+$/.test(value)) return 'почему x';
  if (/^как\s+.+$/.test(value)) return 'как x';
  if (/^.+:\s+.+$/.test(value)) return 'x: y';
  return 'other';
}

function sceneType(introduction) {
  const text = normalize(introduction);
  if (
    /(утром|вечером|на встрече|в кабинете|в чате|на планерке|руководител|сотрудник|коллег|клиент).{0,160}(открыва|говор|спрашива|обсужда|пишет|звонит|ждет)/.test(
      text,
    )
  ) {
    return 'workplace_scene';
  }
  if (/(представьте|допустим|вообразите)/.test(text)) return 'hypothetical_scene';
  if (/\bя\s+(увидел|увидела|спросил|спросила|заметил|заметила|пришел|пришла)\b/.test(text)) {
    return 'personal_scene';
  }
  return 'no_scene';
}

function practicalBlock(markdown, secondLevel) {
  const text = normalize(markdown);
  const headingText = normalize(secondLevel.join(' | '));
  if (
    /(практик|упражнен|разберите|проверьте|возьмите)/.test(headingText) &&
    /(один|одну|одно|1)\s+(случай|заявк|документ|заказ|счет|обещан)/.test(text) &&
    /(карт|по шагам|передач)/.test(text)
  ) {
    return 'single_case_map';
  }
  if (/(чек-лист|чеклист|список проверки)/.test(headingText)) return 'checklist';
  if (/(эксперимент|пилот|тест на неделю)/.test(headingText)) return 'experiment';
  if (/(сравните|сравнение|два варианта)/.test(headingText)) return 'comparison';
  return 'no_practical_block';
}

function finalMove(markdown, secondLevel) {
  const lastHeading = normalize(secondLevel.at(-1) ?? '');
  const tail = normalize(markdown.slice(-800));
  if (
    /(завтра|следующ(?:ий|его) (?:шаг|действ)|с чего начать|начните|выберите один)/.test(
      `${lastHeading} ${tail}`,
    )
  ) {
    return 'next_action';
  }
  if (/(вопрос|подумайте|спросите себя)/.test(lastHeading)) return 'open_question';
  if (/(итог|вывод|главное)/.test(lastHeading)) return 'summary';
  if (/(обратитесь|напишите|оставьте заявку|свяжитесь)/.test(tail)) return 'call_to_action';
  return 'statement';
}

function fingerprint(markdown) {
  const firstLevel = headings(markdown, 1);
  const secondLevel = headings(markdown, 2);
  const firstH2Index = markdown.search(/^##\s+/m);
  const introduction = firstH2Index >= 0 ? markdown.slice(0, firstH2Index) : markdown;
  const questions = secondLevel.filter((heading) => /\?$/.test(heading.trim())).length;
  const questionH2Ratio =
    secondLevel.length === 0 ? 0 : Number((questions / secondLevel.length).toFixed(2));
  const questionSpine = secondLevel.length >= 3 && questionH2Ratio >= 0.5;
  const scene = sceneType(introduction);
  const practical = practicalBlock(markdown, secondLevel);
  const final = finalMove(markdown, secondLevel);
  const narrativeForm =
    scene !== 'no_scene' ? 'scene_to_explanation' : questionSpine ? 'question_led' : 'expository';
  const compositionSequence = [
    scene,
    questionSpine ? 'question_spine' : 'statement_spine',
    practical,
    final,
  ];

  return {
    h1Formula: h1Formula(firstLevel[0] ?? ''),
    questionH2Ratio,
    questionSpine,
    sceneType: scene,
    narrativeForm,
    practicalBlock: practical,
    finalMove: final,
    compositionSequence,
  };
}

function publicationTimestamp(markdown) {
  const frontmatter = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) return null;

  for (const key of ['publication_date', 'published_at', 'date']) {
    const match = frontmatter.match(new RegExp(`^${key}:\\s*["']?([^"'\\r\\n]+)["']?\\s*$`, 'im'));
    if (!match) continue;
    const timestamp = Date.parse(match[1].trim());
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

function articleInfo(path) {
  const markdown = readFileSync(path, 'utf8');
  return {
    path,
    fingerprint: fingerprint(markdown),
    publicationTimestamp: publicationTimestamp(markdown),
  };
}

function recentArticles() {
  return readdirSync(contentDir)
    .filter(isArticleMarkdown)
    .map((file) => join(contentDir, file))
    .filter((file) => resolve(file) !== candidatePath)
    .map((file) => ({ ...articleInfo(file), mtimeMs: statSync(file).mtimeMs }))
    .sort((left, right) => {
      if (left.publicationTimestamp !== null || right.publicationTimestamp !== null) {
        if (left.publicationTimestamp === null) return 1;
        if (right.publicationTimestamp === null) return -1;
        if (left.publicationTimestamp !== right.publicationTimestamp) {
          return right.publicationTimestamp - left.publicationTimestamp;
        }
      }

      // Filenames are the stable fallback; mtime only resolves an otherwise identical key.
      return right.path.localeCompare(left.path, 'en') || right.mtimeMs - left.mtimeMs;
    })
    .slice(0, recentLimit)
    .map(
      ({ mtimeMs: _mtimeMs, publicationTimestamp: _publicationTimestamp, ...article }) => article,
    );
}

function dominantValues(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const maximum = Math.max(0, ...counts.values());
  if (maximum < 2) return [];
  return [...counts.entries()]
    .filter(([, count]) => count === maximum)
    .sort(([leftValue], [rightValue]) => leftValue.localeCompare(rightValue, 'en'));
}

const candidate = articleInfo(candidatePath);
const recent = recentArticles();
const issues = [];
const dominantFormulas = dominantValues(
  recent.map(({ fingerprint: item }) => item.h1Formula).filter((formula) => formula !== 'other'),
);
const repeatedFormula = dominantFormulas.find(
  ([formula]) => candidate.fingerprint.h1Formula === formula,
);

if (repeatedFormula) {
  issues.push({
    code: 'dominant_h1_formula',
    message: `Candidate repeats the recent dominant H1 formula: ${repeatedFormula[0]}.`,
    formula: repeatedFormula[0],
    recentCount: repeatedFormula[1],
  });
}

const candidateComposition = JSON.stringify(candidate.fingerprint.compositionSequence);
const repeatedCompositionCount = recent.filter(
  ({ fingerprint: item }) => JSON.stringify(item.compositionSequence) === candidateComposition,
).length;

if (repeatedCompositionCount >= 2) {
  issues.push({
    code: 'repeated_composition',
    message: 'Candidate repeats a composition sequence used by at least two recent articles.',
    compositionSequence: candidate.fingerprint.compositionSequence,
    recentCount: repeatedCompositionCount,
  });
}

const result = { candidate, recent, issues, pass: issues.length === 0 };
console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
