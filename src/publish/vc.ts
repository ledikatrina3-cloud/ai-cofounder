// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE ADAPTER (не ядро движка). Пример внешнего паблишер-адаптера под
// vc.ru/Osnova. Дефолт AI-Cofounder — self-contained вывод в content/; этот
// адаптер опционален и активируется только через agents/<id>/target.yml.
// ─────────────────────────────────────────────────────────────────────────────
// vc.ru publisher (v2 — Hybrid HTML paste + cover + category + tags).
//
// Контракт `publishToVc(draft, opts)`:
//   1. Открывает persistent-сессию vc/<account>.
//   2. Идёт на https://vc.ru/, проверяет login.
//   3. Кликает «Написать» — editor.
//   4. Загружает cover (если draft.cover задан) — fileChooser/setInputFiles.
//   5. Вводит title.
//   6. Вставляет body:
//        * если draft.htmlBody != null → DataTransfer paste с text/html
//          (ProseMirror vc.ru-редактора сохраняет H2/strong/a/ul/blockquote).
//        * иначе → fallback на построчный type (старая логика).
//   7. confirm callback (preview screenshot перед клик'ом).
//   8. Клик «Опубликовать» — открывается modal настроек публикации.
//   9. Внутри modal'а:
//        * категория (Сообщество) — если draft.category задана
//        * теги — если draft.tags непустые
//        * финальная кнопка «Опубликовать»
//  10. Ждём редирект на URL поста.
//
// Принцип graceful-fail: шаги cover/category/tags/paste-html ловятся индивидуально.
// Если конкретный шаг не нашёл DOM — пишем warning в console.error и идём дальше
// БЕЗ падения. Лучше публикация без обложки чем не публикация вообще. Падаем
// только на critical steps: auth, click-write, fill-title, click-publish, redirect.
//
// vc.ru DOM фрагилен (хешированные React-классы, поменяется через 2-3 мес).
// Селекторы — role/text/placeholder/aria-label с fallback'ом. При поломке —
// обновлять этот файл и Update artifacts в /tmp/vc-publish-debug/.

import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserSession, openSession } from '../browser/session.js';
import { type Draft, PublishError, type PublishResult } from './types.js';

const VC_HOME = 'https://vc.ru/';
const PUBLISH_TIMEOUT_MS = 60_000;
const SHORT_TIMEOUT_MS = 8_000;

export interface PublishToVcOptions {
  /** Callback approve — вернёт true для публикации, false для отмены. */
  confirm: (preview: PublishPreview) => Promise<boolean>;
  /** Видимое окно. Default true (рекомендуется для соцсетей). */
  headless?: boolean;
  /** Override корня профилей (для тестов). */
  profileRootDir?: string;
  /** Куда складывать скриншоты (default: `os.tmpdir()/ai-cofounder-publish/`). */
  screenshotsDir?: string;
  /** DI для тестов: подменить openSession. */
  openSessionFn?: typeof openSession;
  /**
   * Keep-open mode: после полной подготовки статьи (cover/category/body) НЕ
   * пытаемся click «Опубликовать» (vc.ru anti-bot блокирует synthetic clicks)
   * — оставляем окно открытым на 10 минут, чтобы фаундер руками нажал
   * «Опубликовать» в готовом composer'е. Потом ловим URL поста.
   */
  keepOpen?: boolean;
}

export interface PublishPreview {
  title: string;
  bodyPreview: string;
  tags: string[];
  account: string;
  cover: string | null;
  category: string | null;
  hasHtmlBody: boolean;
  /** Скриншот editor'а ПОСЛЕ заполнения, ДО клика Опубликовать. */
  editorScreenshotPath: string;
}

