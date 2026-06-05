import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { BridgeEvent } from '../../../../events.js';

// ActivityStream — ГЛАВНАЯ панель Bridge UI. Показывает реальную деятельность
// бота: чат с фаундером (что он пишет, что бот отвечает), деньги, support fetch,
// проблемы/диагнозы/предложения. Источник истины — таблица Record (БД), polling
// через /activity (2 сек), плюс live-патч из SSE-событий, чтобы свежее
// сообщение появлялось без 2-сек задержки.
//
// Зачем не Three.js: 3D-сцена выглядит «красиво», но ничего не сообщает —
// фаундер хочет видеть СЛОВА бота и СЛОВА свои, а не орбитали.

interface ActivityItem {
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
    | 'audit'
    | 'tool'
    | 'live';
  title: string;
  detail: string;
  meta?: Record<string, unknown>;
}

const KIND_STYLE: Record<ActivityItem['kind'], { color: string; bg: string; symbol: string }> = {
  'user-msg': { color: '#7cb29a', bg: 'rgba(124,178,154,0.06)', symbol: '▶' },
  'agent-msg': { color: '#d97757', bg: 'rgba(217,119,87,0.07)', symbol: '◀' },
  spend: { color: '#c4a747', bg: 'rgba(196,167,71,0.05)', symbol: '$' },
  'support-fetch': { color: '#7c9eb2', bg: 'rgba(124,158,178,0.05)', symbol: '↓' },
  problem: { color: '#a77c9c', bg: 'rgba(167,124,156,0.06)', symbol: '?' },
  diagnosis: { color: '#9ca77c', bg: 'rgba(156,167,124,0.05)', symbol: '✦' },
  proposal: { color: '#7cb29a', bg: 'rgba(124,178,154,0.05)', symbol: '→' },
  routine: { color: '#d97757', bg: 'rgba(217,119,87,0.05)', symbol: '◆' },
  deny: { color: '#ef4444', bg: 'rgba(239,68,68,0.07)', symbol: '✗' },
  audit: { color: '#7c4a2e', bg: 'rgba(124,74,46,0.04)', symbol: '·' },
  tool: { color: '#7c9eb2', bg: 'rgba(124,158,178,0.05)', symbol: '▸' },
  live: { color: '#22c55e', bg: 'rgba(34,197,94,0.05)', symbol: '⚡' },
};

