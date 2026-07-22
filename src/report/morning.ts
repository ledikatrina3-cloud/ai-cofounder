// Сборщик утреннего отчёта (фаза 2.5).
//
// Что делает buildReport:
//   1. Грузит config/report.md и шаблоны *.md из templatesDir (lazy-cached).
//   2. На входе — `ReportInput` со стэйтсами цикла и списком reportItems
//      (active intent.problem + опционально diagnosis + опционально proposal +
//      опционально failure step). Источник правды — caller (runIteration в
//      src/core/loop.ts), который собирает items по только что созданным/затронутым
//      Records, не делая отдельный SQL-запрос «всё за окно».
//   3. Возвращает `TelegramMessage[]` готовые к отправке через `sendReport`:
//        [0] — шапка треда, parse_mode=Markdown.
//        [1..N] — по одному на problem или failure-without-problem; reply_to
//                 будет проставлен sender'ом (он знает messageId шапки).
//   4. На overflow >telegramMessageLimit:
//        - усечение сообщения до (limit - len(overflowSuffix));
//        - запись содержимого в файл `<overflowPageDir>/<ulid>.md` (создаётся
//          вместе с папкой при необходимости, если runIteration уже подсунул
//          фабрику filesystem'а — иначе fail-soft);
//        - INSERT Record `Page` с этим path и type=overflowPageType (gitSha
//          ставим 'pending', поскольку файл ещё не закоммичен — git-watcher
//          обновит).
//
// Что НЕ делает:
//   * НЕ отправляет в Telegram (это src/report/sender.ts).
//   * НЕ пишет audit.report.* (это runIteration).
//   * НЕ ходит в БД за reportItems — caller передаёт.
//
// Архитектурный crumb для 2.5:
//   шаблоны живут в `.md` (config/report.md ссылается на них) — фаундер может
//   подкрутить тон фразы без TS. Это прямое следование CLAUDE.md правилу 1
//   («не хардкодить динамику») для пользовательского текста.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ulid } from 'ulid';
import type { PrismaClient } from '../db/client.js';
import { getPrisma } from '../db/client.js';
import type { ProposalFile } from '../solve/run.js';
import { type ReportConfig, loadReportConfig } from './config.js';

// ---------------------------------------------------------------------------
// Контракт ввода — строится в runIteration по результатам шага 13 («собрать
// reportItems»).
// ---------------------------------------------------------------------------

export interface ReportItemBase {
  // Запись intent.problem из этого цикла. Может быть либо новая (mergeResult.created),
  // либо уже существующая (mergeResult.merged). На каждое уникальное problemId —
  // один ReportItem.
  problemId: string;
  // 1-предложение из intent.problem.properties.summary.
  summary: string;
}

export interface ReportItemCodeWithProposal extends ReportItemBase {
  kind: 'code';
  diagnosisId: string;
  rationale: string;
  // Из intent.proposal.properties.
  proposalId: string;
  asIs: string;
  problem: string;
  asWillBe: string;
  files: ProposalFile[];
  estimateMinutes: number;
}

export interface ReportItemCodeNoProposal extends ReportItemBase {
  kind: 'code-no-proposal';
  diagnosisId: string;
  rationale: string;
}

export interface ReportItemHuman extends ReportItemBase {
  kind: 'human';
  diagnosisId: string;
  rationale: string;
}

export interface ReportItemUnclear extends ReportItemBase {
  kind: 'unclear';
  diagnosisId: string;
  rationale: string;
}

export interface ReportItemFailure extends ReportItemBase {
  kind: 'failure';
  // 'investigate' если audit.investigate.failed; 'solve' если audit.solve.failed.
  step: 'investigate' | 'solve';
  message: string;
}

export type ReportItem =
  | ReportItemCodeWithProposal
  | ReportItemCodeNoProposal
  | ReportItemHuman
  | ReportItemUnclear
  | ReportItemFailure;