export async function publishToVc(draft: Draft, opts: PublishToVcOptions): Promise<PublishResult> {
  if (draft.platform !== 'vc') {
    throw new PublishError(
      'vc',
      'precondition',
      `ожидался platform=vc, получено '${draft.platform}'`,
    );
  }
  if (draft.status !== 'ready') {
    throw new PublishError(
      'vc',
      'precondition',
      `черновик не готов: status='${draft.status}' (нужно 'ready')`,
    );
  }

  const startTs = Date.now();
  const screenshotsDir = opts.screenshotsDir ?? join(tmpdir(), 'ai-cofounder-publish');
  await mkdir(screenshotsDir, { recursive: true });

  const open = opts.openSessionFn ?? openSession;
  const sessionOpts: Parameters<typeof openSession>[0] = {
    platform: 'vc',
    account: draft.account,
    headless: opts.headless ?? false,
    requireExistingProfile: true,
  };
  if (opts.profileRootDir !== undefined) sessionOpts.profileRootDir = opts.profileRootDir;
  const session = await open(sessionOpts);

  try {
    return await runPublishFlow(session, draft, opts, screenshotsDir, startTs);
  } finally {
    await session.close();
  }
}

async function runPublishFlow(
  session: BrowserSession,
  draft: Draft,
  opts: PublishToVcOptions,
  screenshotsDir: string,
  startTs: number,
): Promise<PublishResult> {
  const { page } = session;
  const t = PUBLISH_TIMEOUT_MS;

  // ── 0. Anti-bot mask: затираем navigator.webdriver, мокаем Notification
  //       и navigator.permissions — типичные fingerprint-checks. Делается
  //       через CDP до первой навигации, чтобы patch применился ко всем
  //       последующим документам.
  await page
    .addInitScript(() => {
      // biome-ignore lint/suspicious/noExplicitAny: browser
      const g = globalThis as any;
      Object.defineProperty(g.navigator, 'webdriver', { get: () => undefined });
      // chrome-app object — Headless detection wants this absent.
      if (!g.chrome) g.chrome = { runtime: {} };
      // Permissions API: некоторые сайты вызывают navigator.permissions.query
      // и проверяют что Notification.permission === 'denied' (bot) vs 'default'.
      if (g.navigator.permissions?.query) {
        const orig = g.navigator.permissions.query;
        g.navigator.permissions.query = (p: { name: string }) =>
          p.name === 'notifications'
            ? Promise.resolve({ state: g.Notification?.permission ?? 'default' })
            : orig.call(g.navigator.permissions, p);
      }
    })
    .catch(() => {});

  // ── 1. Главная + auth check ────────────────────────────────────────────
  await page.goto(VC_HOME, { waitUntil: 'domcontentloaded', timeout: t }).catch((err) => {
    throw new PublishError('vc', 'goto-home', formatErr(err));
  });
  if (/\/(login|auth|signin)/i.test(page.url())) {
    throw new PublishError(
      'vc',
      'auth',
      `редирект на ${page.url()} — сессия истекла. Запусти: pnpm browser:login vc ${draft.account}`,
    );
  }

  // ── 2. Клик «Написать» → editor ────────────────────────────────────────
  const writeButton = page
    .getByRole('link', { name: /^Написать$/i })
    .or(page.getByRole('button', { name: /^Написать$/i }))
    .first();
  await writeButton.click({ timeout: t }).catch((err) => {
    throw new PublishError(
      'vc',
      'click-write',
      `не нашёл кнопку «Написать» (возможно не залогинены или DOM изменился): ${formatErr(err)}`,
    );
  });
  await page.waitForURL(/\/(write|editor|new)/, { timeout: t }).catch(() => {
    // Иногда vc.ru открывает редактор без URL change — терпим.
  });

  // ── 3-5. Editor.js (CodeX): один contenteditable для всего.
  //         Порядок (важно для vc.ru — обложка должна быть первым блоком):
  //         1) click editor → focus
  //         2) drag-drop cover (создаёт image-block первым)
  //         3) paste HTML body (text-блоки идут ниже image)
  const editorField = page.locator('.editor-tool-input[contenteditable="true"]').first();
  await editorField.click({ timeout: t }).catch((err) => {
    throw new PublishError('vc', 'focus-editor', formatErr(err));
  });

  // Cover СНАЧАЛА — становится image-block #1 = обложка vc.ru.
  // КРИТИЧНО: drag-drop через DataTransfer создаёт image-block с blob:// URL
  // (локальный preview). Editor.js Image-plugin асинхронно делает upload на
  // vc.ru CDN. До этого момента vc.ru блокирует publish (image src должен быть
  // https://, не blob://). Поэтому после drag-drop ждём в DOM пока появится
  // <img src="https://..."> в редакторе.
  if (draft.cover !== null) {
    try {
      await uploadCover(session, draft.cover);
      console.error('[vc-publish] cover drag-drop fired, waiting for server upload...');
      // Ждём появления img с https:// src внутри composer (max 30s).
      const uploaded = await page
        .waitForFunction(
          () => {
            // biome-ignore lint/suspicious/noExplicitAny: browser
            const g = globalThis as any;
            const imgs = Array.from(
              g.document.querySelectorAll('.modal-fullpage img, .ce-block img'),
            );
            // biome-ignore lint/suspicious/noExplicitAny: browser
            return (imgs as any[]).some((i) => {
              const src = i.getAttribute('src') || i.currentSrc || '';
              return src.startsWith('http') && !src.includes('blob:');
            });
          },
          { timeout: 30_000, polling: 500 },
        )
        .then(() => true)
        .catch(() => false);
      if (uploaded) {
        console.error('[vc-publish] cover uploaded to vc.ru CDN ✓');
      } else {
        console.error(
          '[vc-publish] cover upload TIMEOUT — blob:// stays, vc.ru will block publish',
        );
      }
    } catch (err) {
      console.error(`[vc-publish] cover upload skipped: ${formatErr(err)}`);
    }
  }

  // Заново находим body-input (контент vc.ru мог перерисоваться). В full
  // editor mode body — это `.editor-tool-input` после image-block. Берём
  // последний contenteditable, потому что image-блок не contenteditable.
  const bodyInputs = page.locator('[contenteditable="true"]');
  const bodyInputCount = await bodyInputs.count().catch(() => 0);
  if (bodyInputCount > 0) {
    await bodyInputs
      .last()
      .click({ timeout: SHORT_TIMEOUT_MS })
      .catch(() => {});
  }

  // Затем paste body.
  let payloadHtml: string;
  if (draft.htmlBody !== null) {
    payloadHtml = ensureH1(draft.htmlBody, draft.title);
  } else {
    payloadHtml = `<h1>${escapeHtml(draft.title)}</h1>\n${markdownLikeToHtml(draft.body)}`;
  }
  const pasted = await pasteHtmlIntoEditor(session, payloadHtml).catch((err) => {
    console.error(`[vc-publish] HTML paste failed: ${formatErr(err)}`);
    return false;
  });
  if (!pasted) {
    await page.keyboard.type(draft.title, { delay: 8 });
    await page.keyboard.press('Enter');
    await typeBodyPlainText(session, draft.body);
  }

  // Editor screenshot — фиксирует состояние перед publish.
  const editorScreenshotPath = join(screenshotsDir, `vc-${draft.account}-${startTs}-editor.png`);
  await page.screenshot({ path: editorScreenshotPath, fullPage: true }).catch(() => {});

  const bodyPreview = (draft.htmlBody ?? draft.body).slice(0, 280).replace(/<[^>]+>/g, '');
  const approved = await opts.confirm({
    title: draft.title,
    bodyPreview,
    tags: draft.tags,
    account: draft.account,
    cover: draft.cover,
    category: draft.category,
    hasHtmlBody: draft.htmlBody !== null,
    editorScreenshotPath,
  });
  if (!approved) {
    throw new PublishError('vc', 'approval', 'фаундер отменил публикацию');
  }

  // ── 8. Выбор Сообщества ПЕРЕД click publish (критично для vc.ru!) ────
  //       Без выбранной темы кнопка «Опубликовать» silently игнорит click
  //       (vc.ru блокирует «Без темы» → Личный блог = виральность 0).
  //       Селектор Сообщества — DIV/SPAN с текстом «Без темы» в шапке
  //       modal-fullpage'а composer'а.
  if (draft.category !== null) {
    try {
      await selectCategory(session, draft.category);
      console.error(`[vc-publish] category selected: ${draft.category}`);
    } catch (err) {
      console.error(`[vc-publish] category select FAILED: ${formatErr(err)}`);
    }
  }

  // ── 9. Ждём «Сохранено ✓» — vc.ru подтвердил autosave на сервер. Без
  //       этого publish-click игнорируется (статья считается "грязной").
  await page
    .locator('.modal-fullpage')
    .getByText(/^Сохранено$/i)
    .first()
    .waitFor({ timeout: 15_000, state: 'visible' })
    .catch(() => {
      console.error('[vc-publish] "Сохранено" не дождались — пробуем publish всё равно');
    });
  await page.waitForTimeout(800);

  // ── 10a. KEEP-OPEN: если флаг включён — НЕ кликаем publish. vc.ru anti-bot
  //         блокирует synthetic clicks (подтверждено v8: все 3 стратегии
  //         отработали, modal не закрылся). Альтернатива — оставляем окно
  //         на 10 минут, фаундер сам кликает «Опубликовать» в готовом
  //         composer (всё подготовлено: cover, тема, body). Ловим URL.
  if (opts.keepOpen === true) {
    console.error(
      '[vc-publish] KEEP-OPEN: всё подготовлено — нажми «Опубликовать» в окне patchright. Жду URL до 10 минут...',
    );
    // Ждём пока URL изменится на пост (содержит число / id).
    let publishedUrl: string | null = null;
    try {
      await page.waitForURL(
        (url) => {
          const s = url.toString();
          if (/\/(write|editor|new|modal=editor)/.test(s)) return false;
          return /\/\d+/.test(s);
        },
        { timeout: 600_000 }, // 10 минут
      );
      publishedUrl = page.url();
      console.error(`[vc-publish] DETECTED PUBLISH! URL=${publishedUrl}`);
    } catch {
      console.error('[vc-publish] keep-open timeout — статья не опубликована за 10 мин');
    }

    const ssPath = join(screenshotsDir, `vc-${draft.account}-${startTs}-keep-open-result.png`);
    await page.screenshot({ path: ssPath, fullPage: false }).catch(() => {});

    return {
      url: publishedUrl,
      platform: 'vc',
      account: draft.account,
      durationMs: Date.now() - startTs,
      screenshotPath: ssPath,
    };
  }

  // ── 10. Click «Опубликовать» через multi-strategy anti-bot bypass.
  //        vc.ru anti-bot блокирует synthetic clicks с event.isTrusted=false.
  //        Стратегии (по убыванию надёжности):
  //          a) locator.click() БЕЗ force — Playwright делает actionability
  //             checks + scroll into view + использует CDP trusted-input
  //          b) page.mouse.click(x, y) по координатам — CDP raw event
  //          c) keyboard.press('Enter') при focus — keyboard event = trusted
  const publishButton = page
    .locator('button.button--type-primary.button--rounded')
    .filter({ hasText: 'Опубликовать' })
    .first();

  // ── Диагностика: проверяем disabled-state ДО click. Если кнопка disabled —
  //    значит vc.ru сам блокирует publish (нет cover-upload-finished / нет
  //    темы / контент слишком короткий) — click ничего не сделает.
  const btnDiag = await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: browser
    const g = globalThis as any;
    // biome-ignore lint/suspicious/noExplicitAny: browser
    const btn = Array.from(g.document.querySelectorAll('button')).find((b: any) =>
      /^Опубликовать$/i.test(((b.textContent as string) || '').trim()),
    );
    if (!btn) return { found: false };
    // biome-ignore lint/suspicious/noExplicitAny: browser
    const b = btn as any;
    return {
      found: true,
      disabled: b.disabled,
      ariaDisabled: b.getAttribute('aria-disabled'),
      hasPrimary: (b.className || '').includes('--type-primary'),
    };
  });
  console.error(`[vc-publish] publish button state: ${JSON.stringify(btnDiag)}`);
  if (btnDiag.found && btnDiag.disabled === true) {
    console.error(
      '[vc-publish] ⚠ КНОПКА DISABLED — vc.ru блокирует publish. Возможные причины: cover не uploaded на CDN / тема не выбрана / контент короткий. Не пытаюсь click.',
    );
    throw new PublishError(
      'vc',
      'publish-disabled',
      'кнопка «Опубликовать» disabled — vc.ru не разрешает publish (cover blob:// / тема / контент)',
    );
  }

  let clickedSuccessfully = false;

  // Strategy A — trusted click через Playwright actionability.
  try {
    await publishButton.scrollIntoViewIfNeeded({ timeout: 5_000 });
    await publishButton.click({ timeout: 15_000 });
    clickedSuccessfully = true;
    console.error('[vc-publish] click strategy A (locator.click) succeeded');
  } catch (err) {
    console.error(`[vc-publish] strategy A failed: ${formatErr(err)}`);
  }

  // Если первый click был но composer не закрылся за 5с — пробуем strategy B.
  await page.waitForTimeout(5000);
  const composerStillVisible = await page
    .locator('.modal-fullpage')
    .isVisible({ timeout: 1000 })
    .catch(() => false);

  if (composerStillVisible) {
    // Strategy B — human-like mouse trail + CDP raw click.
    //   Идея: vc.ru anti-bot может смотреть на mouse-trail patterns. Делаем
    //   движение через несколько точек с задержками, потом click через CDP
    //   на уровне Input.dispatchMouseEvent (минует Playwright synthetic layer).
    try {
      const box = await publishButton.boundingBox();
      if (box !== null) {
        const targetX = box.x + box.width / 2;
        const targetY = box.y + box.height / 2;
        // Стартовая точка — где-то в правой части окна (имитация смотрел контент).
        const startX = 900;
        const startY = 400;
        // 8 точек по кривой Безье, с realistic accel/decel.
        await page.mouse.move(startX, startY);
        for (let i = 1; i <= 8; i++) {
          const t = i / 8;
          const ease = t * t * (3 - 2 * t); // smoothstep
          const cx = startX + (targetX - startX) * ease + (Math.random() - 0.5) * 4;
          const cy = startY + (targetY - startY) * ease + (Math.random() - 0.5) * 4;
          await page.mouse.move(cx, cy);
          await page.waitForTimeout(40 + Math.random() * 30);
        }
        await page.waitForTimeout(180); // hover-pause перед click

        // CDP raw click — самый низкий уровень input в Chromium.
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: targetX,
          y: targetY,
          button: 'left',
          clickCount: 1,
          buttons: 1,
        });
        await page.waitForTimeout(80 + Math.random() * 40);
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: targetX,
          y: targetY,
          button: 'left',
          clickCount: 1,
          buttons: 0,
        });
        await cdp.detach().catch(() => {});
        console.error('[vc-publish] click strategy B (CDP raw + human-trail) fired');
        clickedSuccessfully = true;
      }
    } catch (err) {
      console.error(`[vc-publish] strategy B failed: ${formatErr(err)}`);
    }
    await page.waitForTimeout(4000);
  }

  // Strategy C — keyboard если modal всё ещё открыт.
  const stillVisible2 = await page
    .locator('.modal-fullpage')
    .isVisible({ timeout: 1000 })
    .catch(() => false);
  if (stillVisible2) {
    try {
      await publishButton.focus({ timeout: 3000 });
      await page.keyboard.press('Enter');
      console.error('[vc-publish] click strategy C (keyboard Enter) fired');
    } catch (err) {
      console.error(`[vc-publish] strategy C failed: ${formatErr(err)}`);
    }
    await page.waitForTimeout(3000);
  }

  if (!clickedSuccessfully) {
    throw new PublishError('vc', 'click-publish', 'все 3 click-стратегии провалились');
  }

  // ── 11. Иногда vc.ru показывает доп. confirm modal с «Опубликовать»
  //        ещё раз. Пробуем второй click — graceful.
  await page
    .locator('button.button--type-primary.button--rounded')
    .filter({ hasText: /Опубликовать|Подтвердить/ })
    .first()
    .click({ timeout: 5_000 })
    .catch(() => {});

  // ── 11a. Если modal всё ещё открыт после ВСЕХ click-стратегий —
  //         vc.ru anti-bot нас перебил. Открываем профиль и ищем нашу
  //         статью среди последних — возможно опубликовалась без redirect.
  const stillStuck = await page
    .locator('.modal-fullpage')
    .isVisible({ timeout: 1000 })
    .catch(() => false);
  if (stillStuck) {
    console.error('[vc-publish] composer всё ещё открыт после всех click — проверяю профиль');
    try {
      await page.goto('https://vc.ru/u/me', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(2500);
      // Ищем заголовок нашей статьи на странице.
      const titleEsc = draft.title.slice(0, 50).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const link = await page.evaluate((pattern: string) => {
        // biome-ignore lint/suspicious/noExplicitAny: browser
        const g = globalThis as any;
        const re = new RegExp(pattern, 'i');
        const links = Array.from(g.document.querySelectorAll('a[href]'));
        // biome-ignore lint/suspicious/noExplicitAny: browser
        for (const a of links as any[]) {
          const text = (a.textContent || '').trim();
          if (re.test(text)) return a.href;
        }
        return null;
      }, titleEsc);
      if (link !== null) {
        console.error(`[vc-publish] FOUND published article: ${link}`);
        const successScreenshotPath = join(
          screenshotsDir,
          `vc-${draft.account}-${startTs}-result.png`,
        );
        await page.screenshot({ path: successScreenshotPath, fullPage: false }).catch(() => {});
        return {
          url: link,
          platform: 'vc',
          account: draft.account,
          durationMs: Date.now() - startTs,
          screenshotPath: successScreenshotPath,
        };
      }
      console.error('[vc-publish] статья НЕ найдена в /u/me — anti-bot заблокировал publish');
    } catch (err) {
      console.error(`[vc-publish] profile check failed: ${formatErr(err)}`);
    }
  }

  // ── 11. Ждём redirect на URL поста ────────────────────────────────────
  let publishedUrl: string | null = null;
  try {
    await page.waitForURL(
      (url) => {
        const s = url.toString();
        if (/\/(write|editor|new)/.test(s)) return false;
        return /\/\d+/.test(s);
      },
      { timeout: t },
    );
    publishedUrl = page.url();
  } catch {
    // Не дождались редиректа — модерация или vc.ru-ошибка. Скриншот ниже покажет.
  }

  const successScreenshotPath = join(screenshotsDir, `vc-${draft.account}-${startTs}-result.png`);
  await page.screenshot({ path: successScreenshotPath, fullPage: false }).catch(() => {});

  return {
    url: publishedUrl,
    platform: 'vc',
    account: draft.account,
    durationMs: Date.now() - startTs,
    screenshotPath: successScreenshotPath,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

async function uploadCover(session: BrowserSession, coverPath: string): Promise<void> {
  const { readFile } = await import('node:fs/promises');
  const { page } = session;

  // Вариант A — найти input[type=file] и setInputFiles напрямую.
  const fileInput = page.locator('input[type="file"]').first();
  if ((await fileInput.count()) > 0) {
    await fileInput.setInputFiles(coverPath, { timeout: SHORT_TIMEOUT_MS });
    return;
  }

  // Вариант B — клик по кнопке/области загрузки обложки + ловля filechooser.
  const coverButton = page
    .getByRole('button', { name: /обложк/i })
    .or(page.locator('[aria-label*="бложк" i]'))
    .first();
  const buttonExists = (await coverButton.count()) > 0;
  if (buttonExists) {
    const fileChooserPromise = page
      .waitForEvent('filechooser', { timeout: SHORT_TIMEOUT_MS })
      .catch(() => null);
    const clickResult = await coverButton.click({ timeout: SHORT_TIMEOUT_MS }).catch(() => 'fail');
    if (clickResult !== 'fail') {
      const fc = await fileChooserPromise;
      if (fc !== null) {
        await fc.setFiles(coverPath);
        return;
      }
    } else {
      await fileChooserPromise;
    }
  }

  // Вариант C — drag-drop File в editor через DataTransfer. vc.ru-composer
  // использует Editor.js, у которого Image-tool ловит paste/drop events с
  // image-MIME и автоматически создаёт image-block (в нашем случае — первым,
  // что становится обложкой статьи).
  const buf = await readFile(coverPath);
  const name = coverPath.split('/').pop() ?? 'cover.png';
  const mime =
    name.toLowerCase().endsWith('.jpg') || name.toLowerCase().endsWith('.jpeg')
      ? 'image/jpeg'
      : 'image/png';
  await page.evaluate(
    (args: { bytes: number[]; name: string; mime: string }) => {
      // biome-ignore lint/suspicious/noExplicitAny: browser
      const g = globalThis as any;
      const editor = g.document.querySelector('.editor-tool-input[contenteditable="true"]');
      if (editor === null) return;
      editor.focus();
      const arr = new Uint8Array(args.bytes);
      const file = new g.File([arr], args.name, { type: args.mime });
      const dt = new g.DataTransfer();
      dt.items.add(file);
      // Drag-drop emulation: dragover → drop.
      const rect = editor.getBoundingClientRect();
      const opts = {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        clientX: rect.x + 10,
        clientY: rect.y + 10,
      };
      editor.dispatchEvent(new g.DragEvent('dragenter', opts));
      editor.dispatchEvent(new g.DragEvent('dragover', opts));
      editor.dispatchEvent(new g.DragEvent('drop', opts));
    },
    { bytes: Array.from(buf), name, mime },
  );
  await page.waitForTimeout(2500);
}

/**
 * Вставка HTML в ProseMirror-редактор vc.ru через synthetic ClipboardEvent.
 *
 * ProseMirror слушает paste-события и парсит `clipboardData.getData('text/html')`,
 * восстанавливая структуру (H2/strong/a/ul/blockquote). Это работает без
 * navigator.clipboard permissions и без реального Cmd+V.
 *
 * Возвращает true если paste отправлен; false если редактор не найден.
 */
/**
 * Конвертирует <pre><code>...</code></pre> блоки в <blockquote> ПЕРЕД paste.
 *
 * Editor.js paste-handler НЕ парсит <pre><code> в native Code Block tool
 * (probe v7 2026-05-25 подтвердил: даже после paste HTML с 7 <pre> blocks
 * Editor.js создаёт ОДИН ce-block — всё схлопывается в text). Code Block tool
 * на vc.ru доступен только через slash-команду или hover-toolbar, что нельзя
 * вызвать reliable из page.evaluate.
 *
 * Workaround: оборачиваем <pre><code> в <blockquote>. Editor.js парсит
 * blockquote → создаёт Quote-блок (визуально отличается от text). Inline
 * <code> оставляем с обрамлением backtick'ами — даёт visual signal в plain
 * text после Editor.js strip'нет inline-теги.
 *
 * Это не идеально, но даёт читаемую структуру vs total формат-loss.
 */
function preprocessHtmlForEditorJs(html: string): string {
  // 1. <pre><code lang="lang">…</code></pre> → <blockquote>▾ <strong>код (lang)</strong><br>…<br>▴</blockquote>
  let result = html.replace(
    /<pre[^>]*>\s*<code(?:\s+class="language-([^"]*)")?[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_match, lang: string | undefined, code: string) => {
      const langLabel = lang !== undefined && lang.length > 0 ? ` (${lang})` : '';
      // Декодируем basic HTML entities внутри code-content, чтобы не дублить.
      const decoded = code
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"');
      // Каждый \n превращаем в <br> чтобы Editor.js сохранил newlines внутри quote.
      const escaped = decoded
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
      return `<blockquote>▾ <strong>код${langLabel}</strong><br>${escaped}<br>▴</blockquote>`;
    },
  );

  // 2. Изолированный <pre> без <code> внутри (если есть).
  result = result.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_match, content: string) => {
    const stripped = content.replace(/<[^>]+>/g, '');
    return `<blockquote>▾ <strong>код</strong><br>${stripped.replace(/\n/g, '<br>')}<br>▴</blockquote>`;
  });

  // 3. Inline <code> → `…` (backticks). Editor.js strip'нет inline теги, но
  //    backticks останутся как visual marker моноспейса.
  result = result.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

  return result;
}

