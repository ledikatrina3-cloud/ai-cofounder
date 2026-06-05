#!/usr/bin/env tsx
// Регенерирует cover.png под актуальный title в frontmatter draft'а
// (используя новый research-based template) и обновляет уже опубликованный пост.
//
// Cover дизайн (см. org/cover-design-brief.md):
// - Title в верхней-левой трети (F-pattern, NN/Group)
// - Артефакт: стопка из 5 карточек JSON-сниппетов в стиле Ray.so/Carbon (правая 2/3 экрана)
// - НЕТ: лого, eyebrow, footer, стрелочек (всё что в краях обрезается в превью)
// - Тёмная палитра выделяется в белых карточках vc.ru ленты
//
// Usage:
//   VC_REFRESH_TOKEN=<rt> pnpm tsx scripts/regen-cover-and-update.ts \
//     <draft-md-path> <vc-post-id>

import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'patchright';
import { loadDraft } from '../src/publish/loader.js';
import { markdownToOsnova } from '../src/publish/markdown-to-osnova.js';
import {
  buildCoverPrompt,
  generateImage as nanoGenerate,
  saveImage as nanoSave,
} from '../src/publish/nano-banana.js';
import {
  makeCoverBlock,
  pickBrandAsset,
  refreshAndPersist,
  saveEntry,
  uploadImage,
} from '../src/publish/vc-api.js';

// Подгружаем .env.local в process.env (для GEMINI_API_KEY, LLM_PROXY_*).
async function loadDotEnv(envPath: string): Promise<void> {
  try {
    const content = await readFile(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const m = /^([A-Z_a-z]+)=(.*)$/.exec(line);
      if (m?.[1] && !(m[1] in process.env)) {
        process.env[m[1]] = m[2] ?? '';
      }
    }
  } catch {
    /* ignore */
  }
}

