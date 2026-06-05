// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE ADAPTER (не ядро движка). Опциональная генерация обложек через Google
// Gemini. Дефолтная обложка AI-Cofounder — локальная типографская
// (skills/cover-design), без сети и API-ключей; этот адаптер подключается только
// при явном запросе агента с ключом в permissions.yml: secrets.
// ─────────────────────────────────────────────────────────────────────────────
// Nano Banana (Gemini 2.5 Flash Image) wrapper для cover-генерации.
//
// Схема:
// - Пакет `@google/genai`, модель `gemini-2.5-flash-image`
// - Опциональный flow с proxy (обход гео-блока для AI Studio API)
// - Env vars: GEMINI_API_KEY + LLM_PROXY_URL + LLM_PROXY_SECRET
//
// Зачем не Imagen 3: Nano Banana работает через прокси (Imagen API
// тоже геоблочит, но один прокси работает для всей generativelanguage.googleapis.com).

import { GoogleGenAI } from '@google/genai';

export class IllustrationSafetyError extends Error {
  constructor(public readonly safetyReason: string) {
    super(`Gemini отклонил промпт по политике безопасности: ${safetyReason}`);
    this.name = 'IllustrationSafetyError';
  }
}

export class IllustrationRateLimitError extends Error {
  constructor() {
    super('Gemini вернул 429 после всех ретраев');
    this.name = 'IllustrationRateLimitError';
  }
}

export interface ReferenceImage {
  /** Raw PNG/JPEG buffer for character reference (Gemini multimodal input). */
  buffer: Buffer;
  /** MIME type — `image/png` | `image/jpeg`. */
  mimeType: string;
}

export interface GenerateImageOptions {
  prompt: string;
  aspectRatio?: '16:9' | '1:1' | '4:3' | '3:4' | '9:16';
  /**
   * Optional character/subject reference images. Gemini 2.5 Flash Image
   * treats these as visual anchors — «render this character in the new scene
   * described by the prompt». Supply your OWN original mascot art here if you
   * want a consistent character across covers. Ships empty by default.
   */
  referenceImages?: ReferenceImage[];
}

export interface GeneratedImage {
  buffer: Buffer;
  mimeType: string;
  promptUsed: string;
  modelVersion: string;
  generatedAt: Date;
}

const MODEL = 'gemini-2.5-flash-image';
const MAX_RETRIES = 3;

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GEMINI_API_KEY не задан. Возьми на https://aistudio.google.com/app/apikey, положи в .env.local',
      );
    }
    const proxy = process.env.LLM_PROXY_URL?.replace(/\/$/, '');
    const secret = process.env.LLM_PROXY_SECRET;
    if (proxy && secret) {
      client = new GoogleGenAI({
        apiKey,
        httpOptions: {
          baseUrl: `${proxy}/google`,
          headers: { 'X-Proxy-Secret': secret },
        },
      });
    } else {
      // Без прокси - работает только не из РФ (геоблок Google AI Studio).
      client = new GoogleGenAI({ apiKey });
    }
  }
  return client;
}

/**
 * Генерирует одну картинку через Gemini 2.5 Flash Image.
 * Возвращает PNG buffer.
 */
