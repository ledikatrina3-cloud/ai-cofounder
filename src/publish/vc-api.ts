// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE ADAPTER (не ядро движка). Пример внешнего паблишер-адаптера под
// vc.ru/Osnova. AI-Cofounder self-contained по умолчанию: агенты пишут результат
// в content/ локально. Этот адаптер опционален и активируется только через
// agents/<id>/target.yml. Платформенные эндпоинты/поля токенов здесь — образец
// интеграции под конкретную площадку, а НЕ дефолт продукта.
//
// ВНИМАНИЕ: автоматизирует НЕОФИЦИАЛЬНЫЙ (reverse-engineered) API сторонней
// площадки (vc.ru/Osnova). Может нарушать её Условия использования. Пример для
// справки, НЕ endorsed; используешь на свой риск.
// ─────────────────────────────────────────────────────────────────────────────
// vc.ru Osnova API клиент - прямая публикация через обычный HTTPS-клиент.
//
// Reverse-engineered протокол (см. experiments/vc-ru/attempts/2026-05-25_path-1-success.md):
//
// 1. Refresh:  POST /v3.0/auth/refresh
//              Content-Type: application/x-www-form-urlencoded
//              body: token=<refresh_token>
//              → { data: { accessToken, refreshToken, ... } }
//
// 2. Subsite lookup:  GET /v2.31/subsite?uri=/<slug>
//                     Headers: JWTAuthorization: Bearer <AT>
//                     → { result: { subsite: { id, ... } } }
//
// 3. Save/Publish entry:  POST /v2.1/editor
//                         Headers: JWTAuthorization, pwa: 1
//                         Body: multipart/form-data, поле entry=<JSON>
//                         JSON: { id?, type:1, user_id, subsite_id, title, is_published, entry: { blocks: [...] } }
//                         БЕЗ id → создаёт новую запись, возвращает id
//                         С id → обновляет существующую
//
// 4. Osnova блоки: type "text"/"header"/"code"/"list"/"quote", обёрнуто в
//    `{ data, cover: false, hidden: false, anchor: "" }`. Text-блоки: data.text
//    обёрнут в <p>...</p>.

import type { OsnovaBlock } from './markdown-to-osnova.js';

const API_BASE = 'https://api.vc.ru';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  /** Unix-timestamp seconds. */
  accessExpTimestamp: number;
  /** Unix-timestamp seconds. */
  refreshExpTimestamp: number;
}

export interface Subsite {
  id: number;
  uri: string;
  url: string;
  name: string;
  isEnableWriting: boolean;
}

export interface EntryResult {
  id: number;
  user_id: number;
  type: number;
  title: string;
  url: string;
  is_published: boolean;
  subsite_id: number;
  subsite_name: string;
  modification_date: number;
  blocks: OsnovaBlock[];
}

export class VcApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
    message: string,
    public readonly response?: unknown,
  ) {
    super(message);
    this.name = 'VcApiError';
  }
}

/**
 * Обменивает refresh_token на свежий access_token (JWT, 5 минут жизни).
 * vc.ru auth/refresh endpoint требует form-urlencoded `token=` (НЕ JSON).
 *
 * **vc.ru ротирует refresh-token** — каждый успешный refresh выдаёт НОВЫЙ RT
 * и инвалидирует старый. Поэтому caller обязан сохранить `session.refreshToken`
 * для следующего запуска. См. `refreshAndPersist` ниже - удобная обёртка.
 *
 * Retry: 3 попытки при 5xx (vc.ru API иногда падает в 503) с backoff 30s/60s/120s.
 */
export async function refreshAccessToken(refreshToken: string): Promise<AuthSession> {
  const delays = [0, 30_000, 60_000, 120_000];
  let lastErr: VcApiError | null = null;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] !== undefined && delays[attempt]! > 0) {
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
    let r: Response;
    try {
      r = await fetch(`${API_BASE}/v3.0/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
          Origin: 'https://vc.ru',
        },
        body: `token=${encodeURIComponent(refreshToken)}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastErr = new VcApiError(0, 'NETWORK_ERROR', msg, null);
      continue;
    }
    if (r.status >= 500 && r.status < 600) {
      // vc.ru downtime - retry с backoff.
      lastErr = new VcApiError(r.status, 'SERVER_ERROR', `${r.status} from refresh`, null);
      continue;
    }
    type RefreshJson = {
      message?: string;
      data?: {
        accessToken: string;
        refreshToken: string;
        accessExpTimestamp: number;
        refreshExpTimestamp: number;
      };
    };
    let json: RefreshJson;
    try {
      json = (await r.json()) as RefreshJson;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new VcApiError(r.status, 'INVALID_JSON', `refresh response not JSON: ${msg}`, null);
    }
    if (!json.data?.accessToken) {
      throw new VcApiError(r.status, 'AUTH_REFRESH_FAILED', json.message ?? 'no data', json);
    }
    return json.data;
  }
  throw lastErr ?? new VcApiError(0, 'REFRESH_EXHAUSTED', 'all retries failed', null);
}

