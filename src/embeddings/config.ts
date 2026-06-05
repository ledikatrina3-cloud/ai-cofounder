// Загрузчик config/embeddings.md (фаза 2.2b). Тот же паттерн, что
// src/triage/config.ts и src/llm/pricing.ts: один json-блок в markdown,
// парсится по запросу.

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export type EmbeddingsProvider = 'xenova-local' | 'voyage' | 'openai';

export interface EmbeddingsConfig {
  provider: EmbeddingsProvider;
  model: string;
  dim: number;
  mergeThreshold: number;
  mergeWindowDays: number;
  vecTable: string;
  asOf: number;
  sourcePath: string;
}

const CONFIG_PATH = 'config/embeddings.md';

export async function loadEmbeddingsConfig(
  rootDir: string = process.cwd(),
): Promise<EmbeddingsConfig> {
  const absPath = resolve(rootDir, CONFIG_PATH);
  const [body, fileStat] = await Promise.all([readFile(absPath, 'utf-8'), stat(absPath)]);
  const json = extractJsonBlock(body, absPath);
  validateShape(json, absPath);
  return {
    provider: json.provider,
    model: json.model,
    dim: json.dim,
    mergeThreshold: json.mergeThreshold,
    mergeWindowDays: json.mergeWindowDays,
    vecTable: json.vecTable,
    asOf: fileStat.mtimeMs,
    sourcePath: CONFIG_PATH,
  };
}

interface EmbeddingsJson {
  provider: EmbeddingsProvider;
  model: string;
  dim: number;
  mergeThreshold: number;
  mergeWindowDays: number;
  vecTable: string;
}

function extractJsonBlock(markdown: string, path: string): EmbeddingsJson {
  const match = markdown.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match || match[1] === undefined) {
    throw new Error(
      `${path}: не найден json-блок \`\`\`json ... \`\`\`. Настройки embeddings лежат в первом json-блоке файла.`,
    );
  }
  try {
    return JSON.parse(match[1]) as EmbeddingsJson;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${path}: json-блок не парсится: ${reason}`);
  }
}

const ALLOWED_PROVIDERS: ReadonlySet<EmbeddingsProvider> = new Set([
  'xenova-local',
  'voyage',
  'openai',
]);

// Валидация делает runtime-проверки над `unknown`, потому что после
// `JSON.parse() as EmbeddingsJson` TS уже считает данные правильными.
function validateShape(json: EmbeddingsJson, path: string): void {
  const raw = json as unknown as Record<string, unknown>;
  if (
    typeof raw.provider !== 'string' ||
    !ALLOWED_PROVIDERS.has(raw.provider as EmbeddingsProvider)
  ) {
    throw new Error(
      `${path}: provider должен быть одним из ${[...ALLOWED_PROVIDERS].join(' | ')}, получено '${String(raw.provider)}'.`,
    );
  }
  if (typeof raw.model !== 'string' || raw.model.length === 0) {
    throw new Error(`${path}: model должно быть непустой строкой.`);
  }
  if (typeof raw.dim !== 'number' || !Number.isInteger(raw.dim) || raw.dim <= 0 || raw.dim > 4096) {
    throw new Error(`${path}: dim должно быть положительным целым ≤ 4096.`);
  }
  if (
    typeof raw.mergeThreshold !== 'number' ||
    !Number.isFinite(raw.mergeThreshold) ||
    raw.mergeThreshold < 0 ||
    raw.mergeThreshold > 1
  ) {
    throw new Error(`${path}: mergeThreshold должен быть числом в [0, 1].`);
  }
  if (
    typeof raw.mergeWindowDays !== 'number' ||
    !Number.isFinite(raw.mergeWindowDays) ||
    raw.mergeWindowDays <= 0
  ) {
    throw new Error(`${path}: mergeWindowDays должен быть положительным числом.`);
  }
  if (typeof raw.vecTable !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(raw.vecTable)) {
    throw new Error(`${path}: vecTable должно быть валидным идентификатором SQL.`);
  }
}
