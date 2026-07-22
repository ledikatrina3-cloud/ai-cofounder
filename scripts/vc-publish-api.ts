#!/usr/bin/env tsx
// CLI публикатор vc.ru через прямой Osnova API.
//
// Использование:
//   VC_REFRESH_TOKEN=<rt> pnpm tsx scripts/vc-publish-api.ts <path-to-draft.md> [--publish]
//
// --publish: реально публиковать (is_published=true). Без флага - только draft.
//
// Flow:
// 1. Refresh AT через VC_REFRESH_TOKEN
// 2. Резолвит draft.category → subsite_id
// 3. Конвертит markdown → Osnova blocks
// 4. POST /v2.1/editor (multipart, entry={...})
// 5. Печатает URL опубликованного поста / черновика

import { loadDraft } from '../src/publish/loader.js';
import { markdownToOsnova } from '../src/publish/markdown-to-osnova.js';
import {
  type Subsite,
  VcApiError,
  makeCoverBlock,
  refreshAndPersist,
  resolveSubsiteByCategory,
  saveEntry,
  uploadImage,
} from '../src/publish/vc-api.js';

async function main(): Promise<void> {
  const draftPath = process.argv[2];
  if (!draftPath) {
    console.error('usage: pnpm tsx scripts/vc-publish-api.ts <path-to-draft.md> [--publish]');
    process.exit(1);
  }
  const doPublish = process.argv.includes('--publish');

  console.log(`[cli] loading draft: ${draftPath}`);
  const draft = await loadDraft(draftPath);
  if (draft.status !== 'ready') {
    console.error(`[cli] draft status='${draft.status}', ожидался 'ready'`);
    process.exit(1);
  }
  console.log(`[cli] title: ${draft.title}`);
  console.log(`[cli] category: ${draft.category ?? '(none)'}`);
  console.log(`[cli] mode: ${doPublish ? 'PUBLISH' : 'DRAFT'}`);

  console.log('[cli] refreshing access token (auto-persist в .env.local)...');
  const session = await refreshAndPersist();
  console.log(
    `[cli] AT exp in ${Math.round((session.accessExpTimestamp * 1000 - Date.now()) / 1000)}s`,
  );

  // Resolve subsite.
  let subsite: Subsite;
  if (draft.category) {
    subsite = await resolveSubsiteByCategory(session.accessToken, draft.category);
    console.log(`[cli] subsite '${draft.category}' → id=${subsite.id} name='${subsite.name}'`);
  } else {
    console.error('[cli] draft.category не задан - не знаю куда публиковать');
    process.exit(1);
  }

  if (!subsite.isEnableWriting) {
    console.error(`[cli] subsite '${subsite.uri}' не разрешает публикации`);
    process.exit(1);
  }

  // Convert markdown.
  const md = stripFirstH1IfDuplicate(draft.body, draft.title);
  const { blocks: contentBlocks } = markdownToOsnova(md);
  console.log(`[cli] converted to ${contentBlocks.length} Osnova blocks`);

  // Upload cover (обязательно для vc.ru - иначе пост без превью в ленте).
  if (!draft.cover) {
    console.error('[cli] draft.cover не задан - публикация без обложки запрещена');
    process.exit(1);
  }
  console.log(`[cli] uploading cover: ${draft.cover}`);
  const coverImg = await uploadImage(session.accessToken, draft.cover);
  console.log(`[cli] cover uploaded: uuid=${coverImg.uuid} ${coverImg.width}x${coverImg.height}`);

  const coverBlock = makeCoverBlock(coverImg);
  const blocks = [coverBlock, ...contentBlocks];

  // user_id: для personal_blog в Osnova-протоколе используется subsite.id блога
  // (не JWT.user_id). Берём из env VC_USER_ID (id твоего персонального блога на
  // vc.ru); если не задан — fallback на subsite.id текущего раздела.
  const userId = Number(process.env.VC_USER_ID) || subsite.id;

  console.log('[cli] saving...');
  try {
    const entry = await saveEntry(session.accessToken, {
      userId,
      subsiteId: subsite.id,
      title: draft.title,
      blocks,
      isPublished: doPublish,
    });
    console.log('');
    console.log(`✓ ${doPublish ? 'PUBLISHED' : 'SAVED AS DRAFT'}`);
    console.log(`  id:    ${entry.id}`);
    console.log(`  title: ${entry.title}`);
    console.log(`  url:   ${entry.url}`);
    console.log(`  blocks accepted: ${entry.blocks.length}`);
    if (blocks.length !== entry.blocks.length) {
      console.warn(
        `  ⚠ блоков отправлено=${blocks.length}, принято=${entry.blocks.length} (vc.ru мог отфильтровать)`,
      );
    }
  } catch (err) {
    if (err instanceof VcApiError) {
      console.error(`[cli] API error [${err.status}]: ${err.code} - ${err.message}`);
      console.error('[cli] response:', JSON.stringify(err.response).slice(0, 600));
    } else {
      console.error('[cli] fatal:', err);
    }
    process.exit(2);
  }
}

function stripFirstH1IfDuplicate(body: string, title: string): string {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (line.trim().startsWith('# ')) {
      const h1Text = line.trim().slice(2).trim();
      if (h1Text === title.trim()) {
        return lines
          .slice(i + 1)
          .join('\n')
          .trim();
      }
    }
    break;
  }
  return body;
}

main().catch((err) => {
  console.error('[cli] fatal:', err);
  process.exit(1);
});
