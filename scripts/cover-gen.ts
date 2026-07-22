#!/usr/bin/env tsx
// Pre-publish cover generator: AI-сцена + типографический overlay.
//
// Pipeline:
//   1. Nano Banana генерит editorial illustration с пустой зоной слева (без текста)
//   2. Chromium вписывает русский title в эту зону тем же шрифтом и цветом,
//      что и стиль сцены — текст лежит НА сцене, не на отдельной плашке.
//
// Why hybrid: Nano Banana ломает кириллицу в любом промпте (известное ограничение
// model'и Gemini 2.5 Flash Image). AI делает то, в чём он силён — illustration.
// Chromium делает то, в чём он силён — точный controlled text. Единая визуальная
// атмосфера — за счёт согласованной палитры и шрифта.
//
// Usage:
//   pnpm exec tsx scripts/cover-gen.ts <draft-md-path> [--keep-existing] [--brand=<slug>]

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'patchright';
import { loadDraft } from '../src/publish/loader.js';
import {
  type ReferenceImage,
  buildCoverPrompt,
  generateImage as nanoGenerate,
  saveImage as nanoSave,
} from '../src/publish/nano-banana.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function loadDotEnv(envPath: string): Promise<void> {
  try {
    const content = await readFile(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const m = /^([A-Z_a-z][A-Z_a-z0-9]*)=(.*)$/.exec(line);
      if (m?.[1] && !(m[1] in process.env)) {
        process.env[m[1]] = m[2] ?? '';
      }
    }
  } catch {
    /* .env.local не существует — продолжаем (cron-сценарий обычно даёт env иначе) */
  }
}

function detectBrandFromTitle(title: string): string {
  const t = title.toLowerCase();
  if (t.includes('claude') || t.includes('anthropic')) return 'claude-code';
  if (t.includes('codex') || t.includes('chatgpt') || t.includes('openai')) return 'chatgpt';
  if (t.includes('gemini')) return 'gemini';
  if (t.includes('grok')) return 'grok';
  if (t.includes('llama')) return 'llama';
  if (t.includes('mistral')) return 'mistral';
  return 'claude-code';
}

function extractLead(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    if (t.startsWith('#')) continue;
    if (t.startsWith('---')) continue;
    return t.slice(0, 300);
  }
  return '';
}

/**
 * Сокращает title для overlay'я — берёт первую часть до точки/двоеточия,
 * максимум 8 слов. Полный title уже на vc.ru, обложка работает как hook.
 */
