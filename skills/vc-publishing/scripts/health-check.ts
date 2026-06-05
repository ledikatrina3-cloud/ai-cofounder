// vc-publishing health-check.
//
// Существ-проверка vc.ru editor'а: открывает https://vc.ru/new в браузере
// (через persistent profile или anonymous, см. ниже), ждёт загрузку,
// проверяет наличие ключевых селекторов редактора (title, content,
// publish button). НЕ ПУБЛИКУЕТ.
//
// Эмитит JSON последней строкой stdout:
//   {status: 'ok' | 'failed', mode: 'authed' | 'anon', selectors: {...},
//    sessionOk?: boolean, errors: string[]}
//
// Режимы:
//   * По умолчанию — anonymous (не использует профиль). Проверяет что
//     vc.ru/new загружается и базовые DOM-селекторы на месте. Это всё,
//     что нужно для smoke-теста: если vc.ru сменил HTML — мы это сразу
//     увидим.
//   * --check-session — открывает с persistent профилем 'vc/main' и
//     дополнительно проверяет, что сессия живая (по наличию аватара
//     профиля). Если профиля нет — переключается на anonymous и
//     помечает sessionOk=false без error'а.
//
// Никаких реальных паролей/cookies здесь нет: даже в --check-session
// мы лишь ПРОВЕРЯЕМ что профиль на месте; никаких credentials в коде.
// `pnpm browser:login vc main` создаётся фаундером отдельно.
//
// Fallback на fetch+cheerio: если patchright недоступен (например,
// `npx playwright install` ещё не отрабатывал), пробуем fetch GET vc.ru/new
// и smoke-check'аем что страница 200 + содержит ключевые слова. Это
// неполный чек, но лучше чем «процесс падает с ENOMODULE».

import { setTimeout as sleep } from 'node:timers/promises';

const VC_NEW_URL = 'https://vc.ru/new';
const SELECTORS = {
  // Эти значения подобраны на 2026-05; vc.ru держит их стабильно последние
  // полгода. При смене разметки health-check сразу сигналит failed —
  // это и есть цель smoke-теста.
  titleArea: 'h1[contenteditable="true"], textarea[placeholder*="Заголовок"]',
  contentArea: '[contenteditable="true"]',
  publishButton: 'button:has-text("Опубликовать"), [aria-label*="Опубликовать"]',
  profileAvatar: '[aria-label*="Аккаунт"], [class*="avatar"]',
};

interface CheckResult {
  status: 'ok' | 'failed';
  mode: 'authed' | 'anon' | 'fetch-fallback';
  selectors?: {
    titleArea: boolean;
    contentArea: boolean;
    publishButton: boolean;
  };
  sessionOk?: boolean;
  httpStatus?: number;
  errors: string[];
}

function emit(result: CheckResult): void {
  console.log(JSON.stringify(result));
}

