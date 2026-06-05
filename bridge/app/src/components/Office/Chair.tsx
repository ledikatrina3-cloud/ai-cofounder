// Офисное кресло — мебель, ставится одно на стол в OfficeLayout. Не движется с
// воркером (его лерп — это позиция тела, кресло остаётся у стола).
//
// Геометрия:
//   - Сиденье 0.46×0.06×0.42 на высоте y=0.78
//   - Спинка 0.44×0.55×0.05, наклон вертикальный, на +Z от сиденья
//   - Газлифт-цилиндр под сиденьем
//   - 5-лучевая крестовина с маленькими «колёсиками»
//
// Размер +Z направления: спинка кресла на +Z, чтобы воркер (развёрнутый на 180°
// и сидящий) попадал спиной в спинку.

import type { ReactNode } from 'react';

interface ChairProps {
  position: [number, number, number];
}

export function Chair({ position }: ChairProps): ReactNode {
  return (
    <group position={position}>
      {/* Сиденье */}
      <mesh position={[0, 0.78, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.46, 0.06, 0.42]} />
        <meshStandardMaterial color="#3a2818" roughness={0.85} />
      </mesh>
      {/* Спинка — на +Z стороне */}
      <mesh position={[0, 1.15, 0.18]} castShadow>
        <boxGeometry args={[0.44, 0.55, 0.05]} />
        <meshStandardMaterial color="#3a2818" roughness={0.85} />
      </mesh>
      {/* Газлифт */}
      <mesh position={[0, 0.4, 0]} castShadow>
        <cylinderGeometry args={[0.04, 0.04, 0.7, 12]} />
        <meshStandardMaterial color="#2a1c10" roughness={0.6} metalness={0.5} />
      </mesh>
      {/* Хаб крестовины */}
      <mesh position={[0, 0.06, 0]} castShadow>
        <cylinderGeometry args={[0.04, 0.04, 0.05, 8]} />
        <meshStandardMaterial color="#2a1c10" />
      </mesh>
      {/* 5 лучей + колёсики */}
      {([0, 1, 2, 3, 4] as const).map((i) => {
        const angle = (i / 5) * Math.PI * 2;
        const r = 0.28;
        return (
          <group key={`base-${i}`} position={[0, 0.04, 0]} rotation={[0, angle, 0]}>
            <mesh position={[0, 0, r / 2]} castShadow>
              <boxGeometry args={[0.05, 0.04, r]} />
              <meshStandardMaterial color="#2a1c10" roughness={0.85} />
            </mesh>
            <mesh position={[0, -0.02, r]}>
              <sphereGeometry args={[0.035, 8, 8]} />
              <meshStandardMaterial color="#1a1410" roughness={0.6} metalness={0.4} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
