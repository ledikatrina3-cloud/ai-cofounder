// Bridge HTTP-сервер на localhost:BRIDGE_PORT (default 3737).
// Источник дизайна: architecture/10-оболочка-bridge/мостик.md L132 + L162-175 (LIVE-режим
// принимает hooks от claude-code, AI-Cofounder POST'ит сюда же из src/observe/bridge.ts).
//
// Контракты:
//   POST /event/<type>  body: JSON       — публикует BridgeEvent на шину + JSONL.
//                                          path-параметр <type> используется только для
//                                          логирования; type берётся из body.type.
//                                          Тело не валидируется строгим JSON-Schema —
//                                          claude-code-hooks (мостик.md L162) пушат сюда
//                                          свой формат, нормализация — в Renderer'е/M2.
//   GET  /stream        SSE              — Renderer (или curl) подписывается на event-bus.
//   GET  /healthz       text             — для smoke-проверки.
//   GET  /metrics       JSON             — агрегаты за сегодня (UTC): spend, routines, tokens.
//
// startServer возвращает handle с .close(), чтобы тесты/электрон могли остановить
// сервер чисто. Слушаем localhost — не bind'имся на 0.0.0.0, не торчим в LAN.

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import {
  type AgentCreateInput,
  type AgentUpdatePatch,
  AgentWriteError,
  createAgent,
  deleteAgent,
  updateAgent,
} from './agents-write.js';
import { bridgePort } from './config.js';
import {
  type DepartmentCreateInput,
  DepartmentWriteError,
  createDepartment,
  deleteDepartment,
} from './departments-write.js';
import { getBridgeBus } from './event-bus.js';
import type { BridgeEvent } from './events.js';
import { type JsonlSession, startJsonlSession } from './jsonl-writer.js';
import { redactSecrets } from './redaction.js';
import {
  type RoutineRecord,
  buildRoutineSummary,
  buildTranscript,
  computeNextRunAt,
  getSkillFull,
  listAllSkills,
  listRecentRuns,
  listSkillHealth,
  loadListRoutines,
  resolveRoutineSkillsForUi,
} from './routines-api.js';
import {
  type RoutineCreateInput,
  type RoutinePatchLike,
  RoutineWriteError,
  createRoutine,
  deleteRoutine,
  updateRoutine,
} from './routines-write.js';
import {
  type SkillBuilderHistoryItem,
  deleteSkill,
  handleSkillBuilderMessage,
  readSkillRaw,
  saveNewSkill,
  updateSkill,
} from './skill-builder.js';

// Dynamic-loaded chat-handler. bridge tsconfig изолирован (rootDir=bridge), поэтому
// статически импортировать `src/telegram/chat-handler` нельзя — TS вынес бы файл
// за пределы rootDir. Используем runtime import из скомпилированного main tsc
// (`dist/src/telegram/chat-handler.js`). Тип ответа повторён локально, чтобы
// /chat endpoint не зависел от src/-типов на уровне сборки.
interface ChatHandlerReply {
  text: string;
  durationMs: number;
  usd: number;
  status: 'ok' | 'failed' | 'timeout';
  sessionId: string;
}
type ChatHandlerFn = (chatId: number, userText: string) => Promise<ChatHandlerReply>;
let cachedChatHandler: ChatHandlerFn | null = null;
async function loadChatHandler(): Promise<ChatHandlerFn> {
  if (cachedChatHandler !== null) return cachedChatHandler;
  const handlerPath = resolve(process.cwd(), 'dist', 'src', 'telegram', 'chat-handler.js');
  const mod = (await import(pathToFileURL(handlerPath).href)) as {
    handleChatMessage: ChatHandlerFn;
  };
  cachedChatHandler = mod.handleChatMessage;
  return cachedChatHandler;
}

// ---------------------------------------------------------------------------
// Analytics queries — dynamic import. См. /analytics/* endpoints ниже.
// Тот же паттерн что в loadChatHandler / loadListRoutines: bridge tsconfig
// rootDir=bridge, поэтому статически из src/ грузить нельзя.
// ---------------------------------------------------------------------------

interface AnalyticsQueriesMod {
  getAnalyticsSummary: (opts: { period?: string }) => Promise<unknown>;
  getPostsList: (opts: { period?: string }) => Promise<unknown[]>;
  getCostTrend: (opts: { weeks?: number }) => Promise<unknown[]>;
  getTrafficTrend: (opts: { weeks?: number }) => Promise<unknown[]>;
}
let cachedAnalyticsQueries: AnalyticsQueriesMod | null = null;
async function loadAnalyticsQueries(): Promise<AnalyticsQueriesMod> {
  if (cachedAnalyticsQueries !== null) return cachedAnalyticsQueries;
  const modPath = resolve(process.cwd(), 'dist', 'src', 'analytics', 'queries.js');
  const mod = (await import(pathToFileURL(modPath).href)) as AnalyticsQueriesMod;
  cachedAnalyticsQueries = mod;
  return cachedAnalyticsQueries;
}

// Классификация ошибок skill-эндпоинтов в HTTP-статус (ревью findings #3/#4).
// По умолчанию 400 (ошибка ввода/валидации parser'а); 500 только для системных
// FS/loader-ошибок; 404 — не найден; 409 — конфликт. Раньше POST /skills по
// подстрокам считал валидационные ошибки серверными (500).
function skillErrorStatus(msg: string): 400 | 404 | 409 | 500 {
  if (/ENOENT|EACCES|EPERM|ENOSPC|Cannot find module|ERR_MODULE_NOT_FOUND/.test(msg)) return 500;
  if (msg.includes('не найден')) return 404;
  if (msg.includes('уже существует')) return 409;
  return 400;
}

function analyticsErrorBody(err: unknown): { ok: false; error: string } {
  console.error('[analytics]', err);
  const msg = err instanceof Error ? err.message : String(err);
  const hint =
    msg.includes('Cannot find module') || msg.includes('ERR_MODULE_NOT_FOUND')
      ? '. Запусти `pnpm exec tsc -p tsconfig.json` чтобы появился dist/src/analytics/queries.js'
      : '';
  return { ok: false, error: `${msg}${hint}` };
}

// ---------------------------------------------------------------------------
// Helpers for /metrics — прямой better-sqlite3 без Prisma-клиента.
// Bridge — отдельный процесс, Prisma-клиент из src/ не инициализирован здесь;
// используем тот же DB-файл через легковесный better-sqlite3 read-only.
// ---------------------------------------------------------------------------

function resolveDbPath(): string {
  const url = process.env.DATABASE_URL ?? '';
  const raw = url.startsWith('file:') ? url.slice('file:'.length) : url;
  if (!raw || raw === '') return resolve(process.cwd(), 'prisma', 'dev.db');
  if (raw.startsWith('/')) return raw;
  return resolve(process.cwd(), 'prisma', raw);
}

interface MetricsData {
  totalUsd: number;
  routinesRan: number;
  toolCalls: number;
  topRoutine: string | null;
  totalTokens: number;
}