async function runWithPlaywright(checkSession: boolean): Promise<CheckResult | null> {
  // patchright — наш wrapper над playwright. Если его нет — возвращаем null,
  // fallback в main подхватит.
  let openSession: typeof import('../../../src/browser/session.js').openSession;
  try {
    const mod = await import('../../../src/browser/session.js');
    openSession = mod.openSession;
  } catch {
    return null;
  }

  // ANON режим — НЕ используем persistent профиль (вообще даже не резолвим
  // его, чтобы health-check не упирался в первый запуск). Просто открываем
  // patchright с временным userDataDir.
  //
  // AUTHED режим — пробуем профиль 'vc/main' (если фаундер логинился через
  // `pnpm browser:login`). Если профиля нет — этого мало для failed:
  // авто-фоллбэк на anon с sessionOk=false.

  const useAuthed = checkSession;

  try {
    const session = await openSession({
      platform: 'vc',
      account: 'main',
      headless: true,
      requireExistingProfile: useAuthed,
    });
    try {
      const page = session.page;
      await page.goto(VC_NEW_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      // даём редактору смонтироваться
      await sleep(2_000);

      // Перебираем selector'ы: title/content/publish.
      const [hasTitle, hasContent, hasPublish, hasAvatar] = await Promise.all([
        page
          .locator(SELECTORS.titleArea)
          .first()
          .count()
          .then((n) => n > 0)
          .catch(() => false),
        page
          .locator(SELECTORS.contentArea)
          .first()
          .count()
          .then((n) => n > 0)
          .catch(() => false),
        page
          .locator(SELECTORS.publishButton)
          .first()
          .count()
          .then((n) => n > 0)
          .catch(() => false),
        page
          .locator(SELECTORS.profileAvatar)
          .first()
          .count()
          .then((n) => n > 0)
          .catch(() => false),
      ]);

      const errors: string[] = [];
      if (!hasTitle) errors.push('selector titleArea not found');
      if (!hasContent) errors.push('selector contentArea not found');
      // publishButton доступен только авторизованному; в anon-режиме его
      // нет (vc.ru скрывает редактор за логином). Поэтому не валим
      // failed из-за этого — просто помечаем.
      const publishExpected = useAuthed && hasAvatar;
      if (publishExpected && !hasPublish) {
        errors.push('selector publishButton not found (session may be expired)');
      }

      const result: CheckResult = {
        status: errors.length === 0 ? 'ok' : 'failed',
        mode: useAuthed ? 'authed' : 'anon',
        selectors: {
          titleArea: hasTitle,
          contentArea: hasContent,
          publishButton: hasPublish,
        },
        errors,
      };
      if (useAuthed) result.sessionOk = hasAvatar;
      return result;
    } finally {
      await session.close();
    }
  } catch (err) {
    // Если useAuthed=true и профиля нет — `requireExistingProfile` бросит
    // BrowserSessionError. Делаем graceful: пробуем anon-проверку,
    // помечаем sessionOk=false.
    if (useAuthed) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('профиль для vc/main не создан')) {
        const anonResult = await runWithPlaywright(false);
        if (anonResult !== null) {
          anonResult.sessionOk = false;
          anonResult.errors.push('profile vc/main missing: run `pnpm browser:login vc main`');
          // Сохраняем mode=anon, чтобы наблюдатель видел что сессии не было.
          return anonResult;
        }
      }
    }
    return {
      status: 'failed',
      mode: useAuthed ? 'authed' : 'anon',
      errors: [`playwright error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

async function runWithFetch(): Promise<CheckResult> {
  // Fallback: fetch vc.ru/new напрямую, проверяем что HTTP 200 и в HTML есть
  // знакомые маркеры. Это сильно слабее, чем DOM-чек, но лучше чем nothing.
  try {
    const res = await fetch(VC_NEW_URL, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    const httpStatus = res.status;
    if (httpStatus >= 500) {
      return {
        status: 'failed',
        mode: 'fetch-fallback',
        httpStatus,
        errors: [`vc.ru вернул ${httpStatus}`],
      };
    }
    const html = await res.text();
    // Грубые маркеры: упоминание vc.ru, наличие meta og:site_name или
    // следов editor (script tag с "/editor/").
    const hasVcMark =
      html.includes('vc.ru') || html.includes('vcru') || html.toLowerCase().includes('заголовок');
    if (!hasVcMark) {
      return {
        status: 'failed',
        mode: 'fetch-fallback',
        httpStatus,
        errors: ['HTML без vc.ru-маркеров (возможно blocked/гайды поменялись)'],
      };
    }
    return {
      status: 'ok',
      mode: 'fetch-fallback',
      httpStatus,
      errors: [],
    };
  } catch (err) {
    return {
      status: 'failed',
      mode: 'fetch-fallback',
      errors: [`fetch failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

async function main(): Promise<void> {
  const checkSession = process.argv.includes('--check-session');

  const pw = await runWithPlaywright(checkSession);
  if (pw !== null) {
    emit(pw);
    if (pw.status === 'failed') process.exit(1);
    return;
  }

  // Playwright недоступен — fallback на fetch.
  const fb = await runWithFetch();
  emit(fb);
  if (fb.status === 'failed') process.exit(1);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  emit({
    status: 'failed',
    mode: 'anon',
    errors: [`uncaught: ${msg}`],
  });
  process.exit(1);
});
