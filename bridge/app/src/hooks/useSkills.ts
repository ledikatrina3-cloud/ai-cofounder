// Хуки маркетплейса (Фаза 4 плана 2026-05-21-skills-architecture-v3):
//   * useSkills — листинг GET /skills с polling каждые 30с и loading/error
//     состояниями. Карточки маркетплейса меняются редко (фаундер
//     добавил/удалил скилл) → редкий poll.
//   * useSkillDetail — детальный GET /skills/:name. Грузится только когда
//     открыт drawer (по name); кэшируется в state (повторное открытие
//     того же скилла — без сетевого запроса).

import { useEffect, useRef, useState } from 'react';

const BRIDGE_URL = 'http://127.0.0.1:3737';
const LIST_POLL_MS = 30_000;

// ---------------------------------------------------------------------------
// Зеркало SkillDiscovery + усиление полем usedBy (см. bridge/routines-api.ts).
// Фронт не зависит от node-only модулей — поэтому держим тип локально.
// ---------------------------------------------------------------------------

export interface SkillListItem {
  name: string;
  displayName?: string;
  description: string;
  icon?: string;
  color?: string;
  category?: string;
  version?: string;
  usedBy?: string[];
}

export interface SkillFull {
  name: string;
  description: string;
  displayName?: string;
  icon?: string;
  color?: string;
  category?: string;
  version?: string;
  dependsOn?: string[];
  body: string;
  permissions: Record<string, unknown>;
  usedBy: string[];
}

export interface UseSkillsResult {
  items: SkillListItem[];
  loading: boolean;
  error: string | null;
}

interface ListResponse {
  ok: boolean;
  skills?: SkillListItem[];
  error?: string;
}

/**
 * useSkills — листинг маркетплейса. Polling на 30с, не моргает при сетевых
 * сбоях (оставляет последний успешный массив). При первом empty-фейле
 * выставляет error — UI покажет «Bridge offline, запусти pnpm bridge:start».
 */
export function useSkills(refreshKey = 0): UseSkillsResult {
  const [items, setItems] = useState<SkillListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey — trigger-only, форсит немедленный re-fetch списка после create/edit/delete скилла
  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const res = await fetch(`${BRIDGE_URL}/skills`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as ListResponse;
        if (cancelled) return;
        if (body.ok && Array.isArray(body.skills)) {
          setItems(body.skills);
          setError(null);
        } else {
          setError(body.error ?? 'unknown error');
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    const interval = setInterval(() => {
      void load();
    }, LIST_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [refreshKey]);

  return { items, loading, error };
}

// ---------------------------------------------------------------------------
// useSkillDetail — fetch одного скилла по имени с кэшем в useRef.
// Открыли drawer → грузим GET /skills/:name. Закрыли и снова открыли тот
// же скилл → берём из кэша. Кэш сбрасывается при unmount хука.
// ---------------------------------------------------------------------------

export interface UseSkillDetailResult {
  skill: SkillFull | null;
  loading: boolean;
  error: string | null;
}

interface DetailResponse {
  ok: boolean;
  skill?: SkillFull;
  error?: string;
}

export function useSkillDetail(name: string | null, refreshKey = 0): UseSkillDetailResult {
  const [skill, setSkill] = useState<SkillFull | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef<Map<string, SkillFull>>(new Map());
  const cacheKey = useRef(refreshKey);

  useEffect(() => {
    // refreshKey сменился → инвалидируем кэш, иначе отдадим протухший skill.
    if (cacheKey.current !== refreshKey) {
      cache.current.clear();
      cacheKey.current = refreshKey;
    }
    if (name === null) {
      setSkill(null);
      setError(null);
      setLoading(false);
      return;
    }
    const cached = cache.current.get(name);
    if (cached !== undefined) {
      setSkill(cached);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setSkill(null);
    setError(null);
    (async (): Promise<void> => {
      try {
        const res = await fetch(`${BRIDGE_URL}/skills/${encodeURIComponent(name)}`);
        if (res.status === 404) {
          if (!cancelled) setError(`skill '${name}' не найден`);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as DetailResponse;
        if (cancelled) return;
        if (body.ok && body.skill !== undefined) {
          cache.current.set(name, body.skill);
          setSkill(body.skill);
        } else {
          setError(body.error ?? 'unknown error');
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [name, refreshKey]);

  return { skill, loading, error };
}
