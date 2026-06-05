// Двухъярусные кровати ЗА СПИНАМИ воркеров: 3 отдельных bunk bed × 2 яруса = 6 мест.
//
// Воркер сидит за столом и смотрит в -Z (к монитору). Его спина — в +Z.
// Кровати стоят на z≈3.5, по одной под каждой колонкой столов (x=-2.5, 0, 2.5).
// Каждая кровать развёрнута rotation Y=π/2: изголовье в +Z (дальняя сторона),
// изножье в -Z (близко к воркеру). Так логически: «закончил работу, развернулся
// на 180°, лёг на свою кровать ногами к столу».
//
// Lounge-зона (диван, столик, plants) удалена из AmbientProps — кровати
// заменили её собой.

import type { ReactNode } from 'react';

const FRAME_COLOR = '#3a2410';
const FRAME_DARK = '#1f1410';
const MATTRESS_COLOR = '#e8d4b8';
const PILLOW_COLOR = '#d97757';
const BLANKET_COLOR = '#5a3820';

// Одна кровать (одно спальное место).
const MATTRESS_LEN = 1.5; // по X (длина)
const MATTRESS_WIDTH = 0.75; // по Z (ширина матраса)
const MATTRESS_THICK = 0.16;

// Высоты ярусов одной кровати.
const BOTTOM_Y = 0.42;
const TOP_Y = 1.5;
const POST_HEIGHT = 2.0;

// Общая компоновка: 3 кровати в ряд по X, по одной за каждой колонкой столов.
// Координаты колонок столов: x ∈ {-2.5, 0, 2.5} (см. OfficeLayout COL_STEP).
// Кровати развёрнуты на 90° по Y — длинная ось матраса идёт по Z.
const BED_X_COLUMNS = [-2.5, 0, 2.5] as const;
// Центр кровати по Z. Стена комнаты на z=+7 (ROOM_D=14). Кровать длиной
// MATTRESS_LEN=1.5 по Z после поворота → дальний край на BED_GLOBAL_Z+0.75.
// Ставим впритык: 6.05 + 0.75 = 6.8, зазор от стены 0.2.
export const BED_GLOBAL_Z = 6.05;

/**
 * Позиция спального места для воркера 0..5 в WORLD-координатах.
 *
 * Раскладка: bedIndex = Math.floor(i/2) ∈ {0,1,2} → x-колонка;
 * tier = i%2 (0=bottom, 1=top). Воркеры 0+1 спят в кровати col 0 (низ/верх),
 * 2+3 — в кровати col 1, 4+5 — в col 2. Так каждая пара воркеров делит
 * кровать прямо за своими столами.
 */
export function getBedSlotPosition(index: number): [number, number, number] {
  const bedIndex = Math.floor(index / 2);
  const tier = index % 2;
  const x = BED_X_COLUMNS[bedIndex] ?? 0;
  const y = (tier === 0 ? BOTTOM_Y : TOP_Y) + MATTRESS_THICK / 2 + 0.04;
  return [x, y, BED_GLOBAL_Z];
}

interface SingleMattressProps {
  y: number;
  tier: 'bottom' | 'top';
}

function SingleMattress({ y, tier }: SingleMattressProps): ReactNode {
  return (
    <group position={[0, y, 0]}>
      {/* Опорная плита (база матраса) — узкая, только под этот матрас */}
      <mesh position={[0, -MATTRESS_THICK / 2 - 0.015, 0]} castShadow receiveShadow>
        <boxGeometry args={[MATTRESS_LEN + 0.06, 0.03, MATTRESS_WIDTH + 0.06]} />
        <meshStandardMaterial color={FRAME_DARK} roughness={0.85} />
      </mesh>
      {/* Матрас */}
      <mesh castShadow receiveShadow>
        <boxGeometry args={[MATTRESS_LEN, MATTRESS_THICK, MATTRESS_WIDTH]} />
        <meshStandardMaterial color={MATTRESS_COLOR} roughness={0.95} />
      </mesh>
      {/* Подушка у изголовья (-X, к стене) */}
      <mesh position={[-MATTRESS_LEN / 2 + 0.22, MATTRESS_THICK / 2 + 0.06, 0]} castShadow>
        <boxGeometry args={[0.34, 0.1, 0.45]} />
        <meshStandardMaterial color={PILLOW_COLOR} roughness={0.85} />
      </mesh>
      {/* Одеяло — накрывает половину матраса в сторону ног (+X) */}
      <mesh position={[MATTRESS_LEN / 4, MATTRESS_THICK / 2 + 0.03, 0]} castShadow>
        <boxGeometry args={[MATTRESS_LEN / 2 + 0.04, 0.06, MATTRESS_WIDTH + 0.03]} />
        <meshStandardMaterial color={BLANKET_COLOR} roughness={0.9} />
      </mesh>
      {/* Подвёрнутый край простыни — узкая светлая полоска */}
      <mesh position={[0, MATTRESS_THICK / 2 + 0.06, 0]}>
        <boxGeometry args={[0.05, 0.018, MATTRESS_WIDTH + 0.02]} />
        <meshStandardMaterial color="#f0e6dc" roughness={0.9} />
      </mesh>
      {/* Бортик безопасности раньше тут был, но в плановом ракурсе камеры
          он перекрывал спящего на верхнем ярусе — убран. */}
    </group>
  );
}

