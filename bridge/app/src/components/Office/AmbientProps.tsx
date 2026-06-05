// Окружение офиса: «жилые» детали, чтобы комната не выглядела пустой.
//
//   - Plant: воксельный горшок + ствол + 5 листьев-плоскостей.
//   - Whiteboard: текстура из CanvasContext с нарисованными «диаграммами»
//     (стрелки, прямоугольники, маркер-каракули).
//   - NeonSign: emissive «AI CO-FOUNDER» + pulsation на useFrame.
//   - WallClock: круг с цифрами + бегущая секундная стрелка.
//   - Poster: текстурный плакат с «хайповым» текстом.
//   - ServerRack: дополнительная вертикальная стойка с пульсирующими LED.
//   - WaterCooler: цилиндрический баллон + основание.

import { useFrame } from '@react-three/fiber';
import { type ReactNode, useMemo, useRef } from 'react';
import * as THREE from 'three';

const ACCENT = '#d97757';

// ───────────────────────────────────────────────────────────────────
// Plant
// ───────────────────────────────────────────────────────────────────
function Plant({ position }: { position: [number, number, number] }): ReactNode {
  const swayRef = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (swayRef.current) {
      const t = state.clock.elapsedTime;
      swayRef.current.rotation.z = 0.04 * Math.sin(t * 0.6);
      swayRef.current.rotation.x = 0.03 * Math.sin(t * 0.4 + 1);
    }
  });
  return (
    <group position={position}>
      {/* Горшок — нижняя ступенька */}
      <mesh position={[0, 0.15, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.32, 0.25, 0.3, 16]} />
        <meshStandardMaterial color="#3a2818" roughness={0.85} />
      </mesh>
      {/* Земля — тёмный диск */}
      <mesh position={[0, 0.305, 0]}>
        <cylinderGeometry args={[0.28, 0.28, 0.02, 16]} />
        <meshStandardMaterial color="#1a1008" roughness={1.0} />
      </mesh>
      {/* Ствол + листья — slight sway */}
      <group ref={swayRef} position={[0, 0.31, 0]}>
        <mesh position={[0, 0.4, 0]} castShadow>
          <cylinderGeometry args={[0.03, 0.04, 0.8, 8]} />
          <meshStandardMaterial color="#4a3818" roughness={0.85} />
        </mesh>
        {/* Листья — наклонённые плоскости */}
        {[
          { rot: [0, 0, 0.5], pos: [0.4, 0.6, 0], scale: [0.7, 0.25, 1] },
          { rot: [0, Math.PI / 2, 0.6], pos: [0, 0.7, 0.4], scale: [0.7, 0.25, 1] },
          { rot: [0, Math.PI, 0.7], pos: [-0.45, 0.55, 0], scale: [0.7, 0.25, 1] },
          { rot: [0, -Math.PI / 2, 0.5], pos: [0, 0.65, -0.4], scale: [0.7, 0.25, 1] },
          { rot: [0, Math.PI / 4, -0.3], pos: [0.25, 0.85, 0.25], scale: [0.5, 0.2, 1] },
          { rot: [0, -Math.PI / 4, -0.4], pos: [-0.2, 0.95, -0.2], scale: [0.5, 0.2, 1] },
        ].map((leaf, i) => (
          <mesh
            // biome-ignore lint/suspicious/noArrayIndexKey: static literal array, order fixed
            key={i}
            position={leaf.pos as [number, number, number]}
            rotation={leaf.rot as [number, number, number]}
            castShadow
          >
            <boxGeometry args={[0.5, 0.04, 0.18]} />
            <meshStandardMaterial color={i % 2 === 0 ? '#5a6e3a' : '#3a5028'} roughness={0.7} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

// ───────────────────────────────────────────────────────────────────
// Whiteboard
// ───────────────────────────────────────────────────────────────────
function useWhiteboardTexture(): THREE.CanvasTexture {
  return useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 320;
    const ctx = canvas.getContext('2d');
    if (!ctx) return new THREE.CanvasTexture(canvas);

    // Фон — почти-белая доска
    ctx.fillStyle = '#f4ede1';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // «Hand-drawn» лёгкие штрихи маркером
    ctx.strokeStyle = '#1a1410';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';

    // Заголовок: «AI CO-FOUNDER»
    ctx.fillStyle = '#d97757';
    ctx.font = 'bold 26px monospace';
    ctx.fillText('AI CO-FOUNDER', 30, 40);

    // Линия под заголовком
    ctx.beginPath();
    ctx.moveTo(30, 50);
    ctx.lineTo(280, 50);
    ctx.stroke();

    // 3 прямоугольника, соединённых стрелками — простой flow
    const drawBox = (
      x: number,
      y: number,
      w: number,
      h: number,
      label: string,
      color: string,
    ): void => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = color;
      ctx.font = '14px monospace';
      ctx.fillText(label, x + 8, y + h / 2 + 5);
    };
    drawBox(30, 90, 130, 50, 'TRIAGE', '#7c9eb2');
    drawBox(190, 90, 130, 50, 'SOLVE', '#9ca77c');
    drawBox(350, 90, 130, 50, 'REPORT', '#c4a747');

    // Стрелки между ними
    const drawArrow = (x1: number, y1: number, x2: number, y2: number): void => {
      ctx.strokeStyle = '#1a1410';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      // Наконечник
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - 8, y2 - 5);
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - 8, y2 + 5);
      ctx.stroke();
    };
    drawArrow(160, 115, 190, 115);
    drawArrow(320, 115, 350, 115);

    // Каракули-список снизу
    ctx.fillStyle = '#1a1410';
    ctx.font = '16px monospace';
    const todos = ['✓ M1: ядро', '✓ M2: триаж', '○ M3: routines', '○ M4: solve'];
    todos.forEach((s, i) => {
      ctx.fillText(s, 30, 180 + i * 25);
    });

    // Sticky note рядом
    ctx.fillStyle = '#c4a747';
    ctx.fillRect(330, 180, 130, 100);
    ctx.fillStyle = '#1a1410';
    ctx.font = '14px monospace';
    ctx.fillText('IDEA:', 345, 205);
    ctx.fillText('opus 4.7', 345, 225);
    ctx.fillText('1M ctx', 345, 245);

    return new THREE.CanvasTexture(canvas);
  }, []);
}

