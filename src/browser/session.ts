// Обёртка patchright (Playwright + anti-detect патчи) с persistent profile.
//
// Контракт `openSession`:
//   * Открывает Chromium через `chromium.launchPersistentContext(userDataDir)`.
//     userDataDir резолвится через `resolveProfile(platform, account)` — там же
//     создаётся директория и помечается «первый запуск».
//   * `headless: false` по умолчанию: соцсети агрессивно ловят headless
//     Chromium через `navigator.webdriver` и сопутствующие сигналы. patchright
//     прячет webdriver, но видимое окно — дополнительный сигнал «человек».
//   * Возвращает `{ context, page, close, profile }`. `page` — первая (и
//     единственная на старте) вкладка контекста.
//
// Что НЕ делает (намеренно):
//   * Не управляет proxy/IP — local-first, IP пользовательский.
//   * Не делает screenshot/трейс сам — это ответственность вызывающего
//     publisher'а (он знает, в какой момент что снять).
//   * Не интегрируется в Bridge events — emit'ить будем из publish/* для
//     осмысленных событий, а не «вот окно открылось». Bridge integration
//     запланирована фазой 3 плана.

import type { BrowserContext, Page } from 'patchright';
import { chromium } from 'patchright';
import { type ProfileLocation, type ResolveProfileOptions, resolveProfile } from './profiles.js';

export interface OpenSessionOptions {
  /** Идентификатор платформы: 'vc', 'dzen', 'reddit', 'linkedin'. */
  platform: string;
  /** Имя аккаунта внутри платформы. По умолчанию 'main'. */
  account?: string;
  /** Видимое окно (default: true). Headless для соцсетей не рекомендуется. */
  headless?: boolean;
  /**
   * Жёсткий запрет открытия если профиль ещё не создан (нужен ручной логин
   * через scripts/browser-login.ts). Если true — кидает ошибку при
   * preexisted=false. Default: false (browser-login создаёт профиль с нуля).
   */
  requireExistingProfile?: boolean;
  /** Размер окна. Default 1280x800 — как Electron bridge. */
  viewport?: { width: number; height: number };
  /** Override корня профилей (для тестов). */
  profileRootDir?: string;
}

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  profile: ProfileLocation;
  close: () => Promise<void>;
}

export class BrowserSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserSessionError';
  }
}

export async function openSession(opts: OpenSessionOptions): Promise<BrowserSession> {
  const account = opts.account ?? 'main';
  const profileOpts: ResolveProfileOptions = {};
  if (opts.profileRootDir !== undefined) profileOpts.rootDir = opts.profileRootDir;
  const profile = await resolveProfile(opts.platform, account, profileOpts);

  if (opts.requireExistingProfile === true && !profile.preexisted) {
    throw new BrowserSessionError(
      `профиль для ${opts.platform}/${account} не создан. Запусти: pnpm browser:login ${opts.platform} ${account}`,
    );
  }

  const viewport = opts.viewport ?? { width: 1280, height: 800 };
  const headless = opts.headless ?? false;

  // patchright docs: `channel: 'chrome'` ловит установленный Chrome (с реальным
  // user-agent), но требует наличия Chrome на машине. По умолчанию используем
  // bundled Chromium (ms-playwright cache). Если фаундер хочет Chrome — выставит
  // CHROME_CHANNEL=chrome в env.
  const channel = process.env.CHROME_CHANNEL ?? undefined;

  const context = await chromium.launchPersistentContext(profile.path, {
    headless,
    viewport,
    ...(channel !== undefined ? { channel } : {}),
    // Это уже дефолт patchright, но фиксируем явно: не выставляем
    // navigator.webdriver=true.
    ignoreDefaultArgs: ['--enable-automation'],
    // Локаль и таймзона браузерного профиля. Нейтральный дефолт en-US / UTC;
    // под конкретную площадку задай BROWSER_LOCALE и BROWSER_TIMEZONE в .env.
    locale: process.env.BROWSER_LOCALE ?? 'en-US',
    timezoneId: process.env.BROWSER_TIMEZONE ?? 'UTC',
  });

  // launchPersistentContext открывает 1 пустую страницу автоматически.
  // Если её нет (например, после Chrome restart) — создаём.
  const pages = context.pages();
  const page = pages[0] ?? (await context.newPage());

  return {
    context,
    page,
    profile,
    close: async () => {
      await context.close().catch(() => {
        // Контекст уже мог быть закрыт пользователем (закрыл окно).
      });
    },
  };
}
