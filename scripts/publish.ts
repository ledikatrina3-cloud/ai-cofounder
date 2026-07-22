// CLI публикатор. Универсальный entry-point для всех platform-publishers.
//
// Использование:
//   pnpm publish <platform> <путь-к-черновику.md> [--yes]
//   pnpm publish vc content/drafts/vc/today.md
//   pnpm publish vc content/drafts/vc/today.md --yes   # auto-approve
//
// Без `--yes` спрашивает confirm в stdin перед клика «Опубликовать».

import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { loadDraft } from '../src/publish/loader.js';
import type { PublishResult } from '../src/publish/types.js';
import { type PublishPreview, publishToVc } from '../src/publish/vc.js';

type Publisher = (
  draft: Awaited<ReturnType<typeof loadDraft>>,
  opts: { confirm: (preview: PublishPreview) => Promise<boolean> },
) => Promise<PublishResult>;

const PUBLISHERS: Record<string, Publisher> = {
  vc: (draft, opts) => publishToVc(draft, opts),
};

async function askConfirm(preview: PublishPreview): Promise<boolean> {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Готов опубликовать:');
  console.log(`    title:     ${preview.title}`);
  console.log(`    account:   ${preview.account}`);
  console.log(`    tags:      ${preview.tags.join(', ') || '(нет)'}`);
  console.log(`    preview:   ${preview.bodyPreview.slice(0, 120)}…`);
  console.log(`    скриншот:  ${preview.editorScreenshotPath}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question('Опубликовать? [y/N] ')).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

async function main(): Promise<void> {
  const platform = process.argv[2];
  const draftPath = process.argv[3];
  const autoApprove = process.argv.includes('--yes');

  if (platform === undefined || draftPath === undefined) {
    console.error('Использование: pnpm publish <platform> <draft.md> [--yes]');
    console.error(`Платформы: ${Object.keys(PUBLISHERS).join(', ')}`);
    process.exit(1);
  }

  const publisher = PUBLISHERS[platform];
  if (publisher === undefined) {
    console.error(`Неизвестная платформа: '${platform}'`);
    console.error(`Доступно: ${Object.keys(PUBLISHERS).join(', ')}`);
    process.exit(1);
  }

  console.log(`▶ читаю черновик ${draftPath}…`);
  const draft = await loadDraft(draftPath);
  if (draft.platform !== platform) {
    console.error(
      `черновик лежит в директории platform='${draft.platform}', а CLI запрошен для '${platform}'. Переложи файл или поправь команду.`,
    );
    process.exit(1);
  }
  console.log(`  title:   ${draft.title}`);
  console.log(`  status:  ${draft.status}`);
  console.log(`  account: ${draft.account}`);
  console.log(`  tags:    ${draft.tags.join(', ') || '(нет)'}`);
  console.log('');

  const confirm = autoApprove
    ? async (_p: PublishPreview): Promise<boolean> => {
        console.log('  [--yes] approve автоматический, не спрашиваю.');
        return true;
      }
    : askConfirm;

  console.log(`▶ запускаю publisher для ${platform}…`);
  const result = await publisher(draft, { confirm });

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (result.url !== null) {
    console.log('✓ опубликовано:');
    console.log(`    URL:        ${result.url}`);
  } else {
    console.log('⚠ публикация завершилась без URL (возможно модерация или ошибка)');
  }
  console.log(`    скриншот:   ${result.screenshotPath}`);
  console.log(`    duration:   ${result.durationMs}ms`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch((err: unknown) => {
  console.error('Ошибка:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack !== undefined) {
    const stackLines = err.stack.split('\n').slice(0, 5).join('\n');
    console.error(stackLines);
  }
  process.exit(1);
});