function Whiteboard({
  position,
  rotation,
}: {
  position: [number, number, number];
  rotation: [number, number, number];
}): ReactNode {
  const tex = useWhiteboardTexture();
  return (
    <group position={position} rotation={rotation}>
      {/* Доска (висит на стенде, центр на y≈1.5 от пола) */}
      <group position={[0, 1.5, 0]}>
        {/* Рамка */}
        <mesh castShadow>
          <boxGeometry args={[2.4, 1.5, 0.08]} />
          <meshStandardMaterial color="#1a1410" roughness={0.6} />
        </mesh>
        {/* Сама доска */}
        <mesh position={[0, 0, 0.045]}>
          <planeGeometry args={[2.3, 1.4]} />
          <meshStandardMaterial map={tex} roughness={0.85} />
        </mesh>
        {/* Лоток для маркеров под доской */}
        <mesh position={[0, -0.78, 0.06]}>
          <boxGeometry args={[2.2, 0.06, 0.12]} />
          <meshStandardMaterial color="#3a2818" roughness={0.7} />
        </mesh>
        {/* Маркеры */}
        <mesh position={[-0.6, -0.78, 0.13]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.012, 0.012, 0.13, 8]} />
          <meshStandardMaterial color="#d97757" />
        </mesh>
        <mesh position={[-0.3, -0.78, 0.13]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.012, 0.012, 0.13, 8]} />
          <meshStandardMaterial color="#7c9eb2" />
        </mesh>
        <mesh position={[0, -0.78, 0.13]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.012, 0.012, 0.13, 8]} />
          <meshStandardMaterial color="#9ca77c" />
        </mesh>
      </group>
      {/* Стенд-треножник — 2 наклонённые ноги + поперечина */}
      <mesh position={[-0.9, 0.75, 0]} rotation={[0, 0, 0.18]} castShadow>
        <boxGeometry args={[0.07, 1.5, 0.07]} />
        <meshStandardMaterial color="#3a2818" roughness={0.85} />
      </mesh>
      <mesh position={[0.9, 0.75, 0]} rotation={[0, 0, -0.18]} castShadow>
        <boxGeometry args={[0.07, 1.5, 0.07]} />
        <meshStandardMaterial color="#3a2818" roughness={0.85} />
      </mesh>
      {/* Задняя опора (наклонённая назад) */}
      <mesh position={[0, 0.75, -0.35]} rotation={[0.25, 0, 0]} castShadow>
        <boxGeometry args={[0.07, 1.6, 0.07]} />
        <meshStandardMaterial color="#3a2818" roughness={0.85} />
      </mesh>
      {/* Поперечина */}
      <mesh position={[0, 0.4, 0]}>
        <boxGeometry args={[2.0, 0.05, 0.05]} />
        <meshStandardMaterial color="#3a2818" roughness={0.85} />
      </mesh>
    </group>
  );
}

// ───────────────────────────────────────────────────────────────────
// Neon sign
// ───────────────────────────────────────────────────────────────────
function useNeonTexture(text: string): THREE.CanvasTexture {
  return useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) return new THREE.CanvasTexture(canvas);

    // Чёрный фон
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // «Trumpet glow»: рисуем текст несколько раз с увеличивающимся блюром
    ctx.font = 'bold 120px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let pass = 0; pass < 5; pass++) {
      ctx.shadowColor = ACCENT;
      ctx.shadowBlur = pass * 18;
      ctx.fillStyle = pass === 4 ? '#fff5ed' : ACCENT;
      ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    }
    ctx.shadowBlur = 0;

    return new THREE.CanvasTexture(canvas);
  }, [text]);
}

