// LiveActivityStream — real-time лог происходящего в текущей сессии routine'ы.
//
// Источник данных: `useBridgeEvents()` — ring-buffer SSE-событий из bridge'а
// (последние 500). Каждое событие, эмитнутое `runSubagentViaCli`, долетает
// сюда: assistant.thinking, tool.start, tool.end, routine.start/end,
// skill.loaded, audit.spend.
//
// Что показываем (фильтр по routineId этого drawer'а):
//   • routine.start         — «🟢 запуск (cron|manual)»
//   • skill.loaded          — «🧠 skill: <name>»
//   • assistant.thinking    — мысль агента (≤280 chars от runtime)
//   • tool.start            — «🔧 <toolName>(<input-summary>)»
//   • tool.end              — «✓ <toolName>» (если успешно) / «✗» (error)
//   • audit.spend           — «💰 $X.XX за этап»
//   • routine.end           — «🔴 готово (status=ok|failed, дур.)»
//
// Привязка к routineId:
//   • routine.start/end, skill.loaded — поле `routineId`
//   • assistant.thinking — поле `workerId` (= routineId по контракту)
//   • tool.start/end — НЕТ прямой ссылки на routineId; берём «активный» по
//     последнему routine.start этого routine'а и используем как scope.
//
// Auto-scroll: scrollIntoView'м последний элемент при каждом обновлении.
// Можно отключить кнопкой если пользователь скроллит вверх.
//
// Empty state: «agent ещё не работает или события буфера протекли»
// + подсказка про nextRunAt если он скоро.

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { BridgeEvent } from '../../../../events.js';
import { useBridgeEvents } from '../../hooks/useBridgeEvents.js';

interface LiveActivityStreamProps {
  routineId: string;
  /** Цвет акцента (border, иконки). */
  accentColor?: string;
}

interface DisplayedEvent {
  ts: number;
  icon: string;
  label: string;
  detail?: string;
  color: string;
  jsonPayload?: unknown;
}

const COLORS = {
  start: '#7cb29a',
  end: '#a77c9c',
  skill: '#c4a747',
  thinking: '#7c9eb2',
  tool: '#d97757',
  toolError: '#b25555',
  spend: '#9ca77c',
  fade: '#777',
} as const;

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
}

function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input.slice(0, 60);
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (typeof obj.command === 'string') return obj.command.slice(0, 80);
    if (typeof obj.file_path === 'string') return obj.file_path.slice(0, 80);
    if (typeof obj.pattern === 'string') return obj.pattern.slice(0, 60);
    if (typeof obj.url === 'string') return obj.url.slice(0, 80);
    if (typeof obj.prompt === 'string') return obj.prompt.slice(0, 80);
    if (typeof obj.description === 'string') return obj.description.slice(0, 80);
    try {
      return JSON.stringify(obj).slice(0, 80);
    } catch {
      return '[object]';
    }
  }
  return String(input).slice(0, 60);
}

/**
 * Свернуть BridgeEvent[] в DisplayedEvent[] для конкретного routine.
 *
 * Алгоритм: один проход. Поддерживаем «активный routine» из последнего
 * routine.start этого routineId; tool.start/end засчитываем только пока
 * активный — иначе они принадлежат другому воркеру или прилетели до нашего
 * start'а.
 */
