import { curveCatmullRom, line } from 'd3-shape';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { BridgeEvent } from '../../../../events.js';
import type { AgentStatus } from '../../hooks/useAgentStatus.js';

type Props = { status: AgentStatus; events: BridgeEvent[] };

const STATUS_COLOR: Record<AgentStatus, string> = {
  idle: '#22c55e',
  thinking: '#d97757',
  executing: '#ef4444',
};

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: 'ONLINE',
  thinking: 'THINKING',
  executing: 'EXECUTING',
};

const ECG_DURATION: Record<AgentStatus, string> = {
  idle: '3s',
  thinking: '2s',
  executing: '1s',
};

const PULSE_DURATION: Record<AgentStatus, string> = {
  idle: '2s',
  thinking: '1s',
  executing: '0.5s',
};

const SVG_WIDTH = 200;
const SVG_HEIGHT = 40;
const MID_Y = 20;

function generateIdlePoints(offsetX: number): [number, number][] {
  const points: [number, number][] = [];
  const lambda = 40;
  const amplitude = 8;
  for (let i = 0; i <= SVG_WIDTH; i += 2) {
    const y = Math.sin((i / lambda) * 2 * Math.PI) * amplitude + MID_Y;
    points.push([offsetX + i, y]);
  }
  return points;
}

function generateThinkingPoints(offsetX: number): [number, number][] {
  const points: [number, number][] = [];
  const lambda = 27;
  const amplitude = 12;
  for (let i = 0; i <= SVG_WIDTH; i += 2) {
    const y = Math.sin((i / lambda) * 2 * Math.PI) * amplitude + MID_Y;
    points.push([offsetX + i, y]);
  }
  return points;
}

// One PQRST complex over 50px
const PQRST_PATTERN: [number, number][] = [
  [0, 20],
  [8, 20],
  [10, 18],
  [12, 5],
  [14, 35],
  [16, 20],
  [24, 20],
  [26, 22],
  [28, 18],
  [30, 20],
  [50, 20],
];

function generateExecutingPoints(offsetX: number): [number, number][] {
  const points: [number, number][] = [];
  const repeats = Math.ceil((SVG_WIDTH + 50) / 50) + 1;
  for (let r = 0; r < repeats; r++) {
    const base = r * 50;
    for (const [px, py] of PQRST_PATTERN) {
      points.push([offsetX + base + px, py]);
    }
  }
  return points;
}

function buildPath(status: AgentStatus): string {
  const lineGen = line<[number, number]>()
    .x((d) => d[0])
    .y((d) => d[1])
    .curve(curveCatmullRom.alpha(0.5));

  let allPoints: [number, number][] = [];

  if (status === 'idle') {
    allPoints = [...generateIdlePoints(0), ...generateIdlePoints(SVG_WIDTH)];
  } else if (status === 'thinking') {
    allPoints = [...generateThinkingPoints(0), ...generateThinkingPoints(SVG_WIDTH)];
  } else {
    allPoints = [...generateExecutingPoints(0), ...generateExecutingPoints(SVG_WIDTH)];
  }

  return lineGen(allPoints) ?? '';
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const STYLES = `
@keyframes ecg-slide {
  from { transform: translateX(0); }
  to { transform: translateX(-50%); }
}
@keyframes dot-pulse {
  0%   { transform: scale(1);   opacity: 1; }
  50%  { transform: scale(1.5); opacity: 0; }
  100% { transform: scale(1);   opacity: 1; }
}
`;

export function Header({ status, events }: Props): ReactNode {
  const [uptime, setUptime] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      setUptime(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Последняя реально использованная модель — из audit.spend события. Если за
  // сессию ни одного spend не было — null, рендерим тире.
  const lastModel = useMemo<string | null>(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev?.type === 'audit.spend') return ev.model;
    }
    return null;
  }, [events]);

  // Сколько tool-вызовов сейчас «in-flight» (start без end). UI показывает
  // как маленький бейдж рядом со статусом — оживляет шапку при работе агента.
  const inflightTools = useMemo<number>(() => {
    const open = new Set<string>();
    for (const ev of events) {
      if (ev.type === 'tool.start') open.add(ev.toolId);
      else if (ev.type === 'tool.end' || ev.type === 'tool.error') open.delete(ev.toolId);
    }
    return open.size;
  }, [events]);

  // ECG-визуализация удалена 2026-05-22, оставляем только статус-строку.
  const hasAnyEvents = events.length > 0;
  const color = STATUS_COLOR[status];
  const label = hasAnyEvents ? STATUS_LABEL[status] : 'IDLE · waiting for input';
  const pulseDuration = PULSE_DURATION[status];

  return (
    <div
      style={{
        background: 'transparent',
        borderBottom: '1px solid rgba(217,119,87,0.12)',
        height: 28,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <style>{STYLES}</style>

      {/* ECG-визуализация удалена по запросу фаундера 2026-05-22 —
          оживляла шапку, но раздражала «постоянным дёрганьем».
          Оставляем только status-строку с текстом. */}

      {/* Status text — оставшиеся 28px */}
      <div
        style={{
          height: 20,
          padding: '4px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontFamily: "'JetBrains Mono', 'Fira Mono', monospace",
          fontSize: 11,
          letterSpacing: '0.1em',
          color: 'var(--fg, #e9e3dc)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
        }}
      >
        <span>AI-COFOUNDER</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span style={{ color }}>{label}</span>
        {inflightTools > 0 && (
          <span
            style={{
              padding: '1px 6px',
              borderRadius: 8,
              background: 'rgba(217,119,87,0.15)',
              border: `1px solid ${color}`,
              color,
              fontSize: 9,
              letterSpacing: '0.05em',
            }}
          >
            ⚡ {inflightTools}
          </span>
        )}
        <span style={{ opacity: 0.4 }}>·</span>
        <span>UPTIME {formatUptime(uptime)}</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>
          MODEL:{' '}
          <span style={{ color: lastModel ? '#e9e3dc' : '#7c4a2e' }}>{lastModel ?? '—'}</span>
        </span>
        {/* Pulse dot */}
        <span
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: color,
            animation: `dot-pulse ${pulseDuration} ease-in-out infinite`,
            flexShrink: 0,
            marginLeft: 4,
          }}
        />
      </div>
    </div>
  );
}
