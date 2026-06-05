// DeskCountdown — мини-табло «обратной стороны» монитора сотрудника.
//
// Что показывает:
//   • idle + nextRunAt в будущем → «До запуска» + «Xм Yс» (countdown)
//   • running + runningSince → «Работает» + «Xм Yс» (elapsed)
//   • finished / failed / без расписания → ничего
//
// Технически:
//   • <Html> overlay через drei — DOM-узел внутри 3D-сцены. Шрифт JetBrains
//     Mono, прозрачный фон, цветная рамка (accent от воркера). Centered и
//     occlude=false (не прячется за столом/стулом).
//   • useFrame-тик локально обновляет текст каждые 250мс — без React-ререндеров,
//     чтобы не дёргать сцену.
//   • Цвет: idle = синий-холодный (#7c9eb2), running = оранжевый-тёплый
//     (#d97757) (соответствует STATUS_DOT_COLOR из Worker.tsx).
//
// Позиция: правая верхняя часть от воркера (как маленькое табло на столе,
// смотрящее камере; «лицевая» сторона монитора отвёрнута от нас, к воркеру).

import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { type ReactNode, useRef, useState } from 'react';

interface DeskCountdownProps {
  /** 'idle' → countdown, 'running' → elapsed. Остальные статусы — компонент не рендерим. */
  mode: 'idle' | 'running';
  /** Для mode='idle': Unix ms следующего запуска. Для mode='running': игнорируется. */
  nextRunAt?: number;
  /** Для mode='running': Unix ms начала текущего прогона. Для mode='idle': игнорируется. */
  runningSince?: number;
  /** Hex-цвет рамки/текста. Idle → холодный, running → тёплый. */
  accentColor?: string;
  /** Прогресс выполнения 0..100 (только для mode='running'). Если задан — рисуем bar. */
  percent?: number;
  /** Лейбл текущего этапа ('6b', '13a', '12'). Если задан — показываем рядом. */
  stageLabel?: string | null;
}

const POSITION: [number, number, number] = [0.7, 1.8, 0.2];

function formatDuration(ms: number): string {
  const absMs = Math.max(0, ms);
  const totalSec = Math.floor(absMs / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  const sStr = seconds.toString().padStart(2, '0');
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const mStr = m.toString().padStart(2, '0');
    return `${h}ч ${mStr}м`;
  }
  return `${minutes}м ${sStr}с`;
}

export function DeskCountdown({
  mode,
  nextRunAt,
  runningSince,
  accentColor,
  percent,
  stageLabel,
}: DeskCountdownProps): ReactNode {
  // Сразу отказываемся рендерить если нет данных. Это родительский Worker'ный
  // решает (передаёт DeskCountdown только когда status подходит), но защищаем
  // на случай race condition при смене статуса.
  const target = mode === 'idle' ? nextRunAt : mode === 'running' ? runningSince : undefined;
  if (target === undefined) return null;

  const initialDelta = mode === 'idle' ? target - Date.now() : Date.now() - target;
  const [label, setLabel] = useState(formatDuration(initialDelta));
  const lastTickRef = useRef(0);

  useFrame((state) => {
    // Обновляем текст каждые 250мс — глаз не замечает рывков короче, но
    // и не сжигаем CPU 60fps на toString.
    const tNow = state.clock.elapsedTime;
    if (tNow - lastTickRef.current < 0.25) return;
    lastTickRef.current = tNow;

    const delta = mode === 'idle' ? target - Date.now() : Date.now() - target;
    const next = formatDuration(delta);
    if (next !== label) setLabel(next);
  });

  // Цвет: idle — холодный синий (ожидание), running — тёплый оранжевый.
  const color = accentColor ?? (mode === 'idle' ? '#7c9eb2' : '#d97757');
  const captionText = mode === 'idle' ? 'До запуска' : 'Работает';

  const showProgress = mode === 'running' && percent !== undefined && percent > 0;

  return (
    <Html position={POSITION} center distanceFactor={8} occlude={false}>
      <div
        style={{
          background: 'rgba(20, 16, 12, 0.92)',
          color,
          border: `1px solid ${color}`,
          borderRadius: 6,
          padding: '4px 8px',
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 11,
          lineHeight: 1.2,
          textAlign: 'center',
          minWidth: 104,
          boxShadow: `0 0 12px ${color}55`,
          userSelect: 'none',
          pointerEvents: 'none',
        }}
      >
        <div style={{ opacity: 0.65, fontSize: 9, letterSpacing: 0.5 }}>{captionText}</div>
        <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>{label}</div>
        {showProgress && (
          <>
            <div
              style={{
                marginTop: 4,
                height: 4,
                width: '100%',
                background: `${color}22`,
                borderRadius: 2,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${percent}%`,
                  background: color,
                  transition: 'width 400ms ease-out',
                }}
              />
            </div>
            <div style={{ fontSize: 10, opacity: 0.85, marginTop: 2 }}>
              {stageLabel !== null && stageLabel !== undefined ? `этап ${stageLabel}` : null}
              {stageLabel !== null && stageLabel !== undefined ? ' · ' : ''}
              {percent}%
            </div>
          </>
        )}
      </div>
    </Html>
  );
}