/**
 * Удобная обёртка: загружает RT из .env.local, делает refresh, и сохраняет
 * новый RT обратно в .env.local (vc.ru ротирует токены).
 *
 * Это **default способ** аутентификации для всех CLI scripts - чтобы фаундер
 * один раз положил RT в .env.local и больше никогда его не доставал руками.
 */
export async function refreshAndPersist(envPath = '.env.local'): Promise<AuthSession> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const absEnv = resolve(envPath);

  // Загружаем .env.local (без зависимости от dotenv - простая парсинг).
  let envContent = '';
  try {
    envContent = await readFile(absEnv, 'utf8');
  } catch {
    // .env.local не существует - первый запуск. RT должен быть в env переменной.
  }
  const lines = envContent.split('\n');
  const rtLineIdx = lines.findIndex((l) => l.startsWith('VC_REFRESH_TOKEN='));
  const rtFromFile =
    rtLineIdx >= 0 ? lines[rtLineIdx]!.slice('VC_REFRESH_TOKEN='.length).trim() : '';
  const rt = process.env.VC_REFRESH_TOKEN || rtFromFile;

  if (!rt) {
    throw new VcApiError(
      0,
      'NO_REFRESH_TOKEN',
      `VC_REFRESH_TOKEN не найден ни в env, ни в ${envPath}. Один раз положи: получи RT из vc.ru localStorage["auth-refresh-token"] (поле "token") и добавь строку VC_REFRESH_TOKEN=<token> в .env.local.`,
      null,
    );
  }

  const session = await refreshAccessToken(rt);

  // Сохраняем новый RT обратно в .env.local (overwrite строки).
  const newLine = `VC_REFRESH_TOKEN=${session.refreshToken}`;
  if (rtLineIdx >= 0) {
    lines[rtLineIdx] = newLine;
  } else {
    lines.push(newLine);
  }
  const newContent = lines.join('\n').replace(/\n\n+$/, '\n');
  await writeFile(absEnv, newContent, 'utf8');

  return session;
}

/**
 * Получает subsite (Сообщество / Личный блог) по uri.
 * uri начинается со слэша: "/ai", "/your-handle".
 */
export async function getSubsiteByUri(at: string, uri: string): Promise<Subsite> {
  const url = `${API_BASE}/v2.31/subsite?uri=${encodeURIComponent(uri)}`;
  const r = await fetch(url, {
    headers: {
      jwtauthorization: `Bearer ${at}`,
      'User-Agent': USER_AGENT,
      Origin: 'https://vc.ru',
    },
  });
  const json = (await r.json()) as {
    message?: string;
    error?: { code: number; info?: { errorCode?: string } };
    result?: { subsite?: Subsite };
  };
  if (json.error) {
    throw new VcApiError(
      r.status,
      json.error.info?.errorCode ?? null,
      json.message ?? 'subsite lookup failed',
      json,
    );
  }
  const sub = json.result?.subsite;
  if (!sub) {
    throw new VcApiError(r.status, 'SUBSITE_NOT_FOUND', `subsite ${uri} not found`, json);
  }
  return sub;
}

export interface UploadedImage {
  uuid: string;
  width: number;
  height: number;
  size: number;
  type: string;
  color: string;
}

/**
 * Загружает изображение в vc.ru CDN и возвращает uuid + размеры.
 * Используется для cover и для image-блоков внутри статьи.
 */
export async function uploadImage(
  at: string,
  filePath: string,
  mimeType = 'image/png',
): Promise<UploadedImage> {
  const { readFile } = await import('node:fs/promises');
  const { basename } = await import('node:path');
  const buf = await readFile(filePath);
  const blob = new Blob([new Uint8Array(buf)], { type: mimeType });
  const form = new FormData();
  form.append('file_0', blob, basename(filePath));

  const r = await fetch(`${API_BASE}/v2.1/uploader/upload`, {
    method: 'POST',
    headers: {
      jwtauthorization: `Bearer ${at}`,
      pwa: '1',
      'User-Agent': USER_AGENT,
      Origin: 'https://vc.ru',
      Referer: 'https://vc.ru/?modal=editor',
    },
    body: form,
  });
  const json = (await r.json()) as {
    message?: string;
    error?: { code: number; info?: { errorCode?: string } };
    result?: Array<{ type: string; data: UploadedImage }>;
  };
  if (json.error || !json.result?.[0]?.data?.uuid) {
    throw new VcApiError(
      r.status,
      json.error?.info?.errorCode ?? 'UPLOAD_FAILED',
      json.message ?? `upload failed (${r.status})`,
      json,
    );
  }
  return json.result[0].data;
}

/**
 * Формирует cover-блок (тип "media") из загруженного изображения.
 * vc.ru ожидает cover как первый блок entry с `cover: true`.
 */
export function makeCoverBlock(img: UploadedImage): OsnovaBlock {
  return {
    type: 'media',
    data: {
      items: [
        {
          title: '',
          author: '',
          image: { type: 'image', data: img },
        },
      ],
      with_background: false,
      with_border: false,
    },
    cover: true,
    hidden: false,
    anchor: '',
  };
}

