#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const candidateArg = args.find((arg) => !arg.startsWith('--'));

if (!candidateArg) {
  console.error('Usage: node scripts/article-diversity-check.mjs content/<slug>.md [--content-dir content] [--recent 5] [--json]');
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
const contentDir = resolve(readOption('--content-dir', dirname(candidatePath)));
const recentLimit = Number.parseInt(readOption('--recent', '5'), 10);
const jsonOutput = args.includes('--json');

function isArticleMarkdown(file) {
  if (extname(file) !== '.md') {
    return false;
  }

  return !/[.](research|checklist|plan|retro|notes)\.md$/i.test(file);
}

function normalize(text) {
  return text.toLowerCase().replace(/ё/g, 'е');
}

function h1AndH2(markdown) {
  return markdown
    .split(/\r?\n/)
    .filter((line) => /^#{1,2}\s+/.test(line))
    .map((line) => line.replace(/^#{1,2}\s+/, '').trim());
}

function h2(markdown) {
  return markdown
    .split(/\r?\n/)
    .filter((line) => /^##\s+/.test(line))
    .map((line) => line.replace(/^##\s+/, '').trim());
}

function articleInfo(filePath) {
  const markdown = readFileSync(filePath, 'utf8');
  const headings = h1AndH2(markdown);
  const secondLevel = h2(markdown);
  const text = normalize(markdown);
  const headingText = normalize(headings.join(' | '));
  const firstHalf = normalize(markdown.slice(0, 4000));
  const finalH2 = normalize(secondLevel.at(-1) ?? '');

  const categories = {
    one_object_drill:
      /(провед|передайте|опишите|разберите|возьмите|начните)\s+(1|один|одну|одно|обычн|последн).{0,90}(заказ|счет|счёт|товар|заявк|процесс|результат|документ|согласован|строк|объект)/.test(firstHalf) ||
      /(провед|передайте|опишите|разберите|возьмите|начните).{0,60}(через|по).{0,40}(шаг|передач|событ|пол)/.test(headingText),
    queue_status_core: /(очеред|статус|ждет|ждут|завис|следующий шаг|в работе|передач)/.test(headingText),
    exception_core: /(исключ|ошиб|сбой|расхожд|не хватает|непол|просроч|проблем)/.test(headingText),
    rule_owner_core: /(правил|владел|ответствен|кто должен|кто решает|кому|у кого)/.test(headingText),
    pilot_readiness_end: /(пилот|автоматизац|когда пора|рано|готов|специалист|система)/.test(headingText),
    table_card_artifact: /(таблиц|карточк|карта|бриф|письм|вопрос).{0,90}(пол|передач|событ|шаг|строк|руководител|специалист)/.test(text),
    action_final: /(пора|останов|письм|бриф|вопрос|маленьк|специалист|когда|готов|шаг)/.test(finalH2),
  };

  return {
    path: filePath,
    title: headings[0] ?? basename(filePath),
    h2: secondLevel,
    finalH2: secondLevel.at(-1) ?? '',
    categories,
    categoryNames: Object.entries(categories)
      .filter(([, value]) => value)
      .map(([key]) => key),
  };
}

function recentArticles() {
  return readdirSync(contentDir)
    .filter(isArticleMarkdown)
    .map((file) => join(contentDir, file))
    .filter((file) => resolve(file) !== candidatePath)
    .map((file) => ({ file, mtimeMs: statSync(file).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, recentLimit)
    .map(({ file }) => articleInfo(file));
}

const candidate = articleInfo(candidatePath);
const recent = recentArticles();

const comparisons = recent.map((article) => {
  const overlap = candidate.categoryNames.filter((category) => article.categoryNames.includes(category));
  return {
    path: article.path,
    title: article.title,
    finalH2: article.finalH2,
    overlap,
    overlapCount: overlap.length,
  };
});

const recurringCategories = candidate.categoryNames.filter((category) => {
  const usedByRecent = recent.filter((article) => article.categoryNames.includes(category)).length;
  return usedByRecent >= Math.min(3, recent.length);
});

const issues = [];
const nearClone = comparisons.find((comparison) => comparison.overlapCount >= 4);

if (nearClone) {
  issues.push({
    code: 'near_clone_structure',
    message: `Structural overlap ${nearClone.overlapCount}/7 with ${nearClone.title}`,
    overlap: nearClone.overlap,
  });
}

if (recurringCategories.length >= 4) {
  issues.push({
    code: 'recurring_operational_skeleton',
    message: 'The draft reuses too many recurring article-shape categories from recent posts.',
    categories: recurringCategories,
  });
}

if (
  candidate.categories.one_object_drill &&
  recent.filter((article) => article.categories.one_object_drill).length >= 2
) {
  issues.push({
    code: 'reused_one_object_drill',
    message: 'Recent posts already use the "run one object through N steps/transfers" practical block.',
  });
}

if (
  candidate.categories.action_final &&
  recent.filter((article) => article.categories.action_final).length >= 3
) {
  issues.push({
    code: 'reused_action_final',
    message: 'Recent posts already end with an action/check/readiness move.',
  });
}

if (
  candidate.categories.table_card_artifact &&
  recent.filter((article) => article.categories.table_card_artifact).length >= 3
) {
  issues.push({
    code: 'reused_table_card_artifact',
    message: 'Recent posts already rely on a table/card/map/brief practical block. Use a different article form, not another table-like artifact.',
  });
}

const result = {
  pass: issues.length === 0,
  candidate: {
    path: candidate.path,
    title: candidate.title,
    finalH2: candidate.finalH2,
    categories: candidate.categoryNames,
  },
  recent: comparisons,
  issues,
};

if (jsonOutput) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.pass) {
  console.log(`Article diversity gate passed for ${candidate.title}`);
} else {
  console.error(`Article diversity gate failed for ${candidate.title}`);
  for (const issue of issues) {
    console.error(`- ${issue.code}: ${issue.message}`);
  }
}

process.exit(result.pass ? 0 : 1);