export async function generateImage(opts: GenerateImageOptions): Promise<GeneratedImage> {
  const { prompt, aspectRatio = '16:9', referenceImages = [] } = opts;
  const ai = getClient();
  let lastError: unknown = null;

  // Multimodal parts: reference images first (anchors), then text prompt.
  // Gemini читает parts по порядку — references as visual context до prompt.
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> =
    referenceImages.map((ref) => ({
      inlineData: {
        mimeType: ref.mimeType,
        data: ref.buffer.toString('base64'),
      },
    }));
  parts.push({ text: prompt });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: 'user', parts }],
        config: {
          responseModalities: ['IMAGE'],
          // biome-ignore lint/suspicious/noExplicitAny: SDK config types
          imageConfig: { aspectRatio } as any,
        },
      });

      const candidate = response.candidates?.[0];
      if (!candidate) {
        throw new Error('Gemini вернул пустой ответ (нет candidates)');
      }
      if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'PROHIBITED_CONTENT') {
        throw new IllustrationSafetyError(candidate.finishReason);
      }

      const imagePart = candidate.content?.parts?.find((p) => 'inlineData' in p && p.inlineData);
      if (!imagePart || !('inlineData' in imagePart) || !imagePart.inlineData) {
        throw new Error('Gemini не вернул inlineData с картинкой');
      }
      const base64 = imagePart.inlineData.data;
      const mimeType = imagePart.inlineData.mimeType || 'image/png';
      if (!base64) {
        throw new Error('Gemini вернул пустую data в inlineData');
      }
      return {
        buffer: Buffer.from(base64, 'base64'),
        mimeType,
        promptUsed: prompt,
        modelVersion: MODEL,
        generatedAt: new Date(),
      };
    } catch (err) {
      lastError = err;
      if (err instanceof IllustrationSafetyError) throw err;

      const message = err instanceof Error ? err.message : String(err);
      const isRateLimit = message.includes('429') || message.includes('RESOURCE_EXHAUSTED');
      const isServerError = message.includes('500') || message.includes('UNAVAILABLE');
      if (!isRateLimit && !isServerError) throw err;
      if (attempt === MAX_RETRIES - 1) break;

      const backoffMs = Math.min(1000 * 2 ** attempt, 8000) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  if (
    lastError instanceof Error &&
    (lastError.message.includes('429') || lastError.message.includes('RESOURCE_EXHAUSTED'))
  ) {
    throw new IllustrationRateLimitError();
  }
  throw lastError;
}

/**
 * Сохраняет GeneratedImage на диск как PNG.
 */
export async function saveImage(image: GeneratedImage, outputPath: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outputPath, image.buffer);
}

/**
 * Извлекает тематические артефакты по ключевым словам в title (эвристика).
 * Артефакты — конкретные визуальные элементы, которые Nano Banana может органично
 * вписать в сцену (а не дефолтный CLI-терминал для всех статей).
 */
function extractThematicArtifacts(title: string, lead?: string | null): string {
  const text = `${title} ${lead ?? ''}`.toLowerCase();
  const arts: string[] = [];
  if (/лимит|токен|max\b|жжё|жг[уё]т|обед|подписк|тариф|плат/i.test(text)) {
    arts.push('a near-empty fuel gauge with the needle hovering at red zone, soft glowing scale');
  }
  if (/контекст|память|мозг|second brain|claude\.md|claude md/i.test(text)) {
    arts.push('layered translucent file folders stacked like a library, with glowing nodes');
  }
  if (/hook\b|hooks|правил/i.test(text)) {
    arts.push('a chain of small mechanical hooks linking glowing nodes in a circuit');
  }
  if (/ошибк|баг|провал|сломал|fail|косяк/i.test(text)) {
    arts.push('a small warning beacon with soft amber light, debugger overlay');
  }
  if (/sonnet|opus|effort|модел|выбор/i.test(text)) {
    arts.push('a forked path symbol with two glowing branches diverging');
  }
  if (/skill|способн|умен/i.test(text)) {
    arts.push('an interlocking gear-and-key motif, suggesting capability');
  }
  if (/cli|terminal|command|консол/i.test(text)) {
    arts.push('a vintage retro terminal window with glowing prompt cursor');
  }
  if (arts.length === 0) {
    arts.push(
      'an abstract data-flow visualization with glowing nodes connected by thin orange lines',
    );
  }
  return arts.join('; ');
}

/**
 * Формирует cover-prompt под бренд + тему статьи. Полный single-image cover:
 * Nano Banana генерит ВСЁ — фон, артефакты, brand-логотип И русский title.
 * Никакого Chromium composit'а сверху.
 *
 * Принципы:
 * - Промпт на английском (модель лучше понимает инструкции на en)
 * - Title встроен в сцену как ОДНА композиция, не overlay
 * - Кириллица передаётся exact-as-text — модель должна отрендерить буквально
 * - Brand-identity (Claude burst, OpenAI lattice, Gemini sparkle...) интегрирована
 *   как часть сцены, не отдельная вставка
 * - Тематические артефакты подбираются по title (см. extractThematicArtifacts)
 */