interface SingleBunkProps {
  position: [number, number, number];
}

/** Одна классическая двухъярусная кровать (2 спальных места). */
function SingleBunk({ position }: SingleBunkProps): ReactNode {
  const halfX = MATTRESS_LEN / 2;
  const halfZ = MATTRESS_WIDTH / 2;
  // 4 стойки в углах.
  const posts: [number, number][] = [
    [-halfX + 0.04, -halfZ + 0.04],
    [halfX - 0.04, -halfZ + 0.04],
    [-halfX + 0.04, halfZ - 0.04],
    [halfX - 0.04, halfZ - 0.04],
  ];
  return (
    <group position={position}>
      {/* Стойки */}
      {posts.map(([px, pz]) => (
        <mesh key={`post-${px},${pz}`} position={[px, POST_HEIGHT / 2, pz]} castShadow>
          <boxGeometry args={[0.08, POST_HEIGHT, 0.08]} />
          <meshStandardMaterial color={FRAME_COLOR} roughness={0.8} />
        </mesh>
      ))}
      {/* Шары-навершия на верхушках стоек — «спинка-набалдашник» */}
      {posts.map(([px, pz]) => (
        <mesh key={`finial-${px},${pz}`} position={[px, POST_HEIGHT + 0.04, pz]} castShadow>
          <boxGeometry args={[0.11, 0.08, 0.11]} />
          <meshStandardMaterial color={FRAME_COLOR} roughness={0.7} />
        </mesh>
      ))}
      {/* Изголовье у стены (-X): тонкая горизонтальная перекладина наверху */}
      <mesh position={[-halfX + 0.04, POST_HEIGHT - 0.15, 0]} castShadow>
        <boxGeometry args={[0.04, 0.08, MATTRESS_WIDTH - 0.04]} />
        <meshStandardMaterial color={FRAME_COLOR} roughness={0.8} />
      </mesh>
      {/* Изножье у +X: такая же перекладина */}
      <mesh position={[halfX - 0.04, POST_HEIGHT - 0.15, 0]} castShadow>
        <boxGeometry args={[0.04, 0.08, MATTRESS_WIDTH - 0.04]} />
        <meshStandardMaterial color={FRAME_COLOR} roughness={0.8} />
      </mesh>

      {/* Два спальных места */}
      <SingleMattress y={BOTTOM_Y} tier="bottom" />
      <SingleMattress y={TOP_Y} tier="top" />

      {/* Лестница сбоку, у +Z края, обращена к +X (к центру комнаты). */}
      <group position={[halfX * 0.7, 0, halfZ + 0.05]}>
        <mesh position={[0, TOP_Y / 2 + 0.1, 0]} castShadow>
          <boxGeometry args={[0.04, TOP_Y + 0.2, 0.04]} />
          <meshStandardMaterial color={FRAME_COLOR} roughness={0.8} />
        </mesh>
        <mesh position={[0.25, TOP_Y / 2 + 0.1, 0]} castShadow>
          <boxGeometry args={[0.04, TOP_Y + 0.2, 0.04]} />
          <meshStandardMaterial color={FRAME_COLOR} roughness={0.8} />
        </mesh>
        {Array.from({ length: 4 }, (_, i) => {
          const y = 0.45 + i * 0.32;
          return (
            <mesh key={`rung-${y.toFixed(3)}`} position={[0.125, y, 0]} castShadow>
              <boxGeometry args={[0.32, 0.025, 0.04]} />
              <meshStandardMaterial color={FRAME_COLOR} roughness={0.8} />
            </mesh>
          );
        })}
      </group>
    </group>
  );
}

export function BunkBed(): ReactNode {
  return (
    <group>
      {BED_X_COLUMNS.map((x) => (
        // Rotation Y=π/2 разворачивает кровать: голова (была -X) → +Z,
        // ноги (был +X) → -Z. Изголовьем к дальней стене, изножьем к воркеру.
        <group key={`bunk-${x}`} position={[x, 0, BED_GLOBAL_Z]} rotation={[0, Math.PI / 2, 0]}>
          <SingleBunk position={[0, 0, 0]} />
        </group>
      ))}
      {/* Общий тёплый «ночник» над зоной кроватей — мягкий ambient. */}
      <pointLight color="#ffd4a8" intensity={0.45} distance={5} position={[0, 1.0, BED_GLOBAL_Z]} />
    </group>
  );
}