function NeonSign({
  text,
  position,
  rotation,
}: {
  text: string;
  position: [number, number, number];
  rotation: [number, number, number];
}): ReactNode {
  const tex = useNeonTexture(text);
  const matRef = useRef<THREE.MeshStandardMaterial>(null);
  useFrame((state) => {
    if (matRef.current) {
      const t = state.clock.elapsedTime;
      // Лёгкая пульсация + редкие «глитчи»
      const flicker = Math.sin(t * 4) > 0.97 ? 0.4 : 1;
      matRef.current.emissiveIntensity = (1.6 + 0.2 * Math.sin(t * 0.8)) * flicker;
    }
  });
  return (
    <group position={position} rotation={rotation}>
      {/* Тонкая металлическая рамка корпуса вывески */}
      <mesh position={[0, 0, -0.025]} castShadow>
        <boxGeometry args={[3.3, 0.92, 0.04]} />
        <meshStandardMaterial color="#1a1410" roughness={0.4} metalness={0.6} />
      </mesh>
      <mesh>
        <planeGeometry args={[3.2, 0.8]} />
        <meshStandardMaterial
          ref={matRef}
          map={tex}
          emissive="#ffffff"
          emissiveMap={tex}
          emissiveIntensity={1.6}
          transparent
          toneMapped={false}
        />
      </mesh>
      {/* Две «цепи» подвеса — тонкие тёмные цилиндры, уходят вверх */}
      <mesh position={[-1.45, 1.4, 0]}>
        <cylinderGeometry args={[0.015, 0.015, 2.0, 6]} />
        <meshStandardMaterial color="#1a1410" roughness={0.7} metalness={0.6} />
      </mesh>
      <mesh position={[1.45, 1.4, 0]}>
        <cylinderGeometry args={[0.015, 0.015, 2.0, 6]} />
        <meshStandardMaterial color="#1a1410" roughness={0.7} metalness={0.6} />
      </mesh>
      {/* Halo — субтильное pointlight'оподобное свечение */}
      <pointLight color={ACCENT} intensity={1.4} distance={6} position={[0, 0, 0.5]} />
    </group>
  );
}

// ───────────────────────────────────────────────────────────────────
// GiantSeoLetters — гигантские светящиеся буквы «SEO» (≈2.5м высотой)
// сзади сотрудников. Вешаются высоко над их головами на back-сторону офиса,
// чтобы было моментально понятно, что это SEO-отдел. Каждая буква
// собирается из 3D-боксов (без шрифтов, без CDN-fetch). Лёгкая пульсация
// эмиссии — «оживляет», но без раздражающего мигания.
// ───────────────────────────────────────────────────────────────────

function NeonStroke({
  position,
  size,
  rotation = [0, 0, 0],
  matRef,
}: {
  position: [number, number, number];
  size: [number, number, number];
  rotation?: [number, number, number];
  matRef?: React.RefObject<THREE.MeshStandardMaterial | null>;
}): ReactNode {
  return (
    <mesh position={position} rotation={rotation} castShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial
        ref={matRef}
        color="#d97757"
        emissive="#d97757"
        emissiveIntensity={2.2}
        toneMapped={false}
      />
    </mesh>
  );
}

function LetterS({
  position,
  matRef,
  mirrorX = false,
}: {
  position: [number, number, number];
  matRef: React.RefObject<THREE.MeshStandardMaterial | null>;
  mirrorX?: boolean;
}): ReactNode {
  const w = 1.4;
  const h = 2.4;
  const t = 0.28;
  const d = 0.18;
  const m = mirrorX ? -1 : 1;
  return (
    <group position={position}>
      {/* Три горизонтальные перекладины — X-симметричные, mirror не нужен */}
      <NeonStroke position={[0, h / 2 - t / 2, 0]} size={[w, t, d]} matRef={matRef} />
      <NeonStroke position={[0, 0, 0]} size={[w, t, d]} matRef={matRef} />
      <NeonStroke position={[0, -h / 2 + t / 2, 0]} size={[w, t, d]} matRef={matRef} />
      {/* Асимметричные «полки» — mirror'ятся */}
      <NeonStroke
        position={[(-w / 2 + t / 2) * m, h / 4, 0]}
        size={[t, h / 2 - t, d]}
        matRef={matRef}
      />
      <NeonStroke
        position={[(w / 2 - t / 2) * m, -h / 4, 0]}
        size={[t, h / 2 - t, d]}
        matRef={matRef}
      />
    </group>
  );
}

function LetterE({
  position,
  matRef,
  mirrorX = false,
}: {
  position: [number, number, number];
  matRef: React.RefObject<THREE.MeshStandardMaterial | null>;
  mirrorX?: boolean;
}): ReactNode {
  const w = 1.4;
  const h = 2.4;
  const t = 0.28;
  const d = 0.18;
  const m = mirrorX ? -1 : 1;
  return (
    <group position={position}>
      {/* Корень — асимметричный (слева, при mirror — справа) */}
      <NeonStroke position={[(-w / 2 + t / 2) * m, 0, 0]} size={[t, h, d]} matRef={matRef} />
      <NeonStroke position={[0, h / 2 - t / 2, 0]} size={[w, t, d]} matRef={matRef} />
      <NeonStroke position={[-0.1 * m, 0, 0]} size={[w - 0.2, t, d]} matRef={matRef} />
      <NeonStroke position={[0, -h / 2 + t / 2, 0]} size={[w, t, d]} matRef={matRef} />
    </group>
  );
}

