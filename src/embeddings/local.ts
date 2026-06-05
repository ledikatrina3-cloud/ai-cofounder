// Локальный embeddings-провайдер на @xenova/transformers (фаза 2.2b).
//
// Архитектурный смысл:
//   * AI-Cofounder намеренно local-first — embeddings без сети согласуется
//     с тем же духом, что whisper.cpp в M3 (см. план фаза 3.2a).
//   * Anthropic embeddings не предоставляет; сделать ещё один платный канал
//     к Voyage/OpenAI = новый Keychain-сервис, новый pairing flow, новая
//     строка в /деньги. Не оправдано на единичном вызове в день.
//   * Точность multilingual-e5-small для дедупа триажа достаточна — порог
//     0.85 cosine всё равно палец в небо (риск #2 в плане), точностные
//     различия моделей в этом сценарии шумовые.
//
// Что эта библиотека делает:
//   * Лениво загружает модель из `~/.cache/huggingface/` (первый запуск
//     качает ~120MB, потом — мгновенно).
//   * Отдаёт `embedText(text): Promise<Float32Array>` единым шагом.
//   * Проверяет, что размерность модели совпадает с config.dim — иначе
//     virtual table в БД построена под другую модель, мердж даст бессмыслицу.
//
// Контракт:
//   * Возвращает L2-нормализованный вектор. Для cosine distance это значит,
//     `cosine_distance ≈ 0.5 * L2_distance²`. sqlite-vec с
//     `distance_metric=cosine` всё равно нормализует сам, но мы делаем это
//     pre-normalize чтобы (а) числа в БД были стабильными, (б) тест
//     «similarity = 1 - distance» проходил без расхождений.

import type { EmbeddingsConfig } from './config.js';

// Динамический импорт — @xenova/transformers тяжёлый (тащит onnxruntime-node),
// и грузить его на каждый процесс (test:invariants, test:budget и т.д.) не нужно.
// При первом вызове `embedText()` модуль подтягивается, потом кэшируется.
type XenovaPipeline = (
  text: string,
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

let cachedPipelinePromise: Promise<XenovaPipeline> | null = null;
let cachedModelKey: string | null = null;

export interface EmbeddingsClient {
  embedText(text: string): Promise<Float32Array>;
  // Размерность модели — для sanity-проверки с config.dim.
  dim(): Promise<number>;
}

export interface CreateLocalEmbeddingsClientOptions {
  config: EmbeddingsConfig;
  // Подмена pipeline для тестов — обходит загрузку реальной модели и сети.
  pipelineOverride?: XenovaPipeline;
}

export function createLocalEmbeddingsClient(
  options: CreateLocalEmbeddingsClientOptions,
): EmbeddingsClient {
  const { config, pipelineOverride } = options;

  if (config.provider !== 'xenova-local') {
    throw new Error(
      `createLocalEmbeddingsClient: ожидался provider='xenova-local', получено '${config.provider}'.`,
    );
  }

  async function getPipeline(): Promise<XenovaPipeline> {
    if (pipelineOverride !== undefined) return pipelineOverride;
    if (cachedPipelinePromise !== null && cachedModelKey === config.model) {
      return cachedPipelinePromise;
    }
    cachedModelKey = config.model;
    cachedPipelinePromise = (async () => {
      // Импорт через `await import('@xenova/transformers')` — пакет ESM-only,
      // но имеет CJS-обёртку. NodeNext + type:'module' резолвят его корректно.
      const xenova = (await import('@xenova/transformers')) as unknown as {
        pipeline: (task: string, model: string) => Promise<XenovaPipeline>;
      };
      return xenova.pipeline('feature-extraction', config.model);
    })();
    return cachedPipelinePromise;
  }

  return {
    async embedText(text: string): Promise<Float32Array> {
      const pipeline = await getPipeline();
      // pooling: 'mean' — усреднение по токенам (стандарт для sentence
      // embeddings). normalize: true — L2-нормализация (нужна для cosine).
      const out = await pipeline(text, { pooling: 'mean', normalize: true });
      const data = out.data instanceof Float32Array ? out.data : new Float32Array(out.data);
      if (data.length !== config.dim) {
        throw new Error(
          `embeddings: модель '${config.model}' вернула ${data.length}-dim, ` +
            `а config/embeddings.md ожидает ${config.dim}. Проверь dim в конфиге или модель.`,
        );
      }
      return data;
    },
    async dim(): Promise<number> {
      // Простой способ — спросить модель. Делаем embed на «test» строке.
      const data = await this.embedText('dim-probe');
      return data.length;
    },
  };
}

export function _resetEmbeddingsClientCache(): void {
  cachedPipelinePromise = null;
  cachedModelKey = null;
}