/**
 * Сокращает русский title до короткой ёмкой обложечной фразы (4-7 слов).
 * Long titles разваливаются в image-моделях; короткие фразы рендерятся
 * на порядок надёжнее. Полный title всё равно есть на vc.ru — обложка
 * должна работать как hook, не как дубль title.
 */
function distillHeadline(titleRu: string): string {
  const cleaned = titleRu.replace(/[«»"]/g, '').trim();
  const parts = cleaned
    .split(/[.:—]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return cleaned;
  const first = parts[0] ?? '';
  if (first.split(/\s+/).length <= 7) return first;
  return first.split(/\s+/).slice(0, 7).join(' ');
}

export function buildCoverPrompt(args: {
  aiBrand: string | null;
  /** Русский title — НЕ рендерится в картинке (Nano Banana ломает кириллицу). Используется для contextual mood. */
  titleRu: string;
  /** Lead/первый параграф для контекста — для подбора артефактов. Опц. */
  lead?: string | null;
  /** Concept summary на английском (для image-model понимания темы). */
  conceptEn: string;
}): string {
  // Generic, brand-agnostic mascot descriptions. These intentionally do NOT
  // reference any real company's trademarked character, logo, or glyph, and do
  // NOT instruct the model to reproduce an existing mark. Each "brand" key just
  // maps to an original geometric mascot in a distinct accent palette. If you
  // want a consistent custom character, supply your OWN art via referenceImages.
  const BRAND_VISUAL: Record<string, string> = {
    'claude-code':
      'a friendly original geometric robot mascot — a rounded square body in warm orange (#D97757) with a clean cream-white outline, two simple squinting eyes, small rectangular limbs. HERO of the scene at large size (about 55–65% of canvas height in the right half of the canvas), in a flat sticker style, actively engaged with the article artifact.',
    chatgpt:
      'a stylized original humanoid mascot — a clean geometric figure in matte black and warm white with a soft teal (#10A37F) accent rim-light. The figure is the HERO, actively engaged with the article artifact. Crisp vector-like clarity, NOT muddy.',
    openai:
      'a stylized original humanoid mascot — a minimal monochrome geometric figure with a single restrained accent. HERO of the scene, actively engaged with the artifact.',
    codex:
      'a stylized original humanoid mascot — a sharp geometric figure in matte black/white with a teal accent. HERO actively engaged with a code artifact.',
    gemini:
      'a stylized original humanoid mascot — a clean figure in white silhouette accented by a saturated blue-to-purple gradient (#4285F4 → #9C27B0). HERO actively engaged with the artifact, crisp clarity.',
    grok: 'a stylized original humanoid mascot — a stark monochrome figure with an electric-blue (#1DA1F2) rim light. HERO actively engaged with the artifact, sharp and confident.',
    llama:
      'a stylized original llama-like mascot character — a soft friendly creature with a cream body and blue (#0467DF) saddle/scarf markings, drawn in confident ink-and-watercolour. HERO actively engaged with the artifact.',
    mistral:
      'a stylized original humanoid mascot — a clean figure with a warm orange-to-yellow accent gradient (#FA520F → #FFD800) as a rim light. HERO actively engaged with the artifact.',
  };
  const brandVisual =
    (args.aiBrand && BRAND_VISUAL[args.aiBrand]) ??
    'a tasteful abstract tech motif in a single saturated accent color';

  const PALETTE: Record<string, string> = {
    'claude-code':
      'background MUST be solid uniform deep warm brown exactly #141413 across ALL FOUR EDGES (no gradient, no atmospheric haze, no fog) — the illustration will be composed onto a 16:9 cover with the SAME #141413 background, so any deviation from solid #141413 creates a visible seam. Foreground colours: saturated orange #D97757 for accents, cream-white #EDE9E3 for highlights',
    chatgpt:
      'background MUST be solid uniform near-black exactly #0D0D0D across all edges (no gradient). Foreground: teal accent #10A37F, off-white #F5F5F5 highlights',
    openai:
      'background MUST be solid uniform matte black exactly #0D0D0D across all edges. Foreground: monochrome whites with single subtle accent',
    gemini:
      'background MUST be solid uniform deep midnight blue exactly #0F1729 across all edges (no gradient). Foreground: vivid sparkle accents, white highlights',
    grok: 'background MUST be solid uniform pure black #000000 across all edges. Foreground: electric-blue accent, stark monochrome',
    llama:
      'background MUST be solid uniform warm off-white exactly #F8F4EE across all edges. Foreground: blue #0467DF accent, dark navy text-tones',
    mistral:
      'background MUST be solid uniform deep charcoal #1A1A1A across all edges. Foreground: orange-yellow accent gradient, cream highlights',
  };
  const palette = (args.aiBrand && PALETTE[args.aiBrand]) ?? 'monochrome with single accent color';

  const artifacts = extractThematicArtifacts(args.titleRu, args.lead);

  return [
    'You are a senior editorial illustrator producing magazine covers for vc.ru. Visual references: Christoph Niemann (clever conceptual metaphors), Olimpia Zagnoli (bold confident shape language), Owen Davey (vivid flat illustration with crisp edges), Tom Haugomat (cinematic atmosphere). Quality bar: Wired / Bloomberg Businessweek cover. NOT generic AI-illustration, NOT Behance tech-art, NOT muted / muddy / washed-out.',
    '',
    `EDITORIAL BRIEF: ${args.conceptEn}`,
    '',
    'CORE SCENE — one hero, one artifact, one strong moment:',
    `- HERO (right side of the canvas): ${brandVisual}`,
    `- The hero is ACTIVELY engaged with this thematic artifact (not next to it — actually doing something with it): ${artifacts}`,
    '- Pose conveys a clear narrative beat — frustration, focus, discovery, exhaustion — whatever matches the article mood. The viewer should read the story in 2 seconds.',
    '',
    'CANVAS & COMPOSITION (9:16 mobile-portrait):',
    '- Aspect ratio 9:16 (vertical portrait). The illustration is displayed in full — no cropping at edges.',
    '- The character DOMINATES the frame: hero occupies 75-85% of frame height, centred horizontally and vertically.',
    '- Small but clear safe-margin on each side (about 4-6% padding) — silhouette never touches the edge but the character still looks LARGE and confident. The character is the protagonist, the frame is just a tight crop around it.',
    '- The thematic artifact is sized smaller than the character — it interacts with the character (held, hugged, leaned on) as a supporting element, not as a competing focal point.',
    '- DO NOT shrink the character to leave decorative margin. Margins exist only to prevent edge clipping, not to give breathing room around a tiny icon.',
    '- Background: SOLID UNIFORM colour as specified in palette (no gradient, no atmospheric haze, no warm wash). The character + artifact sit cleanly on this flat background. This is critical — the illustration will be merged with a wider canvas that has the SAME solid background, so any deviation creates a visible seam. Atmospheric particles, dust motes, or small accent flecks are OK only if subtle.',
    '- ONE strong light source: directional warm light from upper-right, raking across the scene. Crisp rim-light on the hero, real soft shadow on the lower-left.',
    `- Palette: ${palette}. Saturated, punchy, vivid — NOT desaturated, NOT muted.`,
    '',
    'STYLE EXECUTION — CRISP, BOLD, HIGH-CLARITY:',
    '- Clean confident ink linework with bold organic strokes (NOT scratchy, NOT mushy)',
    '- Flat colour fills with selective watercolour shading (NOT muddy gradients all over)',
    '- HIGH CONTRAST between hero and background — the hero pops, the background recedes',
    '- Sharp focus on the hero, gentle atmospheric softness only at canvas edges',
    '- Generous use of the accent colour as splashes, rim-light, glowing highlights — make the colour DO WORK',
    '',
    'ABSOLUTE BANS:',
    '- The character must NOT touch the edges of the square — leave clear margin around the full silhouette so the image can be safely placed in a wider layout',
    '- NO text, letters, numbers, captions, labels, watermarks anywhere in the image',
    '- If the artifact has displays/screens/dials, fill them with abstract marks (dots, dashes, geometric shapes) — never readable characters',
    '- NO human faces, NO photographs of real people',
    '- NO 3D render, NO photorealism, NO cartoon, NO clip-art, NO cyberpunk, NO neon, NO glitch effects',
    '- NO muddy / dim / washed-out / foggy / over-grainy aesthetic — the image must feel SHARP and CONFIDENT',
    '- NO collage of separate icons — ONE coherent scene',
  ].join('\n');
}
