// Процедурный low-poly humanoid: капсула-тело + сфера-голова + 4 цилиндра.
//
// Поверх — text-label с ролью (drei <Billboard> чтобы всегда смотрел на камеру)
// и status-dot (сфера, цвет которой зависит от статуса).
//
// Анимации (всё через useFrame + lerp, никакой skeletal-rig):
//  - idle:     sin-bob ±5cm по y, медленное вращение ±2° вокруг своей оси
//  - running:  более быстрый bob, лёгкий наклон вперёд
//  - failed:   ссутулился (наклон вниз ~6°, без bob)
//  - finished: вспышка-«прыжок» на ~30cm в течение 1с после смены статуса
//
// Walking: если walkingTo задан — lerp position от desk → tool-station.
// Если walkingTo обнулён — lerp обратно к desk. Время перехода ~800мс,
// реализовано через damping (lerp factor рассчитан так, чтобы достичь
// 95% за 0.8с при 60fps).

import { Html } from '@react-three/drei';
import { type ThreeEvent, useFrame } from '@react-three/fiber';
import { type ReactNode, type RefObject, forwardRef, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { DeskCountdown } from './DeskCountdown.js';
import { DocumentsPile } from './DocumentsPile.js';
import { ThoughtBubble } from './ThoughtBubble.js';
import type { SkillBadge, ToolStationKind, WorkerStatus } from './types.js';

// ───────────────────────────────────────────────────────────────────
// SittingLegs / StandingLegs — две позы ног, переключаемые через `visible`.
// ───────────────────────────────────────────────────────────────────

interface LegProps {
  bodyColor: string;
  darken: (hex: string, factor: number) => string;
}

const SittingLegs = forwardRef<THREE.Group, LegProps>(({ bodyColor, darken }, ref) => {
  return (
    <group ref={ref}>
      {/* Бёдра — горизонтально вперёд (по +Z) */}
      <mesh position={[-0.105, 0.72, 0.2]} castShadow>
        <boxGeometry args={[0.17, 0.16, 0.4]} />
        <meshStandardMaterial color={darken(bodyColor, 0.45)} roughness={0.9} flatShading />
      </mesh>
      <mesh position={[0.105, 0.72, 0.2]} castShadow>
        <boxGeometry args={[0.17, 0.16, 0.4]} />
        <meshStandardMaterial color={darken(bodyColor, 0.45)} roughness={0.9} flatShading />
      </mesh>
      {/* Голени — вертикально вниз */}
      <mesh position={[-0.105, 0.4, 0.4]} castShadow>
        <boxGeometry args={[0.17, 0.62, 0.16]} />
        <meshStandardMaterial color={darken(bodyColor, 0.45)} roughness={0.9} flatShading />
      </mesh>
      <mesh position={[0.105, 0.4, 0.4]} castShadow>
        <boxGeometry args={[0.17, 0.62, 0.16]} />
        <meshStandardMaterial color={darken(bodyColor, 0.45)} roughness={0.9} flatShading />
      </mesh>
      {/* Ботинки */}
      <mesh position={[-0.105, 0.05, 0.48]} castShadow>
        <boxGeometry args={[0.19, 0.08, 0.28]} />
        <meshStandardMaterial color="#1a1410" roughness={0.95} />
      </mesh>
      <mesh position={[0.105, 0.05, 0.48]} castShadow>
        <boxGeometry args={[0.19, 0.08, 0.28]} />
        <meshStandardMaterial color="#1a1410" roughness={0.95} />
      </mesh>
      <mesh position={[-0.105, 0.05, 0.62]} castShadow>
        <boxGeometry args={[0.16, 0.06, 0.04]} />
        <meshStandardMaterial color="#2a1c14" roughness={0.95} />
      </mesh>
      <mesh position={[0.105, 0.05, 0.62]} castShadow>
        <boxGeometry args={[0.16, 0.06, 0.04]} />
        <meshStandardMaterial color="#2a1c14" roughness={0.95} />
      </mesh>
    </group>
  );
});
SittingLegs.displayName = 'SittingLegs';

interface StandingLegsProps extends LegProps {
  leftLegRef: RefObject<THREE.Group | null>;
  rightLegRef: RefObject<THREE.Group | null>;
}

const StandingLegs = forwardRef<THREE.Group, StandingLegsProps>(
  ({ bodyColor, darken, leftLegRef, rightLegRef }, ref) => {
    // Hip-pivot — небольшой коричневый «бедренный сустав» на y=0.78.
    // Группа `leftLegRef`/`rightLegRef` крутится вокруг этой точки (rotation.x).
    return (
      <group ref={ref}>
        {/* Левая нога — pivot на бедре */}
        <group ref={leftLegRef} position={[-0.105, 0.78, 0]}>
          {/* Бедро вертикально вниз — длина 0.35, центр y=-0.175 */}
          <mesh position={[0, -0.175, 0]} castShadow>
            <boxGeometry args={[0.17, 0.35, 0.18]} />
            <meshStandardMaterial color={darken(bodyColor, 0.45)} roughness={0.9} flatShading />
          </mesh>
          {/* Голень — длина 0.35, центр y=-0.525 */}
          <mesh position={[0, -0.525, 0]} castShadow>
            <boxGeometry args={[0.17, 0.35, 0.17]} />
            <meshStandardMaterial color={darken(bodyColor, 0.45)} roughness={0.9} flatShading />
          </mesh>
          {/* Ботинок — высота 0.08, центр y=-0.74 */}
          <mesh position={[0, -0.74, 0.03]} castShadow>
            <boxGeometry args={[0.19, 0.08, 0.26]} />
            <meshStandardMaterial color="#1a1410" roughness={0.95} />
          </mesh>
          <mesh position={[0, -0.74, 0.16]} castShadow>
            <boxGeometry args={[0.16, 0.06, 0.04]} />
            <meshStandardMaterial color="#2a1c14" roughness={0.95} />
          </mesh>
        </group>
        {/* Правая нога — зеркально */}
        <group ref={rightLegRef} position={[0.105, 0.78, 0]}>
          <mesh position={[0, -0.175, 0]} castShadow>
            <boxGeometry args={[0.17, 0.35, 0.18]} />
            <meshStandardMaterial color={darken(bodyColor, 0.45)} roughness={0.9} flatShading />
          </mesh>
          <mesh position={[0, -0.525, 0]} castShadow>
            <boxGeometry args={[0.17, 0.35, 0.17]} />
            <meshStandardMaterial color={darken(bodyColor, 0.45)} roughness={0.9} flatShading />
          </mesh>
          <mesh position={[0, -0.74, 0.03]} castShadow>
            <boxGeometry args={[0.19, 0.08, 0.26]} />
            <meshStandardMaterial color="#1a1410" roughness={0.95} />
          </mesh>
          <mesh position={[0, -0.74, 0.16]} castShadow>
            <boxGeometry args={[0.16, 0.06, 0.04]} />
            <meshStandardMaterial color="#2a1c14" roughness={0.95} />
          </mesh>
        </group>
      </group>
    );
  },
);
StandingLegs.displayName = 'StandingLegs';

interface WorkerProps {
  id: string;
  /** Базовая позиция у стола (центр группы воркера). */
  position: [number, number, number];
  status: WorkerStatus;
  /** Если задан — воркер идёт к указанной tool-station. */
  walkingTo?: ToolStationKind;
  /** Helper для получения координаты станции (из OfficeLayout). */
  getToolStationPosition: (kind: ToolStationKind) => [number, number, number];
  role: string;
  /** Цвет тела. Если undefined — генерируется из id. */
  color?: string;
  /** URL лого (например, '/logos/vc.svg'). Рендерится круглым бейджем над ролью. */
  logo?: string;
  isCurrentlyClicked?: boolean;
  onClick: (id: string) => void;
  /** Текст облака мыслей (≤280 chars). Передаётся из useWorkerEvents. */
  thinking?: string;
  /** Когда облако фейдится. */
  thinkingExpiresAt?: number;
  /**
   * Скиллы routine'ы (до 3-х рендерятся как бейджи поверх label'а).
   * Фаза 3 плана 2026-05-21-skills-architecture-v3.
   */
  skills?: SkillBadge[];
  /**
   * Unix ms следующего запланированного запуска. Если задано и status='idle' —
   * рендерим DeskCountdown «До запуска: Xм Yс».
   */
  nextRunAt?: number;
  /**
   * Unix ms начала текущего прогона (audit.routine.start). Если задано и
   * status='running' — рендерим DeskCountdown «Работает: Xм Yс».
   */
  runningSince?: number;
  /** Прогресс выполнения 0..100 — рисуем bar в DeskCountdown. */
  progressPercent?: number;
  /** Метка текущего этапа («6b», «13a», ...) — показываем рядом с %. */
  progressStageLabel?: string;
  /** Сколько артефактов «сложено на стол» — растит DocumentsPile. */
  documentsCount?: number;
}

const STATUS_DOT_COLOR: Record<WorkerStatus, string> = {
  idle: '#7c7c7c',
  running: '#d97757',
  finished: '#7cb29a',
  failed: '#b25555',
};

// ──────────────────────────────────────────────────────────────────────
// Activity cycle (status='running'). Без этого workflow на 60-90 мин
// выглядел как «сел и сидит», даже если статусы кипят. Циклически
// чередуем микро-действия чтобы было видно что персонаж живёт.
// ──────────────────────────────────────────────────────────────────────

type ActivityPose = 'typing' | 'thinking' | 'stretch' | 'lookaround' | 'wander';

interface PoseSpec {
  weight: number; // вес в weighted-pick'е
  minMs: number;
  maxMs: number;
}

const POSE_SPECS: Record<ActivityPose, PoseSpec> = {
  typing: { weight: 35, minMs: 8_000, maxMs: 16_000 },
  thinking: { weight: 22, minMs: 5_000, maxMs: 10_000 },
  lookaround: { weight: 18, minMs: 3_500, maxMs: 5_000 },
  stretch: { weight: 10, minMs: 1_800, maxMs: 2_500 },
  wander: { weight: 15, minMs: 7_000, maxMs: 13_000 },
};

const ALL_STATIONS: ToolStationKind[] = ['db', 'fs', 'bash', 'web', 'tg', 'email'];

function pickPose(prev: ActivityPose | null): ActivityPose {
  // Weighted random, но запрещаем подряд одну и ту же позу — иначе глаз ловит
  // «застрял на одном движении».
  const total = (Object.entries(POSE_SPECS) as [ActivityPose, PoseSpec][])
    .filter(([k]) => k !== prev)
    .reduce((s, [, v]) => s + v.weight, 0);
  let roll = Math.random() * total;
  for (const [k, v] of Object.entries(POSE_SPECS) as [ActivityPose, PoseSpec][]) {
    if (k === prev) continue;
    roll -= v.weight;
    if (roll <= 0) return k;
  }
  return 'typing';
}

function pickPoseDuration(pose: ActivityPose): number {
  const spec = POSE_SPECS[pose];
  return spec.minMs + Math.random() * (spec.maxMs - spec.minMs);
}

function pickRandomStation(): ToolStationKind {
  return ALL_STATIONS[Math.floor(Math.random() * ALL_STATIONS.length)] ?? 'fs';
}

/** Стабильный hash-цвет из id, если автору не дали явный цвет. */
function colorFromId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const palette = ['#d97757', '#7c9eb2', '#c4a747', '#9ca77c', '#7cb29a', '#a77c9c', '#b25555'];
  return palette[Math.abs(hash) % palette.length] ?? '#d97757';
}