// Cover template v7 (фидбэк фаундера 2026-05-25):
// - Использует ОФИЦИАЛЬНЫЙ Claude Code visual (CMS PNG) как артефакт справа
//   (retro pixel-CLI terminal + signature orange splashes)
// - Title слева с orange accent'ами
// - НЕТ самопальной JSON-карточки (фирменный визуал сам говорит "Claude Code")
// - НЕТ дополнительной подписи (CLI-окно уже содержит wordmark)
const NEW_COVER_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@700;800;900&display=swap');
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  width: 1920px; height: 1080px;
  background: #141413;
  font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
  color: #ede9e3;
  position: relative;
  overflow: hidden;
}
.bg-glow {
  position: absolute;
  width: 1100px; height: 900px;
  right: -100px; top: -100px;
  background: radial-gradient(ellipse, rgba(217,119,87,0.16) 0%, transparent 70%);
  filter: blur(80px);
}
.bg-glow-2 {
  position: absolute;
  width: 600px; height: 600px;
  left: 60px; bottom: 60px;
  background: radial-gradient(ellipse, rgba(217,119,87,0.08) 0%, transparent 70%);
  filter: blur(60px);
}
/* Title - левая половина строго */
.h1 {
  position: absolute;
  top: 300px;
  left: 120px;
  font-family: 'Plus Jakarta Sans';
  font-weight: 900;
  font-size: 110px;
  line-height: 1.02;
  letter-spacing: -0.035em;
  color: #ede9e3;
  width: 780px;
  z-index: 10;
}
.h1 .brand {
  display: block;
  color: #d97757;
  margin-bottom: 36px;
  font-size: 82px;
  line-height: 1.0;
}
.h1 .accent { color: #d97757; }
/* Артефакт - официальный Claude Code visual в правой половине, не пересекается с title */
.artifact-img {
  position: absolute;
  top: 50%;
  right: 120px;
  transform: translateY(-50%);
  width: 800px;
  height: auto;
  z-index: 5;
  filter: drop-shadow(0 30px 60px rgba(0,0,0,0.65));
  border-radius: 16px;
}
</style></head><body>
<div class="bg-glow"></div>
<div class="bg-glow-2"></div>
<img class="artifact-img" src="__BRAND_IMG_SRC__" />
<div class="h1">__TITLE_HTML__</div>
</body></html>`;

async function main() {
  const draftPath = process.argv[2];
  const postId = Number(process.argv[3]);
  if (!draftPath || !postId) {
    console.error('usage: pnpm tsx scripts/regen-cover-and-update.ts <draft-md-path> <vc-post-id>');
    process.exit(1);
  }

  console.log(`[cover-regen] loading draft: ${draftPath}`);
  const draft = await loadDraft(draftPath);
  if (!draft.cover) {
    console.error('draft.cover не задан');
    process.exit(1);
  }
  console.log(`[cover-regen] title: ${draft.title}`);

  // Render new cover via Chromium (file:// URL).
  const coverHtmlPath = draft.cover.replace(/\.png$/, '.html');
  const titleHtml = formatTitleHtml(draft.title);
  const brand = 'claude-code'; // TODO: ai_brand в frontmatter
  const { fileURLToPath: fup } = await import('node:url');
  const { dirname: dn2, resolve: rs2 } = await import('node:path');
  const here = dn2(fup(import.meta.url));
  const repoRoot = rs2(here, '..');
  await loadDotEnv(rs2(repoRoot, '.env.local'));

  // Primary path: Nano Banana (AI-сгенерированная уникальная иллюстрация).
  // Опциональный fallback: static visual из assets/logos/<brand>/ (pickBrandAsset),
  // если пользователь положил туда СВОИ визуалы. OSS-сборка их не поставляет, поэтому
  // pickBrandAsset может бросить — тогда рендерим обложку без brand-картинки, без падения.
  const illustrationPath = draft.cover.replace(/\.png$/, '-illustration.png');
  let visualPath: string | null = null;
  const tryPickBrandAsset = async (): Promise<string | null> => {
    try {
      const asset = await pickBrandAsset(brand, draft.title, repoRoot);
      return asset.path;
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      console.warn(`[cover-regen] ⚠ нет brand-визуала (${m}) → обложка без логотипа`);
      return null;
    }
  };
  if (process.env.GEMINI_API_KEY) {
    try {
      console.log('[cover-regen] generating cover illustration via Nano Banana...');
      const prompt = buildCoverPrompt({
        aiBrand: brand,
        titleRu: draft.title,
        conceptEn: `An article titled "${draft.title.replace(/[«»"]/g, '')}" about AI coding tools.`,
      });
      const startMs = Date.now();
      const image = await nanoGenerate({ prompt, aspectRatio: '16:9' });
      await nanoSave(image, illustrationPath);
      console.log(
        `[cover-regen] ✓ Nano Banana ${Math.round((Date.now() - startMs) / 1000)}s, ${image.buffer.length}b → ${illustrationPath}`,
      );
      visualPath = illustrationPath;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[cover-regen] ⚠ Nano Banana failed: ${msg} → fallback на pool`);
      visualPath = await tryPickBrandAsset();
    }
  } else {
    console.log('[cover-regen] GEMINI_API_KEY не задан, используем pool brand-visuals');
    visualPath = await tryPickBrandAsset();
  }

  const html = NEW_COVER_HTML.replace('__TITLE_HTML__', titleHtml).replace(
    '__BRAND_IMG_SRC__',
    visualPath ? `file://${visualPath}` : '',
  );
  await writeFile(coverHtmlPath, html, 'utf8');
  console.log('[cover-regen] cover.html обновлён');

  console.log('[cover-regen] rendering cover.png 1920x1080 via Chromium...');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  await page.goto(`file://${coverHtmlPath}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  await page.screenshot({ path: draft.cover, type: 'png', fullPage: false });
  await browser.close();
  console.log(`[cover-regen] cover.png saved: ${draft.cover}`);

  // Сохраняем cover.title.txt - проверка соответствия для будущих публикаций.
  await writeFile(`${draft.cover}.title.txt`, draft.title, 'utf8');

  // Refresh AT (с auto-persist нового RT в .env.local).
  console.log('[cover-regen] refreshing AT (auto-persist в .env.local)...');
  const session = await refreshAndPersist();

  // Upload new cover.
  const img = await uploadImage(session.accessToken, draft.cover);
  console.log(`[cover-regen] uploaded uuid=${img.uuid}`);

  // Re-convert markdown body.
  const md = draft.body.split('\n').slice(1).join('\n').trim();
  const { blocks: contentBlocks } = markdownToOsnova(md);
  const blocks = [makeCoverBlock(img), ...contentBlocks];

  // Save entry (UPDATE existing published post). userId = id персонального блога,
  // subsiteId = id раздела/сообщества — оба под твой аккаунт через env.
  const userId = Number(process.env.VC_USER_ID);
  const subsiteId = Number(process.env.VC_SUBSITE_ID);
  if (!Number.isFinite(userId) || !Number.isFinite(subsiteId)) {
    throw new Error('Задай VC_USER_ID и VC_SUBSITE_ID в .env (id блога и раздела на vc.ru).');
  }
  console.log(`[cover-regen] updating post id=${postId}...`);
  const entry = await saveEntry(session.accessToken, {
    id: postId,
    userId,
    subsiteId,
    title: draft.title,
    blocks,
    isPublished: true,
  });
  console.log('');
  console.log(`✓ Updated post #${entry.id}`);
  console.log(`  url: ${entry.url}`);
  console.log(`  blocks: ${entry.blocks.length}`);
}

