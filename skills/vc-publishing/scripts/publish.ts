// vc-publishing skill — тонкая обёртка над `src/publish/vc.ts`.
//
// Контракт (Фаза 2 плана 2026-05-21-skills-architecture-v3, п.6):
//   * Принимает arg <draft-path> + опциональный --account=<name> + --yes.
//   * Загружает draft через `src/publish/loader.ts` (не дублируя логику).
//   * Вызывает `publishToVc` из `src/publish/vc.ts`.
//   * Печатает последней строкой stdout JSON:
//       {status: 'ok'|'failed', url: string|null, draftPath: string, errors: string[]}
//
// Это НЕ замена `pnpm publish vc` (он остаётся рабочим). Это
// machine-callable интерфейс для routine-LLM: одна команда → один JSON.
//
// LLM-вызовы внутри скрипта запрещены (anti-goal #5 из плана). Скрипт —
// детерминированная кнопка, решения принимает routine между вызовами.

import { loadDraft } from '../../../src/publish/loader.js';
import { type PublishPreview, publishToVc } from '../../../src/publish/vc.js';

interface Output {
  status: 'ok' | 'failed';
  url: string | null;
  draftPath: string;
  errors: string[];
}

function parseArgs(argv: string[]): {
  draftPath: string | null;
  account: string | null;
  yes: boolean;
  keepOpen: boolean;
} {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flags = argv.filter((a) => a.startsWith('--'));
  const draftPath = positional[0] ?? null;
  const accountFlag = flags.find((f) => f.startsWith('--account='));
  const account = accountFlag !== undefined ? accountFlag.slice('--account='.length) : null;
  const yes = flags.includes('--yes');
  const keepOpen = flags.includes('--keep-open');
  return { draftPath, account, yes, keepOpen };
}

function emit(out: Output): void {
  // Финальная строка stdout — машинно-читаемый JSON. Любой пред-вывод (логи)
  // идёт через console.error, чтобы парсер последней строки stdout не сбивался.
  console.log(JSON.stringify(out));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.draftPath === null) {
    emit({
      status: 'failed',
      url: null,
      draftPath: '',
      errors: ['нет аргумента <draft-path>'],
    });
    process.exit(1);
  }

  let draft: Awaited<ReturnType<typeof loadDraft>>;
  try {
    draft = await loadDraft(args.draftPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({
      status: 'failed',
      url: null,
      draftPath: args.draftPath,
      errors: [`loadDraft: ${msg}`],
    });
    process.exit(1);
    return;
  }

  // account-override: если передали --account, перезаписываем в draft.
  if (args.account !== null && args.account !== '') {
    draft = { ...draft, account: args.account };
  }

  const confirm = async (preview: PublishPreview): Promise<boolean> => {
    if (args.yes) return true;
    // Без --yes отказываем — interactive prompt в LLM-вызове неприменим.
    console.error(
      `skill:vc-publishing: confirm требует --yes (preview title='${preview.title}', account='${preview.account}').`,
    );
    return false;
  };

  try {
    const result = await publishToVc(draft, { confirm, keepOpen: args.keepOpen });
    emit({
      status: 'ok',
      url: result.url,
      draftPath: draft.filePath,
      errors: [],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({
      status: 'failed',
      url: null,
      draftPath: draft.filePath,
      errors: [msg],
    });
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  // Защитная сетка — обычно main() сам обрабатывает ошибки и эмитит JSON.
  const msg = err instanceof Error ? err.message : String(err);
  emit({ status: 'failed', url: null, draftPath: '', errors: [`uncaught: ${msg}`] });
  process.exit(1);
});
