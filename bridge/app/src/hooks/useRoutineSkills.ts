// Хук подтягивает скиллы для каждой routine'ы через GET /routines/:id/skills.
//
// Фаза 3 плана 2026-05-21-skills-architecture-v3: UI рисует бейджи скиллов
// поверх аватара сотрудника. Backend уже резолвит транзитивные deps и
// возвращает discovery-DTO. Тут мы только агрегируем по routineId.
//
// Зачем отдельный хук, а не запихать в useRoutines:
//   * useRoutines поллит /routines каждые 5с — это «горячий» путь.
//     Скиллы меняются редко (фаундер добавил/удалил), их можно грузить
//     один раз при появлении нового routineId.
//   * Если bridge упадёт на /routines/:id/skills (нет dist/), UI не должен
//     ломаться — просто скиллы не показываются.

import { useEffect, useRef, useState } from 'react';
import type { SkillBadge } from '../components/Office/types.js';

const BRIDGE_URL = 'http://127.0.0.1:3737';

interface SkillsResponse {
  ok: boolean;
  skills?: SkillBadge[];
  error?: string;
}

export type SkillsByRoutineId = Record<string, SkillBadge[]>;

/**
 * Возвращает map routineId → SkillBadge[]. Если для какого-то routineId
 * запрос упал — в map не попадает (UI просто не рисует бейджи).
 *
 * Дополнительные fetch'и происходят, когда в `routineIds` появляется
 * новое имя. Удалённые имена остаются в state (no-op) — UI всё равно
 * мапит по актуальному списку workers.
 */
export function useRoutineSkills(routineIds: string[]): SkillsByRoutineId {
  const [byId, setById] = useState<SkillsByRoutineId>({});
  // Запоминаем, что уже запросили — не дублируем запросы при каждом poll'е.
  const fetchedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const toFetch = routineIds.filter((id) => !fetchedRef.current.has(id));
    if (toFetch.length === 0) return;
    let cancelled = false;

    (async (): Promise<void> => {
      for (const id of toFetch) {
        // Помечаем сразу — даже если запрос упадёт, не будем DDOSить.
        fetchedRef.current.add(id);
        try {
          const res = await fetch(`${BRIDGE_URL}/routines/${encodeURIComponent(id)}/skills`);
          if (!res.ok) continue;
          const body = (await res.json()) as SkillsResponse;
          if (cancelled) return;
          if (body.ok && Array.isArray(body.skills) && body.skills.length > 0) {
            setById((prev) => ({ ...prev, [id]: body.skills as SkillBadge[] }));
          }
        } catch {
          // Сеть упала или bridge не поднят — skips silently.
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [routineIds]);

  return byId;
}