/**
 * Формирует title HTML с brand-line (оранжевый) + main (белый, с оранжевыми
 * acent'ами на цифры и ключевые слова после запятой / в конце).
 */
function formatTitleHtml(title: string): string {
  const escaped = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  if (escaped.includes(' - ')) {
    const [brand, ...rest] = escaped.split(' - ');
    const main = rest.join(' - ').trim();
    return `<span class="brand">${brand}</span>${highlightMainTitle(main)}`;
  }
  if (escaped.includes(':')) {
    const [head, ...rest] = escaped.split(':');
    return `<span class="brand">${head}:</span>${highlightMainTitle(rest.join(':').trim())}`;
  }
  return highlightMainTitle(escaped);
}

/**
 * Разбивает основной title на 2-3 строки + добавляет оранжевый accent.
 * - Цифры в начале → accent
 * - Глагол "не <X>" в конце (антитеза, hook) → accent
 */
function highlightMainTitle(main: string): string {
  let html = main;
  // Accent на цифры (1-2 цифры в начале): "5 правил" → "<accent>5 правил</accent>"
  // Берём первое слово с цифрой + следующее.
  const numMatch = /^(\d+\s+\S+)/.exec(html);
  if (numMatch) {
    const [phrase] = numMatch;
    html = html.replace(phrase, `<span class="accent">${phrase}</span>`);
  }
  // Accent на "не <X>" в конце ("не забывает", "не падает", "не теряется").
  const negMatch = /\b(не\s+\S+)\s*$/i.exec(html);
  if (negMatch) {
    const [, phrase] = negMatch;
    html = html.replace(new RegExp(`${phrase}\\s*$`), `<span class="accent">${phrase}</span>`);
  }

  // Line-break: после запятой.
  if (html.includes(',')) {
    const commaIdx = html.indexOf(',');
    const head = html.slice(0, commaIdx + 1).trim();
    const tail = html.slice(commaIdx + 1).trim();
    // Возможно tail слишком длинный - разбиваем по середине.
    const stripped = tail.replace(/<[^>]+>/g, '');
    if (stripped.length > 30) {
      const words = tail.split(' ');
      const mid = Math.ceil(words.length / 2);
      return `${head}<br>${words.slice(0, mid).join(' ')}<br>${words.slice(mid).join(' ')}`;
    }
    return `${head}<br>${tail}`;
  }
  return html;
}

main().catch((e) => {
  console.error('[cover-regen] fatal:', e);
  process.exit(1);
});
