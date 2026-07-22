// Универсальный particle-эффект: воксельные «предметы» (бумаги, конверты,
// data-пакеты), летящие по параболе от source к target.
//
// Каждая частица имеет фазу [0..1], проходящую цикл за `cycleMs` мс.
// При phase=0 — у source. При phase=1 — у target (fade out). Затем повтор.
// Частицы рандомизированы по стартовой фазе → плавный «непрерывный поток».
//
// Используется в ToolStation: при tool.active эффект включается, рисует поток
// предметов от станции к воркеру (или наоборот). Когда не active — `active=false`
// и компонент не рендерится.

import { useFrame } from '@react-three/fiber';
import { type ReactNode, useMemo, useRef } from 'react';
import * as THREE from 'three';

export type FlyingItemShape = 'paper' | 'envelope' | 'packet' | 'crumb';

interface FlyingItemsProps {
  /** Где появляются (start of arc). */
  source: [number, number, number];
  /** Куда летят (end of arc). Обычно к воркеру у станции. */
  target: [number, number, number];
  /** Сколько частиц в потоке. */
  count?: number;
  /** Длительность одного цикла (мс) — от source до target. */
  cycleMs?: number;
  /** Цвет частицы. */
  color?: string;
  /** Какую форму рисовать. */
  shape?: FlyingItemShape;
  /** Высота параболы — на сколько частица поднимается над прямой source→target. */
  arcHeight?: number;
}

interface ParticleState {
  startPhase: number;
  rotationSeed: number;
}

export function FlyingItems({
  source,
  target,
  count = 6,
  cycleMs = 1500,
  color = '#f0e6dc',
  shape = 'paper',
  arcHeight = 0.6,
}: FlyingItemsProps): ReactNode {
  // Создаём массив ref'ов под каждую частицу.
  const refs = useMemo(
    () => Array.from({ length: count }, () => ({ current: null as THREE.Mesh | null })),
    [count],
  );

  const states = useMemo<ParticleState[]>(
    () =>
      Array.from({ length: count }, (_, i) => ({
        startPhase: (i / count) * cycleMs + Math.random() * 80,
        rotationSeed: Math.random() * Math.PI * 2,
      })),
    [count, cycleMs],
  );

  const sourceVec = useMemo(() => new THREE.Vector3(...source), [source]);
  const targetVec = useMemo(() => new THREE.Vector3(...target), [target]);

  useFrame((state) => {
    const tMs = state.clock.elapsedTime * 1000;
    for (let i = 0; i < count; i++) {
      const ref = refs[i];
      const st = states[i];
      if (!ref?.current || !st) continue;
      const localTime = (tMs + st.startPhase) % cycleMs;
      const phase = localTime / cycleMs; // 0..1

      // Параболическая интерполяция
      const x = sourceVec.x + (targetVec.x - sourceVec.x) * phase;
      const z = sourceVec.z + (targetVec.z - sourceVec.z) * phase;
      const yLinear = sourceVec.y + (targetVec.y - sourceVec.y) * phase;
      // Парабола: 4·h·p·(1-p) — пик на p=0.5
      const yArc = yLinear + arcHeight * 4 * phase * (1 - phase);
      ref.current.position.set(x, yArc, z);

      // Вращение для «эффекта летящего листа»
      ref.current.rotation.x = phase * Math.PI * 2 + st.rotationSeed;
      ref.current.rotation.y = phase * Math.PI * 4 + st.rotationSeed;

      // Fade in (0..0.15) + fade out (0.85..1), полная видимость в середине
      const mat = ref.current.material as THREE.MeshStandardMaterial;
      let opacity: number;
      if (phase < 0.15) opacity = phase / 0.15;
      else if (phase > 0.85) opacity = (1 - phase) / 0.15;
      else opacity = 1;
      mat.opacity = opacity * 0.95;
    }
  });

  return (
    <group>
      {states.map((_, i) => (
        <ParticleMesh
          // biome-ignore lint/suspicious/noArrayIndexKey: particle slot index — refs[i] is keyed by the same index, reordering would break the ref mapping
          key={i}
          shape={shape}
          color={color}
          assignRef={(m) => {
            const ref = refs[i];
            if (ref) ref.current = m;
          }}
        />
      ))}
    </group>
  );
}

interface ParticleMeshProps {
  shape: FlyingItemShape;
  color: string;
  assignRef: (m: THREE.Mesh | null) => void;
}

function ParticleMesh({ shape, color, assignRef }: ParticleMeshProps): ReactNode {
  // Геометрия зависит от shape:
  //   paper — тонкий плоский прямоугольник (бумажный лист)
  //   envelope — чуть толще + другой aspect
  //   packet — кубик (data-пакет)
  //   crumb — мелкая сфера (крошечка/искра)
  switch (shape) {
    case 'paper':
      return (
        <mesh ref={assignRef} castShadow>
          <boxGeometry args={[0.1, 0.005, 0.14]} />
          <meshStandardMaterial color={color} roughness={0.95} transparent opacity={0.9} />
        </mesh>
      );
    case 'envelope':
      return (
        <mesh ref={assignRef} castShadow>
          <boxGeometry args={[0.14, 0.02, 0.1]} />
          <meshStandardMaterial color={color} roughness={0.8} transparent opacity={0.9} />
        </mesh>
      );
    case 'packet':
      return (
        <mesh ref={assignRef} castShadow>
          <boxGeometry args={[0.06, 0.06, 0.06]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.6}
            transparent
            opacity={0.9}
          />
        </mesh>
      );
    case 'crumb':
      return (
        <mesh ref={assignRef}>
          <sphereGeometry args={[0.025, 8, 8]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.8}
            transparent
            opacity={0.9}
          />
        </mesh>
      );
  }
}