function queryMetrics(): MetricsData {
  const dbPath = resolveDbPath();
  const db = new Database(dbPath, { readonly: true });
  try {
    db.pragma('journal_mode = WAL');

    // Начало сегодняшнего дня (UTC) в миллисекундах — SQLite хранит createdAt как ms.
    const now = new Date();
    const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

    // ── Spend за сегодня (audit.spend) ──────────────────────────────────────
    // properties — JSON: { usd, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, routineId? }
    const spendRows = db
      .prepare<[number], { properties: string }>(
        `SELECT properties FROM "Record" WHERE type = 'audit.spend' AND createdAt >= ?`,
      )
      .all(todayMs);

    let totalUsd = 0;
    let totalTokens = 0;
    const routineSpend: Record<string, number> = {};

    for (const row of spendRows) {
      try {
        const p = JSON.parse(row.properties) as Record<string, unknown>;
        if (typeof p.usd === 'number' && Number.isFinite(p.usd)) totalUsd += p.usd;
        const tokens =
          (typeof p.inputTokens === 'number' ? p.inputTokens : 0) +
          (typeof p.outputTokens === 'number' ? p.outputTokens : 0) +
          (typeof p.cacheReadTokens === 'number' ? p.cacheReadTokens : 0) +
          (typeof p.cacheCreationTokens === 'number' ? p.cacheCreationTokens : 0);
        totalTokens += tokens;
        if (typeof p.routineId === 'string' && p.routineId) {
          routineSpend[p.routineId] = (routineSpend[p.routineId] ?? 0) + (p.usd as number);
        }
      } catch {
        // битый JSON — пропускаем
      }
    }

    // ── Routines за сегодня (audit.routine.end) ──────────────────────────────
    // Считаем уникальные routineId из properties.routineId.
    // Если поле routineId хранится в properties — парсим; если нет — используем actorRef.
    const routineEndRows = db
      .prepare<[number], { properties: string }>(
        `SELECT properties FROM "Record" WHERE type = 'audit.routine.end' AND createdAt >= ?`,
      )
      .all(todayMs);

    const seenRoutines = new Set<string>();
    for (const row of routineEndRows) {
      try {
        const p = JSON.parse(row.properties) as Record<string, unknown>;
        const rid = typeof p.routineId === 'string' ? p.routineId : null;
        if (rid) seenRoutines.add(rid);
      } catch {
        // пропускаем
      }
    }
    const routinesRan = seenRoutines.size > 0 ? seenRoutines.size : routineEndRows.length;

    // ── Tool calls за сегодня — audit.action с tool в properties или напрямую ──
    // Нет отдельной таблицы tool calls в Prisma-схеме; bridge events не хранятся в БД.
    // toolCalls = количество audit.spend как proxy (один spend ≈ один LLM-call).
    const toolCalls = spendRows.length;

    // ── Top routine по USD ───────────────────────────────────────────────────
    let topRoutine: string | null = null;
    let topUsd = -1;
    for (const [rid, usd] of Object.entries(routineSpend)) {
      if (usd > topUsd) {
        topUsd = usd;
        topRoutine = rid;
      }
    }

    return { totalUsd, routinesRan, toolCalls, topRoutine, totalTokens };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// /activity — построение «человеческой» ленты из таблицы Record. Это не дубль
// /stream (тот эмитит будущие события), а ретроспектива: даже если процесс-бот
// упал/перезапустился, фаундер видит последние 40 фактов, что произошли в
// журнале. Каждый item приводится к плоскому виду {ts, kind, title, detail, meta}
// чтобы UI мог отрендерить ленту без знания внутренних property-shape'ов.
// ---------------------------------------------------------------------------

export interface ActivityItem {
  id: string;
  ts: number;
  kind:
    | 'user-msg'
    | 'agent-msg'
    | 'spend'
    | 'support-fetch'
    | 'problem'
    | 'diagnosis'
    | 'proposal'
    | 'routine'
    | 'deny'
    | 'audit';
  title: string;
  detail: string;
  meta?: Record<string, unknown>;
}

const ACTIVITY_TYPES = [
  'chat.message.user',
  'chat.message.assistant',
  'audit.spend',
  'audit.fetch.support',
  'intent.problem',
  'intent.diagnosis',
  'intent.proposal',
  'audit.routine.start',
  'audit.routine.end',
  'audit.security.deny',
  'audit.budget.deny',
  'event.support.message',
];

function queryActivity(limit: number): ActivityItem[] {
  const dbPath = resolveDbPath();
  const db = new Database(dbPath, { readonly: true });
  try {
    db.pragma('journal_mode = WAL');
    const placeholders = ACTIVITY_TYPES.map(() => '?').join(',');
    const rows = db
      .prepare<string[], { id: string; type: string; properties: string; createdAt: number }>(
        `SELECT id, type, properties, createdAt FROM "Record"
         WHERE type IN (${placeholders})
         ORDER BY createdAt DESC LIMIT ?`,
      )
      .all(...ACTIVITY_TYPES, String(limit));
    const items: ActivityItem[] = [];
    for (const row of rows) {
      const item = mapActivityRow(row);
      if (item !== null) items.push(item);
    }
    return items;
  } finally {
    db.close();
  }
}

function mapActivityRow(row: {
  id: string;
  type: string;
  properties: string;
  createdAt: number;
}): ActivityItem | null {
  let p: Record<string, unknown> = {};
  try {
    p = JSON.parse(row.properties) as Record<string, unknown>;
  } catch {
    return null;
  }
  const ts = Number(row.createdAt);
  switch (row.type) {
    case 'chat.message.user': {
      const text = typeof p.text === 'string' ? p.text : '';
      return {
        id: row.id,
        ts,
        kind: 'user-msg',
        title: 'фаундер',
        detail: text.slice(0, 280),
        meta: { chatId: p.chatId, sessionId: p.sessionId },
      };
    }
    case 'chat.message.assistant': {
      const text = typeof p.text === 'string' ? p.text : '';
      const usd = typeof p.usd === 'number' ? p.usd : 0;
      const status = typeof p.status === 'string' ? p.status : 'ok';
      return {
        id: row.id,
        ts,
        kind: 'agent-msg',
        title: status === 'ok' ? 'бот' : `бот (${status})`,
        detail: text.slice(0, 280),
        meta: { usd, durationMs: p.durationMs, sessionId: p.sessionId },
      };
    }
    case 'audit.spend': {
      const usd = typeof p.usd === 'number' ? p.usd : 0;
      const model = typeof p.model === 'string' ? p.model : '?';
      const promptId = typeof p.promptId === 'string' ? p.promptId : '?';
      return {
        id: row.id,
        ts,
        kind: 'spend',
        title: `$${usd.toFixed(4)}`,
        detail: `${model} · ${promptId}`,
        meta: { usd, model, promptId },
      };
    }
    case 'audit.fetch.support': {
      const inserted = typeof p.messagesInserted === 'number' ? p.messagesInserted : 0;
      const found = typeof p.messagesFound === 'number' ? p.messagesFound : 0;
      return {
        id: row.id,
        ts,
        kind: 'support-fetch',
        title: 'support',
        detail: `+${inserted} новых из ${found} (поднял из чатов)`,
      };
    }
    case 'event.support.message': {
      const text = typeof p.text === 'string' ? p.text : '';
      const chat = typeof p.chatTitle === 'string' ? p.chatTitle : 'support';
      return {
        id: row.id,
        ts,
        kind: 'support-fetch',
        title: chat,
        detail: text.slice(0, 200),
      };
    }
    case 'intent.problem': {
      const title = typeof p.title === 'string' ? p.title : '';
      const summary = typeof p.summary === 'string' ? p.summary : '';
      return {
        id: row.id,
        ts,
        kind: 'problem',
        title: 'проблема',
        detail: title.length > 0 ? title : summary.slice(0, 200),
      };
    }
    case 'intent.diagnosis': {
      const verdict = typeof p.verdict === 'string' ? p.verdict : '?';
      const summary = typeof p.summary === 'string' ? p.summary : '';
      return {
        id: row.id,
        ts,
        kind: 'diagnosis',
        title: `диагноз: ${verdict}`,
        detail: summary.slice(0, 220),
      };
    }
    case 'intent.proposal': {
      const summary = typeof p.summary === 'string' ? p.summary : '';
      return {
        id: row.id,
        ts,
        kind: 'proposal',
        title: 'предложение',
        detail: summary.slice(0, 220),
      };
    }
    case 'audit.routine.start':
    case 'audit.routine.end': {
      const rid = typeof p.routineId === 'string' ? p.routineId : '?';
      const status = typeof p.status === 'string' ? p.status : '';
      const dur = typeof p.durationMs === 'number' ? `${p.durationMs}ms` : '';
      return {
        id: row.id,
        ts,
        kind: 'routine',
        title: row.type === 'audit.routine.start' ? `▶ ${rid}` : `✓ ${rid}`,
        detail: [status, dur].filter(Boolean).join(' · '),
      };
    }
    case 'audit.security.deny': {
      const cmd = typeof p.command === 'string' ? p.command : '';
      const chat = typeof p.chatId === 'string' ? p.chatId : 'unknown';
      return {
        id: row.id,
        ts,
        kind: 'deny',
        title: 'security deny',
        detail: `chat=${chat} cmd=${cmd}`.slice(0, 200),
      };
    }
    case 'audit.budget.deny': {
      const limit = typeof p.limit === 'string' ? p.limit : '?';
      const cap = typeof p.cap === 'number' ? p.cap : 0;
      return {
        id: row.id,
        ts,
        kind: 'deny',
        title: `budget deny: ${limit}`,
        detail: `cap=${cap}`,
      };
    }
    default:
      return null;
  }
}

export interface BridgeServerHandle {
  port: number;
  sessionId: string;
  jsonlPath: string;
  close(): Promise<void>;
}

export interface StartServerOptions {
  port?: number;
  // Для тестов: подменить JSONL-сессию (или отключить запись на диск, передав mock).
  session?: JsonlSession;
}

export async function startBridgeServer(
  opts: StartServerOptions = {},
): Promise<BridgeServerHandle> {
  const port = opts.port ?? bridgePort();
  const session = opts.session ?? (await startJsonlSession());
  const bus = getBridgeBus();

  // In-memory ring-buffer событий для replay на новое SSE-подключение
  // (план 2026-05-22, фикс «UI открывается посреди прогона — буфер пуст»).
  // Размер выбран чтобы покрыть один тяжёлый workflow (article-writing
  // выдаёт ~200-400 events за 14 этапов). При переполнении — drop oldest.
  // Память: 800 × ~1KB = ~800KB, приемлемо для одного host-процесса.
  const RECENT_BUFFER_MAX = 800;
  const recentEvents: BridgeEvent[] = [];

  // ── Warmup: при старте читаем хвост ПОСЛЕДНЕЙ JSONL-сессии (по mtime),
  // чтобы пережить рестарт bridge'а посреди тяжёлого workflow. Своя session
  // только что создана и пуста — нам интересна предыдущая. Если ничего не
  // найдено — стартуем с пустым буфером.
  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const sessionsDir = path.dirname(session.filePath);
    const entries = await fs.readdir(sessionsDir);
    const jsonlFiles = entries.filter(
      (f) => f.endsWith('.jsonl') && f !== path.basename(session.filePath),
    );
    if (jsonlFiles.length > 0) {
      // Берём последнюю по mtime.
      const stats = await Promise.all(
        jsonlFiles.map(async (f) => ({
          f,
          mtime: (await fs.stat(path.join(sessionsDir, f))).mtimeMs,
        })),
      );
      stats.sort((a, b) => b.mtime - a.mtime);
      const latestFile = stats[0];
      if (latestFile !== undefined) {
        const raw = await fs.readFile(path.join(sessionsDir, latestFile.f), 'utf8');
        const lines = raw.split('\n').filter((l) => l.length > 0);
        const tail = lines.slice(-RECENT_BUFFER_MAX);
        for (const line of tail) {
          try {
            const ev = JSON.parse(line) as BridgeEvent;
            recentEvents.push(ev);
          } catch {
            // битая строка — игнорируем
          }
        }
        if (recentEvents.length > 0) {
          console.log(
            `[bridge.server] warmed up ${recentEvents.length} events from previous session ${latestFile.f}`,
          );
        }
      }
    }
  } catch {
    // ничего не нашлось — стартуем с пустым буфером
  }

  // Подписка на шину: каждое событие сериализуем в JSONL + кладём в ring.
  // Renderer/SSE имеет свою отдельную подписку (в /stream-handler'е). JSONL
  // и SSE независимы — если Renderer закрыт, JSONL всё равно пишется.
  const onEvent = (event: BridgeEvent): void => {
    void session.write(event);
    recentEvents.push(event);
    if (recentEvents.length > RECENT_BUFFER_MAX) recentEvents.shift();
  };
  bus.on('event', onEvent);

  const app = new Hono();

  // CORS: UI грузится с vite-dev (http://localhost:5173) — другой origin, чем
  // bridge-server (http://127.0.0.1:3737). Браузер блокирует fetch без явного
  // Access-Control-Allow-Origin. В Electron-режиме это не нужно (renderer и
  // server в одном процессе), но bridge:server + browser UI требует.
  //
  // Security (ревью 2026-06-22, finding #2): сервер без auth, а write-эндпоинты
  // (CRUD routines/departments/skills, schedule/apply → launchd) опасны. Раньше
  // CORS для неизвестного origin отдавал '*' — любой сайт в браузере фаундера мог
  // слать мутации (CSRF/cross-origin). Теперь: (1) неизвестный origin → НЕ '*';
  // (2) для unsafe-методов жёсткая server-side проверка Origin (origin-guard ниже)
  // — она ловит даже simple-request обход, где preflight не срабатывает.
  const isLocalOrigin = (origin: string): boolean =>
    origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:');
  app.use(
    '*',
    cors({
      origin: (origin) => (origin !== undefined && isLocalOrigin(origin) ? origin : ''),
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['content-type'],
      maxAge: 86400,
    }),
  );

  // Origin-guard для мутаций: браузер ВСЕГДА шлёт Origin на cross-origin (включая
  // simple-request). Запросы без Origin (server-to-server: claude-code-hooks,
  // cron, curl) пропускаем — CSRF из браузера им не грозит. Cross-site браузерный
  // POST/PUT/PATCH/DELETE с чужим Origin → 403, независимо от CORS-заголовков.
  app.use('*', async (c, next) => {
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    const origin = c.req.header('origin');
    if (origin !== undefined && !isLocalOrigin(origin)) {
      return c.json(
        { ok: false, error: 'forbidden: cross-origin мутации запрещены (CSRF-guard)' },
        403,
      );
    }
    return next();
  });

  app.get('/healthz', (c) =>
    c.json({ ok: true, sessionId: session.sessionId, jsonlPath: session.filePath, port }),
  );

  // /diagnostics — что НЕ ОК прямо сейчас. UI рендерит этот ответ как баннер
  // сверху ленты, чтобы фаундер видел причину «ничего не происходит» без
  // лазания в логи. Никакой логики не запускает — только проверяет что есть.
  app.get('/diagnostics', (c) => {
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
    // Транспорт-aware проверка. src/llm/transport.ts: LLM_TRANSPORT=oauth (default) использует
    // gateway + claude CLI, ANTHROPIC_API_KEY не нужен. Для apikey-режима —
    // нужен. Если oauth-режим — пингуем gateway вместо проверки key'а.
    const transport = (process.env.LLM_TRANSPORT ?? 'oauth') as 'oauth' | 'apikey';
    if (transport === 'oauth') {
      const gw = process.env.LLM_GATEWAY_URL ?? 'http://127.0.0.1:8787';
      checks.push({
        name: 'LLM transport: oauth (gateway)',
        ok: true,
        detail: `${gw} · подписка claude.ai (src/llm/transport.ts). API-key не требуется.`,
      });
    } else {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      checks.push({
        name: 'ANTHROPIC_API_KEY',
        ok: typeof apiKey === 'string' && apiKey.length > 10,
        detail:
          typeof apiKey === 'string' && apiKey.length > 10
            ? `${apiKey.slice(0, 10)}…`
            : 'нет в env. положи в .env.local: ANTHROPIC_API_KEY=sk-ant-...',
      });
    }
    try {
      const dbPath = resolveDbPath();
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db.prepare<[], { c: number }>(`SELECT count(*) as c FROM "Record"`).get();
        checks.push({
          name: 'database',
          ok: true,
          detail: `${dbPath} · ${row?.c ?? 0} records`,
        });
      } finally {
        db.close();
      }
    } catch (err) {
      checks.push({
        name: 'database',
        ok: false,
        detail: `ошибка: ${err instanceof Error ? err.message : String(err)}. запусти: pnpm db:migrate`,
      });
    }
    const projectsPath = resolve(process.cwd(), 'config', 'projects.md');
    const projectsExists = existsSync(projectsPath);
    // config/projects.md ОПЦИОНАЛЕН (агенты agents/<id>/ работают без него), поэтому
    // его отсутствие НЕ роняет агрегатный health — иначе свежий OSS-клон (целевой
    // юзер фичи) показывал бы «нездоров» из-за файла, который сам же помечен опц.
    // (ревью D3-1). ok:true всегда; факт наличия — в detail.
    checks.push({
      name: 'config/projects.md',
      ok: true,
      detail: projectsExists
        ? projectsPath
        : "отсутствует (опционально: нужен только для cross-project routine'ов; агенты agents/<id>/ работают без него)",
    });
    const allOk = checks.every((c) => c.ok);
    return c.json({ ok: allOk, checks });
  });

  // Chat прямо из Bridge UI: фаундер пишет в окно, и сразу запускается тот же
  // handleChatMessage что и в Telegram-боте. Sub-agent SDK эмитит tool/text/spend
  // в шину bridge — UI видит ВСЁ в реальном времени, без второго процесса (бота)
  // и без переключения в Telegram. Реальная польза: один экран → один разговор
  // → видно что бот реально делает (читает файлы, гоняет bash) пока думает.
  // chatId = -1 — синтетический «UI-канал», чтобы не пересекаться с настоящими
  // Telegram chat_id'ами в Record.properties.chatId.
  app.post('/chat', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid-json' }, 400);
    }
    const text = (body as { text?: unknown })?.text;
    if (typeof text !== 'string' || text.trim().length === 0) {
      return c.json({ ok: false, error: 'text-required' }, 400);
    }
    try {
      const handler = await loadChatHandler();
      const reply = await handler(-1, text);
      return c.json({
        ok: true,
        reply: {
          text: reply.text,
          usd: reply.usd,
          durationMs: reply.durationMs,
          status: reply.status,
          sessionId: reply.sessionId,
        },
      });
    } catch (err) {
      console.error('[bridge:/chat]', err);
      const msg = err instanceof Error ? err.message : String(err);
      // Самая частая причина: dist/src/telegram/chat-handler.js не существует
      // — забыли запустить главный `tsc` перед `bridge:dev`. Подсказываем фаундеру.
      const hint =
        msg.includes('Cannot find module') || msg.includes('ERR_MODULE_NOT_FOUND')
          ? '. Запусти `pnpm build` или добавь `tsc -p tsconfig.json` в bridge:dev — нет dist/src/telegram/chat-handler.js'
          : '';
      return c.json({ ok: false, error: `${msg}${hint}` }, 500);
    }
  });

  app.post('/event/:kind', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid-json' }, 400);
    }

    // Привести входящий объект к BridgeEvent. Если type/ts/source не заданы —
    // подставляем дефолты, потому что claude-code-hooks (LIVE-режим) шлёт свой
    // формат и зашить туда type='tool.start' извне нельзя — это работа M2.
    // Для AI-Cofounder, который шлёт через src/observe/bridge.ts, поля уже стоят.
    const kindFromPath = c.req.param('kind');
    const obj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const raw = {
      ...obj,
      type: typeof obj.type === 'string' ? obj.type : kindFromPath,
      ts: typeof obj.ts === 'number' ? obj.ts : Date.now(),
      source: typeof obj.source === 'string' ? obj.source : 'claude-code-hooks',
    } as BridgeEvent;

    // Redaction: события от claude-code-hooks приходят без предварительной обработки
    // (в отличие от AI-Cofounder, где redaction сделана в src/observe/bridge.ts emit()).
    // Применяем redactSecrets на сериализованном JSON и десериализуем обратно, чтобы
    // секреты не попали ни в bus, ни в SSE, ни в JSONL.
    const redactedStr = redactSecrets(JSON.stringify(raw));
    const event = JSON.parse(redactedStr) as BridgeEvent;

    bus.publish(event);
    return c.json({ ok: true });
  });

  app.get('/metrics', (c) => {
    try {
      const data = queryMetrics();
      return c.json({ ok: true, data });
    } catch (err) {
      console.error('[metrics]', err);
      return c.json({
        ok: true,
        data: { totalUsd: 0, routinesRan: 0, toolCalls: 0, topRoutine: null, totalTokens: 0 },
      });
    }
  });

  // /activity — лента реальной деятельности из БД. Источник истины: таблица
  // Record. Возвращает последние N записей всех «человеческих» типов, чтобы UI
  // показал что бот реально делал/делает: чат-сообщения, расходы, support
  // fetch, выявленные проблемы, диагнозы, предложения, security-deny.
  // Работает независимо от того, эмитит ли процесс-бот в Bridge или нет —
  // это критично, потому что фаундер видит активность даже если bridge:dev
  // запустился позже бота.
  app.get('/activity', (c) => {
    try {
      const limit = Number.parseInt(c.req.query('limit') ?? '40', 10);
      const items = queryActivity(Number.isFinite(limit) ? Math.min(limit, 100) : 40);
      return c.json({ ok: true, items });
    } catch (err) {
      console.error('[activity]', err);
      return c.json({ ok: true, items: [] });
    }
  });

  // ── /routines, /routines/:id, /routines/:id/runs/:triggerId/transcript ──
  //
  // План 2026-05-17 «3D-офис AI-сотрудников»: фронт рендерит человечков-routine'ов
  // и им нужно знать: какие routine'ы есть, в каком они сейчас состоянии,
  // запускались ли, что было в transcript последнего run'а.
  //
  // Реестр routine'ов берётся из src/routines/registry.ts через runtime-import
  // (bridge/tsconfig.json изолирован, статический import невозможен). Состояние
  // — через better-sqlite3 read-only поверх таблицы Record (audit.routine.*,
  // event.routine.trigger, audit.spend).
  //
  // loadListRoutines кэширует только ИМПОРТ модуля-реестра (singleton-ссылку на
  // listRoutines), а сама listRoutines на каждый запрос перечитывает диск
  // (fast-glob + чтение каждого файла). Поэтому мутации (create/edit/delete агента
  // из UI) видны на следующем poll БЕЗ рестарта — это и нужно для CRUD из браузера.
  app.get('/routines', async (c) => {
    try {
      const listRoutines = await loadListRoutines();
      const routines = await listRoutines();
      const dbPath = resolveDbPath();
      const db = new Database(dbPath, { readonly: true });
      try {
        db.pragma('journal_mode = WAL');
        const items = routines.map((r) => buildRoutineSummary(db, r));
        return c.json({ ok: true, items });
      } finally {
        db.close();
      }
    } catch (err) {
      console.error('[routines]', err);
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get('/routines/:id', async (c) => {
    const id = c.req.param('id');
    try {
      const listRoutines = await loadListRoutines();
      const routines = await listRoutines();
      const found = routines.find((r) => r.id === id) ?? null;
      if (found === null) {
        return c.json({ ok: false, error: `routine '${id}' не найдена` }, 404);
      }
      const dbPath = resolveDbPath();
      const db = new Database(dbPath, { readonly: true });
      try {
        db.pragma('journal_mode = WAL');
        const recentRuns = listRecentRuns(db, id, 20);
        // Эндпоинт отдаёт ПОЛНЫЙ Routine (включая prompt/tools/maxTokens —
        // эти поля нужны Drawer-у на фронте). Полный Routine приходит из
        // listRoutines() — но наш узкий RoutineRecord только подвыборка. Чтобы
        // отдать всё — re-load в runtime через тот же кэш registry. Грузим
        // через `as Record<string, unknown>` чтобы не дублировать тип в bridge.
        const fullRoutine = found as RoutineRecord & Record<string, unknown>;
        // nextRunAt вычисляем тут же — drawer показывает «следующий запуск»
        // относительно сейчас, без отдельного запроса в /routines.
        const nextRunAt = computeNextRunAt(found.trigger);
        return c.json({
          ok: true,
          routine: { ...fullRoutine, ...(nextRunAt !== undefined ? { nextRunAt } : {}) },
          recentRuns,
        });
      } finally {
        db.close();
      }
    } catch (err) {
      console.error('[routines/:id]', err);
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // GET /routines/:id/skills — discovery-DTO для скиллов конкретной routine'ы
  // (с резолвом транзитивных deps). UI рендерит из этих данных бейджи
  // поверх аватара сотрудника + список скиллов в drawer'е. Фаза 3 плана
  // 2026-05-21-skills-architecture-v3.
  app.get('/routines/:id/skills', async (c) => {
    const id = c.req.param('id');
    try {
      const listRoutines = await loadListRoutines();
      const routines = await listRoutines();
      const found = routines.find((r) => r.id === id) ?? null;
      if (found === null) {
        return c.json({ ok: false, error: `routine '${id}' не найдена` }, 404);
      }
      const skills = await resolveRoutineSkillsForUi(found);
      return c.json({ ok: true, skills });
    } catch (err) {
      console.error('[routines/:id/skills]', err);
      const msg = err instanceof Error ? err.message : String(err);
      const hint =
        msg.includes('Cannot find module') || msg.includes('ERR_MODULE_NOT_FOUND')
          ? '. Запусти `pnpm exec tsc -p tsconfig.json` чтобы появился dist/src/skills/registry.js'
          : '';
      return c.json({ ok: false, error: `${msg}${hint}` }, 500);
    }
  });

  // GET /skills — все скиллы как лёгкий discovery-DTO (Фаза 4 плана
  // 2026-05-21-skills-architecture-v3). Без body SKILL.md и без permissions
  // — тяжёлый payload не нужен в маркетплейс-листинге. Каждый объект
  // содержит поле `usedBy: string[]` — routine-id'ы, где скилл объявлен
  // в `skills: [...]` (без транзитивных deps). Это «used by X сотрудниками»
  // в карточке.
  app.get('/skills', async (c) => {
    try {
      const skills = await listAllSkills();
      return c.json({ ok: true, skills });
    } catch (err) {
      console.error('[skills]', err);
      const msg = err instanceof Error ? err.message : String(err);
      const hint =
        msg.includes('Cannot find module') || msg.includes('ERR_MODULE_NOT_FOUND')
          ? '. Запусти `pnpm exec tsc -p tsconfig.json` чтобы появился dist/src/skills/registry.js'
          : '';
      return c.json({ ok: false, error: `${msg}${hint}` }, 500);
    }
  });

  // GET /skills/health — последние health-check'и для всех скиллов, у
  // которых хоть раз прогонялся health-check. Фронт читает каждые 30s,
  // карточка в маркетплейсе показывает цветную точку.
  // ВАЖНО: объявлен ДО /skills/:name, иначе wildcard перехватит "health"
  // как имя скилла.
  app.get('/skills/health', async (c) => {
    try {
      const items = await listSkillHealth();
      return c.json({ ok: true, items });
    } catch (err) {
      console.error('[skills/health]', err);
      const msg = err instanceof Error ? err.message : String(err);
      const hint =
        msg.includes('Cannot find module') || msg.includes('ERR_MODULE_NOT_FOUND')
          ? '. Запусти `pnpm exec tsc -p tsconfig.json` чтобы появился dist/src/skills/health-store.js'
          : '';
      return c.json({ ok: false, error: `${msg}${hint}`, items: [] }, 500);
    }
  });

  // GET /skills/:name — полный DTO одного скилла. Включает body SKILL.md
  // (markdown), permissions из permissions.md, dependsOn, usedBy. Это то,
  // что рендерит SkillDetailDrawer в маркетплейсе. 404 если скилла нет.
  // GET /skills/:name/raw — сырые SKILL.md + permissions.md для prefill
  // edit-режима (Ф5). Объявлен ДО /skills/:name (3-сегментный путь, но порядок
  // для ясности). name проходит kebab-валидацию в readSkillRaw.
  app.get('/skills/:name/raw', async (c) => {
    const name = c.req.param('name');
    if (name === undefined) return c.json({ ok: false, error: 'name-required' }, 400);
    try {
      const raw = await readSkillRaw(name);
      return c.json({ ok: true, ...raw });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: msg }, skillErrorStatus(msg));
    }
  });

  app.get('/skills/:name', async (c) => {
    const name = c.req.param('name');
    try {
      const skill = await getSkillFull(name);
      if (skill === null) {
        return c.json({ ok: false, error: `skill '${name}' не найден` }, 404);
      }
      return c.json({ ok: true, skill });
    } catch (err) {
      console.error('[skills/:name]', err);
      const msg = err instanceof Error ? err.message : String(err);
      const hint =
        msg.includes('Cannot find module') || msg.includes('ERR_MODULE_NOT_FOUND')
          ? '. Запусти `pnpm exec tsc -p tsconfig.json` чтобы появился dist/src/skills/registry.js'
          : '';
      return c.json({ ok: false, error: `${msg}${hint}` }, 500);
    }
  });

  // PUT /skills/:name — перезапись существующего скилла (Ф5). DELETE — удаление.
  app.put('/skills/:name', async (c) => {
    const name = c.req.param('name');
    if (name === undefined) return c.json({ ok: false, error: 'name-required' }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid-json' }, 400);
    }
    const o = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const skillMd = typeof o.skillMd === 'string' ? o.skillMd : '';
    const permissionsMd = typeof o.permissionsMd === 'string' ? o.permissionsMd : '';
    try {
      const res = await updateSkill({ name, skillMd, permissionsMd });
      return c.json({ ok: true, ...res });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: msg }, skillErrorStatus(msg));
    }
  });

  app.delete('/skills/:name', async (c) => {
    const name = c.req.param('name');
    if (name === undefined) return c.json({ ok: false, error: 'name-required' }, 400);
    try {
      const res = await deleteSkill(name);
      return c.json({ ok: true, ...res });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: msg }, skillErrorStatus(msg));
    }
  });

  // POST /skills — создание нового скилла из SkillBuilder wizard'а.
  // Принимает {name, skillMd, permissionsMd}, валидирует через parseSkillSources,
  // пишет в skills/<name>/{SKILL.md, permissions.md}. Возвращает 400 с подробностями
  // ошибки, если что-то невалидно. Безопасность: имя проходит strict-validation
  // (kebab-case), запись только внутрь skills/<name>/, никакого path-traversal.
  app.post('/skills', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid-json' }, 400);
    }
    const obj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name : '';
    const skillMd = typeof obj.skillMd === 'string' ? obj.skillMd : '';
    const permissionsMd = typeof obj.permissionsMd === 'string' ? obj.permissionsMd : '';

    try {
      const created = await saveNewSkill({ name, skillMd, permissionsMd });
      return c.json({ ok: true, ...created });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: msg }, skillErrorStatus(msg));
    }
  });

  // POST /skills/builder/message — один turn чат-сессии в SkillBuilder.
  // Принимает {history: [...], userMessage}, отправляет в Sonnet через
  // существующий subagent/call. Возвращает {assistantMessage, draftSkillMd,
  // draftPermissionsMd}. Stateless: вся history передаётся каждый раз.
  app.post('/skills/builder/message', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid-json' }, 400);
    }
    const obj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const userMessage = typeof obj.userMessage === 'string' ? obj.userMessage : '';
    if (userMessage.trim().length === 0) {
      return c.json({ ok: false, error: 'userMessage-required' }, 400);
    }
    // Защита от token-DDoS: cap на длину сообщения и историю.
    // /skills/builder/message ходит к LLM (Sonnet) — без лимита
    // пользователь / злоумышленник может отправить мегабайтный prompt и
    // выжечь подписочный лимит за один запрос.
    const MAX_USER_MESSAGE_CHARS = 16_000; // ~4k токенов
    const MAX_HISTORY_ITEMS = 40;
    const MAX_HISTORY_TEXT_CHARS = 8_000; // на один item
    if (userMessage.length > MAX_USER_MESSAGE_CHARS) {
      return c.json(
        {
          ok: false,
          error: `userMessage слишком большой: ${userMessage.length} > ${MAX_USER_MESSAGE_CHARS} символов`,
        },
        413,
      );
    }
    const rawHistory = Array.isArray(obj.history) ? obj.history : [];
    if (rawHistory.length > MAX_HISTORY_ITEMS) {
      return c.json(
        {
          ok: false,
          error: `history слишком большая: ${rawHistory.length} > ${MAX_HISTORY_ITEMS} элементов`,
        },
        413,
      );
    }
    const history: SkillBuilderHistoryItem[] = [];
    for (const item of rawHistory) {
      if (typeof item !== 'object' || item === null) continue;
      const it = item as Record<string, unknown>;
      const role = it.role === 'assistant' ? 'assistant' : 'user';
      const text = typeof it.text === 'string' ? it.text : '';
      if (text === '') continue;
      // Hard-cap каждого item'а, чтобы один зловредный append не раздул prompt.
      const capped =
        text.length > MAX_HISTORY_TEXT_CHARS ? text.slice(0, MAX_HISTORY_TEXT_CHARS) : text;
      history.push({ role, text: capped });
    }

    try {
      const reply = await handleSkillBuilderMessage({ history, userMessage });
      return c.json({ ok: true, ...reply });
    } catch (err) {
      console.error('[skills/builder/message]', err);
      const msg = err instanceof Error ? err.message : String(err);
      const hint =
        msg.includes('Cannot find module') || msg.includes('ERR_MODULE_NOT_FOUND')
          ? '. Запусти `pnpm exec tsc -p tsconfig.json` чтобы появился dist/src/llm/call.js'
          : '';
      return c.json({ ok: false, error: `${msg}${hint}` }, 500);
    }
  });

  // GET /content/briefs/latest — текущий article brief для human review gate.
  app.get('/content/briefs/latest', async (c) => {
    const briefPath = resolve(process.cwd(), 'content', 'briefs', 'article-brief-latest.md');
    try {
      const markdown = await readFile(briefPath, 'utf8');
      const statusMatch = /^Status:\s*(.+)$/m.exec(markdown);
      const titleMatch = /^#\s+Article Brief:\s*(.+)$/m.exec(markdown);
      const keywordMatch = /^CORE-KEYWORD:\s*(.+)$/m.exec(markdown);
      return c.json({
        ok: true,
        path: briefPath,
        status: statusMatch?.[1]?.trim() ?? 'unknown',
        title: titleMatch?.[1]?.trim() ?? null,
        coreKeyword: keywordMatch?.[1]?.trim() ?? null,
        markdown,
      });
    } catch (err) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: unknown }).code)
          : '';
      if (code === 'ENOENT') {
        return c.json({ ok: false, error: 'latest brief не найден' }, 404);
      }
      console.error('[content/briefs/latest]', err);
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // POST /content/briefs/latest/approve — ручное подтверждение brief.
  // Меняет только Status в latest-файле; writer потом можно запустить обычной кнопкой.
  app.post('/content/briefs/latest/approve', async (c) => {
    const briefPath = resolve(process.cwd(), 'content', 'briefs', 'article-brief-latest.md');
    try {
      const markdown = await readFile(briefPath, 'utf8');
      if (!/^Status:\s*needs_human_review\s*$/m.test(markdown)) {
        const statusMatch = /^Status:\s*(.+)$/m.exec(markdown);
        return c.json(
          {
            ok: false,
            error: `brief сейчас не в needs_human_review (Status: ${statusMatch?.[1]?.trim() ?? 'unknown'})`,
          },
          409,
        );
      }
      const updated = markdown.replace(/^Status:\s*needs_human_review\s*$/m, 'Status: approved');
      await writeFile(briefPath, updated, 'utf8');
      return c.json({ ok: true, path: briefPath, status: 'approved' });
    } catch (err) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: unknown }).code)
          : '';
      if (code === 'ENOENT') {
        return c.json({ ok: false, error: 'latest brief не найден' }, 404);
      }
      console.error('[content/briefs/latest/approve]', err);
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // POST /routines/:id/run — ручной запуск routine из UI (кнопка
  // «Запустить сейчас» в RoutineDetailDrawer). Реализация повторяет
  // scripts/dev-run-routine.ts: dynamic import из dist/src/, чтобы bridge
  // tsconfig (rootDir=bridge) не тащил src/-зависимости статически.
  // Возвращаем сразу 202 — runRoutine крутится в фоне, фронт следит за
  // прогрессом через SSE (routine.start/end + tool.start/end).
  app.post('/routines/:id/run', async (c) => {
    const routineId = c.req.param('id');
    try {
      const dispatcherPath = resolve(process.cwd(), 'dist', 'src', 'core', 'dispatcher.js');
      const triggersPath = resolve(process.cwd(), 'dist', 'src', 'core', 'triggers.js');
      const dispatcher = (await import(pathToFileURL(dispatcherPath).href)) as {
        runRoutine: (id: string, runDate: string, trigger: unknown) => Promise<void>;
      };
      const triggers = (await import(pathToFileURL(triggersPath).href)) as {
        triggerManualRoutine: (id: string) => unknown;
      };
      const now = new Date();
      const runDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const trigger = triggers.triggerManualRoutine(routineId);
      // Запускаем в фоне, отвечаем сразу — UI следит через SSE.
      void dispatcher.runRoutine(routineId, runDate, trigger).catch((err: unknown) => {
        console.error('[/routines/:id/run] runRoutine threw', err);
      });
      return c.json({ ok: true, routineId, runDate }, 202);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const hint =
        msg.includes('Cannot find module') || msg.includes('ERR_MODULE_NOT_FOUND')
          ? '. Запусти `pnpm exec tsc -p tsconfig.json` чтобы появился dist/src/core/dispatcher.js'
          : '';
      return c.json({ ok: false, error: `${msg}${hint}` }, 500);
    }
  });

  // GET /projects — список проектов из config/projects.md для UI (дропдаун при
  // создании агента + вывод id-префикса). 'self' (синтетический owner agents/<id>/)
  // не отдаём — это отдельный формат, не редактируется этим UI.
  app.get('/projects', async (c) => {
    try {
      const modPath = resolve(process.cwd(), 'dist', 'src', 'projects', 'registry.js');
      const mod = (await import(pathToFileURL(modPath).href)) as {
        listProjects: (opts?: {
          cwd?: string;
          includeSelfProject?: boolean;
        }) => Promise<Array<{ id: string; name: string; routinesGlob: string; enabled: boolean }>>;
      };
      // includeSelfProject:true — чтобы при ОТСУТСТВУЮЩЕМ config/projects.md
      // registry не бросал (свежий OSS-клон без проектов), а отдал только
      // синтетический 'self', который ниже отфильтровываем → items=[]. Так UI
      // получает пустой список (агент создаётся в agents/<id>/, проект не нужен),
      // а не 500.
      const projects = await mod.listProjects({ cwd: process.cwd(), includeSelfProject: true });
      const items = projects
        .filter((p) => p.id !== 'self')
        .map((p) => ({
          id: p.id,
          name: p.name,
          routinesGlob: p.routinesGlob,
          enabled: p.enabled,
        }));
      return c.json({ ok: true, items });
    } catch (err) {
      console.error('[projects]', err);
      const msg = err instanceof Error ? err.message : String(err);
      const hint =
        msg.includes('Cannot find module') || msg.includes('ERR_MODULE_NOT_FOUND')
          ? '. Запусти `pnpm exec tsc` чтобы появился dist/src/projects/registry.js'
          : '';
      return c.json({ ok: false, error: `${msg}${hint}` }, 500);
    }
  });

  // ── Departments (Ф4) ───────────────────────────────────────────────────────
  // GET /departments — отделы + кол-во членов (routines с этим departmentId).
  app.get('/departments', async (c) => {
    try {
      const deptPath = resolve(process.cwd(), 'dist', 'src', 'departments', 'registry.js');
      const deptMod = (await import(pathToFileURL(deptPath).href)) as {
        listDepartments: (opts?: {
          cwd?: string;
        }) => Promise<Array<{ id: string; name: string; description: string; budget?: unknown }>>;
      };
      const departments = await deptMod.listDepartments({ cwd: process.cwd() });
      // Считаем членов: routines с departmentId.
      const listRoutines = await loadListRoutines();
      const routines = (await listRoutines()) as Array<{ id: string; departmentId?: string }>;
      const items = departments.map((d) => {
        const members = routines.filter((r) => r.departmentId === d.id).map((r) => r.id);
        return { id: d.id, name: d.name, description: d.description, budget: d.budget, members };
      });
      return c.json({ ok: true, items });
    } catch (err) {
      console.error('[departments]', err);
      const msg = err instanceof Error ? err.message : String(err);
      const hint =
        msg.includes('Cannot find module') || msg.includes('ERR_MODULE_NOT_FOUND')
          ? '. Запусти `pnpm exec tsc` чтобы появился dist/src/departments/registry.js'
          : '';
      return c.json({ ok: false, error: `${msg}${hint}` }, 500);
    }
  });

  app.post('/departments', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid-json' }, 400);
    }
    const o = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    for (const k of ['id', 'name', 'description']) {
      if (typeof o[k] !== 'string' || (o[k] as string) === '') {
        return c.json({ ok: false, error: `поле '${k}' обязательно (непустая строка)` }, 400);
      }
    }
    const input: DepartmentCreateInput = {
      id: o.id as string,
      name: o.name as string,
      description: o.description as string,
    };
    if (typeof o.budget === 'object' && o.budget !== null) {
      const b = o.budget as Record<string, unknown>;
      if (typeof b.perDayUsd === 'number' && typeof b.perRunUsd === 'number') {
        input.budget = { perDayUsd: b.perDayUsd, perRunUsd: b.perRunUsd };
      }
    }
    try {
      const res = await createDepartment(input);
      return c.json(res, 201);
    } catch (err) {
      if (err instanceof DepartmentWriteError) {
        return c.json({ ok: false, error: err.message }, err.status);
      }
      console.error('[POST /departments]', err);
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.delete('/departments/:id', async (c) => {
    const id = c.req.param('id');
    if (id === undefined) return c.json({ ok: false, error: 'id-required' }, 400);
    try {
      const res = await deleteDepartment(id);
      return c.json(res);
    } catch (err) {
      if (err instanceof DepartmentWriteError) {
        return c.json({ ok: false, error: err.message }, err.status);
      }
      console.error('[DELETE /departments/:id]', err);
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── Routine CRUD (Ф1 плана 2026-06-22-bridge-control-panel) ────────────────
  // Запись на диск через bridge/routines-write.ts: dist-serializer + защита от
  // path-traversal + атомарная запись (temp+rename). GET /routines читает реестр
  // с диска заново на каждый запрос, поэтому после мутации UI видит изменения на
  // следующем poll'е — инвалидация кэша не нужна.
  const asStrArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

  app.post('/routines', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid-json' }, 400);
    }
    const o = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

    // Маршрутизация формата. Реальный projectId (не пустой и не 'self') → legacy
    // routines/<id>.md (нужен проект из config/projects.md). Иначе (по умолчанию) —
    // самодостаточный agents/<id>/, привязанный к синтетическому 'self':
    // config/projects.md НЕ требуется. Это путь «создать агента из браузера без
    // ручной правки файлов» (план 2026-06-23).
    const reqProjectId = typeof o.projectId === 'string' ? o.projectId : '';
    const isLegacy = reqProjectId !== '' && reqProjectId !== 'self';

    if (!isLegacy) {
      for (const k of ['id', 'trigger', 'model', 'outputType', 'description', 'prompt']) {
        if (typeof o[k] !== 'string' || (o[k] as string) === '') {
          return c.json({ ok: false, error: `поле '${k}' обязательно (непустая строка)` }, 400);
        }
      }
      if (typeof o.enabled !== 'boolean') {
        return c.json({ ok: false, error: "поле 'enabled' обязательно (boolean)" }, 400);
      }
      // displayName = role (имя «сотрудника» в офисе). Fallback на id.
      const displayName =
        typeof o.role === 'string' && o.role.trim() !== ''
          ? o.role.trim()
          : typeof o.displayName === 'string' && o.displayName.trim() !== ''
            ? o.displayName.trim()
            : (o.id as string);
      const agentInput: AgentCreateInput = {
        id: o.id as string,
        displayName,
        description: o.description as string,
        prompt: o.prompt as string,
        model: o.model as string,
        enabled: o.enabled,
        trigger: o.trigger as string,
        outputType: o.outputType as string,
      };
      if (typeof o.maxTokens === 'number') agentInput.maxTokens = o.maxTokens;
      if (typeof o.timeoutMs === 'number') agentInput.timeoutMs = o.timeoutMs;
      if (typeof o.avatar === 'string' && o.avatar !== '') agentInput.avatar = o.avatar;
      if (typeof o.color === 'string' && o.color !== '') agentInput.color = o.color;
      if (typeof o.logo === 'string' && o.logo !== '') agentInput.logo = o.logo;
      if (typeof o.departmentId === 'string' && o.departmentId !== '')
        agentInput.departmentId = o.departmentId;
      const aSkills = asStrArray(o.skills);
      if (aSkills !== undefined) agentInput.skills = aSkills;
      const aForce = asStrArray(o.forceLoad);
      if (aForce !== undefined) agentInput.forceLoad = aForce;
      const aTools = asStrArray(o.tools);
      if (aTools !== undefined && aTools.length > 0) agentInput.tools = aTools;
      const aBash = asStrArray(o.bashWhitelist);
      if (aBash !== undefined && aBash.length > 0) agentInput.bashWhitelist = aBash;
      try {
        const res = await createAgent(agentInput);
        return c.json(res, 201);
      } catch (err) {
        if (err instanceof AgentWriteError) {
          return c.json({ ok: false, error: err.message }, err.status);
        }
        console.error('[POST /routines:agent]', err);
        const msg = err instanceof Error ? err.message : String(err);
        const hint =
          msg.includes('Cannot find module') || msg.includes('ERR_MODULE_NOT_FOUND')
            ? '. Запусти `pnpm exec tsc` чтобы появился dist/src/routines/agent-serializer.js'
            : '';
        return c.json({ ok: false, error: `${msg}${hint}` }, 500);
      }
    }

    // ── legacy routines/<id>.md (явно задан реальный projectId) ──
    for (const k of [
      'id',
      'projectId',
      'trigger',
      'model',
      'outputType',
      'description',
      'prompt',
    ]) {
      if (typeof o[k] !== 'string' || (o[k] as string) === '') {
        return c.json({ ok: false, error: `поле '${k}' обязательно (непустая строка)` }, 400);
      }
    }
    if (typeof o.enabled !== 'boolean') {
      return c.json({ ok: false, error: "поле 'enabled' обязательно (boolean)" }, 400);
    }
    const tools = asStrArray(o.tools);
    if (tools === undefined) {
      return c.json({ ok: false, error: "поле 'tools' обязательно (массив строк)" }, 400);
    }
    if (typeof o.maxTokens !== 'number' || typeof o.timeoutMs !== 'number') {
      return c.json({ ok: false, error: "'maxTokens' и 'timeoutMs' обязательны (числа)" }, 400);
    }
    const input: RoutineCreateInput = {
      id: o.id as string,
      projectId: o.projectId as string,
      enabled: o.enabled,
      trigger: o.trigger as string,
      tools,
      model: o.model as string,
      maxTokens: o.maxTokens,
      timeoutMs: o.timeoutMs,
      outputType: o.outputType as string,
      description: o.description as string,
      prompt: o.prompt as string,
    };
    if (typeof o.role === 'string') input.role = o.role;
    if (typeof o.avatar === 'string') input.avatar = o.avatar;
    if (typeof o.color === 'string') input.color = o.color;
    if (typeof o.logo === 'string') input.logo = o.logo;
    const bw = asStrArray(o.bashWhitelist);
    if (bw !== undefined) input.bashWhitelist = bw;
    const sk = asStrArray(o.skills);
    if (sk !== undefined) input.skills = sk;
    const fl = asStrArray(o.forceLoad);
    if (fl !== undefined) input.forceLoad = fl;
    if (typeof o.departmentId === 'string') input.departmentId = o.departmentId;
    if (typeof o.targetProject === 'string') input.targetProject = o.targetProject;

    try {
      const res = await createRoutine(input);
      return c.json(res, 201);
    } catch (err) {
      if (err instanceof RoutineWriteError) {
        return c.json({ ok: false, error: err.message }, err.status);
      }
      console.error('[POST /routines]', err);
      const msg = err instanceof Error ? err.message : String(err);
      const hint =
        msg.includes('Cannot find module') || msg.includes('ERR_MODULE_NOT_FOUND')
          ? '. Запусти `pnpm exec tsc` чтобы появился dist/src/routines/serializer.js'
          : '';
      return c.json({ ok: false, error: `${msg}${hint}` }, 500);
    }
  });

  // PUT и PATCH — частичное обновление (applyRoutinePatch по своей природе
  // частичный; id/projectId сменить нельзя — они фиксируют discovery). Для
  // опциональных полей null = удалить строку из frontmatter.
  const coerceRoutinePatch = (o: Record<string, unknown>): RoutinePatchLike => {
    const patch: RoutinePatchLike = {};
    if (typeof o.enabled === 'boolean') patch.enabled = o.enabled;
    if (typeof o.trigger === 'string') patch.trigger = o.trigger;
    if (typeof o.model === 'string') patch.model = o.model;
    if (typeof o.maxTokens === 'number') patch.maxTokens = o.maxTokens;
    if (typeof o.timeoutMs === 'number') patch.timeoutMs = o.timeoutMs;
    if (typeof o.outputType === 'string') patch.outputType = o.outputType;
    if (typeof o.description === 'string') patch.description = o.description;
    if (typeof o.prompt === 'string') patch.prompt = o.prompt;
    const tools = asStrArray(o.tools);
    if (tools !== undefined) patch.tools = tools;
    // Nullable: значение — установить, null — удалить, отсутствие — не трогать.
    for (const k of ['role', 'avatar', 'color', 'logo', 'departmentId', 'targetProject'] as const) {
      if (o[k] === null) patch[k] = null;
      else if (typeof o[k] === 'string') patch[k] = o[k] as string;
    }
    for (const k of ['bashWhitelist', 'skills', 'forceLoad'] as const) {
      if (o[k] === null) patch[k] = null;
      else {
        const arr = asStrArray(o[k]);
        if (arr !== undefined) patch[k] = arr;
      }
    }
    return patch;
  };

  // Патч для agents/<id>/ (нет projectId/targetProject — формат привязан к 'self').
  const coerceAgentPatch = (o: Record<string, unknown>): AgentUpdatePatch => {
    const patch: AgentUpdatePatch = {};
    // У агента role == displayName (имя «сотрудника»). Пустой не шлём — это
    // обязательное поле AGENT.md, валидация всё равно отвергла бы.
    if (typeof o.role === 'string' && o.role.trim() !== '') patch.displayName = o.role.trim();
    if (typeof o.enabled === 'boolean') patch.enabled = o.enabled;
    if (typeof o.trigger === 'string') patch.trigger = o.trigger;
    if (typeof o.model === 'string') patch.model = o.model;
    if (typeof o.maxTokens === 'number') patch.maxTokens = o.maxTokens;
    if (typeof o.timeoutMs === 'number') patch.timeoutMs = o.timeoutMs;
    if (typeof o.outputType === 'string') patch.outputType = o.outputType;
    if (typeof o.description === 'string') patch.description = o.description;
    if (typeof o.prompt === 'string') patch.prompt = o.prompt;
    for (const k of ['avatar', 'color', 'logo', 'departmentId'] as const) {
      if (o[k] === null) patch[k] = null;
      else if (typeof o[k] === 'string') patch[k] = o[k] as string;
    }
    for (const k of ['skills', 'forceLoad'] as const) {
      if (o[k] === null) patch[k] = null;
      else {
        const arr = asStrArray(o[k]);
        if (arr !== undefined) patch[k] = arr;
      }
    }
    const tools = asStrArray(o.tools);
    if (tools !== undefined) patch.tools = tools;
    const bash = asStrArray(o.bashWhitelist);
    if (bash !== undefined) patch.bashWhitelist = bash;
    return patch;
  };

  // Рантайм-Routine шире узкого RoutineRecord: содержит agentDir для agents/<id>/.
  // По его наличию маршрутизируем UPDATE/DELETE на agents-write vs routines-write.
  const findRoutineRaw = async (id: string): Promise<Record<string, unknown> | null> => {
    const listRoutines = await loadListRoutines();
    const routines = (await listRoutines()) as unknown as Array<Record<string, unknown>>;
    return routines.find((r) => r.id === id) ?? null;
  };
  const isAgentRecord = (r: Record<string, unknown> | null): boolean =>
    r !== null && typeof r.agentDir === 'string' && r.agentDir !== '';

  const handleRoutineUpdate = async (c: Context): Promise<Response> => {
    const id = c.req.param('id');
    if (id === undefined) return c.json({ ok: false, error: 'id-required' }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid-json' }, 400);
    }
    const o = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    try {
      const existing = await findRoutineRaw(id);
      const res = isAgentRecord(existing)
        ? await updateAgent(id, coerceAgentPatch(o))
        : await updateRoutine(id, coerceRoutinePatch(o));
      return c.json(res);
    } catch (err) {
      if (err instanceof RoutineWriteError || err instanceof AgentWriteError) {
        return c.json({ ok: false, error: err.message }, err.status);
      }
      console.error('[PUT/PATCH /routines/:id]', err);
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  };
  app.put('/routines/:id', handleRoutineUpdate);
  app.patch('/routines/:id', handleRoutineUpdate);

  app.delete('/routines/:id', async (c) => {
    const id = c.req.param('id');
    if (id === undefined) return c.json({ ok: false, error: 'id-required' }, 400);
    try {
      const existing = await findRoutineRaw(id);
      const res = isAgentRecord(existing) ? await deleteAgent(id) : await deleteRoutine(id);
      return c.json(res);
    } catch (err) {
      if (err instanceof RoutineWriteError || err instanceof AgentWriteError) {
        return c.json({ ok: false, error: err.message }, err.status);
      }
      console.error('[DELETE /routines/:id]', err);
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // POST /routines/:id/schedule/apply — применить расписание к launchd (Ф3).
  // Опасно: мутирует живой планировщик мака, поэтому вызывается ТОЛЬКО по явному
  // подтверждению из UI. enabled+cron → пишет plist + launchctl load; manual или
  // disabled → unload + удаляет plist. Возвращает action + nextRunAt.
  app.post('/routines/:id/schedule/apply', async (c) => {
    const id = c.req.param('id');
    if (id === undefined) return c.json({ ok: false, error: 'id-required' }, 400);
    // Планировщик в v1 — только launchd (macOS). На других ОС честно говорим, а не
    // падаем cryptic-ошибкой `launchctl: command not found` из глубины.
    if (process.platform !== 'darwin') {
      return c.json(
        {
          ok: false,
          error:
            'Применение расписания работает только на macOS (launchd). На этой ОС запускай агента вручную кнопкой «Запустить» или настрой cron/systemd-timer сам.',
        },
        400,
      );
    }
    try {
      const regPath = resolve(process.cwd(), 'dist', 'src', 'routines', 'registry.js');
      const launchdPath = resolve(process.cwd(), 'dist', 'src', 'routines', 'launchd.js');
      const reg = (await import(pathToFileURL(regPath).href)) as {
        getRoutine: (id: string, opts?: { cwd?: string }) => Promise<RoutineRecord | null>;
      };
      const launchd = (await import(pathToFileURL(launchdPath).href)) as {
        applyRoutineSchedule: (
          routine: unknown,
          opts?: { repoRoot?: string },
        ) => { action: string; plistPath?: string; reason: string };
      };
      const routine = await reg.getRoutine(id, { cwd: process.cwd() });
      if (routine === null) {
        return c.json({ ok: false, error: `routine '${id}' не найдена` }, 404);
      }
      const result = launchd.applyRoutineSchedule(routine, { repoRoot: process.cwd() });
      const nextRunAt = computeNextRunAt(routine.trigger);
      return c.json({ ok: true, ...result, ...(nextRunAt !== undefined ? { nextRunAt } : {}) });
    } catch (err) {
      console.error('[POST /routines/:id/schedule/apply]', err);
      const msg = err instanceof Error ? err.message : String(err);
      const hint =
        msg.includes('Cannot find module') || msg.includes('ERR_MODULE_NOT_FOUND')
          ? '. Запусти `pnpm exec tsc` чтобы появился dist/src/routines/launchd.js'
          : '';
      return c.json({ ok: false, error: `${msg}${hint}` }, 500);
    }
  });

  app.get('/routines/:id/runs/:triggerId/transcript', (c) => {
    const triggerId = c.req.param('triggerId');
    try {
      const dbPath = resolveDbPath();
      const db = new Database(dbPath, { readonly: true });
      try {
        db.pragma('journal_mode = WAL');
        const events = buildTranscript(db, triggerId);
        if (events === null) {
          return c.json({ ok: false, error: `triggerId '${triggerId}' не найден` }, 404);
        }
        return c.json({ ok: true, events });
      } finally {
        db.close();
      }
    } catch (err) {
      console.error('[routines/:id/runs/:triggerId/transcript]', err);
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── /analytics/* — KPI dashboard (Фаза 8 плана 2026-05-21-skills-architecture-v3).
  //
  // Все запросы dynamically импортируют dist/src/analytics/queries.js (тот же
  // паттерн, что /routines, /skills). Bridge tsconfig изолирован — статический
  // импорт из src/ невозможен. Если dist/ нет — отдаём 500 с подсказкой.
  app.get('/analytics/summary', async (c) => {
    const period = c.req.query('period') ?? '7d';
    try {
      const mod = await loadAnalyticsQueries();
      const data = await mod.getAnalyticsSummary({ period });
      return c.json({ ok: true, data });
    } catch (err) {
      return c.json(analyticsErrorBody(err), 500);
    }
  });

  app.get('/analytics/posts', async (c) => {
    const period = c.req.query('period') ?? '30d';
    try {
      const mod = await loadAnalyticsQueries();
      const items = await mod.getPostsList({ period });
      return c.json({ ok: true, items });
    } catch (err) {
      return c.json(analyticsErrorBody(err), 500);
    }
  });

  app.get('/analytics/cost-trend', async (c) => {
    const weeks = Math.min(
      Math.max(Number.parseInt(c.req.query('weeks') ?? '12', 10) || 12, 1),
      52,
    );
    try {
      const mod = await loadAnalyticsQueries();
      const items = await mod.getCostTrend({ weeks });
      return c.json({ ok: true, items });
    } catch (err) {
      return c.json(analyticsErrorBody(err), 500);
    }
  });

  app.get('/analytics/traffic-trend', async (c) => {
    const weeks = Math.min(
      Math.max(Number.parseInt(c.req.query('weeks') ?? '12', 10) || 12, 1),
      52,
    );
    try {
      const mod = await loadAnalyticsQueries();
      const items = await mod.getTrafficTrend({ weeks });
      return c.json({ ok: true, items });
    } catch (err) {
      return c.json(analyticsErrorBody(err), 500);
    }
  });

  // SECURITY (R2, security-review 1.5b): listener подписывается на bus в начале,
  // отписывается в finally — гарантированно, даже если writeSSE/promise упадут до
  // onAbort. Heartbeat каждые 25 сек предотвращает закрытие соединения
  // прокси/браузером по idle (мостик.md L361 «reliability»).
  app.get('/stream', (c) => {
    // Опциональный query-param `?replay=N` — сколько последних buffered
    // events отдать на старте перед подпиской на live. Дефолт: 200 (покрывает
    // десяток минут работы тяжёлого routine). 0 — выключить replay.
    // Max — RECENT_BUFFER_MAX (мы не храним больше).
    const replayRaw = c.req.query('replay');
    const replayN =
      replayRaw === undefined
        ? 200
        : Math.max(0, Math.min(RECENT_BUFFER_MAX, Number.parseInt(replayRaw, 10) || 0));

    return streamSSE(c, async (stream) => {
      // ── Replay: на старте подключения сразу отдаём последние N events,
      // чтобы фронт открытый посреди прогона видел контекст.
      if (replayN > 0 && recentEvents.length > 0) {
        const slice = recentEvents.slice(-replayN);
        for (const ev of slice) {
          await stream.writeSSE({ data: JSON.stringify(ev), event: ev.type });
        }
      }

      const handler = (event: BridgeEvent): void => {
        void stream.writeSSE({ data: JSON.stringify(event), event: event.type });
      };
      bus.on('event', handler);

      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: 'heartbeat', data: '' }).catch(() => {});
      }, 25_000);

      try {
        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve());
        });
      } finally {
        clearInterval(heartbeat);
        bus.off('event', handler);
      }
    });
  });

  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });

  // Дождаться, пока сервер реально начал слушать, и получить фактический порт.
  // При port=0 (тесты) ОС назначает свободный порт — берём его из server.address().
  const actualPort = await new Promise<number>((resolve) => {
    if (server.listening) {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : port);
    } else {
      server.once('listening', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr !== null ? addr.port : port);
      });
    }
  });

  return {
    port: actualPort,
    sessionId: session.sessionId,
    jsonlPath: session.filePath,
    async close(): Promise<void> {
      bus.off('event', onEvent);
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
