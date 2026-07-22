// Wave 2: производное состояние «живого» офиса из BridgeEvent[].
//
// Входной поток (useBridgeEvents) — ring-buffer последних ~500 BridgeEvent'ов.
// На выходе — Record<routineId, LiveWorkerState>, где для каждой routine
// видно текущий статус, текущий tool (если идёт tool-call) и timestamp
// последнего события (чтобы отсортировать / задисплеить «свежесть»).
//
// Логика sticky-finished: после `routine.end status=ok|noop` worker остаётся
// в `finished` 3 секунды (короткая «celebration»-анимация в Worker.tsx),
// потом decay → 'idle'. Реализовано через дополнительный «tick» state:
// useEffect ставит таймер, по истечении делает forceUpdate — пересчёт
// убирает 'finished' из выдачи.
//
// Failed залипает до следующего `routine.start` (поведение из плана).
//
// Хук не делает сетевых запросов — чистое derived state.

import { useEffect, useMemo, useState } from 'react';
import type { BridgeEvent } from '../../../events.js';
import type { ToolStationKind, WorkerStatus } from '../components/Office/types.js';

export interface LiveWorkerState {
  status: WorkerStatus;
  currentTool?: ToolStationKind;
  /** Сырое имя tool'а (Read/Bash/...) — для ToolStationActivity-карточки. */
  currentToolName?: string;
  /** Input tool'а — для краткого summary в activity-карточке (filename, SQL, URL). */
  currentToolInput?: unknown;
  currentTriggerId?: string;
  /** Последний накопленный текст «мысли» (≤280 chars). Облако над головой. */
  thinking?: string;
  /** Когда мысль фейдится. Worker рисует пока now < expiresAt. */
  thinkingExpiresAt?: number;
  /**
   * Unix ms момента, когда воркер перешёл в status='running' (routine.start.ts).
   * Используется DeskCountdown'ом для elapsed-таймера «Работает: Xм Yс».
   * Сохраняется через tool.start/end/thinking, чтобы счётчик не сбрасывался
   * на каждом tool-вызове. Очищается на routine.end.
   */
  runningSince?: number;
  lastEventTs: number;
}

export type LiveStateMap = Record<string, LiveWorkerState>;

const FINISHED_DECAY_MS = 3000;
const THINKING_TTL_MS = 10000;

// ── Tool → Station mapping. Полная таблица в архитектурном документе мостик.md;
//    тот же набор имён, что в src/observe/bridge.ts (tool.start.name).
//    Порядок проверок важен: префиксы mcp__* проверяем до общих substring'ов.
//
// Для Bash дополнительно смотрим на команду (input.command) — если в ней psql,
// curl к telegram-api, sendmail и т.п., перенаправляем воркера на специализиро-
// ванную станцию. Это работает потому что в текущей конфигурации routine'ы
// часто используют Bash как «универсальный шлюз» к БД/TG/Email (см.
// PREFETCHED_TOOL_NAMES в src/routines/tool-registry.ts — настоящие mcp-tools
// унифицированы под Bash до M3.2).
export function mapToolToStation(toolName: string, input?: unknown): ToolStationKind {
  // ── 1. Bash-команда: смотрим на content, может оказаться psql/curl/etc.
  if (toolName === 'Bash') {
    const cmd = extractBashCommand(input).toLowerCase();
    if (cmd.length > 0) {
      // База
      if (/\b(psql|mysql|sqlite3?|mongo|redis-cli|pg_dump)\b/.test(cmd)) return 'db';
      // Telegram
      if (cmd.includes('api.telegram.org') || /\btelegram\b/.test(cmd)) return 'tg';
      // Email
      if (/\b(sendmail|mailx|smtp|imap)\b/.test(cmd) || cmd.includes('gmail')) return 'email';
      // HTTP/Web
      if (/\b(curl|wget|http(s)?:\/\/|fetch)\b/.test(cmd)) return 'web';
      // FS-команды (cat, ls, grep, find, sed, awk)
      if (/\b(cat|ls|grep|find|sed|awk|head|tail|tree|wc)\b/.test(cmd)) return 'fs';
    }
    return 'bash';
  }
  // ── 2. По имени tool'а
  const n = toolName.toLowerCase();
  if (
    n.startsWith('mcp__postgres') ||
    n.includes('postgres') ||
    n.includes('sql') ||
    n.includes('mysql')
  ) {
    return 'db';
  }
  if (n.startsWith('mcp__telegram') || n.includes('telegram')) return 'tg';
  if (n.includes('email') || n.includes('mail')) return 'email';
  if (toolName === 'WebSearch' || toolName === 'WebFetch') return 'web';
  if (
    toolName === 'Read' ||
    toolName === 'Glob' ||
    toolName === 'Grep' ||
    toolName === 'Edit' ||
    toolName === 'Write' ||
    toolName === 'NotebookEdit'
  ) {
    return 'fs';
  }
  // default: fs
  return 'fs';
}

