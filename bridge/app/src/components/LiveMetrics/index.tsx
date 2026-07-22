import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { BridgeEvent } from '../../../../events.js';

interface MetricsData {
  totalUsd: number;
  routinesRan: number;
  toolCalls: number;
  topRoutine: string | null;
  totalTokens: number;
}

interface Props {
  events: BridgeEvent[];
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function LiveMetrics({ events }: Props): ReactNode {
  const [metrics, setMetrics] = useState<MetricsData>({
    totalUsd: 0,
    routinesRan: 0,
    toolCalls: 0,
    topRoutine: null,
    totalTokens: 0,
  });
  const [flashCell, setFlashCell] = useState<string | null>(null);
  const [uptimeSeconds, setUptimeSeconds] = useState(0);
  const startRef = useRef(Date.now());

  // Polling: обновляем метрики каждые 5 секунд (база — agregated audit.spend
  // за день из БД). Этот источник истинный, но запаздывает; push-инкремент ниже
  // даёт мгновенную реакцию в Bridge UI пока polling не догнал.
  useEffect(() => {
    const load = (): void => {
      fetch('http://127.0.0.1:3737/metrics')
        .then((r) => r.json())
        .then((body: { ok: boolean; data: MetricsData }) => {
          if (body.ok) setMetrics(body.data);
        })
        .catch(() => {}); // тихо проглотить — сервер может быть недоступен
    };
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  // Push-инкременты от событий за текущую сессию Bridge UI (всё, что в кольцевом
  // буфере useBridgeEvents). Берём как «приоритетный» оверлей над polling — если
  // polling уже посчитал больше, показываем его; если живые события впереди —
  // их. Так $0.00 моментально превращается в первую копейку, не ждя 5 секунд.
  const liveDelta = useMemo<{ usd: number; tools: number }>(() => {
    let usd = 0;
    let tools = 0;
    for (const ev of events) {
      if (ev.type === 'audit.spend') usd += ev.usd;
      else if (ev.type === 'tool.start') tools += 1;
    }
    return { usd, tools };
  }, [events]);

  // Flash-анимация при routine.end / audit.spend (новый spend → подсвечиваем
  // SPEND TODAY ячейку, чтобы фаундер видел «капля денег прилетела»).
  useEffect(() => {
    const last = events[events.length - 1];
    if (!last) return;
    if (last.type === 'routine.end') {
      setFlashCell('routinesRan');
    } else if (last.type === 'audit.spend') {
      setFlashCell('totalUsd');
    } else if (last.type === 'tool.start' || last.type === 'tool.end') {
      setFlashCell('toolCalls');
    } else {
      return;
    }
    const t = setTimeout(() => setFlashCell(null), 600);
    return () => clearTimeout(t);
  }, [events]);

  // Uptime — инкремент каждую секунду
  useEffect(() => {
    const id = setInterval(() => {
      setUptimeSeconds(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const effectiveUsd = Math.max(metrics.totalUsd, liveDelta.usd);
  const effectiveToolCalls = Math.max(metrics.toolCalls, liveDelta.tools);

  const cells: { key: string; label: string; value: string }[] = [
    { key: 'totalUsd', label: 'SPEND TODAY', value: `$${effectiveUsd.toFixed(2)}` },
    { key: 'routinesRan', label: 'ROUTINES RAN', value: String(metrics.routinesRan) },
    { key: 'toolCalls', label: 'TOOL CALLS', value: String(effectiveToolCalls) },
    {
      key: 'topRoutine',
      label: 'TOP ROUTINE',
      value: metrics.topRoutine?.slice(0, 12) ?? '—',
    },
    {
      key: 'totalTokens',
      label: 'TOKENS USED',
      value: metrics.totalTokens > 0 ? `${(metrics.totalTokens / 1000).toFixed(1)}k` : '—',
    },
    { key: 'uptime', label: 'UPTIME', value: formatUptime(uptimeSeconds) },
  ];

  return (
    <div
      style={{
        padding: '8px',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gridTemplateRows: '1fr 1fr',
        gap: '6px',
        height: '100%',
        boxSizing: 'border-box',
      }}
    >
      {cells.map((cell) => {
        const isFlashing = flashCell === cell.key;
        return (
          <div
            key={cell.key}
            style={{
              background: isFlashing ? 'rgba(217,119,87,0.08)' : 'transparent',
              border: '1px solid rgba(217,119,87,0.12)',
              borderRadius: 2,
              padding: '6px 8px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              transition: 'background 0.3s',
              overflow: 'hidden',
            }}
          >
            <span
              style={{
                fontSize: 9,
                color: '#7c4a2e',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                lineHeight: 1,
              }}
            >
              {cell.label}
            </span>
            <span
              style={{
                fontSize: 20,
                color: '#e9e3dc',
                fontFamily: "'JetBrains Mono', 'Fira Mono', monospace",
                lineHeight: 1,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {cell.value}
            </span>
          </div>
        );
      })}
    </div>
  );
}
