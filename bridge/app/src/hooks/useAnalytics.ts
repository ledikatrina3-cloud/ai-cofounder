// useAnalytics — fetcher'ы для /analytics/* endpoint'ов (Фаза 8).
//
// Дефолтный polling — 60s. Метрики собираются раз в день (cron), поэтому
// чаще обновлять смысла нет. Тем не менее, при ручном «Запустить collect»
// фаундер всё равно увидит свежие цифры через минуту.

import { useEffect, useState } from 'react';

const BRIDGE_URL = 'http://127.0.0.1:3737';
const POLL_MS = 60_000;

// ---------------------------------------------------------------------------
// Types (зеркало src/analytics/queries.ts. См. ADR в комментариях туда.)
// ---------------------------------------------------------------------------

export interface AnalyticsSummary {
  period: string;
  topline: {
    postsThisWeek: number;
    postsPrevWeek: number;
    viewsCurrent: number;
    viewsPrev: number;
    costCurrentUsd: number;
    costPrevUsd: number;
    costPerPostAvgUsd: number;
  };
  trafficByPlatform: {
    platform: string;
    totalViews: number;
    totalComments: number;
    totalLikes: number;
  }[];
}

export interface PostDetailItem {
  postUrl: string;
  platform: string;
  postedAt: number;
  views: number;
  comments: number;
  likes: number;
  costUsd: number;
}

export interface TrendPoint {
  weekStartDate: string;
  weekStartMs: number;
  totalUsd?: number;
  totalViews?: number;
  totalComments?: number;
  totalLikes?: number;
}

// ---------------------------------------------------------------------------
// Generic poll-fetch helper.
// ---------------------------------------------------------------------------

function usePollFetch<T>(
  url: string,
  parse: (json: unknown) => T,
  defaultValue: T,
): { value: T; loading: boolean; error: string | null } {
  const [value, setValue] = useState<T>(defaultValue);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const res = await fetch(url);
        const body = (await res.json()) as { ok?: boolean; error?: string } & Record<
          string,
          unknown
        >;
        if (cancelled) return;
        if (res.ok && body.ok === true) {
          setValue(parse(body));
          setError(null);
        } else {
          setError(body.error ?? `HTTP ${res.status}`);
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
  }, [url, parse]);

  return { value, loading, error };
}

// ---------------------------------------------------------------------------
// Hooks.
// ---------------------------------------------------------------------------

export function useAnalyticsSummary(period = '7d'): {
  data: AnalyticsSummary | null;
  loading: boolean;
  error: string | null;
} {
  const url = `${BRIDGE_URL}/analytics/summary?period=${encodeURIComponent(period)}`;
  const { value, loading, error } = usePollFetch<AnalyticsSummary | null>(
    url,
    (json) => {
      const j = json as { data?: AnalyticsSummary };
      return j.data ?? null;
    },
    null,
  );
  return { data: value, loading, error };
}

export function useAnalyticsPosts(period = '30d'): {
  items: PostDetailItem[];
  loading: boolean;
  error: string | null;
} {
  const url = `${BRIDGE_URL}/analytics/posts?period=${encodeURIComponent(period)}`;
  const { value, loading, error } = usePollFetch<PostDetailItem[]>(
    url,
    (json) => {
      const j = json as { items?: PostDetailItem[] };
      return Array.isArray(j.items) ? j.items : [];
    },
    [],
  );
  return { items: value, loading, error };
}

export function useAnalyticsTrend(
  kind: 'cost' | 'traffic',
  weeks = 12,
): { items: TrendPoint[]; loading: boolean; error: string | null } {
  const url = `${BRIDGE_URL}/analytics/${kind}-trend?weeks=${weeks}`;
  const { value, loading, error } = usePollFetch<TrendPoint[]>(
    url,
    (json) => {
      const j = json as { items?: TrendPoint[] };
      return Array.isArray(j.items) ? j.items : [];
    },
    [],
  );
  return { items: value, loading, error };
}
