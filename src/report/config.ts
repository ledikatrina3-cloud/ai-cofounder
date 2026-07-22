// Загрузчик config/report.md (фаза 2.5). Тот же паттерн, что
// src/triage/config.ts / src/investigate/config.ts / src/solve/config.ts:
// один json-блок в markdown, валидация ручная, без Zod.
//
// Меняешь формат сообщения — правишь .md в templatesDir; меняешь лимит /
// retry / overflow-Page параметры — правишь config/report.md. TS не трогается.

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface ReportConfig {
  telegramMessageLimit: number;
  templatesDir: string;
  headerTemplate: string;
  emptyTemplate: string;
  codeTemplate: string;
  codeNoProposalTemplate: string;
  humanTemplate: string;
  unclearTemplate: string;
  failureTemplate: string;
  errorReportTemplate: string;
  overflowPageDir: string;
  overflowPageType: string;
  overflowSuffixTemplate: string;
  parseMode: 'Markdown' | 'HTML';
  sendRetries: number;
  sendRetryBaseMs: number;
  sendRetryJitterMs: number;
  usdCap: number;
  asOf: number;
  sourcePath: string;
}

const CONFIG_PATH = 'config/report.md';

export async function loadReportConfig(rootDir: string = process.cwd()): Promise<ReportConfig> {
  const absPath = resolve(rootDir, CONFIG_PATH);
  const [body, fileStat] = await Promise.all([readFile(absPath, 'utf-8'), stat(absPath)]);
  const json = extractJsonBlock(body, absPath);
  validateShape(json, absPath);
  return {
    telegramMessageLimit: json.telegramMessageLimit,
    templatesDir: json.templatesDir,
    headerTemplate: json.headerTemplate,
    emptyTemplate: json.emptyTemplate,
    codeTemplate: json.codeTemplate,
    codeNoProposalTemplate: json.codeNoProposalTemplate,
    humanTemplate: json.humanTemplate,
    unclearTemplate: json.unclearTemplate,
    failureTemplate: json.failureTemplate,
    errorReportTemplate: json.errorReportTemplate,
    overflowPageDir: json.overflowPageDir,
    overflowPageType: json.overflowPageType,
    overflowSuffixTemplate: json.overflowSuffixTemplate,
    parseMode: json.parseMode,
    sendRetries: json.sendRetries,
    sendRetryBaseMs: json.sendRetryBaseMs,
    sendRetryJitterMs: json.sendRetryJitterMs,
    usdCap: json.usdCap,
    asOf: fileStat.mtimeMs,
    sourcePath: CONFIG_PATH,
  };
}

interface ReportJson {
  telegramMessageLimit: number;
  templatesDir: string;
  headerTemplate: string;
  emptyTemplate: string;
  codeTemplate: string;
  codeNoProposalTemplate: string;
  humanTemplate: string;
  unclearTemplate: string;
  failureTemplate: string;
  errorReportTemplate: string;
  overflowPageDir: string;
  overflowPageType: string;
  overflowSuffixTemplate: string;
  parseMode: 'Markdown' | 'HTML';
  sendRetries: number;
  sendRetryBaseMs: number;
  sendRetryJitterMs: number;
  usdCap: number;
}

function extractJsonBlock(markdown: string, path: string): ReportJson {
  const match = markdown.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match || match[1] === undefined) {
    throw new Error(
      `${path}: не найден json-блок \`\`\`json ... \`\`\`. Настройки отчёта должны лежать в первом json-блоке файла.`,
    );
  }
  try {
    return JSON.parse(match[1]) as ReportJson;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${path}: json-блок не парсится: ${reason}`);
  }
}

function validateShape(json: ReportJson, path: string): void {
  const raw = json as unknown as Record<string, unknown>;
  if (
    typeof raw.telegramMessageLimit !== 'number' ||
    !Number.isInteger(raw.telegramMessageLimit) ||
    raw.telegramMessageLimit <= 0
  ) {
    throw new Error(`${path}: telegramMessageLimit должно быть положительным целым числом.`);
  }
  for (const field of [
    'templatesDir',
    'headerTemplate',
    'emptyTemplate',
    'codeTemplate',
    'codeNoProposalTemplate',
    'humanTemplate',
    'unclearTemplate',
    'failureTemplate',
    'errorReportTemplate',
    'overflowPageDir',
    'overflowPageType',
    'overflowSuffixTemplate',
  ] as const) {
    const value = raw[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${path}: ${field} должно быть непустой строкой.`);
    }
  }
  if (raw.parseMode !== 'Markdown' && raw.parseMode !== 'HTML') {
    throw new Error(`${path}: parseMode должно быть 'Markdown' или 'HTML'.`);
  }
  if (
    typeof raw.sendRetries !== 'number' ||
    !Number.isInteger(raw.sendRetries) ||
    raw.sendRetries < 0
  ) {
    throw new Error(`${path}: sendRetries должно быть неотрицательным целым числом.`);
  }
  if (
    typeof raw.sendRetryBaseMs !== 'number' ||
    !Number.isFinite(raw.sendRetryBaseMs) ||
    raw.sendRetryBaseMs < 0
  ) {
    throw new Error(`${path}: sendRetryBaseMs должно быть неотрицательным числом миллисекунд.`);
  }
  if (
    typeof raw.sendRetryJitterMs !== 'number' ||
    !Number.isFinite(raw.sendRetryJitterMs) ||
    raw.sendRetryJitterMs < 0
  ) {
    throw new Error(`${path}: sendRetryJitterMs должно быть неотрицательным числом миллисекунд.`);
  }
  if (typeof raw.usdCap !== 'number' || !Number.isFinite(raw.usdCap) || raw.usdCap < 0) {
    throw new Error(`${path}: usdCap должно быть неотрицательным числом.`);
  }
}
