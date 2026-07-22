// Координатная сетка офиса — один отдел из 6 рабочих мест.
//
// Сцена в координатах метров. Y=0 — пол. Y растёт вверх. Камера сверху-сбоку.
//
// - Размер помещения: ~16×14 м (см. Room.tsx).
// - Один кластер: 3 колонки × 2 ряда = 6 столов, центр на origin.
// - Tool stations распределены по периметру.

import type { ReactNode } from 'react';
import { Vector3 } from 'three';
import { BunkBed } from './BunkBed.js';
import { Chair } from './Chair.js';
import { Desk } from './Desk.js';
import { ToolStation } from './ToolStation.js';
import type { ToolStationKind, WorkerData } from './types.js';

export { getBedSlotPosition } from './BunkBed.js';

export const MAX_WORKERS = 6;

const COL_STEP = 2.5;
const ROW_STEP = 2.5;
const COLS = 3;

const STATION_ORDER: ToolStationKind[] = ['db', 'fs', 'bash', 'web', 'tg', 'email'];

/**
 * Tool stations распределены по периметру 16×14 м комнаты.
 * Каждая привязана к ребру; внутрь — глобус/стойка/телефон смотрят к центру.
 */
const STATION_POSITIONS: Record<ToolStationKind, [number, number, number]> = {
  db: [-7, 0, -5.5], // NW
  fs: [7, 0, -5.5], // NE
  bash: [-7, 0, 5.5], // SW
  web: [7, 0, 5.5], // SE
  tg: [-7, 0, 0], // W mid
  email: [7, 0, 0], // E mid
};

/**
 * Позиция СТОЛА для индекса в массиве. 3 колонки × 2 ряда, центр кластера на origin.
 */
export function getDeskPosition(index: number): [number, number, number] {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  const dx = (col - (COLS - 1) / 2) * COL_STEP;
  const dz = row * ROW_STEP - ROW_STEP / 2;
  return [dx, 0, dz];
}

/**
 * Позиция ВОРКЕРА: сидит за столом, тело развёрнуто к монитору (на -Z).
 * См. Worker.tsx — body-rotation Y=π.
 */
const WORKER_BEHIND_DESK_OFFSET = 0.45;
export function getWorkerStandPosition(index: number): [number, number, number] {
  const [x, y, z] = getDeskPosition(index);
  return [x, y, z + WORKER_BEHIND_DESK_OFFSET];
}

/**
 * Точка перед tool-station, к которой подходит воркер для работы.
 */
export function getToolStationPosition(kind: ToolStationKind): [number, number, number] {
  const [x, y, z] = STATION_POSITIONS[kind];
  const dirToCenter = new Vector3(-x, 0, -z).normalize().multiplyScalar(0.8);
  return [x + dirToCenter.x, y, z + dirToCenter.z];
}

function getToolStationAnchor(kind: ToolStationKind): [number, number, number] {
  return STATION_POSITIONS[kind];
}

/** Позиция кресла = за рабочим местом воркера. */
export function getChairPosition(index: number): [number, number, number] {
  const [x, y, z] = getDeskPosition(index);
  return [x, y, z + 0.4];
}

interface OfficeLayoutProps {
  workers: WorkerData[];
}

export function OfficeLayout({ workers }: OfficeLayoutProps): ReactNode {
  // Определяем, есть ли воркер на каждой станции — для активации tool-аним.
  const activeByStation: Partial<Record<ToolStationKind, { workerIdx: number; data: WorkerData }>> =
    {};
  workers.slice(0, MAX_WORKERS).forEach((w, i) => {
    if (w.walkingTo !== undefined && activeByStation[w.walkingTo] === undefined) {
      activeByStation[w.walkingTo] = { workerIdx: i, data: w };
    }
  });

  return (
    <group>
      {/* Двухъярусная кровать у западной стены — место для idle-воркеров.
          Индекс спального места = индекс воркера (см. getBedSlotPosition). */}
      <BunkBed />

      {workers.slice(0, MAX_WORKERS).map((w, i) => (
        <group key={w.id}>
          <Desk position={getDeskPosition(i)} monitorAccent={w.color} />
          <Chair position={getChairPosition(i)} />
        </group>
      ))}
      {STATION_ORDER.map((kind) => {
        const active = activeByStation[kind];
        const stationPos = getToolStationAnchor(kind);
        const props: Parameters<typeof ToolStation>[0] = {
          kind,
          position: stationPos,
        };
        if (active !== undefined) {
          if (active.data.currentToolName !== undefined) {
            props.activeToolName = active.data.currentToolName;
          }
          if (active.data.currentToolInput !== undefined) {
            props.activeToolInput = active.data.currentToolInput;
          }
          props.activeWorkerPosition = getWorkerStandPosition(active.workerIdx);
        }
        return <ToolStation key={kind} {...props} />;
      })}
    </group>
  );
}