/** Затемнение hex-цвета на factor (0..1). Используется для штанов/обуви. */
function darken(hex: string, factor: number): string {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return hex;
  const v = Number.parseInt(m[1] ?? '000000', 16);
  const r = Math.max(0, Math.round(((v >> 16) & 0xff) * factor));
  const g = Math.max(0, Math.round(((v >> 8) & 0xff) * factor));
  const b = Math.max(0, Math.round((v & 0xff) * factor));
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** Подобранный аккуратный «accent» цвет для шляпки/воротника:
    дополняющий тон из палитры, чтобы был контраст к телу. */
function hatColor(bodyHex: string): string {
  const palette: Record<string, string> = {
    '#d97757': '#1a1410', // оранжевый → почти-чёрный
    '#7c9eb2': '#d97757', // синий → оранжевый
    '#c4a747': '#1a1410', // жёлтый → чёрный
    '#9ca77c': '#3a2d1c', // оливковый → тёмный
    '#7cb29a': '#d97757', // ментол → оранжевый
    '#a77c9c': '#c4a747', // лавандовый → жёлтый
    '#b25555': '#1a1410', // красный → чёрный
    '#7c4a2e': '#c4a747',
  };
  return palette[bodyHex.toLowerCase()] ?? '#1a1410';
}

export function Worker(props: WorkerProps): ReactNode {
  const {
    id,
    position,
    status,
    walkingTo,
    getToolStationPosition,
    role,
    color,
    logo,
    isCurrentlyClicked,
    onClick,
    thinking,
    thinkingExpiresAt,
    skills,
    nextRunAt,
    runningSince,
    progressPercent,
    progressStageLabel,
    documentsCount,
  } = props;

  // До 3-х бейджей. Если у скилла нет icon — пропускаем (без иконки бейдж
  // бесполезен, но имя всё равно появится в drawer'е).
  const visibleSkills = (skills ?? []).slice(0, 3);

  const groupRef = useRef<THREE.Group>(null);
  const innerRef = useRef<THREE.Group>(null);
  const headGroupRef = useRef<THREE.Group>(null);
  const eyesGroupRef = useRef<THREE.Group>(null);
  const leftHandRef = useRef<THREE.Mesh>(null);
  const rightHandRef = useRef<THREE.Mesh>(null);
  const legsGroupRef = useRef<THREE.Group>(null);
  const sittingLegsRef = useRef<THREE.Group>(null);
  const standingLegsRef = useRef<THREE.Group>(null);
  const leftLegRef = useRef<THREE.Group>(null);
  const rightLegRef = useRef<THREE.Group>(null);
  const phaseRef = useRef(Math.random() * Math.PI * 2);
  const blinkPhaseRef = useRef(Math.random() * 100);

  // Target positions для lerp'а
  const desk = useRef(new THREE.Vector3(...position));
  const target = useRef(new THREE.Vector3(...position));

  // ── Activity cycle: чередуем микро-позы пока status='running' ──
  // currentPose — что персонаж делает прямо сейчас.
  // poseUntilRef — performance.now() когда переключаем на следующую.
  // wanderStationRef — куда «прогуливается» по пути cycle'а (если pose='wander').
  // wanderArrivedAtRef — когда «дошёл» до станции (для return через ~MIN_HOLD).
  const currentPoseRef = useRef<ActivityPose>('typing');
  const poseUntilRef = useRef<number>(0);
  const wanderStationRef = useRef<ToolStationKind | null>(null);

  // «Метка» момента когда status стал 'finished' — для одноразовой celebration
  const finishedAtRef = useRef<number | null>(null);

  // Reactive: меняется status — фиксируем время finished
  useEffect(() => {
    if (status === 'finished') {
      finishedAtRef.current = performance.now();
    }
  }, [status]);

  // Дебаунс смены walkingTo — минимум 1500мс между переключениями, чтобы
  // быстрые серии tool.start не смазывали walking-анимацию.
  // displayedWalkingTo — то, что реально показываем; обновляется через таймер.
  const [displayedWalkingTo, setDisplayedWalkingTo] = useState<ToolStationKind | undefined>(
    walkingTo,
  );
  const lastChangeRef = useRef<number>(0);

  // Reactive: меняется position или walkingTo (новое значение prop'а) — обновляем
  // displayedWalkingTo с дебаунсом 1500мс.
  useEffect(() => {
    if (walkingTo === displayedWalkingTo) return;
    const now = performance.now();
    const sinceLast = now - lastChangeRef.current;
    const MIN_HOLD_MS = 2500;
    if (sinceLast >= MIN_HOLD_MS || displayedWalkingTo === undefined) {
      // Достаточно времени прошло — переключаемся сразу.
      setDisplayedWalkingTo(walkingTo);
      lastChangeRef.current = now;
    } else {
      // Отложить переключение до конца hold-window'а.
      const handle = window.setTimeout(() => {
        setDisplayedWalkingTo(walkingTo);
        lastChangeRef.current = performance.now();
      }, MIN_HOLD_MS - sinceLast);
      return () => window.clearTimeout(handle);
    }
    return undefined;
  }, [walkingTo, displayedWalkingTo]);

  // Reactive: position или displayedWalkingTo — обновляем lerp-target.
  // wander-станция (внутренняя, из activity cycle) применяется в useFrame, не
  // тут — чтобы не дёргать React-state каждые несколько секунд.
  useEffect(() => {
    desk.current.set(...position);
    if (displayedWalkingTo !== undefined) {
      const [tx, ty, tz] = getToolStationPosition(displayedWalkingTo);
      target.current.set(tx, ty, tz);
    } else {
      target.current.copy(desk.current);
    }
  }, [position, displayedWalkingTo, getToolStationPosition]);

  const bodyColor = color ?? colorFromId(id);

  useFrame((state, delta) => {
    if (!groupRef.current || !innerRef.current) return;

    const t = state.clock.elapsedTime;
    const nowMs = performance.now();

    // ─── Activity cycle: тикаем только в status='running', и только если нет
    // реальной data-driven walkingTo (она имеет приоритет). Если время позы
    // вышло — pick'аем новую и считаем длительность. wander pose дополнительно
    // ставит wanderStationRef, что переопределяет target ниже.
    if (status === 'running' && walkingTo === undefined) {
      if (poseUntilRef.current === 0 || nowMs >= poseUntilRef.current) {
        const next = pickPose(currentPoseRef.current);
        currentPoseRef.current = next;
        poseUntilRef.current = nowMs + pickPoseDuration(next);
        wanderStationRef.current = next === 'wander' ? pickRandomStation() : null;
      }
    } else {
      // status !== 'running' или есть реальный walkingTo → cycle спит.
      currentPoseRef.current = 'typing';
      poseUntilRef.current = 0;
      wanderStationRef.current = null;
    }
    const pose = currentPoseRef.current;
    // Сколько времени проведено в текущей позе (0..1).
    const poseSpec = POSE_SPECS[pose];
    const poseProgress =
      poseUntilRef.current === 0
        ? 0
        : Math.min(1, 1 - (poseUntilRef.current - nowMs) / poseSpec.maxMs);

    // ─── Решаем куда идти. Приоритет: реальный walkingTo → wanderStation → desk ───
    if (displayedWalkingTo !== undefined) {
      const [tx, ty, tz] = getToolStationPosition(displayedWalkingTo);
      target.current.set(tx, ty, tz);
    } else if (status === 'running' && wanderStationRef.current !== null) {
      const [tx, ty, tz] = getToolStationPosition(wanderStationRef.current);
      target.current.set(tx, ty, tz);
    } else {
      target.current.copy(desk.current);
    }

    // 1. Lerp position к target. Damp factor 0.12 на dt=16ms даёт примерно
    //    95% сходимости за ~0.8с — что нам и нужно.
    const lerpFactor = 1 - Math.exp(-delta * 4.5);
    groupRef.current.position.lerp(target.current, lerpFactor);

    // 2. Idle / running / failed / finished анимации применяем к innerRef
    //    (yOffset, rotation, leanX). groupRef отвечает только за walking.
    let yOffset = 0;
    let leanX = 0;
    let rotY = 0;

    if (status === 'idle') {
      // bob ±5cm, slow rotate ±2deg
      yOffset = 0.05 * Math.sin(t * 1.4 + phaseRef.current);
      rotY = ((2 * Math.PI) / 180) * Math.sin(t * 0.6 + phaseRef.current);
    } else if (status === 'running') {
      // База: усиленный bob и наклон. Поза-зависимые модификаторы — ниже.
      yOffset = 0.1 * Math.sin(t * 4.2 + phaseRef.current);
      leanX = (5 * Math.PI) / 180;
      rotY = ((3 * Math.PI) / 180) * Math.sin(t * 1.4 + phaseRef.current);
      if (pose === 'thinking') {
        // Откинулся: наклон назад, медленнее, голова туда-сюда.
        leanX = (-3 * Math.PI) / 180;
        yOffset = 0.03 * Math.sin(t * 1.2 + phaseRef.current);
      } else if (pose === 'stretch') {
        // Подался назад резко в первые ~30%, потом вернулся.
        const k = poseProgress < 0.3 ? poseProgress / 0.3 : 1 - (poseProgress - 0.3) / 0.7;
        leanX = ((-8 * Math.PI) / 180) * k;
        yOffset = 0.12 * k;
      } else if (pose === 'lookaround') {
        // Сильнее качается всем телом — «оглядывается».
        rotY = ((10 * Math.PI) / 180) * Math.sin(t * 1.8 + phaseRef.current);
      }
    } else if (status === 'failed') {
      // ссутулился, без bob
      leanX = (10 * Math.PI) / 180;
      yOffset = -0.08;
    } else if (status === 'finished') {
      // короткий прыжок: первые 1000мс после смены статуса
      const elapsed =
        finishedAtRef.current === null ? 9999 : performance.now() - finishedAtRef.current;
      if (elapsed < 1000) {
        // парабола: 0 → max → 0 за 1с
        const p = elapsed / 1000;
        yOffset = 0.3 * Math.sin(p * Math.PI);
      } else {
        yOffset = 0.05 * Math.sin(t * 1.4 + phaseRef.current);
      }
    }

    innerRef.current.position.y = yOffset;
    innerRef.current.rotation.x = leanX;
    innerRef.current.rotation.y = rotY;

    // ─── Голова: idle-swing по умолчанию, lookaround/thinking — сильнее ───
    if (headGroupRef.current) {
      let amplitudeDeg = 5;
      let speed = 0.7;
      if (status === 'running') {
        if (pose === 'lookaround') {
          amplitudeDeg = 40; // широкие повороты
          speed = 0.9;
        } else if (pose === 'thinking') {
          amplitudeDeg = 18; // задумчиво
          speed = 0.5;
        } else if (pose === 'typing') {
          amplitudeDeg = 8;
          speed = 0.9;
        }
      }
      headGroupRef.current.rotation.y =
        ((amplitudeDeg * Math.PI) / 180) * Math.sin(t * speed + phaseRef.current * 0.7);
    }

    // ─── Моргание глаз: scale.y → 0.05 на ~120мс каждые 3-4с ───
    if (eyesGroupRef.current) {
      const blinkCycle = (t + blinkPhaseRef.current) % 3.8;
      const isBlinking = blinkCycle < 0.12;
      eyesGroupRef.current.scale.y = isBlinking ? 0.08 : 1;
    }

    // ─── Кисти: разные позы — разное поведение ───
    if (leftHandRef.current && rightHandRef.current) {
      const baseY = 0.84;
      const baseZ = 0.42;
      // Дефолтные позиции (на клавиатуре). Pose-specific переопределит.
      let lY = baseY;
      let rY = baseY;
      let lZ = baseZ;
      let rZ = baseZ;
      if (status === 'running') {
        if (pose === 'typing') {
          const tick = t * 14;
          lY = baseY + 0.025 * Math.abs(Math.sin(tick));
          rY = baseY + 0.025 * Math.abs(Math.sin(tick + 1.5));
        } else if (pose === 'stretch') {
          // Обе руки вверх в первые ~30% позы, потом плавный возврат.
          const k = poseProgress < 0.3 ? poseProgress / 0.3 : 1 - (poseProgress - 0.3) / 0.7;
          const up = 0.7 * k;
          lY = baseY + up;
          rY = baseY + up;
          lZ = baseZ - 0.15 * k;
          rZ = baseZ - 0.15 * k;
        } else if (pose === 'thinking') {
          // Правая — к подбородку (вверх и ближе к голове). Левая отдыхает.
          lY = baseY - 0.05;
          rY = baseY + 0.6;
          rZ = baseZ - 0.25;
        } else if (pose === 'lookaround') {
          // Лёгкое движение кистей, словно листает или показывает.
          const tick = t * 5;
          lY = baseY + 0.04 * Math.sin(tick);
          rY = baseY + 0.04 * Math.sin(tick + Math.PI);
        }
        // wander: кисти просто отдыхают (стоит у станции).
      }
      leftHandRef.current.position.y = lY;
      rightHandRef.current.position.y = rY;
      leftHandRef.current.position.z = lZ;
      rightHandRef.current.position.z = rZ;
    }

    // ─── Posture: sitting vs standing ───
    // Стоим если: реальная walkingTo ИЛИ wander-станция активна.
    const isStanding = displayedWalkingTo !== undefined || wanderStationRef.current !== null;
    if (sittingLegsRef.current && standingLegsRef.current) {
      sittingLegsRef.current.visible = !isStanding;
      standingLegsRef.current.visible = isStanding;
    }
    // Leg swing при движении: проверяем дистанцию до target, если ещё не дошёл —
    // ноги колеблются ±15° на хипах. Когда у станции — стоит ровно.
    if (isStanding && leftLegRef.current && rightLegRef.current) {
      const distToTarget = groupRef.current.position.distanceTo(target.current);
      if (distToTarget > 0.15) {
        const swing = (15 * Math.PI) / 180;
        leftLegRef.current.rotation.x = swing * Math.sin(t * 6);
        rightLegRef.current.rotation.x = swing * Math.sin(t * 6 + Math.PI);
      } else {
        leftLegRef.current.rotation.x *= 0.85; // плавный return
        rightLegRef.current.rotation.x *= 0.85;
      }
    }
  });

  const handleClick = (e: ThreeEvent<MouseEvent>): void => {
    e.stopPropagation();
    onClick(id);
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: r3f <group> is a 3D mesh, not a DOM element — keyboard handlers don't apply.
    <group ref={groupRef} position={position} onClick={handleClick}>
      <group ref={innerRef}>
        {/* Body parts смотрят в +Z в своей frame; обёртка-rotation Y=π
            разворачивает их в -Z (к монитору стола). Стул вынесен наружу
            этой обёртки, чтобы сохранить его ориентацию: спинка в +Z (за воркером
            после поворота). */}
        <group rotation={[0, Math.PI, 0]}>
          {/* ───────────── Voxel-человечек, Minecraft-Steve пропорции ─────────────
            Принципы:
              * Один воксель ≈ 0.05м (как 1 пиксель в Minecraft).
              * Лицо лепится из множества мини-кубиков, не плоской текстурой,
                чтобы при ближнем зуме оставалась читаемая «пиксельность».
              * Каждая часть — flat-shading (грани не сглаживаются), чтобы
                рёбра подчёркивались тенью.
              * Палитра: skinTone (натуральный кожанистый), bodyColor (рубашка),
                darken(bodyColor) (штаны), hatColor (кепка/воротник, контраст). */}

          {/* Голова + лицо + кепка обёрнуты в одну группу для idle head-swing. */}
          <group ref={headGroupRef} position={[0, 1.55, 0]}>
            {/* Голова — нейтрально-тёплый skin-tone, не цвет рубашки. */}
            <mesh castShadow>
              <boxGeometry args={[0.4, 0.4, 0.4]} />
              <meshStandardMaterial color="#e6c4a0" roughness={0.9} flatShading />
            </mesh>

            {/* ─── Лицо: глаза (отдельная группа для моргания), нос, рот, брови ─── */}
            {/* Z=0.201 — фронт головы (0.4/2=0.2) + чуть-чуть от z-fight */}
            <group ref={eyesGroupRef}>
              {/* Белки глаз */}
              <mesh position={[-0.08, 0.05, 0.201]}>
                <boxGeometry args={[0.06, 0.05, 0.015]} />
                <meshStandardMaterial color="#f5f0e8" />
              </mesh>
              <mesh position={[0.08, 0.05, 0.201]}>
                <boxGeometry args={[0.06, 0.05, 0.015]} />
                <meshStandardMaterial color="#f5f0e8" />
              </mesh>
              {/* Зрачки — тёмные кубики поверх белков */}
              <mesh position={[-0.08, 0.05, 0.21]}>
                <boxGeometry args={[0.025, 0.025, 0.015]} />
                <meshStandardMaterial color="#0a0a0a" />
              </mesh>
              <mesh position={[0.08, 0.05, 0.21]}>
                <boxGeometry args={[0.025, 0.025, 0.015]} />
                <meshStandardMaterial color="#0a0a0a" />
              </mesh>
            </group>
            {/* Брови — тёмные коричневые полоски над глазами */}
            <mesh position={[-0.08, 0.11, 0.201]}>
              <boxGeometry args={[0.08, 0.018, 0.015]} />
              <meshStandardMaterial color="#3a2818" />
            </mesh>
            <mesh position={[0.08, 0.11, 0.201]}>
              <boxGeometry args={[0.08, 0.018, 0.015]} />
              <meshStandardMaterial color="#3a2818" />
            </mesh>
            {/* Нос — пирамидка из 2-х кубиков. Чуть выпирает вперёд (z=0.215). */}
            <mesh position={[0, 0.005, 0.215]}>
              <boxGeometry args={[0.04, 0.07, 0.04]} />
              <meshStandardMaterial color="#d4ad8a" roughness={0.9} />
            </mesh>
            {/* Рот — тёмная улыбка-полоска */}
            <mesh position={[0, -0.07, 0.201]}>
              <boxGeometry args={[0.1, 0.025, 0.015]} />
              <meshStandardMaterial color="#5a2818" />
            </mesh>
            {/* Подбородок-щёчка тон — мини-кубик чуть тёплее ниже рта */}
            <mesh position={[0, -0.115, 0.201]}>
              <boxGeometry args={[0.14, 0.04, 0.015]} />
              <meshStandardMaterial color="#d4ad8a" roughness={0.95} />
            </mesh>

            {/* Уши — мини-кубики сбоку головы */}
            <mesh position={[-0.21, 0, 0]}>
              <boxGeometry args={[0.025, 0.1, 0.08]} />
              <meshStandardMaterial color="#d4ad8a" roughness={0.9} />
            </mesh>
            <mesh position={[0.21, 0, 0]}>
              <boxGeometry args={[0.025, 0.1, 0.08]} />
              <meshStandardMaterial color="#d4ad8a" roughness={0.9} />
            </mesh>

            {/* ─── Волосы / кепка — двухслойная: каркас сверху + козырёк спереди ─── */}
            {/* Основная «макушка» волос/шапки — слой 1 (по контуру головы, чуть выпирает по бокам) */}
            <mesh position={[0, 0.22, 0]} castShadow>
              <boxGeometry args={[0.42, 0.1, 0.42]} />
              <meshStandardMaterial color={hatColor(bodyColor)} roughness={0.75} flatShading />
            </mesh>
            {/* Верхушка кепки — более узкий куб */}
            <mesh position={[0, 0.285, 0]} castShadow>
              <boxGeometry args={[0.3, 0.04, 0.3]} />
              <meshStandardMaterial color={hatColor(bodyColor)} roughness={0.75} flatShading />
            </mesh>
            {/* Козырёк кепки — выпирает вперёд */}
            <mesh position={[0, 0.19, 0.22]} castShadow>
              <boxGeometry args={[0.32, 0.025, 0.12]} />
              <meshStandardMaterial color={darken(hatColor(bodyColor), 0.7)} roughness={0.7} />
            </mesh>
          </group>

          {/* ─── Шея — узкий куб skin-tone ─── */}
          <mesh position={[0, 1.33, 0]} castShadow>
            <boxGeometry args={[0.15, 0.07, 0.15]} />
            <meshStandardMaterial color="#d4ad8a" roughness={0.9} />
          </mesh>

          {/* ─── Туловище ─── */}
          {/* Основная рубашка */}
          <mesh position={[0, 1.05, 0]} castShadow>
            <boxGeometry args={[0.46, 0.5, 0.28]} />
            <meshStandardMaterial color={bodyColor} roughness={0.8} flatShading />
          </mesh>
          {/* Воротник — контрастная узкая полоса */}
          <mesh position={[0, 1.27, 0.005]} castShadow>
            <boxGeometry args={[0.48, 0.05, 0.29]} />
            <meshStandardMaterial color={hatColor(bodyColor)} roughness={0.6} />
          </mesh>
          {/* «Вырез» воротника — V из 2 мини-кубиков */}
          <mesh position={[0, 1.22, 0.146]}>
            <boxGeometry args={[0.07, 0.06, 0.02]} />
            <meshStandardMaterial color={darken(bodyColor, 0.7)} />
          </mesh>
          {/* Пуговицы вертикально на груди */}
          <mesh position={[0, 1.13, 0.146]}>
            <boxGeometry args={[0.025, 0.025, 0.02]} />
            <meshStandardMaterial color={hatColor(bodyColor)} />
          </mesh>
          <mesh position={[0, 1.06, 0.146]}>
            <boxGeometry args={[0.025, 0.025, 0.02]} />
            <meshStandardMaterial color={hatColor(bodyColor)} />
          </mesh>
          <mesh position={[0, 0.99, 0.146]}>
            <boxGeometry args={[0.025, 0.025, 0.02]} />
            <meshStandardMaterial color={hatColor(bodyColor)} />
          </mesh>

          {/* Карман на левой стороне рубашки */}
          <mesh position={[-0.13, 1.08, 0.146]}>
            <boxGeometry args={[0.1, 0.08, 0.015]} />
            <meshStandardMaterial color={darken(bodyColor, 0.85)} />
          </mesh>

          {/* Ремень — широкая чёрная полоска */}
          <mesh position={[0, 0.81, 0]} castShadow>
            <boxGeometry args={[0.48, 0.06, 0.3]} />
            <meshStandardMaterial color="#1a1410" roughness={0.95} />
          </mesh>
          {/* Пряжка ремня */}
          <mesh position={[0, 0.81, 0.151]}>
            <boxGeometry args={[0.07, 0.06, 0.015]} />
            <meshStandardMaterial color={hatColor(bodyColor)} metalness={0.4} roughness={0.5} />
          </mesh>

          {/* ─── Руки: плечо + предплечье горизонтально вперёд (на стол) + кисть на клавиатуре ─── */}
          {/* Левое плечо-шарик в shoulder-joint */}
          <mesh position={[-0.3, 1.05, 0.05]} castShadow>
            <boxGeometry args={[0.16, 0.18, 0.18]} />
            <meshStandardMaterial color={bodyColor} roughness={0.85} flatShading />
          </mesh>
          {/* Левое предплечье — рубашка, тянется вперёд (+Z) к клавиатуре */}
          <mesh position={[-0.3, 0.9, 0.22]} castShadow>
            <boxGeometry args={[0.14, 0.16, 0.42]} />
            <meshStandardMaterial color={bodyColor} roughness={0.85} flatShading />
          </mesh>
          {/* Левая кисть — skin-tone, на конце предплечья (ref для typing-анимации) */}
          <mesh ref={leftHandRef} position={[-0.3, 0.84, 0.42]} castShadow>
            <boxGeometry args={[0.13, 0.12, 0.18]} />
            <meshStandardMaterial color="#e6c4a0" roughness={0.9} flatShading />
          </mesh>
          {/* Правое плечо-шарик */}
          <mesh position={[0.3, 1.05, 0.05]} castShadow>
            <boxGeometry args={[0.16, 0.18, 0.18]} />
            <meshStandardMaterial color={bodyColor} roughness={0.85} flatShading />
          </mesh>
          {/* Правое предплечье */}
          <mesh position={[0.3, 0.9, 0.22]} castShadow>
            <boxGeometry args={[0.14, 0.16, 0.42]} />
            <meshStandardMaterial color={bodyColor} roughness={0.85} flatShading />
          </mesh>
          {/* Правая кисть */}
          <mesh ref={rightHandRef} position={[0.3, 0.84, 0.42]} castShadow>
            <boxGeometry args={[0.13, 0.12, 0.18]} />
            <meshStandardMaterial color="#e6c4a0" roughness={0.9} flatShading />
          </mesh>

          {/* ─── НОГИ: две позы (sitting/standing) через условный рендер ───
            Sitting — бёдра горизонтально, голени вниз (за столом).
            Standing — обе ноги вертикально, лёгкое qualifying-шевеление при ходьбе.
            Переключение через `posture` ref в useFrame (по walkingTo).
            См. <SittingLegs/> и <StandingLegs/> ниже. */}
          <group ref={legsGroupRef}>
            <SittingLegs bodyColor={bodyColor} darken={darken} ref={sittingLegsRef} />
            <StandingLegs
              bodyColor={bodyColor}
              darken={darken}
              ref={standingLegsRef}
              leftLegRef={leftLegRef}
              rightLegRef={rightLegRef}
            />
          </group>
        </group>
        {/* конец body rotation wrapper */}

        {/* Status-dot — сфера над головой */}
        <mesh position={[0, 1.95, 0]}>
          <sphereGeometry args={[0.07, 12, 12]} />
          <meshStandardMaterial
            color={STATUS_DOT_COLOR[status]}
            emissive={STATUS_DOT_COLOR[status]}
            emissiveIntensity={status === 'idle' ? 0.3 : 0.9}
          />
        </mesh>

        {/* Подпись с ролью — drei Html overlay (DOM-шрифт, без сетевого fetch'а).
            Раньше использовался drei Text + Troika web-worker, но он грузит
            шрифт через fetch на CDN и suspend'ит всю сцену при failure.
            Label кликабельна → открывает drawer (r3f raycast click на 3D-mesh
            ловит только trusted browser events, проще иметь DOM-handle). */}
        <Html position={[0, 2.2, 0]} center distanceFactor={8} occlude={false}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 4,
            }}
          >
            {/* Платформенный логотип-баннер — круглый бейдж над ролью.
                Рендерится только если задан logo. ${color}-glow вокруг чтобы
                бейдж «висел» над сотрудником. */}
            {logo !== undefined && (
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: '50%',
                  overflow: 'hidden',
                  background: '#0a0a0a',
                  border: '2px solid rgba(217,119,87,0.6)',
                  boxShadow: `0 0 12px ${bodyColor}55, 0 2px 6px rgba(0,0,0,0.6)`,
                  marginBottom: 2,
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
                border: `1px solid ${isCurrentlyClicked === true ? '#ffaa66' : 'rgba(217,119,87,0.55)'}`,
                borderRadius: 3,
                whiteSpace: 'nowrap',
                userSelect: 'none',
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              {role}
            </button>
            {/* Skill badges — до 3-х. Кружок с emoji-иконкой на фоне skill.color.
                Если у скилла нет icon, рендерим первую букву имени (плохой
                fallback, но честный — фаундер увидит, что у скилла забыл задать icon). */}
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
                      boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                    }}
                  >
                    {s.icon ?? s.name[0]?.toUpperCase() ?? '?'}
                  </span>
                ))}
              </div>
            )}
          </div>
        </Html>

        {/* Click-highlight ring (если кликнут) */}
        {isCurrentlyClicked === true && (
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
            <ringGeometry args={[0.5, 0.55, 24]} />
            <meshBasicMaterial color="#d97757" transparent opacity={0.8} />
          </mesh>
        )}

        {/* Облако мыслей — видно когда WorkerData.thinking задан И не expire'ed.
            Прячем когда воркер на tool-станции (currentTool present) — там
            будет ToolStationActivity-карточка с tool-input'ом. */}
        {thinking !== undefined && thinking.length > 0 && thinkingExpiresAt !== undefined && (
          <ThoughtBubble text={thinking} expiresAt={thinkingExpiresAt} accentColor={bodyColor} />
        )}

        {/* Мини-табло «обратной стороны монитора» — показывает либо обратный
            счёт до запланированного запуска (idle + nextRunAt), либо elapsed
            текущего прогона (running + runningSince). Скрывается при остальных
            статусах. */}
        {status === 'idle' && nextRunAt !== undefined && nextRunAt > Date.now() && (
          <DeskCountdown mode="idle" nextRunAt={nextRunAt} />
        )}
        {status === 'running' && runningSince !== undefined && (
          <DeskCountdown
            mode="running"
            runningSince={runningSince}
            percent={progressPercent}
            stageLabel={progressStageLabel ?? null}
          />
        )}

        {/* Стопка документов на столе — растёт по мере работы (каждый tool.end
            добавляет лист). Показываем когда есть хотя бы 1 артефакт. После
            routine.end сбрасывается через countDocumentsForRoutine. */}
        {documentsCount !== undefined && documentsCount > 0 && (
          <DocumentsPile count={documentsCount} />
        )}
      </group>
    </group>
  );
}
