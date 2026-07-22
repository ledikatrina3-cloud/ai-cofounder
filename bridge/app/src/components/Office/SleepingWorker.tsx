// Упрощённое представление воркера во сне.
//
// Когда status='idle' — настоящего сложного Worker (с ногами, руками, кистями)
// мы не рендерим: вместо этого здесь — голова на подушке + холмик одеяла +
// «zzz» над головой + DeskCountdown с подписью «Просыпаюсь через…».
//
// Это значительно дешевле по draw-calls и сразу читается как «спит».
//
// Поза: лежит на спине, голова к стене (-X), ноги к центру (+X). Координаты
// согласованы с getBedSlotPosition() из BunkBed.tsx.

import { Html } from '@react-three/drei';
import { type ThreeEvent, useFrame } from '@react-three/fiber';
import { type ReactNode, useRef } from 'react';
import type * as THREE from 'three';
import type { SkillBadge } from './types.js';

interface SleepingWorkerProps {
  id: string;
  /** Центр спального места (из getBedSlotPosition). */
  position: [number, number, number];
  role: string;
  color: string;
  logo?: string;
  /** Unix ms следующего запуска — рисуем countdown «Просыпаюсь через X». */
  nextRunAt?: number;
  /** Бейджи скиллов — те же что у активного воркера, для консистентности. */
  skills?: SkillBadge[];
  isCurrentlyClicked?: boolean;
  onClick: (id: string) => void;
}

const HEAD_SIZE = 0.34;

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

