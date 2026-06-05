// «Открытая» комната офиса — только пол, без стен и потолка.
// Прямоугольное помещение 24×16 для двух кластеров рабочих мест.
//
// Что здесь:
//   - Воксельный пол через InstancedMesh: 2 instance'а на shade (a/b) +
//     2 instance'а на швы (горизонтальный/вертикальный). Раньше — 224
//     group'а × 3 mesh'а = ~672 draw calls. Стало — 4 draw calls.
//   - Тёмный «базовый» пол на случай микро-щелей между плитками.
//   - Edge-strip (NASA accent) — оранжевая неоновая полоса по периметру.
//
// ВАЖНО про ориентацию InstancedMesh:
// Каждая plane geometry смотрит в +Z (вертикально). Чтобы плитка легла на пол,
// её надо повернуть на -π/2 вокруг X. Раньше делал rotation={[-π/2,0,0]} на
// самом `<instancedMesh>` — это поворачивает родителя ПОСЛЕ применения
// instance matrix, в итоге translation (x, 0.005, z) после rotation
// превращается в (x, z, -0.005) и плитки оказываются вертикальными
// «полосами» поперёк сцены. Правильно — закладывать поворот ВНУТРЬ instance
// matrix (compose с quaternion от Euler[-π/2,0,0]).

import { type ReactNode, useLayoutEffect, useMemo, useRef } from 'react';
import { Euler, type InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';

export const ROOM_W = 16; // ось X
export const ROOM_D = 14; // ось Z
const TILE = 1;

const FLOOR_A = '#2a1c14';
const FLOOR_B = '#1f1410';
const FLOOR_SEAM = '#0c0806';
const ACCENT = '#d97757';

// Quaternion поворота plane → пол. Считаем один раз на модуль.
const FLOOR_QUAT = new Quaternion().setFromEuler(new Euler(-Math.PI / 2, 0, 0));
const UNIT_SCALE = new Vector3(1, 1, 1);

interface TileData {
  shadeA: { x: number; z: number }[];
  shadeB: { x: number; z: number }[];
}

export function Room(): ReactNode {
  const tiles = useMemo<TileData>(() => {
    const a: { x: number; z: number }[] = [];
    const b: { x: number; z: number }[] = [];
    const xCount = Math.floor(ROOM_W / TILE);
    const zCount = Math.floor(ROOM_D / TILE);
    const xStart = -ROOM_W / 2 + TILE / 2;
    const zStart = -ROOM_D / 2 + TILE / 2;
    for (let i = 0; i < xCount; i++) {
      for (let j = 0; j < zCount; j++) {
        const x = xStart + i * TILE;
        const z = zStart + j * TILE;
        const isA = (i + Math.floor(j / 2)) % 2 === 0;
        (isA ? a : b).push({ x, z });
      }
    }
    return { shadeA: a, shadeB: b };
  }, []);

  const tilesARef = useRef<InstancedMesh>(null);
  const tilesBRef = useRef<InstancedMesh>(null);
  const seamHRef = useRef<InstancedMesh>(null);
  const seamVRef = useRef<InstancedMesh>(null);

  useLayoutEffect(() => {
    const m = new Matrix4();
    const pos = new Vector3();
    const setTiles = (
      mesh: InstancedMesh | null,
      cells: { x: number; z: number }[],
      yOffset: number,
      dx = 0,
      dz = 0,
    ): void => {
      if (!mesh) return;
      cells.forEach((c, i) => {
        pos.set(c.x + dx, yOffset, c.z + dz);
        m.compose(pos, FLOOR_QUAT, UNIT_SCALE);
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
    };
    setTiles(tilesARef.current, tiles.shadeA, 0.005);
    setTiles(tilesBRef.current, tiles.shadeB, 0.005);

    const seamCells = [...tiles.shadeA, ...tiles.shadeB];
    setTiles(seamHRef.current, seamCells, 0.006, 0, TILE / 2 - 0.02);
    setTiles(seamVRef.current, seamCells, 0.006, TILE / 2 - 0.02, 0);
  }, [tiles]);

  const totalCells = tiles.shadeA.length + tiles.shadeB.length;
  const tileSize = TILE - 0.04;

  return (
    <group>
      {/* Базовый чёрный пол */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[ROOM_W, ROOM_D]} />
        <meshStandardMaterial color={FLOOR_SEAM} roughness={1.0} />
      </mesh>

      {/* Плитки shade A (instanced). Rotation внутри matrix каждого instance. */}
      <instancedMesh
        ref={tilesARef}
        args={[undefined, undefined, tiles.shadeA.length]}
        receiveShadow
      >
        <planeGeometry args={[tileSize, tileSize]} />
        <meshStandardMaterial color={FLOOR_A} roughness={0.95} metalness={0.05} />
      </instancedMesh>

      {/* Плитки shade B (instanced) */}
      <instancedMesh
        ref={tilesBRef}
        args={[undefined, undefined, tiles.shadeB.length]}
        receiveShadow
      >
        <planeGeometry args={[tileSize, tileSize]} />
        <meshStandardMaterial color={FLOOR_B} roughness={0.95} metalness={0.05} />
      </instancedMesh>

      {/* Швы горизонтальные (по верхней границе плитки) — instanced */}
      <instancedMesh ref={seamHRef} args={[undefined, undefined, totalCells]}>
        <planeGeometry args={[TILE, 0.04]} />
        <meshStandardMaterial color={FLOOR_SEAM} />
      </instancedMesh>

      {/* Швы вертикальные (по правой границе плитки) — instanced */}
      <instancedMesh ref={seamVRef} args={[undefined, undefined, totalCells]}>
        <planeGeometry args={[0.04, TILE]} />
        <meshStandardMaterial color={FLOOR_SEAM} />
      </instancedMesh>

      {/* Edge-strip по периметру пола */}
      <mesh position={[0, 0.04, -ROOM_D / 2 + 0.08]}>
        <boxGeometry args={[ROOM_W - 0.16, 0.08, 0.06]} />
        <meshStandardMaterial color={ACCENT} emissive={ACCENT} emissiveIntensity={1.4} />
      </mesh>
      <mesh position={[0, 0.04, ROOM_D / 2 - 0.08]}>
        <boxGeometry args={[ROOM_W - 0.16, 0.08, 0.06]} />
        <meshStandardMaterial color={ACCENT} emissive={ACCENT} emissiveIntensity={1.4} />
      </mesh>
      <mesh position={[ROOM_W / 2 - 0.08, 0.04, 0]}>
        <boxGeometry args={[0.06, 0.08, ROOM_D - 0.16]} />
        <meshStandardMaterial color={ACCENT} emissive={ACCENT} emissiveIntensity={1.4} />
      </mesh>
      <mesh position={[-ROOM_W / 2 + 0.08, 0.04, 0]}>
        <boxGeometry args={[0.06, 0.08, ROOM_D - 0.16]} />
        <meshStandardMaterial color={ACCENT} emissive={ACCENT} emissiveIntensity={1.4} />
      </mesh>
    </group>
  );
}