export interface DeferredCounts {
  // Сколько проблем не дошли до investigate из-за per-cycle-budget.
  investigateBudget: number;
  // Сколько проблем были обрезаны soft-cap'ом исследователя.
  investigateSoftcap: number;
  // Сколько диагнозов не дошли до solve из-за per-cycle-budget.
  solveBudget: number;
  // Сколько диагнозов были обрезаны soft-cap'ом решателя.
  solveSoftcap: number;
}

export interface ReportStats {
  // Сумма по trayPipeline (triage.usd + fanout.totalUsd + solveBatch.fanout.totalUsd
  // + любые иные audit.spend, инициированные в этом цикле).
  totalUsdSpent: number;
  totalTokensSpent: number;
  // Сколько deferred прошло мимо отчёта — для строки шапки «отложено на завтра».
  deferred: DeferredCounts;
  // ID этой итерации — пишется в overflow Page properties для drill-down.
  eventTriggerId: string;
}

export interface ReportInput {
  stats: ReportStats;
  items: ReportItem[];
}

// ---------------------------------------------------------------------------
// Контракт результата.
// ---------------------------------------------------------------------------

export interface TelegramMessage {
  // 'header' — шапка треда (отправляется первым, без reply_to_message_id).
  // 'item' — сообщение проблемы (отправляется как reply на шапку).
  kind: 'header' | 'item';
  text: string;
  // Markdown (план) или HTML (fallback).
  parseMode: 'Markdown' | 'HTML';
  // Ссылка на ULID проблемы / диагноза / proposal'а / failure-аудита, чтобы
  // sender мог писать audit.report.sent.properties.mentioned*Ids после
  // отправки. Опционально, для шапки = undefined.
  itemRef?: ItemRef;
  // Если сообщение было обрезано — путь к Page'е с полным текстом.
  // Для надёжного assert'а в тесте; sender его не использует.
  overflowPagePath?: string;
}

export interface ItemRef {
  problemId?: string;
  diagnosisId?: string;
  proposalId?: string;
  // Один из верхних: kind отчётного блока.
  kind: ReportItem['kind'];
}

export interface BuildReportDeps {
  db?: PrismaClient;
  configOverride?: ReportConfig;
  // Override корня проекта — тесты передают свой rootDir вместе с темплейтами.
  rootDir?: string;
  // Часы. Default Date.now.
  now?: () => number;
  // Для тестов: подменить fs-функции (mkdir/writeFile). Default — реальный fs.
  fsImpl?: FsImpl;
}

// Типы node:fs/promises слишком обширны — у `mkdir` и `writeFile` по 4-5
// перегрузок. Здесь определяем минимально-достаточный shape для overflow-Page'и:
// одна сигнатура, которая совместима с реальными функциями (через каст в default'е).
export interface FsImpl {
  mkdir: (path: string, opts: { recursive: true }) => Promise<unknown>;
  writeFile: (path: string, data: string, encoding: 'utf-8') => Promise<void>;
}

// ---------------------------------------------------------------------------
// Главная функция.
// ---------------------------------------------------------------------------