function formatTimeAgo(ts: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function eventToItem(ev: BridgeEvent): ActivityItem | null {
  // Live-патч поверх БД-снапшота. Создаём только то, что НЕ дублируется в /activity
  // (чтобы не было двойников после polling). Сообщения чата уже пишутся в Record
  // — они придут с polling'ом через 2 сек, но пока эмитим маркер «бот думает».
  switch (ev.type) {
    case 'tool.start': {
      const input = ev.input as Record<string, unknown> | null;
      let arg = '';
      if (typeof input === 'object' && input !== null) {
        const candidate =
          input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.path;
        arg = String(candidate ?? Object.values(input)[0] ?? '').slice(0, 200);
      }
      return {
        id: `live-${ev.toolId}`,
        ts: ev.ts,
        kind: 'tool',
        title: ev.name,
        detail: arg,
      };
    }
    case 'subagent.start':
      return {
        id: `live-${ev.subagentId}-start`,
        ts: ev.ts,
        kind: 'live',
        title: `${ev.subagentType} thinking`,
        detail: ev.parentSession ? `session=${ev.parentSession.slice(0, 8)}…` : 'started',
      };
    case 'subagent.end': {
      const usd = typeof ev.totalUsd === 'number' ? ` · $${ev.totalUsd.toFixed(4)}` : '';
      return {
        id: `live-${ev.subagentId}-end`,
        ts: ev.ts,
        kind: 'live',
        title: `${ev.verdict ?? 'done'}`,
        detail: `${ev.durationMs}ms${usd}`,
      };
    }
    case 'assistant.message':
      // Не возвращаем — текст ассистента приедет в БД как chat.message.assistant
      // и попадёт в стрим через polling.
      return null;
    case 'tool.error':
      return {
        id: `live-err-${ev.toolId}`,
        ts: ev.ts,
        kind: 'deny',
        title: 'tool error',
        detail: ev.error.slice(0, 200),
      };
    default:
      return null;
  }
}

interface DiagnosticCheck {
  name: string;
  ok: boolean;
  detail: string;
}

const SUGGESTIONS = [
  'расскажи кратко что сейчас в проекте Acme Academy',
  'покажи последние 5 коммитов и что в них поменялось',
  'есть ли необработанные сообщения от пользователей в support',
  'какие проблемы в журнале без диагноза',
];

export function ActivityStream({ events }: { events: BridgeEvent[] }): ReactNode {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [now, setNow] = useState(Date.now());
  const [errorState, setErrorState] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticCheck[] | null>(null);
  const [diagnosticsHidden, setDiagnosticsHidden] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const sendChat = async (): Promise<void> => {
    const text = input.trim();
    if (text.length === 0 || sending) return;
    setSending(true);
    setErrorState(null);
    try {
      const res = await fetch('http://127.0.0.1:3737/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (res.status === 404) {
        // /chat endpoint появился после нашего обновления — старый bridge сервер
        // его не знает. Самая частая причина «нажал send и ничего».
        setErrorState(
          'bridge сервер устарел: останови его (Cmd+Q в окне Electron или Ctrl+C в терминале) и запусти заново `pnpm bridge:dev`',
        );
        return;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        setErrorState(`chat failed: HTTP ${res.status} ${body.slice(0, 200)}`);
        return;
      }
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!body.ok) {
        setErrorState(`chat failed: ${body.error ?? 'unknown'}`);
        return;
      }
      // Успех — очищаем input только сейчас, чтобы юзер не потерял текст при ошибке.
      setInput('');
    } catch (e) {
      setErrorState(
        `bridge не отвечает: ${String(e)}. Похоже сервер не запущен — запусти \`pnpm bridge:dev\``,
      );
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  // Polling /activity каждые 2 сек. Это «правда» из БД.
  useEffect(() => {
    const load = (): void => {
      fetch('http://127.0.0.1:3737/activity?limit=60')
        .then(async (r) => {
          if (r.status === 404) {
            // Старый bridge-сервер до нашего обновления. Он отвечает на /healthz,
            // но не знает /activity. UI должен это видеть, иначе лента молча пустая.
            return { ok: false as const, stale: true };
          }
          if (!r.ok) return { ok: false as const, status: r.status };
          return (await r.json()) as { ok: boolean; items: ActivityItem[] };
        })
        .then((body) => {
          if ('stale' in body) {
            setErrorState(
              'bridge сервер устарел (нет /activity endpoint). Закрой Electron-окно и запусти заново `pnpm bridge:dev`',
            );
            return;
          }
          if (!body.ok) {
            setErrorState(`/activity вернул ошибку${'status' in body ? ` ${body.status}` : ''}`);
            return;
          }
          setItems((body as { items: ActivityItem[] }).items);
          setErrorState(null);
        })
        .catch((e) => setErrorState(`bridge не отвечает: ${String(e)}`));
    };
    load();
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, []);

  // Раз при загрузке — диагностика. Показываем баннер если что-то не ок,
  // иначе скрываем после первого «всё зелёное».
  useEffect(() => {
    fetch('http://127.0.0.1:3737/diagnostics')
      .then(async (r) => {
        if (r.status === 404) {
          setDiagnostics([
            {
              name: 'bridge server (устаревший)',
              ok: false,
              detail:
                "сервер запущен, но без /diagnostics и /chat endpoint'ов. Перезапусти `pnpm bridge:dev` — текущий процесс не знает наших новых endpoint'ов",
            },
          ]);
          return null;
        }
        return r.json() as Promise<{ ok: boolean; checks: DiagnosticCheck[] }>;
      })
      .then((body) => {
        if (body === null) return;
        setDiagnostics(body.checks);
        if (body.ok) setDiagnosticsHidden(true);
      })
      .catch(() => {
        setDiagnostics([
          {
            name: 'bridge server',
            ok: false,
            detail:
              'не отвечает на 127.0.0.1:3737. Похоже ты открыл UI в браузере вместо `pnpm bridge:dev`',
          },
        ]);
      });
  }, []);

  const sendSuggestion = (text: string): void => {
    setInput(text);
    inputRef.current?.focus();
  };

  // Tick 1s — для актуального «N сек назад».
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Live-overlay: события tool/subagent/error появляются мгновенно. Стираются,
  // когда polling привезёт реальный Record (по тому же интервалу 2сек).
  const liveItems = useMemo<ActivityItem[]>(() => {
    const out: ActivityItem[] = [];
    const cutoff = Date.now() - 30_000;
    for (const ev of events) {
      if (ev.ts < cutoff) continue;
      const it = eventToItem(ev);
      if (it !== null) out.push(it);
    }
    return out;
  }, [events]);

  const merged = useMemo<ActivityItem[]>(() => {
    // Сортировка по ts DESC — самое свежее сверху.
    const all = [...items, ...liveItems];
    all.sort((a, b) => b.ts - a.ts);
    // Dedup по id.
    const seen = new Set<string>();
    const result: ActivityItem[] = [];
    for (const it of all) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      result.push(it);
    }
    return result.slice(0, 80);
  }, [items, liveItems]);

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(10,10,10,0.4)',
        border: '1px solid rgba(217,119,87,0.18)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '8px 14px',
          borderBottom: '1px solid rgba(217,119,87,0.18)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 10,
          letterSpacing: '0.12em',
          color: '#7c4a2e',
          textTransform: 'uppercase',
          flexShrink: 0,
        }}
      >
        <span>Лента деятельности</span>
        <span style={{ color: errorState ? '#ef4444' : '#22c55e' }}>
          {errorState ? '● bridge не готов' : `● live · ${merged.length}`}
        </span>
      </div>
      {diagnostics !== null && !diagnosticsHidden && (
        <div
          style={{
            padding: '10px 14px',
            borderBottom: '1px solid rgba(239,68,68,0.3)',
            background: diagnostics.every((c) => c.ok)
              ? 'rgba(34,197,94,0.06)'
              : 'rgba(239,68,68,0.06)',
            fontSize: 11,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 9,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: diagnostics.every((c) => c.ok) ? '#22c55e' : '#ef4444',
              marginBottom: 4,
            }}
          >
            <span>
              {diagnostics.every((c) => c.ok)
                ? '✓ всё готово, можно писать'
                : '⚠ не всё работает — почини и перезапусти'}
            </span>
            <button
              type="button"
              onClick={() => setDiagnosticsHidden(true)}
              style={{
                background: 'none',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: 9,
                letterSpacing: '0.12em',
              }}
            >
              скрыть ✕
            </button>
          </div>
          {diagnostics.map((check) => (
            <div
              key={check.name}
              style={{
                display: 'grid',
                gridTemplateColumns: '20px 140px 1fr',
                gap: 8,
                color: check.ok ? '#22c55e' : '#ef4444',
              }}
            >
              <span>{check.ok ? '✓' : '✗'}</span>
              <span style={{ color: '#e9e3dc' }}>{check.name}</span>
              <span style={{ color: 'rgba(233,227,220,0.6)', fontFamily: 'monospace' }}>
                {check.detail}
              </span>
            </div>
          ))}
        </div>
      )}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 0',
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(217,119,87,0.3) transparent',
        }}
      >
        {merged.length === 0 && !sending && (
          <div
            style={{
              padding: '32px 24px',
              color: '#e9e3dc',
              fontSize: 12,
              lineHeight: 1.7,
            }}
          >
            <div
              style={{
                fontSize: 14,
                color: '#d97757',
                marginBottom: 16,
                letterSpacing: '0.05em',
              }}
            >
              Это твой AI-кофаундер. Пока он ничего не делает.
            </div>
            <div style={{ color: 'rgba(233,227,220,0.7)', marginBottom: 20 }}>
              Напиши ему в поле снизу — увидишь как он читает код, гоняет bash и отвечает. Каждое
              действие — отдельная плашка с цветом и временем. Деньги считаются на лету.
            </div>
            <div
              style={{
                fontSize: 10,
                color: '#7c4a2e',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                marginBottom: 8,
              }}
            >
              попробуй спросить:
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {SUGGESTIONS.map((s) => (
                <button
                  type="button"
                  key={s}
                  onClick={() => sendSuggestion(s)}
                  style={{
                    textAlign: 'left',
                    background: 'rgba(217,119,87,0.06)',
                    border: '1px solid rgba(217,119,87,0.2)',
                    color: '#e9e3dc',
                    padding: '8px 12px',
                    cursor: 'pointer',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 12,
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(217,119,87,0.14)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(217,119,87,0.06)';
                  }}
                >
                  → {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {sending && (
          <div
            style={{
              padding: '6px 14px 8px 14px',
              borderLeft: '2px solid #d97757',
              borderBottom: '1px solid rgba(217,119,87,0.06)',
              background: 'rgba(217,119,87,0.04)',
              display: 'grid',
              gridTemplateColumns: '20px 1fr 50px',
              gap: 10,
              alignItems: 'baseline',
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            <span style={{ color: '#d97757', fontSize: 12 }}>◀</span>
            <div>
              <div
                style={{
                  fontSize: 10,
                  color: '#d97757',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  marginBottom: 2,
                }}
              >
                бот думает…
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'rgba(233,227,220,0.6)',
                  fontStyle: 'italic',
                }}
              >
                tool calls, файлы, ответ — всё появится ниже
              </div>
            </div>
            <span style={{ fontSize: 10, color: '#7c4a2e' }}>now</span>
          </div>
        )}
        {merged.map((item) => {
          const style = KIND_STYLE[item.kind];
          return (
            <div
              key={item.id}
              style={{
                padding: '6px 14px 8px 14px',
                borderLeft: `2px solid ${style.color}`,
                borderBottom: '1px solid rgba(217,119,87,0.06)',
                background: style.bg,
                display: 'grid',
                gridTemplateColumns: '20px 1fr 50px',
                gap: 10,
                alignItems: 'baseline',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              <span style={{ color: style.color, fontSize: 12, lineHeight: 1.4, fontWeight: 700 }}>
                {style.symbol}
              </span>
              <div style={{ minWidth: 0, overflow: 'hidden' }}>
                <div
                  style={{
                    fontSize: 10,
                    color: style.color,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    marginBottom: 2,
                  }}
                >
                  {item.title}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: '#e9e3dc',
                    lineHeight: 1.45,
                    wordBreak: 'break-word',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {item.detail.length > 0 ? item.detail : <span style={{ opacity: 0.4 }}>—</span>}
                </div>
              </div>
              <span
                style={{
                  fontSize: 10,
                  color: '#7c4a2e',
                  textAlign: 'right',
                  fontVariantNumeric: 'tabular-nums',
                }}
                title={new Date(item.ts).toISOString()}
              >
                {formatTimeAgo(item.ts, now)}
              </span>
            </div>
          );
        })}
      </div>
      {errorState !== null && (
        <div
          style={{
            background: 'rgba(239,68,68,0.1)',
            borderTop: '1px solid rgba(239,68,68,0.4)',
            padding: '8px 14px',
            color: '#ef4444',
            fontSize: 11,
            lineHeight: 1.5,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 12,
            flexShrink: 0,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          <div style={{ flex: 1, wordBreak: 'break-word' }}>✗ {errorState}</div>
          <button
            type="button"
            onClick={() => setErrorState(null)}
            style={{
              background: 'none',
              border: 'none',
              color: '#ef4444',
              cursor: 'pointer',
              fontSize: 11,
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void sendChat();
        }}
        style={{
          borderTop: '1px solid rgba(217,119,87,0.18)',
          padding: '8px 10px',
          display: 'flex',
          gap: 8,
          background: 'rgba(10,10,10,0.6)',
          flexShrink: 0,
        }}
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void sendChat();
            }
          }}
          placeholder="напиши боту прямо здесь · Enter — отправить · Shift+Enter — перенос"
          rows={2}
          disabled={sending}
          style={{
            flex: 1,
            background: '#0a0a0a',
            border: '1px solid rgba(217,119,87,0.18)',
            color: '#e9e3dc',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            lineHeight: 1.4,
            padding: '6px 10px',
            resize: 'none',
            outline: 'none',
          }}
        />
        <button
          type="submit"
          disabled={sending || input.trim().length === 0}
          style={{
            background: sending || input.trim().length === 0 ? 'rgba(217,119,87,0.15)' : '#d97757',
            color: sending || input.trim().length === 0 ? '#7c4a2e' : '#0a0a0a',
            border: 'none',
            padding: '0 16px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            cursor: sending || input.trim().length === 0 ? 'default' : 'pointer',
            transition: 'background 0.15s',
          }}
        >
          {sending ? '…' : 'send'}
        </button>
      </form>
    </div>
  );
}