function distillHeadline(titleRu: string): string {
  const cleaned = titleRu.replace(/[«»"]/g, '').trim();
  // Сплит по любому разделителю предложения: точка, двоеточие, em-dash,
  // или дефис в роли тире (« - » с пробелами по бокам).
  const parts = cleaned
    .split(/[.:—]|\s-\s/)
    .map((s) => s.trim().replace(/[-—:.,;\s]+$/u, ''))
    .filter(Boolean);
  const first = parts[0] ?? cleaned;
  const words = first.split(/\s+/);
  if (words.length <= 8) return first;
  return words.slice(0, 8).join(' ');
}

/**
 * Превращает headline в HTML с акцентными словами по приоритету:
 *   1) Числа + измерения («4 часа», «$200», «80 строк», «5 ошибок»)
 *   2) Brand-имена (Claude, ChatGPT, Codex, Gemini, GPT, Anthropic, OpenAI, Max, Sonnet, Opus)
 *   3) Финальная значимая фраза (last 2-3 слова после последнего разделителя)
 *
 * Цель: выделить КЛЮЧЕВУЮ МЫСЛЬ оранжевым, чтобы читалось с первого взгляда.
 * Чистый белый headline без accent выглядит плоско; точечный accent оживляет.
 */
function formatHeadlineHtml(headline: string): string {
  let html = headline.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // (1) Числа с опциональной единицей измерения.
  html = html.replace(
    /(\$?\d+(?:[.,]\d+)?(?:\s*(?:час[аовы]?|строк[аи]?|токен[оаы]?в?|шаг[аовы]?|сесси[йяи]+|ошиб[аокчные]+|пункт[аовы]?|пунктов|секунд[ыав]?|мин(?:ут[ыав]?)?|дн[ейяя]?|недел[ьяи]?|месяц[аев]?|год[аов]?|раз[а]?|тыс|млн))?)/gu,
    '<span class="accent">$1</span>',
  );

  // (2) Brand-имена (case-sensitive — пишутся всегда capitalized).
  const brands = [
    'Claude Code',
    'Claude',
    'Anthropic',
    'ChatGPT',
    'Codex',
    'GPT-5',
    'GPT-4',
    'GPT',
    'OpenAI',
    'Gemini',
    'Google AI',
    'Grok',
    'xAI',
    'Llama',
    'Meta AI',
    'Mistral',
    'Cursor',
    'Copilot',
    'Devin',
    'Replit',
    'Max',
    'Pro',
    'Sonnet',
    'Opus',
    'Haiku',
  ];
  for (const brand of brands) {
    // Не accent'ить если уже внутри <span class="accent">.
    const re = new RegExp(
      `(?<!class="accent">[^<]*?)\\b(${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`,
      'g',
    );
    html = html.replace(re, '<span class="accent">$1</span>');
  }

  // Line breaks по запятой (3-4 строки на headline).
  html = html.replace(/,\s*/g, ',<br>');
  return html;
}

interface CoverPalette {
  bg: string;
  fg: string;
  accent: string;
}

const PALETTES: Record<string, CoverPalette> = {
  'claude-code': { bg: '#141413', fg: '#EDE9E3', accent: '#D97757' },
  chatgpt: { bg: '#0D0D0D', fg: '#F5F5F5', accent: '#10A37F' },
  openai: { bg: '#0D0D0D', fg: '#F5F5F5', accent: '#999999' },
  gemini: { bg: '#0F1729', fg: '#FFFFFF', accent: '#4285F4' },
  grok: { bg: '#000000', fg: '#FFFFFF', accent: '#1DA1F2' },
  llama: { bg: '#F8F4EE', fg: '#0A1F44', accent: '#0467DF' },
  mistral: { bg: '#1A1A1A', fg: '#FFEFE0', accent: '#FA520F' },
};

function buildOverlayHtml(opts: {
  illustrationPath: string;
  headline: string;
  palette: CoverPalette;
}): string {
  const { illustrationPath, headline, palette } = opts;
  const headlineHtml = formatHeadlineHtml(headline);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@800;900&display=swap');
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  width: 1920px; height: 1080px;
  background-color: ${palette.bg};
  position: relative;
  font-family: 'Plus Jakarta Sans', 'Inter', system-ui, sans-serif;
  overflow: hidden;
}
/* AI illustration в правой части canvas. Square 1:1, шире чем правая половина
   (тянется немного влево), но левый край маскируется gradient'ом в transparent
   — переход к palette.bg без жёсткой линии. */
.illustration {
  position: absolute;
  top: 0;
  right: 0;
  height: 100%;
  /* 1/3 canvas — illustration занимает строго правую треть. AI генерится 9:16
     (точно matches пропорции 640×1080), background-size: contain показывает
     ВСЮ картинку без обрезки. Background палитра solid palette.bg, поэтому
     если по высоте останется маленький gap — он невидим. */
  width: 640px;
  background-color: ${palette.bg};
  background-image: url('file://${illustrationPath}');
  background-size: contain;
  background-position: center;
  background-repeat: no-repeat;
  z-index: 0;
  -webkit-mask-image: linear-gradient(
    90deg,
    transparent 0%,
    rgba(0,0,0,0.5) 18%,
    #000 38%,
    #000 100%
  );
  mask-image: linear-gradient(
    90deg,
    transparent 0%,
    rgba(0,0,0,0.5) 18%,
    #000 38%,
    #000 100%
  );
}
.vignette {
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at 70% 50%, transparent 50%, ${palette.bg}33 85%, ${palette.bg}80 100%);
  z-index: 1;
  pointer-events: none;
}
.headline {
  position: absolute;
  /* Vertical centering — текст лежит между верхним и нижним краем canvas.
     2/3 canvas по горизонтали: padding слева + width + 50px gap до illustration. */
  top: 50%;
  left: 90px;
  transform: translateY(-50%);
  width: 1140px;
  font-weight: 900;
  font-size: 140px;
  line-height: 1.02;
  letter-spacing: -0.04em;
  color: ${palette.fg};
  text-shadow:
    0 2px 0 rgba(0,0,0,0.5),
    0 4px 12px rgba(0,0,0,0.7),
    0 14px 40px rgba(0,0,0,0.55);
  z-index: 2;
}
.headline .accent {
  color: ${palette.accent};
  text-shadow:
    0 2px 0 rgba(0,0,0,0.55),
    0 4px 14px rgba(0,0,0,0.75),
    0 0 22px ${palette.accent}66;
}
</style>
</head>
<body>
<div class="illustration"></div>
<div class="vignette"></div>
<div class="headline">${headlineHtml}</div>
</body>
</html>`;
}

async function main(): Promise<void> {
  const draftPath = process.argv[2];
  const keepExisting = process.argv.includes('--keep-existing');
  const brandArg = process.argv.find((a) => a.startsWith('--brand='))?.split('=')[1];
  if (!draftPath) {
    console.error(
      'usage: pnpm exec tsx scripts/cover-gen.ts <draft-md-path> [--keep-existing] [--brand=<slug>]',
    );
    process.exit(1);
  }
  await loadDotEnv(resolve(REPO_ROOT, '.env.local'));

  console.log(`[cover-gen] loading draft: ${draftPath}`);
  const draft = await loadDraft(draftPath);
  if (!draft.cover) {
    console.error('[cover-gen] draft.cover не задан в frontmatter');
    process.exit(1);
  }
  console.log(`[cover-gen] title: ${draft.title}`);

  const brand = brandArg ?? detectBrandFromTitle(draft.title);
  const palette = PALETTES[brand] ?? PALETTES['claude-code']!;
  console.log(`[cover-gen] brand: ${brand}, palette: ${palette.bg} / ${palette.accent}`);

  const illustrationPath = draft.cover.replace(/\.png$/, '-illustration.png');
  const overlayHtmlPath = draft.cover.replace(/\.png$/, '.html');
  const titleStampPath = `${draft.cover}.title.txt`;

  // Idempotency — если cover.png под этот title уже собран, skip.
  if (keepExisting && existsSync(draft.cover) && existsSync(titleStampPath)) {
    const prevTitle = (await readFile(titleStampPath, 'utf8')).trim();
    if (prevTitle === draft.title) {
      console.log('[cover-gen] --keep-existing: cover уже собран под этот title — skip');
      return;
    }
  }

  // Шаг 1: AI illustration (без текста, с пустой зоной слева).
  if (keepExisting && existsSync(illustrationPath)) {
    console.log(`[cover-gen] --keep-existing: переиспользую ${illustrationPath}`);
  } else {
    if (!process.env.GEMINI_API_KEY) {
      console.error(
        '[cover-gen] GEMINI_API_KEY не задан. Проверь .env.local или env в cron-runner.',
      );
      process.exit(2);
    }
    const lead = extractLead(draft.body);
    const conceptEn = `An article about AI coding tools (${brand} ecosystem): ${draft.title.replace(/[«»"]/g, '')}`;

    // Optionally load a reference mascot image if the user has supplied their
    // OWN original art at assets/mascots/<brand>.png|.jpg. Gemini uses it as a
    // visual anchor for a consistent character. Ships with no reference images
    // by default — if absent, we degrade cleanly to a text-only prompt below.
    const referenceImages: ReferenceImage[] = [];
    const mascotPathPng = resolve(REPO_ROOT, 'assets/mascots', `${brand}.png`);
    const mascotPathJpg = resolve(REPO_ROOT, 'assets/mascots', `${brand}.jpg`);
    const mascotPath = existsSync(mascotPathPng)
      ? mascotPathPng
      : existsSync(mascotPathJpg)
        ? mascotPathJpg
        : null;
    if (mascotPath) {
      const buffer = await readFile(mascotPath);
      const mimeType = mascotPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
      referenceImages.push({ buffer, mimeType });
      console.log(`[cover-gen] reference mascot: ${mascotPath} (${buffer.length} bytes)`);
    } else {
      console.log(
        `[cover-gen] no reference mascot for brand '${brand}' (fallback на text-only prompt)`,
      );
    }

    console.log(
      '[cover-gen] generating AI illustration via Nano Banana (1:1 square, composited в правую часть canvas)...',
    );
    const prompt = buildCoverPrompt({
      aiBrand: brand,
      titleRu: draft.title,
      lead,
      conceptEn,
    });
    const startMs = Date.now();
    // 9:16 mobile-portrait — точно matches пропорции illustration zone (640×1080 ≈ 9:15.2 ≈ 9:16).
    // С background-size: contain получаем character без cropping — модель имеет
    // ту же canvas пропорцию что и финальная зона, ничего не теряется.
    const image = await nanoGenerate({ prompt, aspectRatio: '9:16', referenceImages });
    await nanoSave(image, illustrationPath);
    console.log(
      `[cover-gen] ✓ Nano Banana ${Math.round((Date.now() - startMs) / 1000)}s, ${image.buffer.length}b → ${illustrationPath}`,
    );
  }

  // Шаг 2: Chromium вписывает headline.
  const headline = distillHeadline(draft.title);
  console.log(`[cover-gen] overlay headline: «${headline}»`);
  const html = buildOverlayHtml({ illustrationPath, headline, palette });
  await writeFile(overlayHtmlPath, html, 'utf8');

  console.log('[cover-gen] rendering final cover 1920×1080 via Chromium...');
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await ctx.newPage();
    await page.goto(`file://${overlayHtmlPath}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);
    await page.screenshot({ path: draft.cover, type: 'png', fullPage: false });
  } finally {
    await browser.close();
  }
  await writeFile(titleStampPath, draft.title, 'utf8');
  console.log(`[cover-gen] ✓ saved: ${draft.cover}`);
}

main().catch((err) => {
  console.error('[cover-gen] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
