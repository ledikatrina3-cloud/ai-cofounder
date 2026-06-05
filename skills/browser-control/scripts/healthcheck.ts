// browser-control health-check.
//
// Smoke-тест: проверяет что директория профилей резолвится для дефолтной
// связки (vc, main). Эмитит JSON последней строкой stdout:
//   {status: 'ok'|'failed', profilePath: string, preexisted: boolean, errors: []}
//
// Это placeholder Фазы 2 — полноценный DOM-check (открыть vc.ru, проверить
// селекторы редактора) появится в Фазе 7 плана 2026-05-21-skills-architecture-v3.

import { resolveProfile } from '../../../src/browser/profiles.js';

interface Output {
  status: 'ok' | 'failed';
  profilePath?: string;
  preexisted?: boolean;
  errors: string[];
}

function emit(out: Output): void {
  console.log(JSON.stringify(out));
}

async function main(): Promise<void> {
  try {
    const loc = await resolveProfile('vc', 'main');
    emit({
      status: 'ok',
      profilePath: loc.path,
      preexisted: loc.preexisted,
      errors: [],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({ status: 'failed', errors: [`resolveProfile: ${msg}`] });
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  emit({ status: 'failed', errors: [`uncaught: ${msg}`] });
  process.exit(1);
});