function LetterO({
  position,
  matRef,
}: {
  position: [number, number, number];
  matRef: React.RefObject<THREE.MeshStandardMaterial | null>;
  // O — полностью X-симметричная, mirrorX не нужен (принимает для единообразия)
  mirrorX?: boolean;
}): ReactNode {
  const w = 1.5;
  const h = 2.4;
  const t = 0.28;
  const d = 0.18;
  return (
    <group position={position}>
      <NeonStroke position={[0, h / 2 - t / 2, 0]} size={[w, t, d]} matRef={matRef} />
      <NeonStroke position={[0, -h / 2 + t / 2, 0]} size={[w, t, d]} matRef={matRef} />
      <NeonStroke position={[-w / 2 + t / 2, 0, 0]} size={[t, h - 2 * t, d]} matRef={matRef} />
      <NeonStroke position={[w / 2 - t / 2, 0, 0]} size={[t, h - 2 * t, d]} matRef={matRef} />
    </group>
  );
}

function GiantSeoLetters({
  position,
  rotation = [0, 0, 0],
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
}): ReactNode {
  const matRef = useRef<THREE.MeshStandardMaterial>(null);
  const frontRef = useRef<THREE.Group>(null);
  const backRef = useRef<THREE.Group>(null);
  const signZ = position[2];

  useFrame((state) => {
    // Пульсация эмиссии
    if (matRef.current) {
      const t = state.clock.elapsedTime;
      matRef.current.emissiveIntensity = 2.0 + 0.4 * Math.sin(t * 0.7);
    }
    // Visibility-toggle: показываем только тот набор букв, который смотрит
    // на камеру. Без этого оба набора видны одновременно и зеркальный
    // back-set накладывается на корректный front-set — выглядит как «032».
    const camera = state.camera;
    const cameraOnFrontSide = camera.position.z >= signZ;
    if (frontRef.current) frontRef.current.visible = cameraOnFrontSide;
    if (backRef.current) backRef.current.visible = !cameraOnFrontSide;
  });

  const letterGap = 2.1;
  const halfDepth = 0.12;
  return (
    <group position={position} rotation={rotation}>
      {/* FRONT — лицом к +Z; видим, когда камера на +Z стороне вывески */}
      <group ref={frontRef} position={[0, 0, halfDepth]}>
        <LetterS position={[-letterGap, 0, 0]} matRef={matRef} />
        <LetterE position={[0, 0, 0]} matRef={matRef} />
        <LetterO position={[letterGap, 0, 0]} matRef={matRef} />
      </group>
      {/* BACK — лицом к -Z. Достаточно ОДНОЙ операции — rotation Y=π —
          чтобы буквы читались с обратной стороны. Раньше дополнительно
          применял mirrorX, но он + rotation = identity (двойной mirror),
          поэтому буквы выглядели как зеркало («032»). Тот же local-порядок
          S-E-O что у FRONT даёт правильный world-порядок после rotation Y=π
          для -Z-viewer'а. */}
      <group ref={backRef} position={[0, 0, -halfDepth]} rotation={[0, Math.PI, 0]}>
        <LetterS position={[-letterGap, 0, 0]} matRef={matRef} />
        <LetterE position={[0, 0, 0]} matRef={matRef} />
        <LetterO position={[letterGap, 0, 0]} matRef={matRef} />
      </group>
      {/* Halo */}
      <pointLight color="#d97757" intensity={2.5} distance={10} position={[0, 0, 1.5]} />
      <pointLight color="#d97757" intensity={2.5} distance={10} position={[0, 0, -1.5]} />
      <pointLight color="#d97757" intensity={1.4} distance={6} position={[-letterGap, 0, 0]} />
      <pointLight color="#d97757" intensity={1.4} distance={6} position={[letterGap, 0, 0]} />
    </group>
  );
}

// ───────────────────────────────────────────────────────────────────
// SEO Dashboard — плавающий «дашборд» рядом с вывеской SEO DEPARTMENT.
// Показывает 6 растущих столбиков (по количеству платформ) + стрелку
// «TRAFFIC ↑» — визуально подчёркивает, что отдел занимается SEO/трафиком.
// Без стены, висит в воздухе как и сама NeonSign.
// ───────────────────────────────────────────────────────────────────

