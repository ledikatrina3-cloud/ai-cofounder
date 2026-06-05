// Параметризованная tool-station с per-kind анимациями активности.
//
// Когда `active` (есть воркер, использующий tool этого вида), включается:
//   - Усиленная анимация (LED'ы пульсируют быстрее, глобус крутится x4, и т.п.)
//   - FlyingItems поток предметов между станцией и воркером
//   - Html-overlay с кратким summary tool-input'а (имя файла, URL, SQL и т.п.)
//
// Когда не active — лёгкие idle-анимации (мягкий pulse).

import { Box, Cylinder, Html, Sphere } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { type ReactNode, useRef } from 'react';
import type * as THREE from 'three';
import { FlyingItems } from './FlyingItems.js';
import type { ToolStationKind } from './types.js';

interface ToolStationProps {
  kind: ToolStationKind;
  position: [number, number, number];
  /** Если задано — на станции работает воркер с этим именем tool'а
      (Read/Bash/WebFetch/...). Включает «boost» анимации. */
  activeToolName?: string;
  /** Input tool'а (filename, URL, SQL) — для краткого summary в overlay. */
  activeToolInput?: unknown;
  /** Позиция воркера у станции — куда летят летящие предметы. */
  activeWorkerPosition?: [number, number, number];
}

const PALETTE: Record<ToolStationKind, string> = {
  db: '#d97757',
  fs: '#7c9eb2',
  bash: '#c4a747',
  web: '#9ca77c',
  tg: '#7cb29a',
  email: '#a77c9c',
};

const LABEL: Record<ToolStationKind, string> = {
  db: 'DB',
  fs: 'FILES',
  bash: 'BASH',
  web: 'WEB',
  tg: 'TG',
  email: 'MAIL',
};

