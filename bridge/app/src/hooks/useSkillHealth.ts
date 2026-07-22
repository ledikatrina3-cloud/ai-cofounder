// useSkillHealth — fetcher для GET /skills/health (Фаза 7).
// Polling каждые 30s, как useSkills. Возвращает map skillName → health-row,
// чтобы SkillCard мог быстро найти статус по имени O(1).

import { useEffect, useState } from 'react';

const BRIDGE_URL = 'http://127.0.0.1:3737';
const POLL_MS = 30_000;

export type SkillHealthStatus = 'ok' | 'failed' | 'skipped' | 'unknown';

export interface SkillHealthInfo {
  skillName: string;
  status: SkillHealthStatus;
  durationMs: number;
  lastCheckAt: number;
  error?: string;
  reason?: string;
  output?: Record<string, unknown>;
}

interface Response {
  ok: boolean;
  items?: SkillHealthInfo[];
  error?: string;
}

export interface UseSkillHealthResult {
  /** Map skillName → info. Пустая, если бот ещё не прогонял health-check'и. */
  byName: Map<string, SkillHealthInfo>;
  loading: boolean;
  error: string | null;
}

export function useSkillHealth(): UseSkillHealthResult {
  const [byName, setByName] = useState<Map<string, SkillHealthInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const res = await fetch(`${BRIDGE_URL}/skills/health`);
        if (!res.ok) {
          // 500 с items=[] — это ок (нет dist), просто оставляем пустую map.
          const body = (await res.json().catch(() => ({}))) as Response;
          if (!cancelled) {
            if (Array.isArray(body.items)) {
              setByName(new Map(body.items.map((i) => [i.skillName, i])));
            }
            setError(body.error ?? `HTTP ${res.status}`);
          }
          return;
        }
        const body = (await res.json()) as Response;
        if (cancelled) return;
        if (body.ok && Array.isArray(body.items)) {
          setByName(new Map(body.items.map((i) => [i.skillName, i])));
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
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return { byName, loading, error };
}

/** Маппит ISO/ms timestamp → «5 минут назад», «вчера 14:23» и т.п. */
export function formatTimeAgo(ms: number, now = Date.now()): string {
  const diff = now - ms;
  if (diff < 60_000) return 'только что';
  if (diff < 3_600_000) {
    const m = Math.round(diff / 60_000);
    return `${m} мин назад`;
  }
  if (diff < 24 * 3_600_000) {
    const h = Math.round(diff / 3_600_000);
    return `${h} ч назад`;
  }
  const d = Math.round(diff / (24 * 3_600_000));
  return `${d} дн назад`;
}
