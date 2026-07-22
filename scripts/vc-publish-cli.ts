#!/usr/bin/env tsx
// CLI для ручной публикации draft через extension.
//
// Использование:
//   pnpm tsx scripts/vc-publish-cli.ts <path-to-draft.md>
//
// Flow:
// 1. Загружает draft (frontmatter + body).
// 2. Если есть htmlPath - игнорим, берём markdown body (Editor.js native render).
// 3. Конвертит markdown -> Editor.js blocks.
// 4. POST /queue/enqueue в localhost:7777.
// 5. Опрашивает GET /result/:taskId раз в 5 сек, до 10 минут.
// 6. Печатает URL опубликованного поста.

import { loadDraft } from '../src/publish/loader.js';
import { markdownToEditorJs } from '../src/publish/markdown-to-editorjs.js';

const BRIDGE_URL = process.env.VC_BRIDGE_URL ?? 'http://localhost:7777';
const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 10 * 60 * 1000;

async function main(): Promise<void> {
  const draftPath = process.argv[2];
  if (!draftPath) {
    console.error('usage: pnpm tsx scripts/vc-publish-cli.ts <path-to-draft.md>');
    process.exit(1);
  }

  console.log(`[cli] loading draft ${draftPath}`);
  const draft = await loadDraft(draftPath);

  if (draft.status !== 'ready') {
    console.error(`[cli] draft status=${draft.status}, ожидался 'ready'`);
    process.exit(1);
  }

  console.log(`[cli] platform=${draft.platform} title='${draft.title}'`);

  // Берём markdown body. body не содержит первого H1 (он в frontmatter title)
  // - но если в body первый H1 повторяется, конвертер его подцепит как title.
  // Поэтому используем title из frontmatter, а body отдаём как blocks-only.
  const md = stripFirstH1IfDuplicate(draft.body, draft.title);
  const { blocks } = markdownToEditorJs(md);

  console.log(`[cli] converted to ${blocks.length} Editor.js blocks`);

  // Enqueue.
  const enqResp = await fetch(`${BRIDGE_URL}/queue/enqueue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: draft.title,
      blocks,
      cover_path: draft.cover,
      category: draft.category,
      tags: draft.tags,
    }),
  });
  if (!enqResp.ok) {
    console.error(`[cli] enqueue failed: ${enqResp.status} ${await enqResp.text()}`);
    process.exit(1);
  }
  const { taskId } = (await enqResp.json()) as { taskId: string };
  console.log(`[cli] enqueued taskId=${taskId}`);
  console.log('[cli] open Chrome popup vc.ru Publisher → нажми "Опубликовать следующее"');
  console.log('[cli] (или включи Авто-polling и подожди до 30 сек)');

  // Poll result.
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const rRes = await fetch(`${BRIDGE_URL}/result/${taskId}`).catch(() => null);
    if (rRes === null) {
      console.log('[cli] bridge unreachable, retry...');
      continue;
    }
    if (!rRes.ok) {
      console.error(`[cli] result poll: ${rRes.status}`);
      continue;
    }
    const data = (await rRes.json()) as {
      status: 'pending' | 'success' | 'error';
      url?: string;
      error?: string;
    };
    if (data.status === 'pending') {
      const elapsed = Math.round((TIMEOUT_MS - (deadline - Date.now())) / 1000);
      console.log(`[cli] pending (${elapsed}s elapsed)...`);
      continue;
    }
    if (data.status === 'success') {
      console.log(`[cli] ✓ published: ${data.url}`);
      process.exit(0);
    }
    if (data.status === 'error') {
      console.error(`[cli] ✗ failed: ${data.error}`);
      process.exit(2);
    }
  }
  console.error('[cli] timeout 10 минут - extension не вернул result');
  process.exit(3);
}

function stripFirstH1IfDuplicate(body: string, title: string): string {
  // Если body начинается с # <title> - снимаем (вызовет дубликат при render).
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('[cli] fatal:', err);
  process.exit(1);
});