async function pasteHtmlIntoEditor(session: BrowserSession, html: string): Promise<boolean> {
  const { page } = session;
  const processedHtml = preprocessHtmlForEditorJs(html);
  // page.evaluate runs in browser context — DOM globals доступны там, но
  // tsconfig этого Node-проекта не подключает lib=dom. Используем any-cast
  // вместо `/// <reference lib="dom" />` чтобы не загрязнять остальной модуль.
  //
  // Берём ПОСЛЕДНИЙ contenteditable — в full editor mode (после cover-upload)
  // их может быть несколько: title-field и body-field. Body — последний.
  const result = await page.evaluate((htmlPayload: string): boolean => {
    // biome-ignore lint/suspicious/noExplicitAny: browser globals
    const g = globalThis as any;
    const all = g.document.querySelectorAll('[contenteditable="true"]');
    const editor = all.length > 0 ? all[all.length - 1] : null;
    if (editor === null) return false;
    editor.focus();
    const dt = new g.DataTransfer();
    dt.setData('text/html', htmlPayload);
    dt.setData('text/plain', htmlPayload.replace(/<[^>]+>/g, ''));
    const event = new g.ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    return editor.dispatchEvent(event) as boolean;
  }, processedHtml);
  // Маленькая пауза — даём ProseMirror отработать transaction.
  await page.waitForTimeout(1200);
  return result === true;
}

