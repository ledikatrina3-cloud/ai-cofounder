// Загрузчик config/triage.md (фаза 2.2a). Тот же паттерн, что src/llm/pricing.ts:
// один json-блок в markdown, парсится на каждый вызов (нечасто — 1×/день).
//
// Меняешь модель/лимиты — правишь config/triage.md, не код.

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CallToolChoice } from '../llm/call.js';

export interface TriageConfig {
  model: string;
  maxTokens: number;
  toolChoice: CallToolChoice;
  asOf: number;
  sourcePath: string;
}

const CONFIG_PATH = 'config/triage.md';

export async function loadTriageConfig(rootDir: string = process.cwd()): Promise<TriageConfig> {
  const absPath = resolve(rootDir, CONFIG_PATH);
  const [body, fileStat] = await Promise.all([readFile(absPath, 'utf-8'), stat(absPath)]);
  const json = extractJsonBlock(body, absPath);
  validateShape(json, absPath);
  return {
    model: json.model,
    maxTokens: json.maxTokens,
    toolChoice: json.toolChoice,
    asOf: fileStat.mtimeMs,
    sourcePath: CONFIG_PATH,
  };
}

interface TriageJson {
  model: string;
  maxTokens: number;
  toolChoice: CallToolChoice;
}

function extractJsonBlock(markdown: string, path: string): TriageJson {
  const match = markdown.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match || match[1] === undefined) {
    throw new Error(
      `${path}: не найден json-блок \`\`\`json ... \`\`\`. Настройки триажа должны лежать в первом json-блоке файла.`,
    );
  }
  try {
    return JSON.parse(match[1]) as TriageJson;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${path}: json-блок не парсится: ${reason}`);
  }
}

// Валидация делает runtime-проверки над данными, тип которых TS считает уже
// «правильным» из `JSON.parse() as TriageJson`. Поэтому на уровень runtime
// смотрим как на unknown и явно сужаем — иначе TS narrow'ит до never в else-ветках.
function validateShape(json: TriageJson, path: string): void {
  const raw = json as unknown as Record<string, unknown>;
  if (typeof raw.model !== 'string' || raw.model.length === 0) {
    throw new Error(`${path}: model должно быть непустой строкой.`);
  }
  if (typeof raw.maxTokens !== 'number' || !Number.isFinite(raw.maxTokens) || raw.maxTokens <= 0) {
    throw new Error(`${path}: maxTokens должно быть положительным числом.`);
  }
  const tc = raw.toolChoice;
  if (tc === null || typeof tc !== 'object') {
    throw new Error(`${path}: toolChoice должен быть объектом {type:'auto'|'any'|'tool', ...}.`);
  }
  const tcRecord = tc as Record<string, unknown>;
  const tcType = tcRecord.type;
  if (tcType !== 'auto' && tcType !== 'any' && tcType !== 'tool') {
    throw new Error(
      `${path}: toolChoice.type должен быть 'auto' | 'any' | 'tool', получено '${String(tcType)}'.`,
    );
  }
  if (tcType === 'tool' && typeof tcRecord.name !== 'string') {
    throw new Error(`${path}: toolChoice типа 'tool' требует поле name: string.`);
  }
}
