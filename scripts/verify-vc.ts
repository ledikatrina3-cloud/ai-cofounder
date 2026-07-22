// Проверка авторизации на vc.ru через persistent profile.
//
// Что делает:
//   1. Открывает Chromium с профилем vc/main (создаёт если нет).
//   2. Идёт на https://vc.ru/<твой-handle> (env VC_PROFILE_HANDLE) — твою страницу.
//   3. Каждые 3 секунды проверяет: видна ли кнопка «Написать» в шапке
//      (это самый надёжный признак «залогинен»).
//   4. Если не залогинен — ждёт до 5 минут, пока ты руками не залогинишься
//      в открытом окне.
//   5. Когда видит «Написать» → даёт «зелёный» отчёт, делает скриншот,
//      закрывает браузер (это сохраняет cookies в profile дир — следующие
//      запуски маркетолога будут уже авторизованы).
//
// Не публикует ничего. Чистая проверка «можем ли мы публиковать в будущем».

import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'patchright';
import { openSession } from '../src/browser/session.js';

const VC_PROFILE_HANDLE = process.env.VC_PROFILE_HANDLE ?? 'example';
const VC_PROFILE_URL = `https://vc.ru/${VC_PROFILE_HANDLE}`;
const POLL_INTERVAL_MS = 3_000;
const MAX_WAIT_MS = 5 * 60 * 1000;

interface AuthVerdict {
  loggedIn: boolean;
  url: string;
  title: string;
  loginButtonVisible: boolean;
  hasAuthCookie: boolean;
  authCookieNames: string[];
}

// Имена cookies которые vc.ru/osnova ставит ТОЛЬКО для авторизованных
// пользователей. Если хотя бы одна такая есть → залогинен. Если нет, но
// «Войти» не видим → подозрительно (возможно vc.ru поменял name), смотрим
// глазами на скриншот.
const AUTH_COOKIE_PATTERNS = [/^osnova-remember$/i, /^auth/i, /^token/i, /session/i, /^jwt/i];

async function checkAuth(page: Page): Promise<AuthVerdict> {
  const url = page.url();
  const title = await page.title().catch(() => '');

  // Сигнал 1: видна ли кнопка «Войти». Видна → анонимный. Не видна →
  // вероятно залогинен (но проверим и куки).
  const loginBtn = page
    .getByRole('link', { name: /^Войти$/i })
    .or(page.getByRole('button', { name: /^Войти$/i }))
    .first();
  const loginButtonVisible = await loginBtn.isVisible({ timeout: 500 }).catch(() => false);

  // Сигнал 2: какие cookies стоят в браузере для vc.ru — ищем auth-like.
  const cookies = await page.context().cookies();
  const vcCookies = cookies.filter(
    (c) => c.domain.includes('vc.ru') || c.domain.includes('osnova'),
  );
  const authCookies = vcCookies.filter((c) => AUTH_COOKIE_PATTERNS.some((re) => re.test(c.name)));
  const hasAuthCookie = authCookies.length > 0;
  const authCookieNames = authCookies.map((c) => c.name);

  // Считаем залогиненным только если ОБА сигнала совпадают: «Войти» не видна
  // И есть какая-то auth-cookie. Это строже предыдущей версии.
  return {
    loggedIn: !loginButtonVisible && hasAuthCookie,
    url,
    title,
    loginButtonVisible,
    hasAuthCookie,
    authCookieNames,
  };
}

async function main(): Promise<void> {
  console.log(`▶ открываю ${VC_PROFILE_URL} с profile vc/main…`);
  const session = await openSession({
    platform: 'vc',
    account: 'main',
    headless: false,
  });

  console.log(`  профиль:    ${session.profile.path}`);
  console.log(`  preexisted: ${session.profile.preexisted}`);
  console.log('');

  await session.page
    .goto(VC_PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    .catch((err: unknown) => {
      console.error('  goto упал:', err instanceof Error ? err.message : err);
    });

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Если ещё не залогинен — залогинься в открывшемся окне.');
  console.log('  Я каждые 3 сек проверяю состояние.');
  console.log(`  Макс ожидание: ${MAX_WAIT_MS / 60_000} минут.`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  const deadline = Date.now() + MAX_WAIT_MS;
  let verdict = await checkAuth(session.page);
  let pollCount = 0;

  while (!verdict.loggedIn && Date.now() < deadline) {
    pollCount += 1;
    const urlShort = verdict.url.length > 70 ? `${verdict.url.slice(0, 70)}…` : verdict.url;
    console.log(
      `  poll #${pollCount}: loginBtn=${verdict.loginButtonVisible} authCookie=${verdict.hasAuthCookie} url=${urlShort}`,
    );
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    verdict = await checkAuth(session.page);
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (verdict.loggedIn) {
    console.log('✅ АВТОРИЗОВАН на vc.ru (оба сигнала совпали)');
    console.log(`   URL:                ${verdict.url}`);
    console.log(`   title:              ${verdict.title}`);
    console.log('   «Войти» видна:      нет (= залогинен)');
    console.log(`   auth-cookies:       ${verdict.authCookieNames.join(', ')}`);
  } else {
    console.log('❌ НЕ АВТОРИЗОВАН');
    console.log(`   URL:                ${verdict.url}`);
    console.log(`   title:              ${verdict.title}`);
    console.log(
      `   «Войти» видна:      ${verdict.loginButtonVisible ? 'да (анонимная сессия)' : 'нет'}`,
    );
    console.log(
      `   auth-cookies:       ${verdict.authCookieNames.length > 0 ? verdict.authCookieNames.join(', ') : 'нет — нужно залогиниться'}`,
    );
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const screenshotsDir = join(tmpdir(), 'ai-cofounder-verify');
  await mkdir(screenshotsDir, { recursive: true });
  const screenshotPath = join(screenshotsDir, `vc-${Date.now()}.png`);
  await session.page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {
    // скриншот опционален
  });
  console.log(`   скриншот:         ${screenshotPath}`);

  console.log('');
  console.log('закрываю окно через 3 сек (cookies сохранятся в профиле)…');
  await new Promise((r) => setTimeout(r, 3_000));
  await session.close();
}

main().catch((err: unknown) => {
  console.error('Ошибка verify-vc:', err instanceof Error ? err.message : err);
  process.exit(1);
});
