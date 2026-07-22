import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface ModelTariff {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface PricingTable {
  models: Record<string, ModelTariff>;
  aliases: Record<string, string>;
  asOf: number;
  sourcePath: string;
}

const PRICING_PATH = 'config/pricing.md';

export async function loadPricing(rootDir: string = process.cwd()): Promise<PricingTable> {
  const absPath = resolve(rootDir, PRICING_PATH);
  const [body, fileStat] = await Promise.all([readFile(absPath, 'utf-8'), stat(absPath)]);
  const json = extractJsonBlock(body, absPath);
  validateShape(json, absPath);
  return {
    models: json.models,
    aliases: json.aliases ?? {},
    asOf: fileStat.mtimeMs,
    sourcePath: PRICING_PATH,
  };
}

export function resolveModel(
  table: PricingTable,
  model: string,
): { canonical: string; tariff: ModelTariff } {
  const canonical = table.aliases[model] ?? model;
  const tariff = table.models[canonical];
  if (!tariff) {
    const known = [...Object.keys(table.models), ...Object.keys(table.aliases)].sort().join(', ');
    throw new Error(
      `model "${model}" не найдена в ${table.sourcePath}. Известные: ${known}. Добавь модель в config/pricing.md перед вызовом.`,
    );
  }
  return { canonical, tariff };
}

export function computeUsd(
  tariff: ModelTariff,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  },
): number {
  const M = 1_000_000;
  return (
    (usage.inputTokens / M) * tariff.input +
    (usage.outputTokens / M) * tariff.output +
    (usage.cacheCreationTokens / M) * tariff.cacheWrite +
    (usage.cacheReadTokens / M) * tariff.cacheRead
  );
}

interface PricingJson {
  models: Record<string, ModelTariff>;
  aliases?: Record<string, string>;
}

function extractJsonBlock(markdown: string, path: string): PricingJson {
  const match = markdown.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match || match[1] === undefined) {
    throw new Error(
      `${path}: не найден json-блок \`\`\`json ... \`\`\`. Тарифы должны лежать в первом json-блоке файла.`,
    );
  }
  try {
    return JSON.parse(match[1]) as PricingJson;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${path}: json-блок не парсится: ${reason}`);
  }
}

function validateShape(json: PricingJson, path: string): void {
  if (!json.models || typeof json.models !== 'object') {
    throw new Error(`${path}: отсутствует объект "models".`);
  }
  for (const [name, tariff] of Object.entries(json.models)) {
    for (const field of ['input', 'output', 'cacheWrite', 'cacheRead'] as const) {
      const value = tariff[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(
          `${path}: models.${name}.${field} должно быть неотрицательным числом, получено ${String(value)}.`,
        );
      }
    }
  }
  if (json.aliases) {
    for (const [alias, target] of Object.entries(json.aliases)) {
      if (typeof target !== 'string' || !json.models[target]) {
        throw new Error(`${path}: aliases.${alias} ссылается на отсутствующую модель "${target}".`);
      }
    }
  }
}