function SeoDashboard({
  position,
  rotation = [0, 0, 0],
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
}): ReactNode {
  const barColors = ['#A8E063', '#FF8800', '#FC3F1D', '#65A3BE', '#FF4500', '#0A66C2'];
  const barHeights = [0.35, 0.55, 0.7, 0.85, 1.1, 1.35]; // ascending: SEO growth
  const barCount = barColors.length;
  const barWidth = 0.18;
  const barGap = 0.08;
  const totalBarsWidth = barCount * barWidth + (barCount - 1) * barGap;
  const startX = -totalBarsWidth / 2 + barWidth / 2;

  // Subtle pulsation на эмиссии accent-стрелки, без шумовых анимаций
  const arrowRef = useRef<THREE.MeshStandardMaterial>(null);
  useFrame((state) => {
    if (arrowRef.current) {
      const t = state.clock.elapsedTime;
      arrowRef.current.emissiveIntensity = 1.0 + 0.25 * Math.sin(t * 1.3);
    }
  });

  return (
    <group position={position} rotation={rotation}>
      {/* Подложка-«экран» */}
      <mesh position={[0, 0, -0.04]}>
        <boxGeometry args={[2.4, 1.8, 0.06]} />
        <meshStandardMaterial color="#0d0a08" roughness={0.5} metalness={0.4} />
      </mesh>
      {/* Рамка */}
      <mesh position={[0, 0, -0.02]}>
        <planeGeometry args={[2.32, 1.72]} />
        <meshStandardMaterial color="#1a1410" roughness={0.6} />
      </mesh>
      {/* Заголовок */}
      <mesh position={[0, 0.65, 0.01]}>
        <planeGeometry args={[1.4, 0.16]} />
        <meshStandardMaterial color="#d97757" emissive="#d97757" emissiveIntensity={0.6} />
      </mesh>
      {/* Растущие столбики */}
      <group position={[0, -0.4, 0.01]}>
        {barColors.map((color, i) => {
          const h = barHeights[i] ?? 0.5;
          const x = startX + i * (barWidth + barGap);
          return (
            <mesh key={color} position={[x, h / 2, 0]}>
              <boxGeometry args={[barWidth, h, 0.04]} />
              <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={0.55}
                roughness={0.4}
              />
            </mesh>
          );
        })}
        {/* Базовая линия графика */}
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[totalBarsWidth + 0.2, 0.02, 0.02]} />
          <meshStandardMaterial color="#d97757" emissive="#d97757" emissiveIntensity={0.8} />
        </mesh>
      </group>
      {/* Стрелка вверх — диагональ через график */}
      <group position={[0.4, 0.15, 0.04]} rotation={[0, 0, Math.PI / 5]}>
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[1.2, 0.04, 0.02]} />
          <meshStandardMaterial
            ref={arrowRef}
            color="#d97757"
            emissive="#d97757"
            emissiveIntensity={1.0}
          />
        </mesh>
        {/* Наконечник стрелки */}
        <mesh position={[0.55, 0.06, 0]} rotation={[0, 0, Math.PI / 4]}>
          <boxGeometry args={[0.22, 0.04, 0.02]} />
          <meshStandardMaterial color="#d97757" emissive="#d97757" emissiveIntensity={1.0} />
        </mesh>
        <mesh position={[0.55, -0.06, 0]} rotation={[0, 0, -Math.PI / 4]}>
          <boxGeometry args={[0.22, 0.04, 0.02]} />
          <meshStandardMaterial color="#d97757" emissive="#d97757" emissiveIntensity={1.0} />
        </mesh>
      </group>
      {/* Halo для жизни */}
      <pointLight color="#d97757" intensity={0.8} distance={3} position={[0, 0, 0.4]} />
    </group>
  );
}

// ───────────────────────────────────────────────────────────────────
// SEO Search Card — плоская «SERP-карточка» (поиск): лупа + 3 строки
// результатов с подсвеченным первым. Усиливает SEO-семантику зоны.
// ───────────────────────────────────────────────────────────────────

function SeoSerpCard({
  position,
  rotation = [0, 0, 0],
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
}): ReactNode {
  return (
    <group position={position} rotation={rotation}>
      {/* Подложка */}
      <mesh position={[0, 0, -0.04]}>
        <boxGeometry args={[2.0, 1.8, 0.06]} />
        <meshStandardMaterial color="#0d0a08" roughness={0.5} metalness={0.4} />
      </mesh>
      <mesh position={[0, 0, -0.02]}>
        <planeGeometry args={[1.92, 1.72]} />
        <meshStandardMaterial color="#1a1410" roughness={0.6} />
      </mesh>
      {/* Поиск-бар с лупой */}
      <group position={[0, 0.65, 0.01]}>
        <mesh position={[0, 0, 0]}>
          <planeGeometry args={[1.7, 0.22]} />
          <meshStandardMaterial color="#2a2018" roughness={0.7} />
        </mesh>
        {/* Лупа: кольцо */}
        <mesh position={[-0.7, 0, 0.01]}>
          <ringGeometry args={[0.06, 0.085, 16]} />
          <meshStandardMaterial
            color="#d97757"
            emissive="#d97757"
            emissiveIntensity={0.9}
            side={THREE.DoubleSide}
          />
        </mesh>
        {/* Ручка лупы */}
        <mesh position={[-0.62, -0.06, 0.01]} rotation={[0, 0, -Math.PI / 4]}>
          <boxGeometry args={[0.1, 0.02, 0.005]} />
          <meshStandardMaterial color="#d97757" emissive="#d97757" emissiveIntensity={0.9} />
        </mesh>
      </group>
      {/* SERP results — 3 строки, первая подсвечена */}
      {[0.18, -0.08, -0.34].map((y, i) => (
        <group key={y} position={[0, y, 0.01]}>
          {/* Title-полоска */}
          <mesh position={[-0.35, 0.03, 0]}>
            <planeGeometry args={[1.2, 0.05]} />
            <meshStandardMaterial
              color={i === 0 ? '#d97757' : '#5e5246'}
              emissive={i === 0 ? '#d97757' : '#000000'}
              emissiveIntensity={i === 0 ? 0.7 : 0}
            />
          </mesh>
          {/* URL/snippet строки */}
          <mesh position={[-0.45, -0.04, 0]}>
            <planeGeometry args={[1.0, 0.03]} />
            <meshStandardMaterial color="#3c352d" />
          </mesh>
          <mesh position={[-0.5, -0.09, 0]}>
            <planeGeometry args={[0.9, 0.025]} />
            <meshStandardMaterial color="#3c352d" />
          </mesh>
        </group>
      ))}
      {/* Подсветка */}
      <pointLight color="#d97757" intensity={0.6} distance={2.5} position={[0, 0, 0.4]} />
    </group>
  );
}

