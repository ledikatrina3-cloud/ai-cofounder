// Облако мысли над головой воркера. Видно когда WorkerData.thinking задан и
// WorkerData.thinkingExpiresAt > now. После expiresAt — fade-out.
//
// Состоит из:
//   - Воксельные «пузырьки» (3 mesh-сферы) — поднимаются от уровня груди
//     воркера до облака, как в комиксах.
//   - Html overlay c самим текстом — JetBrains Mono, тёмный bg, светлая рамка,
//     максимум 220 chars (UI обрезает с эллипсисом).
//
// Опасно делать canvas-текстуру: имитирует «текст на стене» хуже чем DOM-шрифт.
// Drei <Html> рендерит DOM поверх canvas в перспективе scene'ы.

import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type * as THREE from 'three';

interface ThoughtBubbleProps {
  /** Текст мысли. ≤280 chars из useWorkerEvents. */
  text: string;
  /** Когда облако фейдится (Date.now() ms). */
  expiresAt: number;
  /** Воксельные пузырьки тянутся от этой высоты до основания облака. */
  baseY?: number;
  /** Цвет рамки — accent воркера. По умолчанию warm. */
  accentColor?: string;
}

const BUBBLE_Y = 2.65; // высота облака от пола
const PUFF_BASE_Y = 1.95; // верх головы (ниже status-dot)
const PUFFS = [
  { y: PUFF_BASE_Y + 0.12, size: 0.05 },
  { y: PUFF_BASE_Y + 0.25, size: 0.07 },
  { y: PUFF_BASE_Y + 0.42, size: 0.1 },
];

export function ThoughtBubble({
  text,
  expiresAt,
  accentColor = '#d97757',
}: ThoughtBubbleProps): ReactNode {
  // Локальное состояние fade — обновляется при тике useFrame, чтобы
  // плавно убывать без новых ререндеров React'а.
  const [fade, setFade] = useState(1);
  const puffRef0 = useRef<THREE.Mesh>(null);
  const puffRef1 = useRef<THREE.Mesh>(null);
  const puffRef2 = useRef<THREE.Mesh>(null);
  const phaseRef = useRef(Math.random() * Math.PI * 2);

  useFrame((state) => {
    const now = Date.now();
    const msToExpiry = expiresAt - now;
    let nextFade: number;
    if (msToExpiry > 800) {
      nextFade = 1;
    } else if (msToExpiry > 0) {
      nextFade = msToExpiry / 800; // последние 800мс — fadeout
    } else {
      nextFade = 0;
    }
    setFade((prev) => (Math.abs(prev - nextFade) > 0.02 || nextFade === 0 ? nextFade : prev));

    // Пузырьки покачиваются для «живости»
    const t = state.clock.elapsedTime;
    const swing = (offset: number): number => 0.015 * Math.sin(t * 1.8 + offset + phaseRef.current);
    [puffRef0, puffRef1, puffRef2].forEach((ref, i) => {
      if (!ref.current) return;
      const baseY = PUFFS[i]?.y ?? 0;
      ref.current.position.y = baseY + swing(i * 0.7);
      const mat = ref.current.material as THREE.MeshStandardMaterial;
      mat.opacity = 0.85 * nextFade;
    });
  });

  // Сбрасываем fade при изменении expiresAt — новая «свежая» мысль.
  // biome-ignore lint/correctness/useExhaustiveDependencies: эффект-триггер на смену expiresAt — само значение внутри не используется, но изменение prop'а должно перезапускать fade
  useEffect(() => {
    setFade(1);
  }, [expiresAt]);

  // (debug: фейд снят чтоб облако не пропадало)
  // if (fade <= 0.02) return null;

  // Подготовим текст: убираем многократные пробелы, обрезаем хвост.
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const displayed = cleaned.length > 220 ? `…${cleaned.slice(-220)}` : cleaned;

  return (
    <group>
      {/* Воксельные пузырьки тянутся от рта к облаку */}
      {PUFFS.map((p, i) => (
        <mesh
          // biome-ignore lint/suspicious/noArrayIndexKey: PUFFS is module-level const, refs (puffRef0/1/2) are bound to fixed indices
          key={i}
          ref={i === 0 ? puffRef0 : i === 1 ? puffRef1 : puffRef2}
          position={[-0.15 - i * 0.08, p.y, 0.1]}
        >
          <sphereGeometry args={[p.size, 8, 8]} />
          <meshStandardMaterial color="#f0e6dc" transparent opacity={0.85} roughness={0.7} />
        </mesh>
      ))}

      {/* Само облако — Html overlay */}
      <Html position={[0, BUBBLE_Y, 0]} center distanceFactor={10} occlude={false}>
        <div
          style={{
            position: 'relative',
            opacity: fade,
            padding: '6px 10px',
            maxWidth: 260,
            minWidth: 90,
            fontFamily: 'JetBrains Mono, Menlo, monospace',
            fontSize: 10.5,
            lineHeight: 1.35,
            color: '#1a1410',
            background: '#f0e6dc',
            border: `1.5px solid ${accentColor}`,
            borderRadius: 8,
            boxShadow: `0 0 16px rgba(217,119,87,${0.35 * fade})`,
            pointerEvents: 'none',
            transition: 'opacity 200ms ease-out',
            textAlign: 'left',
            wordWrap: 'break-word',
            whiteSpace: 'pre-wrap',
          }}
        >
          {displayed}
          {/* Маленький треугольник-указатель снизу облака */}
          <div
            style={{
              position: 'absolute',
              bottom: -8,
              left: '38%',
              width: 0,
              height: 0,
              borderLeft: '6px solid transparent',
              borderRight: '6px solid transparent',
              borderTop: `8px solid ${accentColor}`,
            }}
          />
          <div
            style={{
              position: 'absolute',
              bottom: -6,
              left: '39%',
              width: 0,
              height: 0,
              borderLeft: '4px solid transparent',
              borderRight: '4px solid transparent',
              borderTop: '5px solid #f0e6dc',
            }}
          />
        </div>
      </Html>
    </group>
  );
}
