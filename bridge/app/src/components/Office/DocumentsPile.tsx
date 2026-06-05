// DocumentsPile — 3D-стопка «бумаг» на столе сотрудника. Растёт по мере
// работы: каждый tool.end добавляет в стек одну плоскую коробочку. Это
// визуальный аналог реальной кипы документов, которая копится у человека
// за день.
//
// Зачем:
//   • Сразу видно «много ли он наработал» — не глядя в drawer.
//   • Помогает понять, на каком этапе воркер — start workflow'а имеет
//     малую стопку, к концу 14 этапов — высокую.
//
// Технически:
//   • N плоских boxGeometry, стек со смещением Y + лёгкой ротацией по Y
//     (papers не идеально выровнены). Цвет — белый/бежевый с лёгкой
//     случайной вариацией оттенка (seed по index).
//   • Max ~40 видимых документов; дальше не растёт визуально (cap), чтобы
//     не превратить стол в башню. UI покажет «+N more» через DeskCountdown
//     или drawer.
//   • Позиция группы — справа от воркера, на уровне столешницы.
//     Координаты подобраны под существующий desk layout.
//   • Все деревья детерминированы по count — не дёргают seed/Math.random
//     каждый кадр.

import { type ReactNode, useMemo } from 'react';

const PILE_POSITION: [number, number, number] = [0.55, 0.06, 0.35]; // правый ближний угол стола от воркера
const PAPER_W = 0.18;
const PAPER_D = 0.24;
const PAPER_H = 0.005;
const MAX_VISIBLE = 40;

interface DocumentsPileProps {
  /** Сколько успешных tool.end случилось — растит стопку. 0 → ничего не рендерим. */
  count: number;
}

// Псевдо-случайные но детерминированные параметры на каждое i (1..count).
// Используем простую функцию-смесь чтобы не тащить полноценный PRNG.
function paperJitter(i: number): { rotY: number; offsetX: number; offsetZ: number; tint: string } {
  const r = (i * 1103515245 + 12345) & 0x7fffffff;
  const rotY = (((r % 2000) / 2000) * 2 - 1) * 0.18; // ±~10°
  const offsetX = ((((r >> 8) % 2000) / 2000) * 2 - 1) * 0.012;
  const offsetZ = ((((r >> 16) % 2000) / 2000) * 2 - 1) * 0.012;
  // Лёгкая тонировка — почти-белые, иногда слегка бежевые.
  const tintN = (r >> 4) % 4;
  const tint =
    tintN === 0 ? '#f0e6d8' : tintN === 1 ? '#ebe1d2' : tintN === 2 ? '#f5ecde' : '#e8ddc9';
  return { rotY, offsetX, offsetZ, tint };
}

export function DocumentsPile({ count }: DocumentsPileProps): ReactNode {
  if (count <= 0) return null;

  const visible = Math.min(count, MAX_VISIBLE);

  // Мемоизируем массив свойств — пересчитываем только при изменении visible.
  const papers = useMemo(() => {
    const out = [] as Array<{
      y: number;
      rotY: number;
      offsetX: number;
      offsetZ: number;
      tint: string;
    }>;
    for (let i = 0; i < visible; i++) {
      const j = paperJitter(i);
      out.push({
        y: i * PAPER_H * 1.05,
        rotY: j.rotY,
        offsetX: j.offsetX,
        offsetZ: j.offsetZ,
        tint: j.tint,
      });
    }
    return out;
  }, [visible]);

  return (
    <group position={PILE_POSITION}>
      {papers.map((p, i) => (
        <mesh
          // biome-ignore lint/suspicious/noArrayIndexKey: index is stable (count only grows)
          key={i}
          position={[p.offsetX, p.y, p.offsetZ]}
          rotation={[0, p.rotY, 0]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[PAPER_W, PAPER_H, PAPER_D]} />
          <meshStandardMaterial color={p.tint} roughness={0.92} metalness={0} />
        </mesh>
      ))}
    </group>
  );
}