// ───────────────────────────────────────────────────────────────────
// Wall Clock
// ───────────────────────────────────────────────────────────────────
function WallClock({
  position,
  rotation,
}: {
  position: [number, number, number];
  rotation: [number, number, number];
}): ReactNode {
  const secRef = useRef<THREE.Mesh>(null);
  const minRef = useRef<THREE.Mesh>(null);
  const hourRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    // Bridge ходит при 1 сек = 1 сек
    if (secRef.current) secRef.current.rotation.z = -t * 0.5;
    if (minRef.current) minRef.current.rotation.z = -t * 0.05;
    if (hourRef.current) hourRef.current.rotation.z = -t * 0.005;
  });

  return (
    <group position={position} rotation={rotation}>
      {/* Колонна-подставка — часы стоят на стенде */}
      <mesh position={[0, -1.5, 0]} castShadow>
        <boxGeometry args={[0.12, 3, 0.12]} />
        <meshStandardMaterial color="#3a2818" roughness={0.85} />
      </mesh>
      {/* База колонны */}
      <mesh position={[0, -3, 0]} castShadow>
        <boxGeometry args={[0.45, 0.06, 0.45]} />
        <meshStandardMaterial color="#1a1410" roughness={0.85} />
      </mesh>
      {/* Корпус часов */}
      <mesh>
        <cylinderGeometry args={[0.4, 0.4, 0.08, 24]} />
        <meshStandardMaterial color="#1a1410" roughness={0.5} />
      </mesh>
      {/* Циферблат */}
      <mesh position={[0, 0, 0.045]} rotation={[Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.36, 24]} />
        <meshStandardMaterial color="#f0e6dc" roughness={0.9} />
      </mesh>
      {/* 12 меток */}
      {Array.from({ length: 12 }, (_, i) => {
        const angle = (i / 12) * Math.PI * 2;
        const r = 0.31;
        return (
          <mesh
            // biome-ignore lint/suspicious/noArrayIndexKey: Array.from with fixed length, index is the natural identifier
            key={i}
            position={[Math.sin(angle) * r, Math.cos(angle) * r, 0.05]}
            rotation={[Math.PI / 2, 0, -angle]}
          >
            <boxGeometry args={[0.02, 0.04, 0.005]} />
            <meshStandardMaterial color="#1a1410" />
          </mesh>
        );
      })}
      {/* Стрелки */}
      <mesh ref={hourRef} position={[0, 0, 0.052]} rotation={[Math.PI / 2, 0, 0]}>
        <boxGeometry args={[0.03, 0.2, 0.005]} />
        <meshStandardMaterial color="#1a1410" />
      </mesh>
      <mesh ref={minRef} position={[0, 0, 0.053]} rotation={[Math.PI / 2, 0, 0]}>
        <boxGeometry args={[0.02, 0.28, 0.005]} />
        <meshStandardMaterial color="#1a1410" />
      </mesh>
      <mesh ref={secRef} position={[0, 0, 0.054]} rotation={[Math.PI / 2, 0, 0]}>
        <boxGeometry args={[0.008, 0.32, 0.004]} />
        <meshStandardMaterial color={ACCENT} emissive={ACCENT} emissiveIntensity={0.8} />
      </mesh>
      {/* Центральный шуруп */}
      <mesh position={[0, 0, 0.058]}>
        <cylinderGeometry args={[0.025, 0.025, 0.008, 12]} />
        <meshStandardMaterial color="#d97757" emissive={ACCENT} emissiveIntensity={0.4} />
      </mesh>
    </group>
  );
}

