import { useFrame } from '@react-three/fiber';
import { type ReactNode, useRef } from 'react';
import type * as THREE from 'three';
import type { AgentStatus } from '../../hooks/useAgentStatus.js';

interface Props {
  status: AgentStatus;
}

export function Core({ status }: Props): ReactNode {
  const meshRef = useRef<THREE.Mesh>(null);
  const scaleRef = useRef(1);

  useFrame((state, delta) => {
    if (!meshRef.current) return;
    meshRef.current.rotation.y += delta * 0.3;
    // Дыхание: scale 1.0 ↔ 1.05 за 4 сек
    const breathe = 1 + 0.025 * Math.sin((state.clock.elapsedTime * Math.PI) / 2);
    // При executing: небольшой bump
    const targetScale = status === 'executing' ? breathe * 1.08 : breathe;
    scaleRef.current += (targetScale - scaleRef.current) * Math.min(delta * 5, 1);
    meshRef.current.scale.setScalar(scaleRef.current);
  });

  const emissiveIntensity = status === 'executing' ? 0.6 : status === 'thinking' ? 0.4 : 0.25;

  return (
    <mesh ref={meshRef}>
      <icosahedronGeometry args={[1, 2]} />
      <meshStandardMaterial
        wireframe
        color="#d97757"
        emissive="#d97757"
        emissiveIntensity={emissiveIntensity}
      />
    </mesh>
  );
}
