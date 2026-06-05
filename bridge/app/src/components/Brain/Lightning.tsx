import { Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { ToolStartEvent } from '../../../../events.js';
import { mapTool } from '../../lib/tool-mapping.js';
import { getOrbitalPosition } from './Orbital.js';

interface LightningBolt {
  id: string;
  points: THREE.Vector3[];
  color: string;
  opacity: number;
}

interface Props {
  toolEvents: ToolStartEvent[];
}

// Многосегментная ломаная от ядра к точке-цели — даёт ощущение разряда, а не
// прямой стрелы. Чем больше сегментов и jitter, тем более «электрический» look.
function makeJaggedPath(target: THREE.Vector3, segments = 6, jitter = 0.35): THREE.Vector3[] {
  const start = new THREE.Vector3(0, 0, 0);
  const points: THREE.Vector3[] = [start.clone()];
  for (let i = 1; i < segments; i++) {
    const t = i / segments;
    const base = new THREE.Vector3().lerpVectors(start, target, t);
    const dist = start.distanceTo(target);
    // Boundary effect: jitter гаснет к концам, чтобы линия точно входила в ядро
    // и в спутник, а ломалась в середине.
    const taper = Math.sin(Math.PI * t);
    base.x += (Math.random() - 0.5) * jitter * taper * dist;
    base.y += (Math.random() - 0.5) * jitter * taper * dist;
    base.z += (Math.random() - 0.5) * jitter * taper * dist;
    points.push(base);
  }
  points.push(target.clone());
  return points;
}

export function Lightning({ toolEvents }: Props): ReactNode {
  const [bolts, setBolts] = useState<LightningBolt[]>([]);
  const prevLengthRef = useRef(0);

  useEffect(() => {
    if (toolEvents.length <= prevLengthRef.current) return;
    const newEvents = toolEvents.slice(prevLengthRef.current);
    prevLengthRef.current = toolEvents.length;

    for (const ev of newEvents) {
      const mapping = mapTool(ev.name);
      const target = getOrbitalPosition(mapping.orbital);
      setBolts((prev) => [
        ...prev.slice(-10), // max 10 одновременно
        {
          id: ev.toolId,
          points: makeJaggedPath(target),
          color: mapping.color,
          opacity: 1.2,
        },
      ]);
    }
  }, [toolEvents]);

  // Fade out
  useFrame((_, delta) => {
    setBolts((prev) =>
      prev.map((b) => ({ ...b, opacity: b.opacity - delta * 2.0 })).filter((b) => b.opacity > 0),
    );
  });

  return (
    <>
      {bolts.map((bolt) => (
        <Line
          key={bolt.id}
          points={bolt.points}
          color={bolt.color}
          lineWidth={2}
          transparent
          opacity={Math.min(1, bolt.opacity)}
        />
      ))}
    </>
  );
}