function pickEventsForRoutine(events: BridgeEvent[], routineId: string): DisplayedEvent[] {
  const out: DisplayedEvent[] = [];
  let isActive = false;
  let activeStartTs = 0;

  for (const ev of events) {
    switch (ev.type) {
      case 'routine.start': {
        if (ev.routineId !== routineId) {
          // Другой routine стартовал — наш мог быть прерван, но мы продолжаем
          // показывать events до своего routine.end если он придёт.
          continue;
        }
        isActive = true;
        activeStartTs = ev.ts;
        out.push({
          ts: ev.ts,
          icon: '🟢',
          label: `routine start (${ev.trigger.source})`,
          detail: ev.runDate,
          color: COLORS.start,
        });
        break;
      }
      case 'routine.end': {
        if (ev.routineId !== routineId) continue;
        isActive = false;
        const isFail = ev.status === 'failed';
        out.push({
          ts: ev.ts,
          icon: isFail ? '🔴' : '🟣',
          label: `routine end · ${ev.status}`,
          detail:
            ev.reason !== undefined
              ? `${ev.reason} · ${(ev.durationMs / 1000).toFixed(1)}s`
              : `${(ev.durationMs / 1000).toFixed(1)}s`,
          color: isFail ? COLORS.toolError : COLORS.end,
        });
        break;
      }
      case 'skill.loaded': {
        if (ev.routineId !== routineId) continue;
        out.push({
          ts: ev.ts,
          icon: '🧠',
          label: `skill: ${ev.displayName ?? ev.skillName}`,
          detail: `mode=${ev.mode}`,
          color: COLORS.skill,
        });
        break;
      }
      case 'assistant.thinking': {
        if (ev.workerId !== routineId) continue;
        out.push({
          ts: ev.ts,
          icon: '💭',
          label: ev.text.length > 200 ? `${ev.text.slice(0, 200)}…` : ev.text,
          color: COLORS.thinking,
        });
        break;
      }
      case 'tool.start': {
        if (!isActive) continue;
        const inputSummary = summarizeInput(ev.input);
        out.push({
          ts: ev.ts,
          icon: '🔧',
          label: ev.name,
          detail: inputSummary,
          color: COLORS.tool,
          jsonPayload: ev.input,
        });
        break;
      }
      case 'tool.end': {
        if (!isActive) continue;
        // Tool.end-события эмитятся часто — компактный «галочка» без detail.
        out.push({
          ts: ev.ts,
          icon: '✓',
          label: `${ev.toolId} ok`,
          detail: ev.durationMs !== undefined ? `${ev.durationMs}ms` : undefined,
          color: COLORS.fade,
        });
        break;
      }
      case 'tool.error': {
        if (!isActive) continue;
        out.push({
          ts: ev.ts,
          icon: '✗',
          label: 'tool.error',
          detail: ev.error.slice(0, 160),
          color: COLORS.toolError,
        });
        break;
      }
      case 'audit.spend': {
        // audit.spend не имеет routineId явно — но всегда эмитится после
        // блока работы. Привязываем если активны. (routineId читаем
        // защитно через optional-cast: тип AuditSpendEvent его не объявляет,
        // эмиттеры не шлют — но если когда-нибудь начнут, фильтр сработает.)
        if (!isActive) continue;
        const evRoutineId = (ev as { routineId?: string }).routineId;
        if (evRoutineId !== undefined && evRoutineId !== routineId) continue;
        out.push({
          ts: ev.ts,
          icon: '💰',
          label: `$${ev.usd.toFixed(3)} · ${ev.model}`,
          color: COLORS.spend,
        });
        break;
      }
      default:
        break;
    }
    // Защита от runaway-сессий: ограничиваем размер до 300 рядов.
    if (out.length > 300) out.shift();
  }

  // Sanity: timestamp activeStartTs использован выше; tslint иначе не отстанет.
  void activeStartTs;
  return out;
}

export function LiveActivityStream({
  routineId,
  accentColor = '#d97757',
}: LiveActivityStreamProps): ReactNode {
  const events = useBridgeEvents();
  const filtered = useMemo(() => pickEventsForRoutine(events, routineId), [events, routineId]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: эффект-триггер на новое событие — filtered.length внутри не читается, но смена длины обязана дёргать автоскролл
  useEffect(() => {
    if (!autoScroll) return;
    const el = containerRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [filtered.length, autoScroll]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '4px 0 6px',
          fontSize: 10,
          opacity: 0.6,
          letterSpacing: 0.5,
        }}
      >
        <span>{filtered.length} events (last 500 buffered)</span>
        <label style={{ cursor: 'pointer', userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            style={{ marginRight: 4 }}
          />
          auto-scroll
        </label>
      </div>
      <div
        ref={containerRef}
        style={{
          background: '#0a0a0a',
          border: `1px solid ${accentColor}33`,
          borderRadius: 4,
          padding: 6,
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 11,
          lineHeight: 1.45,
          maxHeight: 380,
          minHeight: 120,
          overflow: 'auto',
        }}
      >
        {filtered.length === 0 ? (
          <div style={{ opacity: 0.4, padding: 16, textAlign: 'center' }}>
            нет событий за последние 500 в буфере
            <br />
            <span style={{ fontSize: 10 }}>
              (либо агент ещё не стартовал, либо буфер ротировался)
            </span>
          </div>
        ) : (
          filtered.map((e, i) => (
            <div
              key={`${e.ts}-${i}`}
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto auto 1fr',
                gap: 6,
                padding: '2px 0',
                color: e.color,
                borderBottom: '1px solid rgba(217,119,87,0.05)',
              }}
            >
              <span style={{ opacity: 0.4, fontSize: 10 }}>{formatTime(e.ts)}</span>
              <span style={{ width: 18, textAlign: 'center' }}>{e.icon}</span>
              <span style={{ wordBreak: 'break-word', minWidth: 0 }}>
                <span>{e.label}</span>
                {e.detail !== undefined && (
                  <span style={{ opacity: 0.5, marginLeft: 6, fontSize: 10 }}>{e.detail}</span>
                )}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
