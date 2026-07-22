// Загрузчик config/investigate.md (фаза 2.3a). Тот же паттерн, что
// src/triage/config.ts и src/embeddings/config.ts: один json-блок в markdown,
// парсится при каждом вызове investigateProblem (1×/проблема, не критично).
//
// Меняешь модель/тайм-аут/whitelist — правишь config/investigate.md, не код.

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface InvestigateConfig {
  targetProjectPath: string;
  model: string;
  subagentType: string;
  timeoutMs: number;
  maxTokens: number;
  maxTurns: number;
  promptId: string;
  bashWhitelist: string[];
  // Fan-out параметры (фаза 2.3b). См. config/investigate.md секция «Поля».
  concurrency: number;
  maxProblemsPerCycle: number;
  parentSessionPrefix: string;
  asOf: number;
  sourcePath: string;
}

const CONFIG_PATH = 'config/investigate.md';

export async function loadInvestigateConfig(
  rootDir: string = process.cwd(),
): Promise<InvestigateConfig> {
  const absPath = resolve(rootDir, CONFIG_PATH);
  const [body, fileStat] = await Promise.all([readFile(absPath, 'utf-8'), stat(absPath)]);
  const json = extractJsonBlock(body, absPath);
  validateShape(json, absPath);
  return {
    targetProjectPath: json.targetProjectPath.replace(
      /\$\{(\w+)\}/g,
      (_m, name) => process.env[name] ?? '',
    ),
    model: json.model,
    subagentType: json.subagentType,
    timeoutMs: json.timeoutMs,
    maxTokens: json.maxTokens,
    maxTurns: json.maxTurns,
    promptId: json.promptId,
    bashWhitelist: json.bashWhitelist,
    concurrency: json.concurrency,
    maxProblemsPerCycle: json.maxProblemsPerCycle,
    parentSessionPrefix: json.parentSessionPrefix,
    asOf: fileStat.mtimeMs,
    sourcePath: CONFIG_PATH,
  };
}

interface InvestigateJson {
  targetProjectPath: string;
  model: string;
  subagentType: string;
  timeoutMs: number;
  maxTokens: number;
  maxTurns: number;
  promptId: string;
  bashWhitelist: string[];
  concurrency: number;
  maxProblemsPerCycle: number;
  parentSessionPrefix: string;
}

function extractJsonBlock(markdown: string, path: string): InvestigateJson {
  const match = markdown.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match || match[1] === undefined) {
    throw new Error(
      `${path}: не найден json-блок \`\`\`json ... \`\`\`. Настройки исследователя должны лежать в первом json-блоке файла.`,
    );
  }
  try {
    return JSON.parse(match[1]) as InvestigateJson;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${path}: json-блок не парсится: ${reason}`);
  }
}

function validateShape(json: InvestigateJson, path: string): void {
  const raw = json as unknown as Record<string, unknown>;
  if (typeof raw.targetProjectPath !== 'string' || raw.targetProjectPath.length === 0) {
    throw new Error(`${path}: targetProjectPath должно быть непустой строкой (абсолютный путь).`);
  }
  if (typeof raw.model !== 'string' || raw.model.length === 0) {
    throw new Error(`${path}: model должно быть непустой строкой.`);
  }
  if (typeof raw.subagentType !== 'string' || raw.subagentType.length === 0) {
    throw new Error(`${path}: subagentType должно быть непустой строкой.`);
  }
  if (typeof raw.timeoutMs !== 'number' || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0) {
    throw new Error(`${path}: timeoutMs должно быть положительным числом миллисекунд.`);
  }
  if (typeof raw.maxTokens !== 'number' || !Number.isFinite(raw.maxTokens) || raw.maxTokens <= 0) {
    throw new Error(`${path}: maxTokens должно быть положительным числом.`);
  }
  if (typeof raw.maxTurns !== 'number' || !Number.isFinite(raw.maxTurns) || raw.maxTurns <= 0) {
    throw new Error(`${path}: maxTurns должно быть положительным числом.`);
  }
  if (typeof raw.promptId !== 'string' || raw.promptId.length === 0) {
    throw new Error(`${path}: promptId должно быть непустой строкой.`);
  }
  if (!Array.isArray(raw.bashWhitelist)) {
    throw new Error(`${path}: bashWhitelist должно быть массивом строк.`);
  }
  for (const item of raw.bashWhitelist) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new Error(`${path}: каждый элемент bashWhitelist должен быть непустой строкой.`);
    }
  }
  if (
    typeof raw.concurrency !== 'number' ||
    !Number.isFinite(raw.concurrency) ||
    raw.concurrency <= 0 ||
    !Number.isInteger(raw.concurrency)
  ) {
    throw new Error(`${path}: concurrency должно быть положительным целым числом.`);
  }
  if (
    typeof raw.maxProblemsPerCycle !== 'number' ||
    !Number.isFinite(raw.maxProblemsPerCycle) ||
    raw.maxProblemsPerCycle <= 0 ||
    !Number.isInteger(raw.maxProblemsPerCycle)
  ) {
    throw new Error(`${path}: maxProblemsPerCycle должно быть положительным целым числом.`);
  }
  if (typeof raw.parentSessionPrefix !== 'string' || raw.parentSessionPrefix.length === 0) {
    throw new Error(`${path}: parentSessionPrefix должно быть непустой строкой.`);
  }
}
