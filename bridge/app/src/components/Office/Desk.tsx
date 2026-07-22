// Полностью «жилой» стол с воксельным декором:
//
//   - Деревянная столешница + 4 квадратных ножки (voxel style)
//   - Монитор с анимированным «кодом»: CanvasTexture с цветными синтакс-блоками,
//     которая бесконечно скроллится через texture.offset.y
//   - Стикер на углу монитора
//   - Клавиатура с отдельными «кеями»
//   - Мышь + коврик
//   - Кружка кофе + анимированный пар (мелкие сферы, поднимающиеся вверх)
//   - Гусиная лампа с тёплой точечной подсветкой над столом
//   - Стопка бумаг с post-it
//
// Все объекты статичны, кроме монитора (анимация текстуры) и пара (3 сферы
// на useFrame). Каждый стол получает рандомизированный seed по позиции,
// чтобы мониторы скроллились в разных фазах, а не синхронно.

import { useFrame } from '@react-three/fiber';
import { type ReactNode, useMemo, useRef } from 'react';
import * as THREE from 'three';

interface DeskProps {
  position: [number, number, number];
  /** Цвет «кода» на мониторе. По умолчанию — accent. */
  monitorAccent?: string;
}

const WOOD_COLOR = '#5a3820';
const WOOD_DARK = '#3a2410';
const LEG_COLOR = '#2a1810';
const MONITOR_FRAME = '#0a0806';
const MONITOR_BEZEL = '#1a1410';

const TABLE_W = 1.6;
const TABLE_D = 0.8;
const TABLE_T = 0.07;
const TABLE_Y = 0.75;

/**
 * Generate a canvas texture imitating syntax-highlighted code:
 * vertical stack of rows, каждая строка из 3-5 цветных «блоков» разной длины,
 * с лёгким отступом слева как indent. Текстура очень высокая (tile 8x),
 * чтобы при скролле смотрелась бесконечной.
 */
function useCodeTexture(seed: number): THREE.CanvasTexture {
  return useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) return new THREE.CanvasTexture(canvas);

    // Background
    ctx.fillStyle = '#0a0806';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Pseudo-random by seed
    let s = seed;
    const rng = (): number => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };

    // Syntax palette
    const PALETTE = [
      '#d97757', // keyword (orange)
      '#7c9eb2', // type (blue)
      '#9ca77c', // string (olive)
      '#c4a747', // number (yellow)
      '#7cb29a', // comment (mint)
      '#a77c9c', // builtin (lavender)
      '#f0e6dc', // var (default text)
    ];

    const rowH = 11;
    const rows = canvas.height / rowH;
    for (let r = 0; r < rows; r++) {
      const indent = Math.floor(rng() * 4) * 12 + 6; // 6..54
      let cursorX = indent;
      const segments = 2 + Math.floor(rng() * 4); // 2..5 segments
      for (let s2 = 0; s2 < segments; s2++) {
        const segLen = 8 + Math.floor(rng() * 60);
        const color = PALETTE[Math.floor(rng() * PALETTE.length)] ?? '#f0e6dc';
        ctx.fillStyle = color;
        ctx.fillRect(cursorX, r * rowH + 2, segLen, 5);
        cursorX += segLen + 4 + Math.floor(rng() * 6);
        if (cursorX > canvas.width - 20) break;
      }
    }

    // Add a brighter "current line" stripe at random position
    const currentLine = Math.floor(rng() * rows);
    ctx.fillStyle = 'rgba(217,119,87,0.08)';
    ctx.fillRect(0, currentLine * rowH, canvas.width, rowH);

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1, 1.4); // лёгкое растяжение по высоте
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    return texture;
  }, [seed]);
}

/**
 * Steam particle: 3 маленьких сферы, поднимающиеся над кружкой, fade-out,
 * teleport обратно вниз.
 */
