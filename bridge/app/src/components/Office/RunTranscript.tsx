// Wave 2: timeline transcript одного run'а.
//
// Загружает GET /routines/:id/runs/:triggerId/transcript. Рендерит как лог-файл:
// dense rows, mono-шрифт, разные цвета для разных event-types. Каждая строка
// сворачивается через <details> чтобы развернуть raw JSON properties.
//
// Эстетика — как stream-json в claude-code: time + badge + одна строка summary.

import { type ReactNode, useEffect, useState } from 'react';
import type { ToolStationKind } from './types.js';

interface TranscriptEvent {
  ts: number;
  type: string;
  properties: Record<string, unknown>;
}

interface TranscriptResponse {
  ok: boolean;
  events?: TranscriptEvent[];
  error?: string;
}

interface RunTranscriptProps {
  routineId: string;
  triggerId: string;
  onBack: () => void;
}

const BRIDGE_URL = 'http://127.0.0.1:3737';

// Цвета для badge'ей разных типов event'ов. Tool-related события используют
// палитру станций, остальные — нейтральные (grey/accent).
const TYPE_COLOR: Record<string, string> = {
  'tool.start': '#7c9eb2',
  'tool.end': '#7cb29a',
  'tool.error': '#b25555',
  'assistant.message': '#d97757',
  'audit.spend': '#c4a747',
  'audit.routine.start': '#9ca77c',
  'audit.routine.end': '#9ca77c',
  'event.routine.trigger': '#a77c9c',
  'audit.repeat': '#7c7c7c',
  'audit.routine.skipped': '#7c7c7c',
  'audit.security.deny': '#b25555',
  'audit.budget.deny': '#b25555',
};

const STATION_COLOR: Record<ToolStationKind, string> = {
  db: '#7c9eb2',
  fs: '#c4a747',
  bash: '#9ca77c',
  web: '#7cb29a',
  tg: '#a77c9c',
  email: '#d97757',
};