/** Краткое summary из tool-input для overlay-карточки. */
function summarizeInput(toolName: string | undefined, input: unknown): string | undefined {
  if (toolName === undefined || input === null || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  // Filesystem tools
  if (toolName === 'Read' && typeof obj.file_path === 'string') return shortPath(obj.file_path);
  if (toolName === 'Write' && typeof obj.file_path === 'string')
    return `write → ${shortPath(obj.file_path)}`;
  if (toolName === 'Edit' && typeof obj.file_path === 'string')
    return `edit → ${shortPath(obj.file_path)}`;
  if (toolName === 'Glob' && typeof obj.pattern === 'string') return `glob ${obj.pattern}`;
  if (toolName === 'Grep' && typeof obj.pattern === 'string')
    return `grep "${truncate(obj.pattern, 40)}"`;
  // Bash
  if (toolName === 'Bash' && typeof obj.command === 'string')
    return `$ ${truncate(obj.command, 50)}`;
  // Web
  if ((toolName === 'WebFetch' || toolName === 'WebSearch') && typeof obj.url === 'string') {
    try {
      const url = new URL(obj.url);
      return url.host + (url.pathname.length > 1 ? truncate(url.pathname, 30) : '');
    } catch {
      return truncate(obj.url, 40);
    }
  }
  if (toolName === 'WebSearch' && typeof obj.query === 'string')
    return `search "${truncate(obj.query, 40)}"`;
  // SQL/DB
  if (typeof obj.sql === 'string') return truncate(obj.sql.replace(/\s+/g, ' '), 50);
  if (typeof obj.query === 'string') return truncate(obj.query.replace(/\s+/g, ' '), 50);
  // Telegram / email — текст
  if (typeof obj.text === 'string') return truncate(obj.text, 50);
  return undefined;
}

function shortPath(p: string): string {
  const segments = p.split('/').filter((s) => s.length > 0);
  if (segments.length <= 2) return p;
  return `…/${segments.slice(-2).join('/')}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function ToolStation({
  kind,
  position,
  activeToolName,
  activeToolInput,
  activeWorkerPosition,
}: ToolStationProps): ReactNode {
  const color = PALETTE[kind];
  const label = LABEL[kind];
  const isActive = activeToolName !== undefined;
  const summary = summarizeInput(activeToolName, activeToolInput);

  return (
    <group position={position}>
      {/* Усиленная точечная подсветка когда active */}
      <pointLight
        color={color}
        intensity={isActive ? 1.3 : 0.6}
        distance={isActive ? 4 : 3}
        position={[0, 1.5, 0]}
      />

      {/* Параметрическая геометрия с per-kind boost */}
      {kind === 'db' && <DbRack color={color} active={isActive} />}
      {kind === 'fs' && <FsCabinet color={color} active={isActive} />}
      {kind === 'bash' && <BashTerminal color={color} active={isActive} />}
      {kind === 'web' && <WebGlobe color={color} active={isActive} />}
      {kind === 'tg' && <TgPhone color={color} active={isActive} />}
      {kind === 'email' && <EmailEnvelope color={color} active={isActive} />}

      {/* Летящие предметы от станции к воркеру */}
      {isActive && activeWorkerPosition !== undefined && (
        <FlyingItems
          source={[0, 1.0, 0]}
          target={[
            activeWorkerPosition[0] - position[0],
            1.0,
            activeWorkerPosition[2] - position[2],
          ]}
          shape={particleShapeFor(kind)}
          color={color}
          count={6}
          cycleMs={1600}
          arcHeight={0.7}
        />
      )}

      {/* Лейбл (всегда) */}
      <Html position={[0, 2.2, 0]} center distanceFactor={10} occlude={false}>
        <div
          style={{
            padding: '3px 10px',
            fontFamily: 'JetBrains Mono, Menlo, monospace',
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 1.5,
            color,
            background: 'rgba(10,10,10,0.75)',
            border: `1px solid ${color}`,
            borderRadius: 3,
            whiteSpace: 'nowrap',
            userSelect: 'none',
            pointerEvents: 'none',
            boxShadow: isActive ? `0 0 12px ${color}` : 'none',
            transition: 'box-shadow 200ms',
          }}
        >
          {label}
        </div>
      </Html>

      {/* Activity overlay — summary tool-input'а */}
      {isActive && summary !== undefined && summary.length > 0 && (
        <Html position={[0, 2.6, 0]} center distanceFactor={8} occlude={false}>
          <div
            style={{
              padding: '4px 8px',
              maxWidth: 260,
              fontFamily: 'JetBrains Mono, Menlo, monospace',
              fontSize: 10,
              color: '#f0e6dc',
              background: 'rgba(10,10,10,0.85)',
              border: `1px solid ${color}`,
              borderRadius: 4,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              userSelect: 'none',
              pointerEvents: 'none',
              boxShadow: `0 0 10px ${color}66`,
            }}
          >
            {summary}
          </div>
        </Html>
      )}
    </group>
  );
}

function particleShapeFor(kind: ToolStationKind): 'paper' | 'envelope' | 'packet' | 'crumb' {
  switch (kind) {
    case 'fs':
      return 'paper';
    case 'email':
      return 'envelope';
    case 'tg':
      return 'envelope';
    case 'db':
    case 'web':
      return 'packet';
    case 'bash':
      return 'crumb';
  }
}

// ───────────────────────────────────────────────────────────────────
// DbRack — серверная стойка с LED'ами
// ───────────────────────────────────────────────────────────────────
function DbRack({ color, active }: { color: string; active: boolean }): ReactNode {
  const light1 = useRef<THREE.Mesh>(null);
  const light2 = useRef<THREE.Mesh>(null);
  const light3 = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const speed = active ? 9 : 3;
    if (light1.current) {
      const m = light1.current.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = 0.5 + 0.5 * Math.abs(Math.sin(t * speed));
    }
    if (light2.current) {
      const m = light2.current.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = 0.5 + 0.5 * Math.abs(Math.sin(t * speed + 1.3));
    }
    if (light3.current) {
      const m = light3.current.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = 0.5 + 0.5 * Math.abs(Math.sin(t * speed + 2.7));
    }
  });

  return (
    <group>
      <Box args={[0.8, 1.8, 0.5]} position={[0, 0.9, 0]} castShadow>
        <meshStandardMaterial color="#1a1410" roughness={0.6} />
      </Box>
      {[0.4, 0.8, 1.2, 1.6].map((y) => (
        <Box key={y} args={[0.78, 0.12, 0.52]} position={[0, y, 0]}>
          <meshStandardMaterial color="#0a0a0a" />
        </Box>
      ))}
      <mesh ref={light1} position={[-0.25, 0.5, 0.27]}>
        <sphereGeometry args={[0.03, 8, 8]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} />
      </mesh>
      <mesh ref={light2} position={[0, 0.9, 0.27]}>
        <sphereGeometry args={[0.03, 8, 8]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} />
      </mesh>
      <mesh ref={light3} position={[0.25, 1.3, 0.27]}>
        <sphereGeometry args={[0.03, 8, 8]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} />
      </mesh>
    </group>
  );
}

// ───────────────────────────────────────────────────────────────────
// FsCabinet — шкаф с выдвижными ящиками
// ───────────────────────────────────────────────────────────────────
function FsCabinet({ color, active }: { color: string; active: boolean }): ReactNode {
  const middleDrawer = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (!middleDrawer.current) return;
    if (active) {
      // Тоже jiggle — выдвигаем-задвигаем ящик
      const wobble = 0.15 + 0.05 * Math.sin(state.clock.elapsedTime * 4);
      middleDrawer.current.position.z = wobble;
    } else {
      // Плавно возвращаем
      middleDrawer.current.position.z *= 0.9;
    }
  });
  return (
    <group>
      {[
        { y: 0.3, isMiddle: false },
        { y: 0.85, isMiddle: true },
        { y: 1.4, isMiddle: false },
      ].map((d) => (
        <group
          key={`drawer-${d.y}`}
          position={[0, d.y, 0]}
          ref={d.isMiddle ? middleDrawer : undefined}
        >
          <Box args={[0.9, 0.5, 0.6]} castShadow>
            <meshStandardMaterial color="#3a2d1c" roughness={0.5} />
          </Box>
          <Box args={[0.2, 0.04, 0.04]} position={[0, 0, 0.32]}>
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} />
          </Box>
        </group>
      ))}
    </group>
  );
}

// ───────────────────────────────────────────────────────────────────
// BashTerminal — терминал-куб с курсором
// ───────────────────────────────────────────────────────────────────
function BashTerminal({ color, active }: { color: string; active: boolean }): ReactNode {
  // wireMatRef — ref на сам material (не mesh), потому что `<meshBasicMaterial>` рендерится
  // как Material, и `material.opacity` доступен напрямую.
  const wireMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const cursorRef = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (wireMatRef.current) {
      wireMatRef.current.opacity = active ? 0.6 + 0.4 * Math.abs(Math.sin(t * 8)) : 0.7;
    }
    if (cursorRef.current) {
      const mat = cursorRef.current.material as THREE.MeshStandardMaterial;
      const speed = active ? 6 : 1.5;
      mat.emissiveIntensity = active ? 0.5 + 0.3 * Math.abs(Math.sin(t * speed)) : 0.35;
    }
  });
  return (
    <group position={[0, 1, 0]}>
      <Box args={[1, 1, 1]} castShadow>
        <meshStandardMaterial color="#0a0a0a" />
      </Box>
      <Box args={[1.001, 1.001, 1.001]}>
        <meshBasicMaterial ref={wireMatRef} color={color} wireframe transparent opacity={0.7} />
      </Box>
      <mesh ref={cursorRef} position={[0, 0, 0.51]}>
        <planeGeometry args={[0.6, 0.5]} />
        <meshStandardMaterial color="#0a0a0a" emissive={color} emissiveIntensity={0.35} />
      </mesh>
    </group>
  );
}

// ───────────────────────────────────────────────────────────────────
// WebGlobe — wireframe globe, крутится
// ───────────────────────────────────────────────────────────────────
function WebGlobe({ color, active }: { color: string; active: boolean }): ReactNode {
  const ref = useRef<THREE.Group>(null);
  useFrame((_, delta) => {
    if (ref.current) ref.current.rotation.y += delta * (active ? 1.6 : 0.4);
  });
  return (
    <group ref={ref} position={[0, 1.2, 0]}>
      <Sphere args={[0.55, 16, 16]} castShadow>
        <meshStandardMaterial color={color} wireframe transparent opacity={0.8} />
      </Sphere>
      <Sphere args={[0.48, 24, 24]}>
        <meshStandardMaterial
          color="#1a1410"
          emissive={color}
          emissiveIntensity={active ? 0.4 : 0.15}
        />
      </Sphere>
    </group>
  );
}

// ───────────────────────────────────────────────────────────────────
// TgPhone — телефон-стойка
// ───────────────────────────────────────────────────────────────────
function TgPhone({ color, active }: { color: string; active: boolean }): ReactNode {
  const screenRef = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (!screenRef.current) return;
    const mat = screenRef.current.material as THREE.MeshStandardMaterial;
    const t = state.clock.elapsedTime;
    if (active) {
      mat.emissiveIntensity = 0.6 + 0.4 * Math.abs(Math.sin(t * 5));
    } else {
      mat.emissiveIntensity = 0.5;
    }
  });
  return (
    <group position={[0, 0.9, 0]}>
      <Cylinder args={[0.3, 0.35, 0.1, 12]} position={[0, -0.85, 0]}>
        <meshStandardMaterial color="#1a1410" />
      </Cylinder>
      <Box args={[0.5, 1.6, 0.08]} castShadow>
        <meshStandardMaterial color="#1a1410" roughness={0.5} />
      </Box>
      <mesh ref={screenRef} position={[0, 0.05, 0.045]}>
        <planeGeometry args={[0.4, 1.3]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} />
      </mesh>
    </group>
  );
}

// ───────────────────────────────────────────────────────────────────
// EmailEnvelope — конверт, активно «отправляющий»
// ───────────────────────────────────────────────────────────────────
function EmailEnvelope({ color, active }: { color: string; active: boolean }): ReactNode {
  const flapRef = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (!flapRef.current) return;
    if (active) {
      // Клапан полу-открыт + покачивается
      flapRef.current.rotation.x = -0.4 + 0.1 * Math.sin(state.clock.elapsedTime * 3);
    } else {
      flapRef.current.rotation.x *= 0.9;
    }
  });
  return (
    <group position={[0, 1.0, 0]}>
      <Box args={[1.2, 0.8, 0.08]} castShadow>
        <meshStandardMaterial color="#1a1410" />
      </Box>
      <Box ref={flapRef} args={[1.2, 0.5, 0.06]} position={[0, 0.15, 0.05]}>
        <meshStandardMaterial color={color} roughness={0.5} />
      </Box>
      <Box args={[1.3, 0.04, 0.04]} position={[0, 0, 0.06]} rotation={[0, 0, Math.PI / 6]}>
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} />
      </Box>
      <Box args={[1.3, 0.04, 0.04]} position={[0, 0, 0.06]} rotation={[0, 0, -Math.PI / 6]}>
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} />
      </Box>
    </group>
  );
}
