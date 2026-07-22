// Корневая 3D-сцена офиса. Cinematic-grade visuals:
//
//   - Лёгкий objc-fog для глубины.
//   - Многослойное освещение: hemi (мягкая заливка), directional (ключевой),
//     2× rim-light (контурная подсветка), 4× ceiling spot.
//   - Postprocessing: N8AO + Bloom + ToneMapping ACES + HueSat + Contrast +
//     ChromaticAberration + Vignette + lёгкий Noise.
//   - DustParticles + LightBeams — атмосфера.
//   - AmbientProps: plants, whiteboard, neon, clock, posters, server-rack,
//     water-cooler — «жилая» комната.
//
// Camera: позиция чуть подальше для более широкого кадра.

import { OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import {
  Bloom,
  BrightnessContrast,
  EffectComposer,
  HueSaturation,
  N8AO,
  Vignette,
} from '@react-three/postprocessing';
import { Component, type ErrorInfo, type ReactNode, useEffect, useState } from 'react';
import { ACESFilmicToneMapping, FogExp2, MOUSE } from 'three';
import { AmbientProps } from './AmbientProps.js';
import { DustParticles } from './DustParticles.js';
import {
  MAX_WORKERS,
  OfficeLayout,
  getBedSlotPosition,
  getToolStationPosition,
  getWorkerStandPosition,
} from './OfficeLayout.js';
import { Room } from './Room.js';
import { SleepingWorker } from './SleepingWorker.js';
import { Worker } from './Worker.js';
import type { WorkerData } from './types.js';

class OfficeErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; fallback: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[OfficeScene] Three.js error:', error, info);
  }
  override render(): ReactNode {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

const FALLBACK = (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      width: '100%',
      color: 'rgba(217,119,87,0.6)',
      fontSize: 13,
      fontFamily: 'JetBrains Mono, monospace',
      background: '#0a0a0a',
    }}
  >
    [OFFICE] — WebGL недоступен
  </div>
);

interface OfficeSceneProps {
  workers: WorkerData[];
  onWorkerClick: (id: string) => void;
  selectedWorkerId?: string;
}

/**
 * Кастомные orbit controls с поддержкой Shift-modifier:
 *   - LEFT drag         → pan (двигает сцену)
 *   - SHIFT + LEFT drag → rotate (крутить вокруг target)
 *   - RIGHT drag        → rotate (альтернатива для пользователей с двух-кнопочной мышью)
 *   - Wheel             → zoom к курсору
 *   - MIDDLE drag       → dolly (zoom)
 *
 * Реализация: слушаем Shift на keydown/keyup, реактивно подменяем
 * `mouseButtons.LEFT` (PAN ↔ ROTATE). Из-за React-ремоунта OrbitControls
 * меняем `key` prop при смене режима, чтобы новые mouseButtons применились
 * корректно (drei OrbitControls читает props в useEffect один раз).
 */
