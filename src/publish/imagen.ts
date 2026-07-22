// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE ADAPTER (не ядро движка). Опциональная генерация обложек через Google
// Gemini/Imagen. Дефолтная обложка AI-Cofounder — локальная типографская
// (skills/cover-design), без сети и API-ключей. Этот адаптер активируется только
// если агент явно запрашивает Gemini и имеет ключ в permissions.yml: secrets.
// ─────────────────────────────────────────────────────────────────────────────
// Google AI Studio Imagen API клиент для генерации cover-иллюстраций.
//
// Использует Imagen 3 / Imagen 4 через REST API (Google AI Studio, НЕ Vertex AI -
// упрощённый flow для соло-фаундера, не требует GCP проекта).
//
// Endpoint: https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:generateImages
// Auth: API key в query param ?key=<GEMINI_API_KEY>
// Pricing: ~$0.03/image (Imagen 3 standard, 1024×1024)
//
// Важно:
// 1. БЕЗ ТЕКСТА в prompt'е - Imagen плохо рендерит русский текст, лучше класть
//    текст через HTML поверх image (наш template уже так делает).
// 2. Композиция focal-point в правой трети - там у нас слот artifact'а.
// 3. Стиль: retro pixel-CLI / abstract-geometric / tech-illustration -
//    подкреплено brand voice (оранжевый + тёмный фон).

const IMAGEN_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'imagen-3.0-generate-002';

export interface ImagenInput {
  /** Prompt на английском (Imagen лучше работает с английским). */
  prompt: string;
  /** Negative prompt - что НЕ должно быть на картинке. */
  negativePrompt?: string;
  /** Соотношение сторон. Для cover нужен '16:9' но Imagen 3 не поддерживает -
   * только 1:1, 3:4, 4:3, 9:16, 16:9 (если 16:9 не работает, используем 1:1 и crop'им). */
  aspectRatio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
  /** Seed для детерминистики (опционально). */
  seed?: number;
}

export interface ImagenResult {
  /** Base64-encoded PNG. */
  base64: string;
  /** MIME-type (обычно image/png). */
  mimeType: string;
}

export class ImagenError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly response?: unknown,
  ) {
    super(message);
    this.name = 'ImagenError';
  }
}

/**
 * Генерирует одну картинку через Imagen API.
 * Возвращает base64 PNG (caller decode'ит и сохраняет на диск).
 */
export async function generateImage(
  input: ImagenInput,
  apiKey: string,
  model = DEFAULT_MODEL,
): Promise<ImagenResult> {
  const url = `${IMAGEN_API_BASE}/models/${model}:predict?key=${apiKey}`;
  const body = {
    instances: [{ prompt: input.prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio: input.aspectRatio ?? '16:9',
      ...(input.negativePrompt !== undefined ? { negativePrompt: input.negativePrompt } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
    },
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status >= 500) {
    throw new ImagenError(r.status, 'SERVER_ERROR', `${r.status} from Imagen`, null);
  }
  const json = (await r.json()) as {
    error?: { code?: number; message?: string; status?: string };
    predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
  };
  if (json.error) {
    throw new ImagenError(
      r.status,
      json.error.status ?? 'UNKNOWN',
      json.error.message ?? 'unknown error',
      json,
    );
  }
  const pred = json.predictions?.[0];
  if (!pred?.bytesBase64Encoded) {
    throw new ImagenError(r.status, 'NO_PREDICTION', 'no predictions in response', json);
  }
  return {
    base64: pred.bytesBase64Encoded,
    mimeType: pred.mimeType ?? 'image/png',
  };
}

/**
 * Сохраняет ImagenResult на диск как PNG.
 */
export async function saveImage(result: ImagenResult, outputPath: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  const buf = Buffer.from(result.base64, 'base64');
  await writeFile(outputPath, buf);
}

/**
 * Загружает Gemini API key из .env.local или env переменной.
 */
export async function loadApiKey(envPath = '.env.local'): Promise<string> {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const { readFile } = await import('node:fs/promises');
  try {
    const env = await readFile(envPath, 'utf8');
    const line = env.split('\n').find((l) => l.startsWith('GEMINI_API_KEY='));
    if (line) {
      return line.slice('GEMINI_API_KEY='.length).trim();
    }
  } catch {
    // .env.local не существует
  }
  throw new Error(
    'GEMINI_API_KEY не найден ни в env, ни в .env.local. ' +
      'Получи на https://aistudio.google.com/app/apikey и добавь строку GEMINI_API_KEY=<key>.',
  );
}

/**
 * Формирует prompt для cover-иллюстрации статьи про конкретный AI-инструмент.
 * Принципы:
 * - Английский (Imagen работает лучше)
 * - Без текста (text rendering ненадёжен)
 * - Brand palette (оранжевый + тёмный)
 * - Focal point в правой части (там у нас artifact-slot)
 * - Стиль зависит от ai_brand
 */
export function buildCoverPrompt(args: {
  /** Brand: claude-code / chatgpt / gemini / grok / llama / mistral / null (generic). */
  aiBrand: string | null;
  /** Главная концепция статьи (1-3 слова на английском). */
  conceptEn: string;
  /** Тип артефакта (см. cover-design-brief.md): code-fence / terminal / arrow-diagram / stack-fan / single-emblem. */
  artifactType?: string;
}): { prompt: string; negativePrompt: string } {
  // Нейтральные акцентные палитры по ключу темы (БЕЗ имён вендоров и без
  // указаний воспроизводить чужой бренд/маркетинг — только цвета и общий стиль).
  const BRAND_STYLE: Record<string, string> = {
    'claude-code':
      'retro pixel-art CLI terminal aesthetic, warm orange (hex d97757) and dark warm brown (hex 141413) palette, hand-drawn brush strokes',
    chatgpt:
      'minimal abstract geometry, monochrome with a subtle teal accent (hex 10A37F), clean modern lines',
    openai: 'minimal abstract geometry, monochrome, clean lines, subtle gradients',
    gemini:
      'gradient sparkle motif, multi-color accent palette (blue 4285F4, red EA4335, yellow FBBC04, green 34A853), modern aesthetic',
    grok: 'minimal monochrome, dark mode, austere geometric style',
    llama: 'open-source friendly aesthetic, blue accent (hex 0467DF), modern flat illustration',
    mistral: 'orange gradient (hex FA520F to FFD800), clean geometric startup aesthetic',
  };
  const style =
    (args.aiBrand && BRAND_STYLE[args.aiBrand]) ??
    'minimal tech illustration, abstract geometry, single accent color';

  const artifactHint = args.artifactType
    ? `, featuring a ${args.artifactType} visual element on the right side`
    : '';

  const prompt = [
    `An editorial cover illustration for a tech article about "${args.conceptEn}". `,
    `Style: ${style}${artifactHint}. `,
    'Composition: left two-thirds is empty negative space (will be overlaid with title text), ',
    'right one-third contains the focal visual element. ',
    'Background: solid dark warm brown or subtle radial gradient. ',
    'Mood: focused, professional, slightly nostalgic. 16:9 aspect ratio, magazine-quality.',
  ].join('');

  const negativePrompt =
    'text, letters, words, numbers, watermark, logo overlay, stock photo, ' +
    'people faces, hands typing, generic developer photo, ' +
    'cluttered composition, multiple focal points, ' +
    'pastel colors, neon colors, rainbow, ' +
    'cartoon, anime, 3D render, photorealistic, fake AI-generated look';

  return { prompt, negativePrompt };
}