// ───────────────────────────────────────────────────────────────────
// Water cooler
// ───────────────────────────────────────────────────────────────────
function WaterCooler({ position }: { position: [number, number, number] }): ReactNode {
  return (
    <group position={position}>
      {/* Бак */}
      <mesh position={[0, 1.4, 0]} castShadow>
        <cylinderGeometry args={[0.22, 0.25, 0.5, 14]} />
        <meshStandardMaterial color="#7c9eb2" transparent opacity={0.55} roughness={0.2} />
      </mesh>
      {/* Тёмная «вода» внутри */}
      <mesh position={[0, 1.4, 0]}>
        <cylinderGeometry args={[0.2, 0.23, 0.45, 14]} />
        <meshStandardMaterial color="#1a3a4a" transparent opacity={0.7} />
      </mesh>
      {/* Тулово */}
      <mesh position={[0, 0.7, 0]} castShadow>
        <boxGeometry args={[0.38, 1.0, 0.38]} />
        <meshStandardMaterial color="#e8e0d4" roughness={0.6} />
      </mesh>
      {/* Краник */}
      <mesh position={[0.19, 0.85, 0]} castShadow>
        <boxGeometry args={[0.08, 0.06, 0.06]} />
        <meshStandardMaterial color="#1a1410" />
      </mesh>
      {/* Кнопка hot — красная */}
      <mesh position={[0.19, 1.0, 0]}>
        <boxGeometry args={[0.07, 0.02, 0.03]} />
        <meshStandardMaterial color="#b25555" emissive="#b25555" emissiveIntensity={0.5} />
      </mesh>
      {/* Кнопка cold — синяя */}
      <mesh position={[0.19, 0.7, 0]}>
        <boxGeometry args={[0.07, 0.02, 0.03]} />
        <meshStandardMaterial color="#7c9eb2" emissive="#7c9eb2" emissiveIntensity={0.5} />
      </mesh>
      {/* База */}
      <mesh position={[0, 0.08, 0]} castShadow>
        <cylinderGeometry args={[0.24, 0.24, 0.16, 14]} />
        <meshStandardMaterial color="#1a1410" />
      </mesh>
    </group>
  );
}

// ───────────────────────────────────────────────────────────────────
// Tall server rack — accent corner piece
// ───────────────────────────────────────────────────────────────────
function TallServerRack({ position }: { position: [number, number, number] }): ReactNode {
  const lightRefs = useRef<(THREE.Mesh | null)[]>([]);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    lightRefs.current.forEach((m, i) => {
      if (!m) return;
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 0.4 + 0.6 * Math.abs(Math.sin(t * 4 + i * 0.7));
    });
  });
  return (
    <group position={position}>
      {/* Корпус */}
      <mesh position={[0, 1.4, 0]} castShadow>
        <boxGeometry args={[0.7, 2.8, 0.55]} />
        <meshStandardMaterial color="#0a0a0a" roughness={0.7} />
      </mesh>
      {/* 7 серверных модулей */}
      {Array.from({ length: 7 }, (_, i) => {
        const y = 0.4 + i * 0.36;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: Array.from with fixed length, index is the natural identifier
          <group key={i} position={[0, y, 0]}>
            <mesh position={[0, 0, 0.28]}>
              <boxGeometry args={[0.66, 0.3, 0.02]} />
              <meshStandardMaterial color="#1a1410" />
            </mesh>
            {/* LED-полоска */}
            <mesh
              ref={(el) => {
                lightRefs.current[i] = el;
              }}
              position={[-0.22, 0, 0.295]}
            >
              <boxGeometry args={[0.04, 0.04, 0.005]} />
              <meshStandardMaterial color={ACCENT} emissive={ACCENT} emissiveIntensity={0.5} />
            </mesh>
            {/* «Лоток» */}
            <mesh position={[0.16, 0, 0.295]}>
              <boxGeometry args={[0.3, 0.16, 0.005]} />
              <meshStandardMaterial color="#2a1c14" />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

// ───────────────────────────────────────────────────────────────────
// Floor rug — большой коврик под каждый отдел (2 шт)
// ───────────────────────────────────────────────────────────────────
function FloorRug({ position }: { position: [number, number, number] }): ReactNode {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={position} receiveShadow>
      <planeGeometry args={[8, 4.5]} />
      <meshStandardMaterial color="#3a2818" roughness={1.0} />
    </mesh>
  );
}

// ───────────────────────────────────────────────────────────────────
// Lounge sofa — «диванчик» между отделами для совещаний
// ───────────────────────────────────────────────────────────────────
function LoungeSofa({ position }: { position: [number, number, number] }): ReactNode {
  return (
    <group position={position}>
      {/* Сиденье */}
      <mesh position={[0, 0.3, 0]} castShadow>
        <boxGeometry args={[1.6, 0.2, 0.7]} />
        <meshStandardMaterial color="#7c4a2e" roughness={0.85} />
      </mesh>
      {/* Спинка */}
      <mesh position={[0, 0.65, -0.3]} castShadow>
        <boxGeometry args={[1.6, 0.5, 0.1]} />
        <meshStandardMaterial color="#7c4a2e" roughness={0.85} />
      </mesh>
      {/* Подушки */}
      <mesh position={[-0.5, 0.45, 0.05]}>
        <boxGeometry args={[0.45, 0.1, 0.45]} />
        <meshStandardMaterial color="#d97757" roughness={0.85} />
      </mesh>
      <mesh position={[0.5, 0.45, 0.05]}>
        <boxGeometry args={[0.45, 0.1, 0.45]} />
        <meshStandardMaterial color="#c4a747" roughness={0.85} />
      </mesh>
      {/* 4 ножки */}
      {[
        [0.65, 0.1, 0.3],
        [-0.65, 0.1, 0.3],
        [0.65, 0.1, -0.3],
        [-0.65, 0.1, -0.3],
      ].map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static literal array, order fixed
        <mesh key={i} position={p as [number, number, number]} castShadow>
          <boxGeometry args={[0.06, 0.2, 0.06]} />
          <meshStandardMaterial color="#2a1c10" />
        </mesh>
      ))}
    </group>
  );
}

// ───────────────────────────────────────────────────────────────────
// Coffee table — журнальный столик для лаунжа
// ───────────────────────────────────────────────────────────────────
function CoffeeTable({ position }: { position: [number, number, number] }): ReactNode {
  return (
    <group position={position}>
      <mesh position={[0, 0.35, 0]} castShadow>
        <boxGeometry args={[0.9, 0.05, 0.5]} />
        <meshStandardMaterial color="#3a2818" roughness={0.7} />
      </mesh>
      {[
        [0.4, 0.175, 0.22],
        [-0.4, 0.175, 0.22],
        [0.4, 0.175, -0.22],
        [-0.4, 0.175, -0.22],
      ].map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static literal array, order fixed
        <mesh key={i} position={p as [number, number, number]} castShadow>
          <boxGeometry args={[0.04, 0.35, 0.04]} />
          <meshStandardMaterial color="#1a1410" />
        </mesh>
      ))}
      {/* Журналы */}
      <mesh position={[0.15, 0.385, 0]} rotation={[0, 0.2, 0]}>
        <boxGeometry args={[0.22, 0.01, 0.16]} />
        <meshStandardMaterial color="#d97757" />
      </mesh>
      <mesh position={[-0.2, 0.39, 0.08]} rotation={[0, -0.1, 0]}>
        <boxGeometry args={[0.2, 0.005, 0.14]} />
        <meshStandardMaterial color="#7cb29a" />
      </mesh>
    </group>
  );
}