function CameraControls(): ReactNode {
  const [rotateMode, setRotateMode] = useState(false);
  useEffect(() => {
    const onDown = (e: KeyboardEvent): void => {
      if (e.shiftKey) setRotateMode(true);
    };
    const onUp = (e: KeyboardEvent): void => {
      // Сбрасываем при отпускании ЛЮБОЙ клавиши, если shift больше не зажат
      if (!e.shiftKey) setRotateMode(false);
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, []);

  return (
    <OrbitControls
      key={rotateMode ? 'rotate' : 'pan'}
      target={[0, 1.2, 0]}
      enableDamping
      dampingFactor={0.08}
      maxPolarAngle={Math.PI / 2.05}
      minDistance={3}
      maxDistance={50}
      zoomToCursor
      screenSpacePanning
      panSpeed={1.2}
      rotateSpeed={0.9}
      mouseButtons={{
        LEFT: rotateMode ? MOUSE.ROTATE : MOUSE.PAN,
        MIDDLE: MOUSE.DOLLY,
        RIGHT: MOUSE.ROTATE,
      }}
    />
  );
}

function OfficePostprocessing(): ReactNode {
  return (
    <EffectComposer multisampling={0}>
      {/* Screen-space AO — добавляет контактные тени в углах,
          ключевое для ощущения «глубины» сцены. */}
      <N8AO aoRadius={1.2} intensity={1.8} distanceFalloff={1.0} quality="medium" color="#0a0604" />
      {/* Bloom — мягкий орб над эмиссивными объектами (монитор, неон, лампы) */}
      <Bloom
        intensity={1.1}
        luminanceThreshold={0.55}
        luminanceSmoothing={0.9}
        mipmapBlur
        radius={0.85}
      />
      {/* Tone mapping — компрессия highlights — выполняется через gl.toneMapping
          в <Canvas/> (ACESFilmicToneMapping), отдельный pass не нужен. */}
      {/* Повышенная насыщенность — теплее картинка */}
      <HueSaturation saturation={0.22} hue={0.0} />
      {/* Контраст для глубины */}
      <BrightnessContrast brightness={0.04} contrast={0.18} />
      {/* Лёгкая виньетка */}
      <Vignette darkness={0.25} offset={0.4} />
      {/* ChromaticAberration + Noise отключены — это два full-screen pass'а,
          которые дают заметный FPS-drop на retina, а визуально почти неразличимы
          под остальными эффектами. */}
    </EffectComposer>
  );
}

export function OfficeScene({
  workers,
  onWorkerClick,
  selectedWorkerId,
}: OfficeSceneProps): ReactNode {
  const visibleWorkers = workers.slice(0, MAX_WORKERS);

  return (
    <OfficeErrorBoundary fallback={FALLBACK}>
      <Canvas
        shadows
        camera={{ position: [10, 8, 12], fov: 50 }}
        style={{ width: '100%', height: '100%', background: '#1a0f08' }}
        gl={{ antialias: true, toneMapping: ACESFilmicToneMapping, toneMappingExposure: 1.85 }}
        // dpr cap 1.75 — на retina (DPR=2) даёт −23% пикселей к отрисовке без
        // заметной потери качества. 2.5 был перебор: разница невидима, цена
        // ~60% больше fragment-работы.
        dpr={[1, 1.75]}
        onCreated={({ scene }) => {
          // Лёгкий warm-fog для глубины (но не настолько, чтоб всё съело)
          scene.fog = new FogExp2('#1a1008', 0.006);
        }}
      >
        {/* ───────────── Освещение ───────────── */}
        {/* Глобальная мягкая заливка */}
        <ambientLight intensity={0.7} color="#e8d4b8" />
        {/* Hemi: тёплый сверху + холодный снизу (имитация неба-пола) */}
        <hemisphereLight args={['#d97757', '#3a2818', 0.85]} />
        {/* Ключевой directional с тенями */}
        <directionalLight
          position={[8, 12, 6]}
          intensity={2.2}
          color="#fff0d4"
          castShadow
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
          shadow-camera-left={-12}
          shadow-camera-right={12}
          shadow-camera-top={12}
          shadow-camera-bottom={-12}
          shadow-camera-near={0.5}
          shadow-camera-far={40}
        />
        {/* Rim-light с противоположной стороны — лёгкий контур */}
        <directionalLight position={[-6, 6, -8]} intensity={0.35} color="#7c9eb2" />

        {/* Потолочные лампы: 4 spotLight над кластером столов */}
        {[
          [-2.5, 3.6, -1.5],
          [2.5, 3.6, -1.5],
          [-2.5, 3.6, 1.5],
          [2.5, 3.6, 1.5],
        ].map(([x, y, z]) => (
          <spotLight
            key={`spot-${x},${z}`}
            position={[x ?? 0, y ?? 0, z ?? 0]}
            angle={0.7}
            penumbra={0.6}
            intensity={1.4}
            color="#ffd4a8"
            distance={9}
            decay={1.5}
            castShadow={false}
            target-position={[x ?? 0, 0, z ?? 0]}
          />
        ))}
        {/* Тёплая «лампа над офисом» в центре — для bloom-эффекта */}
        <pointLight position={[0, 3.4, 0]} color="#d97757" intensity={0.8} distance={10} />

        {/* ───────────── Сцена ───────────── */}
        <Room />
        <AmbientProps />
        <OfficeLayout workers={visibleWorkers} />

        {/* Пылинки в воздухе */}
        <DustParticles />

        {/* ───────────── Воркеры ─────────────
            Idle-воркеры спят на кровати-ярусе (упрощённый SleepingWorker),
            остальные сидят/работают за столом (полный Worker). Это снимает
            десятки мешей с idle-воркеров — критично для FPS, когда вся команда
            бездействует. */}
        {visibleWorkers.map((w, i) =>
          w.status === 'idle' ? (
            <SleepingWorker
              key={w.id}
              id={w.id}
              position={getBedSlotPosition(i)}
              role={w.role}
              color={w.color}
              {...(w.logo !== undefined && { logo: w.logo })}
              {...(w.nextRunAt !== undefined && { nextRunAt: w.nextRunAt })}
              {...(w.skills !== undefined && { skills: w.skills })}
              isCurrentlyClicked={selectedWorkerId === w.id}
              onClick={onWorkerClick}
            />
          ) : (
            <Worker
              key={w.id}
              id={w.id}
              position={getWorkerStandPosition(i)}
              status={w.status}
              walkingTo={w.walkingTo}
              getToolStationPosition={getToolStationPosition}
              role={w.role}
              color={w.color}
              logo={w.logo}
              isCurrentlyClicked={selectedWorkerId === w.id}
              onClick={onWorkerClick}
              thinking={w.thinking}
              thinkingExpiresAt={w.thinkingExpiresAt}
              skills={w.skills}
              nextRunAt={w.nextRunAt}
              runningSince={w.runningSince}
              progressPercent={w.progressPercent}
              progressStageLabel={w.progressStageLabel}
              documentsCount={w.documentsCount}
            />
          ),
        )}

        {/* Камера — slightly elevated, чтобы видеть и стены, и работу на столах */}
        <CameraControls />

        <OfficePostprocessing />
      </Canvas>
    </OfficeErrorBoundary>
  );
}
