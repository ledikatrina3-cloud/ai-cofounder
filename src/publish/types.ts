// Типы публикации. Контракт между loader.ts (парсер черновика) и
// platform-публикаторами (vc.ts, dzen.ts и т.д.).

export type DraftStatus = 'ready' | 'draft' | 'published';

export interface Draft {
  /** Платформа: vc | dzen | reddit | linkedin. */
  platform: string;
  /** Имя аккаунта (mapping на browser-profile). Default 'main'. */
  account: string;
  /** Статус — публикатор обязан проверить 'ready' перед публикацией. */
  status: DraftStatus;
  /** Заголовок (один <h1>). */
  title: string;
  /** Markdown-тело без заголовка (всё что после первого blank-line после frontmatter). */
  body: string;
  /**
   * HTML-тело (если задано `htmlPath` во frontmatter). Приоритет над `body`
   * для платформ с paste-поддержкой (vc.ru ProseMirror). Содержит H2/strong/a/ul/blockquote.
   * `null` если в frontmatter htmlPath не задан.
   */
  htmlBody: string | null;
  /** Теги. Опционально — не все платформы поддерживают (Reddit subreddit ≠ tags). */
  tags: string[];
  /**
   * Абсолютный путь к файлу обложки (PNG/JPG). `null` если не задан.
   * vc.ru/dzen используют это поле для drag-drop в editor.
   */
  cover: string | null;
  /**
   * Slug категории платформы (для vc.ru — 'ai' | 'lichnyy-opyt' | 'future' | 'business' | …).
   * `null` → личный блог (виральность ноль). Critical для vc.ru-публикации.
   */
  category: string | null;
  /** Абсолютный путь к файлу-источнику. Для логов и обновления статуса. */
  filePath: string;
}

export interface PublishResult {
  /** URL опубликованного поста (если получили). */
  url: string | null;
  /** Платформа куда опубликовали. */
  platform: string;
  /** Аккаунт. */
  account: string;
  /** Время от open-сессии до confirmed-publish. */
  durationMs: number;
  /** Путь к скриншоту страницы успеха (если делали). */
  screenshotPath: string | null;
}

export class DraftError extends Error {
  constructor(filePath: string, message: string) {
    super(`draft ${filePath}: ${message}`);
    this.name = 'DraftError';
  }
}

export class PublishError extends Error {
  constructor(
    public readonly platform: string,
    public readonly step: string,
    message: string,
  ) {
    super(`publish[${platform}:${step}]: ${message}`);
    this.name = 'PublishError';
  }
}