async function typeBodyPlainText(session: BrowserSession, body: string): Promise<void> {
  const { page } = session;
  const paragraphs = body.split(/\n\s*\n/);
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i] ?? '';
    await page.keyboard.type(p, { delay: 8 });
    if (i < paragraphs.length - 1) {
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
    }
  }
}

/**
 * Выбор категории (Сообщества) в модале публикации.
 *
 * vc.ru Сообщества — это subsite (subsite.ru = /tribuna, /ai-news и т.п.).
 * В модале обычно кнопка «Выбрать сообщество» → dropdown с поиском.
 * Слово `category` в наших драфтах — slug subsite (ai, lichnyy-opyt, future, business).
 */
async function selectCategory(session: BrowserSession, category: string): Promise<void> {
  const { page } = session;
  // Маппинг наших slug'ов на видимые названия на vc.ru.
  const labelByCategory: Record<string, RegExp> = {
    ai: /^Искусственный интеллект$|^AI$|^Нейросети$/i,
    'lichnyy-opyt': /^Личный опыт$/i,
    future: /^Будущее$|^Тренды$/i,
    business: /^Бизнес$/i,
  };
  const label = labelByCategory[category] ?? new RegExp(`^${category}$`, 'i');

  // vc.ru composer: «Без темы ⌄» — это DIV/A в шапке modal-fullpage.
  // Кликаем scoped к модал.
  const opener = page
    .locator('.modal-fullpage')
    .getByText(/^Без темы$/i)
    .first();
  await opener.click({ timeout: SHORT_TIMEOUT_MS, force: true });
  await page.waitForTimeout(1500);

  // Dropdown: `.context-list .context-list-option`. Items — DIV с label-span
  // внутри. Точный селектор + фильтр по тексту → исключает sidebar/feed.
  // (Probe v5 2026-05-25: подтверждено .context-list-option--with-art--selectable)
  const item = page.locator('.context-list-option').filter({ hasText: label }).first();
  await item.click({ timeout: SHORT_TIMEOUT_MS, force: true });
  await page.waitForTimeout(800);
}