export function SleepingWorker(props: SleepingWorkerProps): ReactNode {
  const { id, position, role, color, logo, nextRunAt, skills, isCurrentlyClicked, onClick } = props;

  // Дыхание: лёгкое sin-движение по Y у головы и одеяла, чтобы было видно «дышит».
  const breatheRef = useRef<THREE.Group>(null);
  // Текстовый таймер обновляется каждые 250мс (без React-ререндера).
  const labelRef = useRef<HTMLDivElement>(null);
  const lastTickRef = useRef(0);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (breatheRef.current) {
      breatheRef.current.position.y = 0.015 * Math.sin(t * 1.1);
    }
    if (nextRunAt !== undefined && labelRef.current) {
      if (t - lastTickRef.current >= 0.25) {
        lastTickRef.current = t;
        const delta = nextRunAt - Date.now();
        labelRef.current.textContent = formatDuration(delta);
      }
    }
  });

  const visibleSkills = (skills ?? []).slice(0, 3);

  const handleClick = (e: ThreeEvent<MouseEvent>): void => {
    e.stopPropagation();
    onClick(id);
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: r3f <group> is a 3D mesh, not a DOM element.
    <group position={position} onClick={handleClick}>
      {/* Тело строится в local-frame с головой в -X, ногами в +X. Кровати в
          сцене развёрнуты так, что изголовье в +Z, изножье в -Z. Соответ-
          ственно поворачиваем тело на Y=π/2: -X (голова) → +Z (к стене),
          +X (ноги) → -Z (к воркеру за столом). Html-оверлеи (zzz, лейбл)
          вынесены наружу этой обёртки — они всегда смотрят на камеру. */}
      <group rotation={[0, Math.PI / 2, 0]}>
        <group ref={breatheRef}>
          {/* Голова — выступает над подушкой чтобы её было видно сверху камерой. */}
          <mesh position={[-0.55, 0.18, 0]} castShadow>
            <boxGeometry args={[HEAD_SIZE, HEAD_SIZE, HEAD_SIZE]} />
            <meshStandardMaterial color="#e6c4a0" roughness={0.9} flatShading />
          </mesh>
          {/* Волосы — небольшая тёмная «макушка» сверху головы */}
          <mesh position={[-0.55, 0.32, 0]} castShadow>
            <boxGeometry args={[HEAD_SIZE + 0.02, 0.08, HEAD_SIZE + 0.02]} />
            <meshStandardMaterial color="#3a2818" roughness={0.85} flatShading />
          </mesh>
          {/* Закрытые глаза — две горизонтальные «чёрточки» */}
          <mesh position={[-0.55, 0.2, 0.1]}>
            <boxGeometry args={[0.06, 0.014, 0.008]} />
            <meshStandardMaterial color="#1a1410" />
          </mesh>
          <mesh position={[-0.55, 0.2, -0.1]}>
            <boxGeometry args={[0.06, 0.014, 0.008]} />
            <meshStandardMaterial color="#1a1410" />
          </mesh>
          {/* Нос-кубик — на фронте головы */}
          <mesh position={[-0.39, 0.16, 0]}>
            <boxGeometry args={[0.06, 0.06, 0.06]} />
            <meshStandardMaterial color="#d4ad8a" roughness={0.9} />
          </mesh>
          {/* Спящий рот — маленькая «o» */}
          <mesh position={[-0.39, 0.06, 0]}>
            <boxGeometry args={[0.035, 0.045, 0.035]} />
            <meshStandardMaterial color="#5a2818" />
          </mesh>

          {/* Холмик одеяла — выраженный, видный сверху и сбоку. Цвет —
              от воркера (color), чтобы можно было различать кто где спит. */}
          <mesh position={[0.25, 0.15, 0]} castShadow>
            <boxGeometry args={[1.1, 0.32, 0.62]} />
            <meshStandardMaterial color={color} roughness={0.9} flatShading />
          </mesh>
          {/* Холмик ног — отдельный, поменьше, у изножья (-Z после rotation = +X в local) */}
          <mesh position={[0.7, 0.1, 0]} castShadow>
            <boxGeometry args={[0.3, 0.22, 0.4]} />
            <meshStandardMaterial color={color} roughness={0.9} flatShading />
          </mesh>
          {/* Подвёрнутый край одеяла у груди — светлая полоска у головы */}
          <mesh position={[-0.32, 0.32, 0]}>
            <boxGeometry args={[0.08, 0.06, 0.6]} />
            <meshStandardMaterial color="#f0e6dc" roughness={0.9} />
          </mesh>
        </group>
      </group>

      {/* «Zzz» — три буквы поднимающиеся вверх через DOM-overlay.
          Анимация — pure CSS keyframes, без useFrame, чтобы не нагружать рендер. */}
      <Html position={[-0.3, 0.55, 0]} center distanceFactor={9} occlude={false}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6,
            pointerEvents: 'none',
            userSelect: 'none',
            fontFamily: 'JetBrains Mono, Menlo, monospace',
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: 4,
              alignItems: 'flex-end',
              fontSize: 16,
              fontWeight: 700,
              color: '#7c9eb2',
              opacity: 0.85,
              filter: 'drop-shadow(0 0 4px #7c9eb288)',
            }}
          >
            <span style={{ animation: 'sleep-z 2.4s ease-in-out infinite' }}>z</span>
            <span style={{ animation: 'sleep-z 2.4s ease-in-out 0.4s infinite', fontSize: 14 }}>
              z
            </span>
            <span style={{ animation: 'sleep-z 2.4s ease-in-out 0.8s infinite', fontSize: 12 }}>
              z
            </span>
          </div>
          <style>{`@keyframes sleep-z {
            0%   { transform: translateY(2px); opacity: 0.4; }
            50%  { opacity: 1; }
            100% { transform: translateY(-10px); opacity: 0.1; }
          }`}</style>
        </div>
      </Html>

      {/* Лейбл-плашка над спальным местом: лого + роль + countdown.
          Кликабельна как у обычного Worker — открывает drawer. */}
      <Html position={[0, 0.7, 0]} center distanceFactor={8} occlude={false}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {logo !== undefined && (
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: '50%',
                overflow: 'hidden',
                background: '#0a0a0a',
                border: '2px solid rgba(124,158,178,0.6)',
                boxShadow: `0 0 10px ${color}55, 0 2px 5px rgba(0,0,0,0.6)`,
                marginBottom: 2,
                opacity: 0.85,
                userSelect: 'none',
                pointerEvents: 'none',
              }}
            >
              <img
                src={logo}
                alt={role}
                style={{ width: '100%', height: '100%', display: 'block' }}
                draggable={false}
              />
            </div>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClick(id);
            }}
            style={{
              padding: '3px 10px',
              fontFamily: 'JetBrains Mono, Menlo, monospace',
              fontSize: 11,
              color: '#f0e6dc',
              background: 'rgba(10,10,10,0.78)',
              border: `1px solid ${isCurrentlyClicked === true ? '#ffaa66' : 'rgba(124,158,178,0.55)'}`,
              borderRadius: 3,
              whiteSpace: 'nowrap',
              userSelect: 'none',
              cursor: 'pointer',
              outline: 'none',
            }}
          >
            {role}
          </button>
          {visibleSkills.length > 0 && (
            <div style={{ display: 'flex', gap: 3 }}>
              {visibleSkills.map((s) => (
                <span
                  key={s.name}
                  title={`${s.displayName ?? s.name}${s.description ? ` — ${s.description}` : ''}`}
                  style={{
                    width: 18,
                    height: 18,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '50%',
                    background: s.color ?? '#3a2818',
                    border: '1px solid rgba(10,10,10,0.8)',
                    fontSize: 11,
                    lineHeight: 1,
                    color: '#f0e6dc',
                    userSelect: 'none',
                    opacity: 0.85,
                    boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                  }}
                >
                  {s.icon ?? s.name[0]?.toUpperCase() ?? '?'}
                </span>
              ))}
            </div>
          )}
          {/* Countdown — обновляется в useFrame через ref, без React-rerender'а. */}
          {nextRunAt !== undefined && nextRunAt > Date.now() && (
            <div
              style={{
                marginTop: 3,
                background: 'rgba(20, 16, 12, 0.92)',
                color: '#7c9eb2',
                border: '1px solid #7c9eb2',
                borderRadius: 6,
                padding: '3px 8px',
                fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                fontSize: 11,
                lineHeight: 1.2,
                textAlign: 'center',
                minWidth: 96,
                boxShadow: '0 0 10px #7c9eb255',
                userSelect: 'none',
                pointerEvents: 'none',
              }}
            >
              <div style={{ opacity: 0.65, fontSize: 9, letterSpacing: 0.5 }}>Просыпаюсь через</div>
              <div ref={labelRef} style={{ fontSize: 13, fontWeight: 600, marginTop: 1 }}>
                {nextRunAt !== undefined ? formatDuration(nextRunAt - Date.now()) : ''}
              </div>
            </div>
          )}
        </div>
      </Html>

      {isCurrentlyClicked === true && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.18, 0]}>
          <ringGeometry args={[0.55, 0.62, 24]} />
          <meshBasicMaterial color="#d97757" transparent opacity={0.8} />
        </mesh>
      )}
    </group>
  );
}