function extractBashCommand(input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  return typeof o.command === 'string' ? o.command : '';
}

interface RunContext {
  routineId: string;
  triggerId?: string;
  startTs: number;
}

/**
 * Свернуть events в LiveStateMap. Чистая функция, легко тестируется.
 *
 * Алгоритм:
 *  - Линейно по events: для каждой routine отслеживаем «активный run»
 *    (последний routine.start), tool.start/end добавляют/убирают currentTool.
 *  - routine.end переводит в finished/failed; finished'ы фильтруются позже
 *    (по now − ts > FINISHED_DECAY_MS).
 *  - Активный triggerId: из routine.start.trigger.idempotencyKey мы не можем
 *    восстановить event.routine.trigger.id (это два разных пространства —
 *    idempotencyKey vs Record.id). Для Drawer-drilldown'а fallback на null.
 */
function buildLiveStateMap(events: BridgeEvent[], now: number): LiveStateMap {
  const state: LiveStateMap = {};
  const activeRuns = new Map<string, RunContext>();

  for (const ev of events) {
    if (ev.type === 'routine.start') {
      const ctx: RunContext = { routineId: ev.routineId, startTs: ev.ts };
      activeRuns.set(ev.routineId, ctx);
      const entry: LiveWorkerState = {
        status: 'running',
        runningSince: ev.ts,
        lastEventTs: ev.ts,
      };
      state[ev.routineId] = entry;
    } else if (ev.type === 'routine.end') {
      const prev = state[ev.routineId];
      activeRuns.delete(ev.routineId);
      // ok / noop / skipped / repeat → finished (celebration с decay)
      // failed → failed (sticky)
      // По плану конкретно: ok|noop → finished, failed → failed. skipped/repeat
      // — это тонкие исходы dispatcher'а, для UI приравниваем к noop (короткая
      // вспышка зелёного).
      const isFailed = ev.status === 'failed';
      const elapsed = now - ev.ts;
      let nextStatus: WorkerStatus;
      if (isFailed) {
        nextStatus = 'failed';
      } else if (elapsed < FINISHED_DECAY_MS) {
        nextStatus = 'finished';
      } else {
        nextStatus = 'idle';
      }
      const next: LiveWorkerState = {
        status: nextStatus,
        lastEventTs: ev.ts,
      };
      if (prev?.currentTriggerId !== undefined) next.currentTriggerId = prev.currentTriggerId;
      // Сохраняем thinking через routine.end — даём облаку «дотухнуть» 6 сек.
      if (prev?.thinking !== undefined) next.thinking = prev.thinking;
      if (prev?.thinkingExpiresAt !== undefined) next.thinkingExpiresAt = prev.thinkingExpiresAt;
      state[ev.routineId] = next;
    } else if (ev.type === 'tool.start') {
      const activeRoutineId = findMostRecentActiveRoutine(activeRuns);
      if (activeRoutineId === null) continue;
      const cur = state[activeRoutineId];
      if (cur === undefined || cur.status !== 'running') continue;
      const station = mapToolToStation(ev.name, ev.input);
      const next: LiveWorkerState = {
        status: cur.status,
        currentTool: station,
        currentToolName: ev.name,
        currentToolInput: ev.input,
        lastEventTs: ev.ts,
      };
      if (cur.currentTriggerId !== undefined) next.currentTriggerId = cur.currentTriggerId;
      if (cur.thinking !== undefined) next.thinking = cur.thinking;
      if (cur.thinkingExpiresAt !== undefined) next.thinkingExpiresAt = cur.thinkingExpiresAt;
      if (cur.runningSince !== undefined) next.runningSince = cur.runningSince;
      state[activeRoutineId] = next;
    } else if (ev.type === 'tool.end' || ev.type === 'tool.error') {
      // НЕ очищаем currentTool на tool.end — воркер «остаётся» у станции пока
      // не появится следующий tool.start (другая станция) или routine.end
      // (воркер возвращается на стул). Это даёт UI время показать анимацию
      // walking + дать пользователю понять, какой tool был использован.
      // Просто обновляем lastEventTs.
      const activeRoutineId = findMostRecentActiveRoutine(activeRuns);
      if (activeRoutineId === null) continue;
      const cur = state[activeRoutineId];
      if (cur === undefined) continue;
      state[activeRoutineId] = { ...cur, lastEventTs: ev.ts };
    } else if (ev.type === 'assistant.thinking') {
      // Привязка по явному workerId (subagent.ts/subagent-cli.ts эмитят с routineId).
      // Если routine не в state — пропускаем (subagent.thinking может прилететь
      // до того, как UI узнал про routine.start, маловероятно но безопасно).
      const cur = state[ev.workerId];
      if (cur === undefined) continue;
      const next: LiveWorkerState = {
        ...cur,
        thinking: ev.text,
        thinkingExpiresAt: ev.ts + THINKING_TTL_MS,
        lastEventTs: ev.ts,
      };
      state[ev.workerId] = next;
    } else if (ev.type === 'event.trigger') {
      // Сохраняем mapping recordId → активная routine — для drilldown'а в Drawer.
      // event.trigger содержит triggerSource — это «cron»|«manual»|«user.message»…
      // routineId извне не приходит, поэтому связь восстанавливаем только если
      // в state уже есть запущенная routine без triggerId. Эвристика, не строго.
      // (Reliable resolution — задача 3D-orchestrator-а в Wave 3.)
    }
  }

  return state;
}

