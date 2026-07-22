import { useFrame } from '@react-three/fiber';
import { type ReactNode, useMemo, useRef } from 'react';
import type * as THREE from 'three';
import type { AgentStatus } from '../../hooks/useAgentStatus.js';

const COUNT = 800;

export function Particles({ status }: { status: AgentStatus }): ReactNode {
  const pointsRef = useRef<THREE.Points>(null);

  const { positions, velocities } = useMemo(() => {
    const positions = new Float32Array(COUNT * 3);
    const velocities = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 10;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 10;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 10;
      velocities[i * 3] = (Math.random() - 0.5) * 0.002;
      velocities[i * 3 + 1] = (Math.random() - 0.5) * 0.002;
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.002;
    }
    return { positions, velocities };
  }, []);

  useFrame(() => {
    if (!pointsRef.current) return;
    const posAttr = pointsRef.current.geometry.attributes.position as THREE.BufferAttribute;
    const speedMult = status === 'thinking' ? 3 : 1;
    for (let i = 0; i < COUNT; i++) {
      const px = posAttr.getX(i) + (velocities[i * 3] ?? 0) * speedMult;
      const py = posAttr.getY(i) + (velocities[i * 3 + 1] ?? 0) * speedMult;
      const pz = posAttr.getZ(i) + (velocities[i * 3 + 2] ?? 0) * speedMult;
      // Wrap around boundary
      posAttr.setXYZ(i, ((px + 5) % 10) - 5, ((py + 5) % 10) - 5, ((pz + 5) % 10) - 5);
    }
    posAttr.needsUpdate = true;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.03} color="#d97757" transparent opacity={0.4} sizeAttenuation />
    </points>
  );
}