function stationForTool(toolName: string): ToolStationKind {
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
  if (toolName === 'Bash') return 'bash';
  if (toolName === 'WebSearch' || toolName === 'WebFetch') return 'web';
  return 'fs';
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

interface RowSummary {
  badge: string;
  badgeColor: string;
  summary: ReactNode;
}

function summarize(ev: TranscriptEvent): RowSummary {
  const p = ev.properties;
  const badgeColor = TYPE_COLOR[ev.type] ?? '#7c7c7c';

  switch (ev.type) {
    case 'tool.start': {
      const name = asString(p.name) ?? 'tool';
      const station = stationForTool(name);
      const stationColor = STATION_COLOR[station];
      const input = p.input;
      let detail = '';
      if (typeof input === 'object' && input !== null) {
        const inp = input as Record<string, unknown>;
        if (typeof inp.file_path === 'string') detail = inp.file_path;
        else if (typeof inp.path === 'string') detail = inp.path;
        else if (typeof inp.command === 'string') detail = inp.command.slice(0, 80);
        else if (typeof inp.query === 'string') detail = inp.query.slice(0, 80);
        else if (typeof inp.pattern === 'string') detail = inp.pattern;
      }
      return {
        badge: name,
        badgeColor: stationColor,
        summary: <span style={{ opacity: 0.85 }}>{detail || '(no input)'}</span>,
      };
    }
    case 'tool.end': {
      const dur = asNumber(p.durationMs);
      return {
        badge: 'tool.end',
        badgeColor,
        summary: <span style={{ opacity: 0.55 }}>ok{dur !== null ? ` · ${dur}ms` : ''}</span>,
      };
    }
    case 'tool.error': {
      const errMsg = asString(p.error) ?? 'error';
      return {
        badge: 'tool.error',
        badgeColor,
        summary: <span style={{ color: '#b25555' }}>{errMsg.slice(0, 120)}</span>,
      };
    }
    case 'assistant.message': {
      const text = asString(p.text) ?? '';
      return {
        badge: 'msg',
        badgeColor,
        summary: (
          <span style={{ fontStyle: 'italic', opacity: 0.9 }}>
            {text.slice(0, 200)}
            {text.length > 200 ? '…' : ''}
          </span>
        ),
      };
    }
    case 'audit.spend': {
      const usd = asNumber(p.usd) ?? 0;
      const inp = asNumber(p.inputTokens) ?? 0;
      const out = asNumber(p.outputTokens) ?? 0;
      const cacheR = asNumber(p.cacheReadTokens) ?? 0;
      const cacheC = asNumber(p.cacheCreationTokens) ?? 0;
      const tokens = inp + out + cacheR + cacheC;
      const model = asString(p.model) ?? '?';
      return {
        badge: 'spend',
        badgeColor,
        summary: (
          <span style={{ color: '#c4a747' }}>
            ${usd.toFixed(4)}
            <span style={{ opacity: 0.6 }}>
              {' '}
              · {tokens.toLocaleString()} tokens · {model}
            </span>
          </span>
        ),
      };
    }
    case 'event.routine.trigger': {
      const src = asString(p.triggerSource) ?? 'trigger';
      return {
        badge: 'trigger',
        badgeColor,
        summary: <span style={{ opacity: 0.7 }}>source: {src}</span>,
      };
    }
    case 'audit.routine.start': {
      const rid = asString(p.routineId) ?? '?';
      return {
        badge: 'start',
        badgeColor,
        summary: <span style={{ opacity: 0.8 }}>▶ {rid}</span>,
      };
    }
    case 'audit.routine.end': {
      const status = asString(p.status) ?? '?';
      const dur = asNumber(p.durationMs);
      const reason = asString(p.reason);
      const color =
        status === 'ok' || status === 'noop'
          ? '#7cb29a'
          : status === 'failed'
            ? '#b25555'
            : '#7c7c7c';
      const icon = status === 'failed' ? '✗' : '✓';
      return {
        badge: 'end',
        badgeColor,
        summary: (
          <span style={{ color }}>
            {icon} {status}
            {dur !== null ? ` · ${dur}ms` : ''}
            {reason !== null ? ` · ${reason}` : ''}
          </span>
        ),
      };
    }
    case 'audit.repeat': {
      return {
        badge: 'repeat',
        badgeColor,
        summary: <span style={{ opacity: 0.6 }}>idempotent dup</span>,
      };
    }
    case 'audit.routine.skipped': {
      const reason = asString(p.reason) ?? '';
      return {
        badge: 'skipped',
        badgeColor,
        summary: <span style={{ opacity: 0.6 }}>skipped: {reason}</span>,
      };
    }
    default: {
      return {
        badge: ev.type,
        badgeColor,
        summary: null,
      };
    }
  }
}

export function RunTranscript({ routineId, triggerId, onBack }: RunTranscriptProps): ReactNode {
  const [data, setData] = useState<TranscriptResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    (async (): Promise<void> => {
      try {
        const res = await fetch(
          `${BRIDGE_URL}/routines/${encodeURIComponent(routineId)}/runs/${encodeURIComponent(triggerId)}/transcript`,
        );
        const body = (await res.json()) as TranscriptResponse;
        if (cancelled) return;
        setData(body);
      } catch (err) {
        if (cancelled) return;
        setData({ ok: false, error: err instanceof Error ? err.message : String(err) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [routineId, triggerId]);

  const events = data?.events ?? [];

  return (
    <>
      {/* Sticky header with back link */}
      <div
        style={{
          padding: '12px 20px',
          borderBottom: '1px solid rgba(217,119,87,0.18)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <button
          type="button"
          onClick={onBack}
          style={{
            background: 'none',
            border: '1px solid rgba(217,119,87,0.3)',
            color: '#d97757',
            padding: '4px 10px',
            fontSize: 11,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          ← back to routine
        </button>
        <div style={{ fontSize: 10, opacity: 0.5, fontFamily: 'inherit', flex: 1, minWidth: 0 }}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{triggerId}</div>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
        {loading ? (
          <div style={{ opacity: 0.6 }}>loading transcript...</div>
        ) : data?.ok === false ? (
          <div style={{ color: '#b25555' }}>error: {data.error ?? 'unknown'}</div>
        ) : events.length === 0 ? (
          <div style={{ opacity: 0.5 }}>no events</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {events.map((ev, idx) => (
              <TranscriptRow key={`${ev.ts}-${idx}`} event={ev} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function TranscriptRow({ event }: { event: TranscriptEvent }): ReactNode {
  const { badge, badgeColor, summary } = summarize(event);
  const time = formatTime(event.ts);
  const propsJson = JSON.stringify(event.properties, null, 2);

  return (
    <details
      style={{
        background: 'rgba(26,20,16,0.4)',
        padding: '4px 8px',
        fontSize: 11,
        lineHeight: 1.4,
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          listStyle: 'none',
          display: 'grid',
          gridTemplateColumns: 'auto auto 1fr',
          gap: 10,
          alignItems: 'center',
        }}
      >
        <span style={{ opacity: 0.45, fontSize: 10 }}>{time}</span>
        <span
          style={{
            padding: '1px 6px',
            border: `1px solid ${badgeColor}`,
            borderRadius: 2,
            color: badgeColor,
            fontSize: 9,
            letterSpacing: '0.05em',
            whiteSpace: 'nowrap',
          }}
        >
          {badge}
        </span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summary}
        </span>
      </summary>
      <pre
        style={{
          marginTop: 6,
          padding: 8,
          background: '#0a0a0a',
          border: '1px solid rgba(217,119,87,0.1)',
          fontSize: 10,
          lineHeight: 1.4,
          color: '#cfc6bc',
          overflow: 'auto',
          maxHeight: 240,
        }}
      >
        {propsJson}
      </pre>
    </details>
  );
}