function findMostRecentActiveRoutine(active: Map<string, RunContext>): string | null {
  let bestId: string | null = null;
  let bestTs = Number.NEGATIVE_INFINITY;
  for (const [id, ctx] of active) {
    if (ctx.startTs > bestTs) {
      bestTs = ctx.startTs;
      bestId = id;
    }
  }
  return bestId;
}

export function useWorkerEvents(events: BridgeEvent[]): LiveStateMap {
  // tick — счётчик, который инкрементируется через 3 сек после самого свежего
  // routine.end. Используется только чтобы пересчитать decay 'finished' → 'idle'
  // даже если новых events не пришло.
  const [tick, setTick] = useState(0);

  // Времена «finished»-событий, по которым ещё горит celebration.
  const pendingDecays = useMemo<number[]>(() => {
    const now = Date.now();
    const out: number[] = [];
    for (const ev of events) {
      if (ev.type === 'routine.end' && ev.status !== 'failed') {
        const elapsed = now - ev.ts;
        if (elapsed < FINISHED_DECAY_MS) out.push(FINISHED_DECAY_MS - elapsed);
      }
    }
    return out;
  }, [events]);

  // Один setTimeout на ближайший decay (если есть). Когда сработает — forceUpdate,
  // пересчитаем map, ушедшие из celebration'а — станут idle.
  useEffect(() => {
    if (pendingDecays.length === 0) return undefined;
    const nearest = Math.min(...pendingDecays);
    const handle = setTimeout(() => setTick((t) => t + 1), nearest + 50);
    return () => clearTimeout(handle);
  }, [pendingDecays]);

  return useMemo(() => {
    // tick read ниже, чтобы useMemo пересчитал когда тикнули decay'и.
    void tick;
    return buildLiveStateMap(events, Date.now());
  }, [events, tick]);
}
