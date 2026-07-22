import { Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { type ReactNode, useRef } from 'react';
import * as THREE from 'three';
import type { OrbitalName } from '../../lib/tool-mapping.js';

// 6 конфигураций орбиталей (наклон, радиус, скорость)
const ORBITAL_CONFIGS: Array<{
  name: OrbitalName;
  tilt: [number, number, number]; // rotation Euler
  rx: number; // radii x
  rz: number; // radii z
  speed: number;
  color: string;
}> = [
  { name: 'FS', tilt: [0.3, 0, 0.2], rx: 2.2, rz: 1.6, speed: 0.4, color: '#7c9eb2' },
  { name: 'BASH', tilt: [1.2, 0.5, 0], rx: 2.4, rz: 1.5, speed: 0.6, color: '#c4a747' },
  { name: 'WEB', tilt: [0.6, 1.0, 0.4], rx: 2.0, rz: 1.8, speed: 0.35, color: '#9ca77c' },
  { name: 'DB', tilt: [1.5, 0.2, 0.8], rx: 2.3, rz: 1.4, speed: 0.5, color: '#d97757' },
  { name: 'TG', tilt: [0.9, 1.5, 0.3], rx: 2.1, rz: 1.7, speed: 0.45, color: '#7cb29a' },
  { name: 'EMAIL', tilt: [0.4, 0.8, 1.2], rx: 2.5, rz: 1.3, speed: 0.55, color: '#a77c9c' },
];

// Генерация точек эллипса
function ellipsePoints(rx: number, rz: number, n = 64): THREE.Vector3[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return new THREE.Vector3(Math.cos(t) * rx, 0, Math.sin(t) * rz);
  });
}

interface SatelliteProps {
  name: OrbitalName;
  rx: number;
  rz: number;
  speed: number;
  color: string;
}

// Текущая мировая позиция каждого спутника. Lightning читает отсюда, чтобы
// молния попадала именно в движущийся спутник, а не в фикс-точку эллипса.
const satelliteWorldPositions = new Map<OrbitalName, THREE.Vector3>();

function Satellite({ name, rx, rz, speed, color }: SatelliteProps): ReactNode {
  const ref = useRef<THREE.Mesh>(null);
  const angleRef = useRef(Math.random() * Math.PI * 2);
  const worldPosRef = useRef(new THREE.Vector3());

  useFrame((_, delta) => {
    if (!ref.current) return;
    angleRef.current += delta * speed;
    ref.current.position.set(Math.cos(angleRef.current) * rx, 0, Math.sin(angleRef.current) * rz);
    ref.current.getWorldPosition(worldPosRef.current);
    satelliteWorldPositions.set(name, worldPosRef.current.clone());
  });

  return (
    <mesh ref={ref}>
      <sphereGeometry args={[0.08, 8, 8]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.8} />
    </mesh>
  );
}

export function Orbitals(): ReactNode {
  return (
    <>
      {ORBITAL_CONFIGS.map((cfg) => (
        <group key={cfg.name} rotation={cfg.tilt}>
          <Line
            points={ellipsePoints(cfg.rx, cfg.rz)}
            color={cfg.color}
            lineWidth={0.5}
            transparent
            opacity={0.4}
          />
          <Satellite name={cfg.name} rx={cfg.rx} rz={cfg.rz} speed={cfg.speed} color={cfg.color} />
        </group>
      ))}
    </>
  );
}

// Текущая мировая позиция спутника соответствующей орбитали. Если кадр ещё не
// прошёл — возвращаем фолбэк через rx,0,0 (визуально это «правый край эллипса»,
// заметно лучше нуля).
export function getOrbitalPosition(name: OrbitalName): THREE.Vector3 {
  const live = satelliteWorldPositions.get(name);
  if (live !== undefined) return live;
  const cfg = ORBITAL_CONFIGS.find((c) => c.name === name);
  return new THREE.Vector3(cfg ? cfg.rx : 2, 0, 0);
}