export async function buildReport(
  input: ReportInput,
  deps: BuildReportDeps = {},
): Promise<TelegramMessage[]> {
  const config = deps.configOverride ?? (await loadReportConfig(deps.rootDir));
  const db = deps.db ?? getPrisma();
  const rootDir = deps.rootDir ?? process.cwd();
  const now = deps.now ?? Date.now;
  // mkdir/writeFile node:fs/promises имеют overload'ы — наш FsImpl принимает
  // ровно одну сигнатуру, совместимую с обоими (recursive:true / utf-8).
  const fsImpl: FsImpl = deps.fsImpl ?? {
    mkdir: (path, opts) => mkdir(path, opts),
    writeFile: (path, data, encoding) => writeFile(path, data, { encoding }),
  };

  const messages: TelegramMessage[] = [];

  // ---- Шапка ----
  const counts = countByKind(input.items);
  const headerText = await renderHeader(config, rootDir, input.stats, counts);
  messages.push({ kind: 'header', text: headerText, parseMode: config.parseMode });

  // ---- На каждый item — отдельное сообщение, с overflow-обработкой ----
  for (const item of input.items) {
    const text = await renderItem(config, rootDir, item);
    const itemRef = buildItemRef(item);
    const finalized = await applyOverflowIfNeeded({
      config,
      rootDir,
      db,
      text,
      item,
      stats: input.stats,
      now,
      fsImpl,
    });
    messages.push({
      kind: 'item',
      text: finalized.text,
      parseMode: config.parseMode,
      itemRef,
      overflowPagePath: finalized.overflowPagePath,
    });
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Пустой отчёт «нечего разбирать сегодня». Отдельная функция — runIteration
// зовёт на 0 непрочитанных + 0 pending (шаг 5). Возвращает один TelegramMessage
// (не шапка треда — тред из одного сообщения).
// ---------------------------------------------------------------------------

export async function buildEmptyReport(deps: BuildReportDeps = {}): Promise<TelegramMessage[]> {
  const config = deps.configOverride ?? (await loadReportConfig(deps.rootDir));
  const rootDir = deps.rootDir ?? process.cwd();
  const text = await loadTemplate(config, rootDir, config.emptyTemplate);
  return [{ kind: 'header', text: text.trim(), parseMode: config.parseMode }];
}

// ---------------------------------------------------------------------------
// Сообщение об ошибке runIteration. Используется на fail-fast (любой шаг
// pipeline'а упал). Возвращает один TelegramMessage без шапки.
// ---------------------------------------------------------------------------

export async function buildErrorReport(
  step: string,
  message: string,
  deps: BuildReportDeps = {},
): Promise<TelegramMessage[]> {
  const config = deps.configOverride ?? (await loadReportConfig(deps.rootDir));
  const rootDir = deps.rootDir ?? process.cwd();
  const tpl = await loadTemplate(config, rootDir, config.errorReportTemplate);
  const rendered = renderTemplate(tpl, { step, message: shortMessage(message, 500) });
  return [{ kind: 'header', text: rendered.trim(), parseMode: config.parseMode }];
}

// ---------------------------------------------------------------------------
// Ренедринг шапки.
// ---------------------------------------------------------------------------

interface KindCounts {
  code: number;
  human: number;
  unclear: number;
  failure: number;
  total: number;
}

function countByKind(items: ReportItem[]): KindCounts {
  let code = 0;
  let human = 0;
  let unclear = 0;
  let failure = 0;
  for (const item of items) {
    if (item.kind === 'code' || item.kind === 'code-no-proposal') code += 1;
    else if (item.kind === 'human') human += 1;
    else if (item.kind === 'unclear') unclear += 1;
    else if (item.kind === 'failure') failure += 1;
  }
  return { code, human, unclear, failure, total: code + human + unclear + failure };
}

async function renderHeader(
  config: ReportConfig,
  rootDir: string,
  stats: ReportStats,
  counts: KindCounts,
): Promise<string> {
  const tpl = await loadTemplate(config, rootDir, config.headerTemplate);
  const deferredNote = renderDeferredNote(stats.deferred);
  const rendered = renderTemplate(tpl, {
    problemsTotal: String(counts.total),
    problemsWord: pluralizeProblems(counts.total),
    codeCount: String(counts.code),
    humanCount: String(counts.human),
    unclearCount: String(counts.unclear),
    usdSpent: stats.totalUsdSpent.toFixed(2),
    usdCap: config.usdCap.toFixed(2),
    deferredNote,
  });
  return rendered.trim();
}

function pluralizeProblems(n: number): string {
  // Русская плюрализация: 1 проблема, 2-4 проблемы, 5+ проблем.
  // Учитываем 11-14 = «проблем» (исключение из правила).
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'проблем';
  if (mod10 === 1) return 'проблема';
  if (mod10 >= 2 && mod10 <= 4) return 'проблемы';
  return 'проблем';
}

function renderDeferredNote(d: DeferredCounts): string {
  const total = d.investigateBudget + d.investigateSoftcap + d.solveBudget + d.solveSoftcap;
  if (total === 0) return '';
  return ` Отложено на завтра: ${total}.`;
}

// ---------------------------------------------------------------------------
// Ренедринг item.
// ---------------------------------------------------------------------------

async function renderItem(
  config: ReportConfig,
  rootDir: string,
  item: ReportItem,
): Promise<string> {
  if (item.kind === 'code') {
    const tpl = await loadTemplate(config, rootDir, config.codeTemplate);
    const filesList = formatFilesList(item.files);
    return renderTemplate(tpl, {
      summary: item.summary,
      asIs: item.asIs,
      problem: item.problem,
      asWillBe: item.asWillBe,
      filesList,
      estimateMinutes: String(item.estimateMinutes),
    }).trim();
  }
  if (item.kind === 'code-no-proposal') {
    const tpl = await loadTemplate(config, rootDir, config.codeNoProposalTemplate);
    return renderTemplate(tpl, {
      summary: item.summary,
      rationale: item.rationale,
      diagnosisId: item.diagnosisId,
    }).trim();
  }
  if (item.kind === 'human') {
    const tpl = await loadTemplate(config, rootDir, config.humanTemplate);
    return renderTemplate(tpl, { summary: item.summary, rationale: item.rationale }).trim();
  }
  if (item.kind === 'unclear') {
    const tpl = await loadTemplate(config, rootDir, config.unclearTemplate);
    return renderTemplate(tpl, { summary: item.summary, rationale: item.rationale }).trim();
  }
  // failure
  const tpl = await loadTemplate(config, rootDir, config.failureTemplate);
  return renderTemplate(tpl, {
    step: item.step,
    message: shortMessage(item.message, 500),
    summary: item.summary,
  }).trim();
}

function formatFilesList(files: ProposalFile[]): string {
  if (files.length === 0) return '_файлы не указаны_';
  return files.map((f) => `- \`${f.path}\` [${f.action}]`).join('\n');
}

function buildItemRef(item: ReportItem): ItemRef {
  if (item.kind === 'code') {
    return {
      kind: item.kind,
      problemId: item.problemId,
      diagnosisId: item.diagnosisId,
      proposalId: item.proposalId,
    };
  }
  if (item.kind === 'code-no-proposal' || item.kind === 'human' || item.kind === 'unclear') {
    return { kind: item.kind, problemId: item.problemId, diagnosisId: item.diagnosisId };
  }
  // failure
  return { kind: item.kind, problemId: item.problemId };
}

// ---------------------------------------------------------------------------
// Overflow → Page'а.
// ---------------------------------------------------------------------------

interface OverflowArgs {
  config: ReportConfig;
  rootDir: string;
  db: PrismaClient;
  text: string;
  item: ReportItem;
  stats: ReportStats;
  now: () => number;
  fsImpl: NonNullable<BuildReportDeps['fsImpl']>;
}

async function applyOverflowIfNeeded(
  args: OverflowArgs,
): Promise<{ text: string; overflowPagePath?: string }> {
  if (args.text.length <= args.config.telegramMessageLimit) {
    return { text: args.text };
  }
  // Нужна обрезка. Сначала вычислим suffix на конкретном path'е, чтобы знать
  // его реальную длину и обрезать ровно на (limit - suffix.length).
  const pageId = ulid();
  const pagePath = `${args.config.overflowPageDir}/${pageId}.md`;
  const suffix = renderTemplate(args.config.overflowSuffixTemplate, { path: pagePath });
  // Безопасный отступ: '\n\n' между обрезкой и suffix'ом.
  const separator = '\n\n';
  const budget = args.config.telegramMessageLimit - suffix.length - separator.length;
  if (budget <= 0) {
    // Шаблон suffix'а сам по себе длиннее лимита — fail-fast разработчику,
    // не тихо отдаём обрезанное «… ещё в …» без головы. Это конфигурационная
    // ошибка, не runtime'а.
    throw new Error(
      `report: overflowSuffixTemplate ('${args.config.overflowSuffixTemplate}') в развёрнутом виде длиннее telegramMessageLimit. Поправь config/report.md.`,
    );
  }
  const truncated = `${args.text.slice(0, budget)}${separator}${suffix}`;

  await writePageFile(args.config, args.rootDir, pagePath, args.text, args.fsImpl);
  await insertPageRecord(args.db, {
    path: pagePath,
    pageType: args.config.overflowPageType,
    title: titleForItem(args.item),
    nowMs: args.now(),
  });

  return { text: truncated, overflowPagePath: pagePath };
}

async function writePageFile(
  config: ReportConfig,
  rootDir: string,
  pagePath: string,
  body: string,
  fsImpl: NonNullable<BuildReportDeps['fsImpl']>,
): Promise<void> {
  const absPath = resolve(rootDir, pagePath);
  // Создаём родительский каталог идемпотентно (recursive). Например,
  // journal/proposals/ может ещё не существовать в проекте AI-Cofounder
  // на первом прогоне.
  await fsImpl.mkdir(dirname(absPath), { recursive: true });
  await fsImpl.writeFile(absPath, body, 'utf-8');
}

interface InsertPageInput {
  path: string;
  pageType: string;
  title: string;
  nowMs: number;
}

async function insertPageRecord(db: PrismaClient, input: InsertPageInput): Promise<void> {
  // Page.gitSha — NOT NULL в schema.prisma. На момент INSERT'а файл ещё не в git
  // (commit делает фаундер). Ставим маркер 'pending', git-watcher обновит на
  // реальный SHA при коммите. То же делает denormalize-логика M1.
  await db.$executeRawUnsafe(
    `INSERT OR IGNORE INTO "Page" (path, type, title, parentPath, freshnessMode, tags, updatedAt, gitSha, archived)
     VALUES (?, ?, ?, NULL, NULL, '[]', ?, 'pending', 0)`,
    input.path,
    input.pageType,
    input.title,
    input.nowMs,
  );
}

function titleForItem(item: ReportItem): string {
  // Page.title — NOT NULL. Используем summary проблемы (он короткий, 1 предложение)
  // как заголовок overflow-страницы. Это согласуется с шапкой (`🛠 <summary>`)
  // в самой странице.
  return shortMessage(item.summary, 200);
}

// ---------------------------------------------------------------------------
// Шаблоны: lazy-cache по path. Тест сбрасывает через _resetTemplateCache().
// ---------------------------------------------------------------------------

const TEMPLATE_CACHE = new Map<string, Promise<string>>();

async function loadTemplate(
  config: ReportConfig,
  rootDir: string,
  filename: string,
): Promise<string> {
  const abs = resolve(rootDir, config.templatesDir, filename);
  let cached = TEMPLATE_CACHE.get(abs);
  if (cached === undefined) {
    cached = readFile(abs, 'utf-8');
    TEMPLATE_CACHE.set(abs, cached);
  }
  return cached;
}

export function _resetTemplateCache(): void {
  TEMPLATE_CACHE.clear();
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}

function shortMessage(message: string, maxLen: number): string {
  if (message.length <= maxLen) return message;
  return `${message.slice(0, maxLen)}…`;
}

// ---------------------------------------------------------------------------
// Re-exports для удобства import'а из 2.5/тестов.
// ---------------------------------------------------------------------------
export type { ProposalFile } from '../solve/run.js';
