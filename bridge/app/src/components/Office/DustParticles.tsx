// Атмосферные частицы пыли. THREE.Points с буфером позиций;
// каждый кадр частица двигается вверх + медленный sin-drift; если ушла
// выше потолка — переносим вниз.
//
// Используем PointsMaterial с sizeAttenuation, мелкий точечный размер.
// Не используем шейдер — для 200 частиц достаточно простого setX/Y/Z.

import { useFrame } from '@react-three/fiber';
import { type ReactNode, useMemo, useRef } from 'react';
import * as THREE from 'three';

const COUNT = 220;
const ROOM_W = 14; // ось X (комната 16, чуть меньше для безопасности)
const ROOM_DEPTH = 12; // ось Z
const ROOM_H = 4;

export function DustParticles(): ReactNode {
  const pointsRef = useRef<THREE.Points>(null);

  const { positions, velocities } = useMemo(() => {
    const pos = new Float32Array(COUNT * 3);
    const vel = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3] = (Math.random() - 0.5) * ROOM_W;
      pos[i * 3 + 1] = Math.random() * ROOM_H;
      pos[i * 3 + 2] = (Math.random() - 0.5) * ROOM_DEPTH;
      vel[i * 3] = (Math.random() - 0.5) * 0.05;
      vel[i * 3 + 1] = 0.05 + Math.random() * 0.12; // всегда вверх
      vel[i * 3 + 2] = (Math.random() - 0.5) * 0.05;
    }
    return { positions: pos, velocities: vel };
  }, []);

  useFrame((state, delta) => {
    if (!pointsRef.current) return;
    const geom = pointsRef.current.geometry;
    const arr = geom.attributes.position?.array as Float32Array | undefined;
    if (!arr) return;
    const t = state.clock.elapsedTime;
    for (let i = 0; i < COUNT; i++) {
      const ix = i * 3;
      const iy = ix + 1;
      const iz = ix + 2;
      arr[ix] = (arr[ix] ?? 0) + (velocities[ix] ?? 0) * delta + Math.sin(t * 0.3 + i) * 0.001;
      arr[iy] = (arr[iy] ?? 0) + (velocities[iy] ?? 0) * delta;
      arr[iz] = (arr[iz] ?? 0) + (velocities[iz] ?? 0) * delta + Math.cos(t * 0.3 + i) * 0.001;

      // Wrap-around
      if ((arr[iy] ?? 0) > ROOM_H) {
        arr[ix] = (Math.random() - 0.5) * ROOM_W;
        arr[iy] = 0;
        arr[iz] = (Math.random() - 0.5) * ROOM_DEPTH;
      }
    }
    geom.attributes.position!.needsUpdate = true;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={COUNT}
          array={positions}
          itemSize={3}
          args={[positions, 3]}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.04}
        color="#d4a878"
        transparent
        opacity={0.55}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

/**
 * Volumetric «luchи» — конусы прозрачного света из потолочных балок,
 * подчеркивающие световые шкафы и придающие глубину.
 */
export function LightBeams(): ReactNode {
  const beams: Array<{ x: number; z: number; intensity: number; tint: string }> = useMemo(
    () => [
      { x: -2.5, z: -1.5, intensity: 0.035, tint: '#ffd4a8' },
      { x: 2.5, z: -1.5, intensity: 0.035, tint: '#ffd4a8' },
      { x: -2.5, z: 1.5, intensity: 0.03, tint: '#ffd4a8' },
      { x: 2.5, z: 1.5, intensity: 0.03, tint: '#ffd4a8' },
      // Лаунж
      { x: 0, z: 4.5, intensity: 0.04, tint: '#ffe6c4' },
    ],
    [],
  );
  return (
    <group>
      {beams.map((b) => (
        <group key={`beam-${b.x},${b.z}`} position={[b.x, 2.0, b.z]} renderOrder={-1}>
          {/* Inverted cone: широкий снизу, узкий сверху — как реальный световой шлейф. */}
          <mesh rotation={[Math.PI, 0, 0]} position={[0, 0, 0]}>
            <coneGeometry args={[1.6, 3.4, 22, 1, true]} />
            <meshBasicMaterial
              color={b.tint}
              transparent
              opacity={b.intensity}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              side={THREE.DoubleSide}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}