// ───────────────────────────────────────────────────────────────────
// Корневой компонент
// ───────────────────────────────────────────────────────────────────
export function AmbientProps(): ReactNode {
  return (
    <group>
      {/* Коврик под отделом */}
      <FloorRug position={[0, 0.012, 0.3]} />

      {/* Лаунж (диван + столик + 2 растения) ранее стоял на z=3.6-5 — теперь
          там зона спален (BunkBed). Сами кровати рендерятся через OfficeLayout. */}

      {/* ─── Растения по углам комнаты ─── */}
      <Plant position={[-5, 0, -5]} />
      <Plant position={[5, 0, -5]} />

      {/* ─── Whiteboard — перед столами с северной стороны (между db и fs) ─── */}
      <Whiteboard position={[-2, 0, -5.5]} rotation={[0, Math.PI / 6, 0]} />

      {/* ─── Neon sign — высоко по центру севера (за спинами сотрудников) ─── */}
      <NeonSign text="SEO DEPARTMENT" position={[0, 3.4, -6]} rotation={[0, 0, 0]} />

      {/* ─── ГИГАНТСКИЕ буквы «SEO» — главная метка отдела, висит высоко
              ЗА СПИНАМИ сотрудников. Сотрудники смотрят в -Z (к монитору на
              столе, см. Worker.tsx:407 rotation Math.PI), их спина — в +Z.
              Поэтому буквы кладём на +Z-сторону офиса БЕЗ поворота (face=+Z),
              чтобы камера (которая тоже на +Z) видела буквы лицом, а не
              зеркалом «032». ─── */}
      <GiantSeoLetters position={[0, 6.5, 6.5]} rotation={[0, 0, 0]} />

      {/* ─── SEO-дашборды по бокам от вывески: bar chart (рост) + SERP-карточка.
              Висят в воздухе на том же z, что и вывеска. Усиливают семантику
              «это SEO-отдел» — фаундер видит сзади сотрудников SEO-метрики. ─── */}
      <SeoDashboard position={[-4.3, 1.8, -6]} rotation={[0, Math.PI / 12, 0]} />
      <SeoSerpCard position={[4.3, 1.8, -6]} rotation={[0, -Math.PI / 12, 0]} />

      {/* ─── Wall clock — справа на колонне ─── */}
      <WallClock position={[3, 3.0, -5.5]} rotation={[0, -Math.PI / 6, 0]} />

      {/* ─── Water cooler — у восточной стены, чтобы не пересекался с
              кроватями (которые теперь стоят на z≈3.7 под колонками столов). ─── */}
      <WaterCooler position={[5.5, 0, 2]} />

      {/* ─── Серверная стойка — в северном углу ─── */}
      <TallServerRack position={[-5.5, 0, -5]} />

      {/* Подсветка */}
      <pointLight color="#e8e0d4" intensity={0.6} distance={4.5} position={[-2, 2.5, -5]} />
      <pointLight color={ACCENT} intensity={0.5} distance={3} position={[-5.5, 1.5, -5]} />
    </group>
  );
}