export interface SaveEntryInput {
  /** Если задан - обновляем существующую запись; иначе - создаём новую. */
  id?: number;
  /** ID юзера (для personal_blog = subsite_id). */
  userId: number;
  /** ID subsite (Сообщество или личный блог). */
  subsiteId: number;
  title: string;
  blocks: OsnovaBlock[];
  /** false = draft, true = опубликовать. */
  isPublished: boolean;
}

/**
 * Создаёт или обновляет запись (черновик / публикацию).
 * Использует POST /v2.1/editor с multipart/form-data (поле "entry" = JSON).
 */
export async function saveEntry(at: string, input: SaveEntryInput): Promise<EntryResult> {
  const entryPayload: Record<string, unknown> = {
    type: 1,
    user_id: input.userId,
    subsite_id: input.subsiteId,
    title: input.title,
    is_published: input.isPublished,
    entry: { blocks: input.blocks },
  };
  if (typeof input.id === 'number') entryPayload.id = input.id;

  const form = new FormData();
  form.append('entry', JSON.stringify(entryPayload));

  const r = await fetch(`${API_BASE}/v2.1/editor`, {
    method: 'POST',
    headers: {
      jwtauthorization: `Bearer ${at}`,
      pwa: '1',
      'User-Agent': USER_AGENT,
      Origin: 'https://vc.ru',
      Referer: 'https://vc.ru/?modal=editor',
    },
    body: form,
  });
  const json = (await r.json()) as {
    message?: string;
    error?: { code: number; info?: { errorCode?: string } };
    result?: { entry?: Record<string, unknown> };
  };
  if (json.error) {
    throw new VcApiError(
      r.status,
      json.error.info?.errorCode ?? null,
      json.message ?? `save failed (${r.status})`,
      json,
    );
  }
  const e = json.result?.entry;
  if (!e || typeof e.id !== 'number') {
    throw new VcApiError(r.status, 'SAVE_NO_ENTRY', 'no entry in response', json);
  }
  // Извлекаем blocks из вложенной структуры entry.entry.blocks.
  const inner = (e.entry as { blocks?: OsnovaBlock[] } | undefined) ?? { blocks: [] };
  return {
    id: e.id as number,
    user_id: e.user_id as number,
    type: e.type as number,
    title: e.title as string,
    url: e.url as string,
    is_published: e.is_published as boolean,
    subsite_id: e.subsite_id as number,
    subsite_name: e.subsite_name as string,
    modification_date: e.modification_date as number,
    blocks: inner.blocks ?? [],
  };
}

/**
 * Детерминистически выбирает один из визуалов бренда из `assets/logos/<brand>/`.
 * Используется в cover-генераторе чтобы каждая статья получала свой визуал
 * (без визуального однообразия в ленте).
 *
 * @param brand - 'claude-code' | 'chatgpt' | 'openai' | 'gemini' | 'grok' | 'llama' | 'mistral'
 * @param seed - slug статьи или title (для детерминистического выбора)
 * @param repoRoot - корень репо ai-cofounder (где лежит assets/logos/)
 * @returns absolute path к выбранному файлу
 */
export async function pickBrandAsset(
  brand: string,
  seed: string,
  repoRoot: string,
): Promise<{ path: string; filename: string; total: number }> {
  const { readdir } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const brandDir = resolve(repoRoot, 'assets', 'logos', brand);
  let files: string[];
  try {
    const entries = await readdir(brandDir);
    files = entries.filter((f) => /\.(svg|png|jpg|jpeg|webp)$/i.test(f)).sort();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`brand folder ${brandDir} не найден: ${msg}`);
  }
  if (files.length === 0) {
    throw new Error(`assets/logos/${brand}/ пуста - добавь хотя бы один визуал`);
  }
  // Hash seed → index. Простой sum-of-codes mod files.length.
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) % 1_000_003;
  const idx = Math.abs(hash) % files.length;
  const filename = files[idx] as string;
  return { path: resolve(brandDir, filename), filename, total: files.length };
}

/**
 * Карта category-slug → vc.ru subsite uri.
 * Если нет в маппинге - publishing идёт в личный блог (надо передать `personal`).
 */
const CATEGORY_URI_MAP: Record<string, string> = {
  ai: '/ai',
  'lichnyy-opyt': '/lichnyy-opyt',
  future: '/future',
  business: '/biznes',
  tech: '/tech',
};

/**
 * Резолвит category-slug в subsite_id через API. Кэширует результаты в Map.
 */
export async function resolveSubsiteByCategory(
  at: string,
  category: string,
  cache: Map<string, Subsite> = new Map(),
): Promise<Subsite> {
  if (cache.has(category)) {
    const cached = cache.get(category);
    if (cached) return cached;
  }
  const uri = CATEGORY_URI_MAP[category];
  if (!uri) {
    throw new VcApiError(0, 'UNKNOWN_CATEGORY', `category '${category}' not in map`, null);
  }
  const sub = await getSubsiteByUri(at, uri);
  cache.set(category, sub);
  return sub;
}