function SteamPlume({
  position,
  color = '#d4c4a8',
}: {
  position: [number, number, number];
  color?: string;
}): ReactNode {
  const ref0 = useRef<THREE.Mesh>(null);
  const ref1 = useRef<THREE.Mesh>(null);
  const ref2 = useRef<THREE.Mesh>(null);

  const phases = useMemo(() => [0, 0.6, 1.2], []);
  useFrame((state) => {
    const refs = [ref0, ref1, ref2];
    const t = state.clock.elapsedTime;
    refs.forEach((r, i) => {
      const phase = phases[i] ?? 0;
      const cycle = ((t + phase) % 1.8) / 1.8; // 0..1
      if (r.current) {
        r.current.position.y = cycle * 0.4;
        const scale = 0.6 + cycle * 1.2;
        r.current.scale.set(scale, scale, scale);
        const mat = r.current.material as THREE.MeshStandardMaterial;
        mat.opacity = (1 - cycle) * 0.5;
      }
    });
  });
  return (
    <group position={position}>
      <mesh ref={ref0}>
        <sphereGeometry args={[0.018, 6, 6]} />
        <meshStandardMaterial color={color} transparent opacity={0.4} depthWrite={false} />
      </mesh>
      <mesh ref={ref1}>
        <sphereGeometry args={[0.015, 6, 6]} />
        <meshStandardMaterial color={color} transparent opacity={0.4} depthWrite={false} />
      </mesh>
      <mesh ref={ref2}>
        <sphereGeometry args={[0.02, 6, 6]} />
        <meshStandardMaterial color={color} transparent opacity={0.4} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** Клавиатура: 1 база + 5 рядов кубиков-кейкэпов. */
function Keyboard({ position }: { position: [number, number, number] }): ReactNode {
  const KB_W = 0.55;
  const KB_D = 0.18;
  const ROWS = 5;
  const COLS = 14;
  const keySize = 0.034;
  const padX = (KB_W - COLS * keySize - (COLS - 1) * 0.003) / 2;
  const padZ = (KB_D - ROWS * keySize - (ROWS - 1) * 0.003) / 2;
  return (
    <group position={position}>
      {/* Корпус клавиатуры */}
      <mesh castShadow receiveShadow>
        <boxGeometry args={[KB_W, 0.015, KB_D]} />
        <meshStandardMaterial color="#1a1410" roughness={0.7} />
      </mesh>
      {/* Кейкэпы */}
      {Array.from({ length: ROWS }, (_, r) =>
        Array.from({ length: COLS }, (_, c) => {
          const x = -KB_W / 2 + padX + c * (keySize + 0.003) + keySize / 2;
          const z = -KB_D / 2 + padZ + r * (keySize + 0.003) + keySize / 2;
          // Подсветка пары кейкэпов (typing-indicator)
          const isLit = (r === 2 && c === 7) || (r === 3 && c === 5);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: composite r/c key is stable for fixed-grid layout
            <mesh key={`${r}-${c}`} position={[x, 0.012, z]}>
              <boxGeometry args={[keySize - 0.003, 0.012, keySize - 0.003]} />
              <meshStandardMaterial
                color={isLit ? '#d97757' : '#2a2418'}
                emissive={isLit ? '#d97757' : '#000000'}
                emissiveIntensity={isLit ? 0.6 : 0}
                roughness={0.6}
              />
            </mesh>
          );
        }),
      )}
    </group>
  );
}

/** Кружка кофе + ручка + жидкость + пар. */
function CoffeeMug({ position }: { position: [number, number, number] }): ReactNode {
  return (
    <group position={position}>
      {/* Корпус кружки */}
      <mesh castShadow>
        <cylinderGeometry args={[0.045, 0.04, 0.09, 14]} />
        <meshStandardMaterial color="#d97757" roughness={0.4} metalness={0.1} />
      </mesh>
      {/* Жидкость сверху — тёмный круг */}
      <mesh position={[0, 0.044, 0]}>
        <cylinderGeometry args={[0.04, 0.04, 0.005, 14]} />
        <meshStandardMaterial color="#1a0a04" emissive="#3a1408" emissiveIntensity={0.3} />
      </mesh>
      {/* Ручка — torus */}
      <mesh position={[0.05, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
        <torusGeometry args={[0.025, 0.008, 6, 10, Math.PI]} />
        <meshStandardMaterial color="#d97757" roughness={0.4} />
      </mesh>
      {/* Пар */}
      <SteamPlume position={[0, 0.06, 0]} />
    </group>
  );
}

/** Гусиная лампа с тёплым point-light. */
function DeskLamp({ position }: { position: [number, number, number] }): ReactNode {
  return (
    <group position={position}>
      {/* База */}
      <mesh castShadow>
        <cylinderGeometry args={[0.05, 0.06, 0.025, 16]} />
        <meshStandardMaterial color="#1a1410" roughness={0.5} metalness={0.4} />
      </mesh>
      {/* Стойка */}
      <mesh position={[0, 0.13, 0]} castShadow>
        <cylinderGeometry args={[0.008, 0.008, 0.25, 8]} />
        <meshStandardMaterial color="#2a2418" roughness={0.4} metalness={0.6} />
      </mesh>
      {/* Изгиб (упрощённый — наклонённый цилиндр) */}
      <mesh position={[0.06, 0.245, 0]} rotation={[0, 0, -Math.PI / 3]} castShadow>
        <cylinderGeometry args={[0.008, 0.008, 0.14, 8]} />
        <meshStandardMaterial color="#2a2418" roughness={0.4} metalness={0.6} />
      </mesh>
      {/* Колпак лампы */}
      <group position={[0.135, 0.215, 0]} rotation={[0, 0, -Math.PI / 3]}>
        <mesh castShadow>
          <coneGeometry args={[0.06, 0.09, 12, 1, true]} />
          <meshStandardMaterial color="#3a2818" roughness={0.6} side={THREE.DoubleSide} />
        </mesh>
        {/* «Свет» из лампы — emissive disc */}
        <mesh position={[0, -0.04, 0]} rotation={[Math.PI, 0, 0]}>
          <circleGeometry args={[0.05, 14]} />
          <meshStandardMaterial color="#fff0c8" emissive="#fff0c8" emissiveIntensity={2.4} />
        </mesh>
        {/* Тёплая точечная подсветка */}
        <pointLight color="#ffd99c" intensity={0.8} distance={1.6} decay={1.6} />
      </group>
    </group>
  );
}

/** Стопка бумаг с post-it'ом */
function PaperStack({ position }: { position: [number, number, number] }): ReactNode {
  return (
    <group position={position}>
      <mesh castShadow>
        <boxGeometry args={[0.14, 0.012, 0.18]} />
        <meshStandardMaterial color="#e8e0d4" roughness={0.95} />
      </mesh>
      <mesh position={[0.01, 0.008, 0.005]} castShadow>
        <boxGeometry args={[0.14, 0.012, 0.18]} />
        <meshStandardMaterial color="#f0e6dc" roughness={0.95} />
      </mesh>
      {/* Post-it жёлтый */}
      <mesh position={[0.04, 0.018, -0.05]} rotation={[-Math.PI / 2, 0, 0.2]}>
        <planeGeometry args={[0.07, 0.07]} />
        <meshStandardMaterial color="#c4a747" roughness={0.7} />
      </mesh>
    </group>
  );
}

export function Desk({ position, monitorAccent = '#d97757' }: DeskProps): ReactNode {
  // Стабильный seed из позиции — чтобы текстуры/фазы отличались, но reproducible.
  const seed = useMemo(
    () => Math.abs(Math.floor(position[0] * 1000 + position[2] * 17)) || 1,
    [position],
  );
  const codeTexture = useCodeTexture(seed);

  // Анимация скролла монитора — texture.offset.y растёт со временем,
  // wrap=Repeat обеспечивает бесшовность.
  const scrollSpeed = useMemo(() => 0.04 + ((seed % 7) / 7) * 0.04, [seed]);
  useFrame((_, delta) => {
    codeTexture.offset.y -= delta * scrollSpeed;
  });

  return (
    <group position={position}>
      {/* ───────────── Столешница ───────────── */}
      <mesh position={[0, TABLE_Y, 0]} castShadow receiveShadow>
        <boxGeometry args={[TABLE_W, TABLE_T, TABLE_D]} />
        <meshStandardMaterial color={WOOD_COLOR} roughness={0.75} metalness={0.05} />
      </mesh>
      {/* Тёмный кант по периметру (выглядит как «обвязка») */}
      <mesh position={[0, TABLE_Y + TABLE_T / 2 + 0.002, 0]}>
        <boxGeometry args={[TABLE_W + 0.02, 0.012, TABLE_D + 0.02]} />
        <meshStandardMaterial color={WOOD_DARK} roughness={0.85} />
      </mesh>

      {/* ───────────── 4 квадратные ножки (voxel) ───────────── */}
      {[
        [TABLE_W / 2 - 0.07, TABLE_D / 2 - 0.07],
        [-(TABLE_W / 2 - 0.07), TABLE_D / 2 - 0.07],
        [TABLE_W / 2 - 0.07, -(TABLE_D / 2 - 0.07)],
        [-(TABLE_W / 2 - 0.07), -(TABLE_D / 2 - 0.07)],
      ].map(([x, z]) => (
        <mesh key={`leg-${x},${z}`} position={[x ?? 0, TABLE_Y / 2, z ?? 0]} castShadow>
          <boxGeometry args={[0.07, TABLE_Y, 0.07]} />
          <meshStandardMaterial color={LEG_COLOR} roughness={0.85} />
        </mesh>
      ))}
      {/* Поперечная связка ножек снизу */}
      <mesh position={[0, 0.08, 0]}>
        <boxGeometry args={[TABLE_W - 0.2, 0.025, 0.04]} />
        <meshStandardMaterial color={LEG_COLOR} roughness={0.85} />
      </mesh>

      {/* ───────────── Монитор: подставка + экран с code-texture ───────────── */}
      <group position={[0, TABLE_Y + TABLE_T / 2, -0.22]}>
        {/* Подставка */}
        <mesh position={[0, 0.02, 0]} castShadow>
          <boxGeometry args={[0.18, 0.025, 0.12]} />
          <meshStandardMaterial color={MONITOR_FRAME} roughness={0.5} />
        </mesh>
        {/* Стойка */}
        <mesh position={[0, 0.11, 0]} castShadow>
          <boxGeometry args={[0.04, 0.16, 0.04]} />
          <meshStandardMaterial color={MONITOR_FRAME} roughness={0.5} />
        </mesh>
        {/* Корпус экрана */}
        <mesh position={[0, 0.34, 0]} castShadow>
          <boxGeometry args={[0.62, 0.42, 0.05]} />
          <meshStandardMaterial color={MONITOR_FRAME} roughness={0.6} />
        </mesh>
        {/* Внутренняя рамка (bezel) */}
        <mesh position={[0, 0.34, 0.026]}>
          <planeGeometry args={[0.58, 0.38]} />
          <meshStandardMaterial color={MONITOR_BEZEL} />
        </mesh>
        {/* Сам экран — code-texture, anim scroll */}
        <mesh position={[0, 0.34, 0.027]}>
          <planeGeometry args={[0.54, 0.34]} />
          <meshStandardMaterial
            map={codeTexture}
            emissive="#ffffff"
            emissiveMap={codeTexture}
            emissiveIntensity={0.55}
            toneMapped={false}
          />
        </mesh>
        {/* Бликующая статус-точка на углу экрана (вкл индикатор) */}
        <mesh position={[0.28, 0.16, 0.027]}>
          <boxGeometry args={[0.012, 0.012, 0.002]} />
          <meshStandardMaterial
            color={monitorAccent}
            emissive={monitorAccent}
            emissiveIntensity={1.6}
          />
        </mesh>
        {/* Post-it на боку монитора */}
        <mesh position={[0.34, 0.34, 0.024]} rotation={[0, 0.05, 0]}>
          <planeGeometry args={[0.06, 0.06]} />
          <meshStandardMaterial color="#c4a747" roughness={0.7} />
        </mesh>
      </group>

      {/* ───────────── Клавиатура + мышь + коврик ───────────── */}
      <group position={[0, TABLE_Y + TABLE_T / 2, 0.1]}>
        {/* Коврик под клавиатуру+мышь */}
        <mesh position={[0.05, 0.001, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[0.85, 0.26]} />
          <meshStandardMaterial color="#0c0806" roughness={1.0} />
        </mesh>
        <Keyboard position={[-0.1, 0, 0]} />
        {/* Мышь — справа */}
        <mesh position={[0.3, 0.015, 0]} castShadow>
          <boxGeometry args={[0.06, 0.025, 0.1]} />
          <meshStandardMaterial color="#1a1410" roughness={0.5} />
        </mesh>
        <mesh position={[0.3, 0.029, -0.02]} castShadow>
          <boxGeometry args={[0.055, 0.005, 0.04]} />
          <meshStandardMaterial color="#2a2418" roughness={0.4} />
        </mesh>
        {/* Кабель мыши — короткий цилиндр */}
        <mesh position={[0.3, 0.015, 0.07]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.004, 0.004, 0.05, 6]} />
          <meshStandardMaterial color="#1a1410" />
        </mesh>
      </group>

      {/* ───────────── Кружка кофе — слева ───────────── */}
      <CoffeeMug position={[-0.6, TABLE_Y + TABLE_T / 2 + 0.045, -0.1]} />

      {/* ───────────── Гусиная лампа — слева сзади ───────────── */}
      <DeskLamp position={[-0.65, TABLE_Y + TABLE_T / 2, -0.28]} />

      {/* ───────────── Стопка бумаг — справа сзади ───────────── */}
      <PaperStack position={[0.55, TABLE_Y + TABLE_T / 2 + 0.013, -0.2]} />

      {/* ───────────── Дополнительно: ручка на бумагах ───────────── */}
      <mesh position={[0.6, TABLE_Y + TABLE_T / 2 + 0.024, -0.18]} rotation={[0, 0.3, 0]}>
        <cylinderGeometry args={[0.005, 0.005, 0.11, 8]} />
        <meshStandardMaterial color="#d97757" roughness={0.4} metalness={0.3} />
      </mesh>
    </group>
  );
}