/**
 * Простановка тегов через текстовое поле «Теги» в модале.
 * Каждый тег вводится + Enter (vc.ru обычно так оформляет chip-input).
 */
async function addTags(session: BrowserSession, tags: string[]): Promise<void> {
  const { page } = session;
  const tagField = page
    .getByPlaceholder(/тег/i)
    .or(page.getByRole('textbox', { name: /тег/i }))
    .first();
  await tagField.click({ timeout: SHORT_TIMEOUT_MS });
  for (const tag of tags) {
    await tagField.fill(tag, { timeout: SHORT_TIMEOUT_MS });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
  }
}

/**
 * Гарантирует что HTML начинается с <h1>. Если первый significant tag не <h1>,
 * добавляем `<h1>{title}</h1>` в начало. Если есть — оставляем как есть.
 */
function ensureH1(html: string, title: string): string {
  const trimmed = html.trim();
  if (/^<h1[\s>]/i.test(trimmed)) return trimmed;
  return `<h1>${escapeHtml(title)}</h1>\n${trimmed}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Простейшая markdown→HTML конвертация для fallback. Поддерживает H2/H3,
 * **bold**, [link](url), пустые строки → параграфы. Не покрывает все случаи —
 * это fallback когда htmlBody почему-то нет.
 */
function markdownLikeToHtml(md: string): string {
  const blocks = md.split(/\n\s*\n/);
  return blocks
    .map((b) => {
      const t = b.trim();
      if (t.startsWith('## ')) return `<h2>${inlineMd(t.slice(3))}</h2>`;
      if (t.startsWith('### ')) return `<h3>${inlineMd(t.slice(4))}</h3>`;
      if (t.length === 0) return '';
      return `<p>${inlineMd(t)}</p>`;
    })
    .join('\n');
}

function inlineMd(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return err.message.split('\n')[0] ?? err.message;
  }
  return String(err);
}
