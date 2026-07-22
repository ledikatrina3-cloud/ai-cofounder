// Metrics — главное полотно раздела «📊 Метрики» (Фаза 8 плана
// 2026-05-21-skills-architecture-v3, раздел C).
//
// Layout (сверху вниз):
//   1. Header: заголовок «Метрики», селектор периода (7d / 30d / 90d).
//   2. Topline KPI cards × 4: «Posts this week», «Views (7d)», «Cost (7d)»,
//      «Cost per post (avg)». На каждой — дельта vs предыдущий период.
//   3. Trends: два графика рядом — Cost по неделям, Traffic по неделям.
//      Рисуем inline-SVG (никаких дополнительных libs — bundle важнее).
//   4. Traffic by platform — мини-табличка.
//   5. Posts table — отсортирована по postedAt DESC, колонки: дата, платформа,
//      URL (clickable), views, comments, cost. Top-N strip — top-3 by views.
//
// Состояния:
//   * Loading: skeletons на KPI и charts.
//   * Empty (нет постов / нет signal.metric): информативная пустышка с подсказкой.
//   * Error: красная плашка с фразой «Bridge offline» при первом fetch fail.
//
// Никаких графических библиотек: inline-SVG (полилинии + точки + ось x).
// Цвета — те же что в остальной части UI (#d97757 для accent, #0a0a0a фон,
// #1a1410 для карточек, #e9e3dc для текста).

import { type ReactNode, useMemo, useState } from 'react';
import {
  type PostDetailItem,
  type TrendPoint,
  useAnalyticsPosts,
  useAnalyticsSummary,
  useAnalyticsTrend,
} from '../../hooks/useAnalytics.js';

type Period = '7d' | '30d' | '90d';
const PERIODS: Period[] = ['7d', '30d', '90d'];

export function Metrics(): ReactNode {
  const [period, setPeriod] = useState<Period>('7d');
  const summary = useAnalyticsSummary(period);
  const posts = useAnalyticsPosts(period === '7d' ? '30d' : period);
  const costTrend = useAnalyticsTrend('cost', 12);
  const trafficTrend = useAnalyticsTrend('traffic', 12);

  const bridgeOffline =
    summary.error !== null &&
    summary.data === null &&
    posts.items.length === 0 &&
    costTrend.items.length === 0;

  return (
    <div
      style={{
        flex: 1,
        height: '100%',
        background: '#0a0a0a',
        color: '#e9e3dc',
        fontFamily: "'JetBrains Mono', 'Fira Mono', monospace",
        overflow: 'auto',
      }}
    >
      {/* Spacer чтобы заголовок не уезжал под nav-overlay */}
      <div style={{ height: 56 }} />
      <Header period={period} onPeriod={setPeriod} loading={summary.loading} />

      {bridgeOffline ? (
        <BridgeOfflineState message={summary.error ?? ''} />
      ) : (
        <div style={{ padding: '0 24px 40px', display: 'flex', flexDirection: 'column', gap: 24 }}>
          <Topline summary={summary.data} loading={summary.loading} period={period} />
          <Trends cost={costTrend.items} traffic={trafficTrend.items} />
          <TrafficByPlatform summary={summary.data} />
          <TopPosts posts={posts.items} />
          <PostsTable posts={posts.items} loading={posts.loading} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header.
// ---------------------------------------------------------------------------

function Header({
  period,
  onPeriod,
  loading,
}: {
  period: Period;
  onPeriod: (p: Period) => void;
  loading: boolean;
}): ReactNode {
  return (
    <div
      style={{
        padding: '20px 24px 16px',
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
      }}
    >
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 500, color: '#d97757', margin: 0 }}>Метрики</h1>
        <div style={{ fontSize: 11, opacity: 0.55, marginTop: 4 }}>
          {loading
            ? 'загружаю агрегаты…'
            : 'публичные метрики (views / comments / likes) и cost-tracking по audit.spend'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {PERIODS.map((p) => (
          <button
            type="button"
            key={p}
            onClick={() => onPeriod(p)}
            style={{
              padding: '6px 14px',
              background: p === period ? 'rgba(217,119,87,0.15)' : 'transparent',
              border: p === period ? '1px solid #d97757' : '1px solid rgba(217,119,87,0.2)',
              borderRadius: 3,
              color: p === period ? '#d97757' : '#e9e3dc',
              fontFamily: 'inherit',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Topline — 4 KPI карточки.
// ---------------------------------------------------------------------------

function Topline({
  summary,
  loading,
  period,
}: {
  summary: ReturnType<typeof useAnalyticsSummary>['data'];
  loading: boolean;
  period: Period;
}): ReactNode {
  if (loading && summary === null) {
    return (
      <Grid cols={4}>
        {(['k1', 'k2', 'k3', 'k4'] as const).map((k) => (
          <KpiCardSkeleton key={k} />
        ))}
      </Grid>
    );
  }
  if (summary === null) {
    return (
      <Grid cols={4}>
        <KpiCard label="Posts" value="—" />
        <KpiCard label={`Views (${period})`} value="—" />
        <KpiCard label={`Cost (${period})`} value="—" />
        <KpiCard label="Cost per post" value="—" />
      </Grid>
    );
  }
  const t = summary.topline;
  const postsDelta = computeDeltaPct(t.postsThisWeek, t.postsPrevWeek);
  const viewsDelta = computeDeltaPct(t.viewsCurrent, t.viewsPrev);
  const costDelta = computeDeltaPct(t.costCurrentUsd, t.costPrevUsd);
  return (
    <Grid cols={4}>
      <KpiCard
        label="Posts (period)"
        value={String(t.postsThisWeek)}
        delta={postsDelta}
        deltaGoodDirection="up"
      />
      <KpiCard
        label={`Views (${period})`}
        value={formatNumber(t.viewsCurrent)}
        delta={viewsDelta}
        deltaGoodDirection="up"
      />
      <KpiCard
        label={`Cost (${period})`}
        value={`$${t.costCurrentUsd.toFixed(2)}`}
        delta={costDelta}
        deltaGoodDirection="down"
      />
      <KpiCard label="Cost per post (avg)" value={`$${t.costPerPostAvgUsd.toFixed(2)}`} />
    </Grid>
  );
}

function KpiCard({
  label,
  value,
  delta,
  deltaGoodDirection,
}: {
  label: string;
  value: string;
  delta?: number | null;
  /** Если 'up' — рост = хорошо (зелёный); 'down' — рост = плохо. */
  deltaGoodDirection?: 'up' | 'down';
}): ReactNode {
  let chip: ReactNode = null;
  if (delta !== undefined && delta !== null && Number.isFinite(delta)) {
    const isGrowth = delta > 0;
    let color = '#888';
    if (deltaGoodDirection === 'up') {
      color = isGrowth ? '#5ec27e' : delta < 0 ? '#b25555' : '#888';
    } else if (deltaGoodDirection === 'down') {
      color = isGrowth ? '#b25555' : delta < 0 ? '#5ec27e' : '#888';
    }
    chip = (
      <span
        style={{
          marginLeft: 8,
          fontSize: 11,
          padding: '2px 6px',
          borderRadius: 2,
          background: `${color}22`,
          color,
        }}
      >
        {delta > 0 ? '↑' : delta < 0 ? '↓' : '·'} {Math.abs(delta).toFixed(0)}%
      </span>
    );
  }
  return (
    <div
      style={{
        background: '#1a1410',
        border: '1px solid rgba(217,119,87,0.2)',
        borderRadius: 4,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ fontSize: 10, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 1 }}>
        {label}
      </div>
      <div style={{ fontSize: 24, color: '#e9e3dc' }}>
        {value}
        {chip}
      </div>
    </div>
  );
}

function KpiCardSkeleton(): ReactNode {
  return (
    <div
      style={{
        background: '#1a1410',
        border: '1px solid rgba(217,119,87,0.12)',
        borderRadius: 4,
        padding: 16,
        height: 76,
        opacity: 0.4,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Trends — два графика.
// ---------------------------------------------------------------------------

function Trends({ cost, traffic }: { cost: TrendPoint[]; traffic: TrendPoint[] }): ReactNode {
  return (
    <Grid cols={2}>
      <ChartCard
        title="Cost per week"
        points={cost.map((p) => ({ x: p.weekStartMs, y: p.totalUsd ?? 0, label: p.weekStartDate }))}
        formatY={(y) => `$${y.toFixed(2)}`}
        accent="#d97757"
      />
      <ChartCard
        title="Traffic (views) per week"
        points={traffic.map((p) => ({
          x: p.weekStartMs,
          y: p.totalViews ?? 0,
          label: p.weekStartDate,
        }))}
        formatY={(y) => formatNumber(y)}
        accent="#5ec27e"
      />
    </Grid>
  );
}

interface ChartPoint {
  x: number;
  y: number;
  label: string;
}

function ChartCard({
  title,
  points,
  formatY,
  accent,
}: {
  title: string;
  points: ChartPoint[];
  formatY: (y: number) => string;
  accent: string;
}): ReactNode {
  const hasData = points.some((p) => p.y > 0);
  return (
    <div
      style={{
        background: '#1a1410',
        border: '1px solid rgba(217,119,87,0.2)',
        borderRadius: 4,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        minHeight: 220,
      }}
    >
      <div style={{ fontSize: 11, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 1 }}>
        {title}
      </div>
      {hasData ? (
        <InlineLineChart points={points} formatY={formatY} accent={accent} />
      ) : (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', opacity: 0.4, fontSize: 12 }}>
          нет данных за выбранный период
        </div>
      )}
    </div>
  );
}

function InlineLineChart({
  points,
  formatY,
  accent,
}: {
  points: ChartPoint[];
  formatY: (y: number) => string;
  accent: string;
}): ReactNode {
  const width = 540;
  const height = 160;
  const padLeft = 44;
  const padRight = 14;
  const padTop = 12;
  const padBottom = 24;
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;
  if (points.length === 0) return null;

  const maxY = Math.max(1, ...points.map((p) => p.y));
  const minX = points[0]?.x ?? 0;
  const maxX = points[points.length - 1]?.x ?? minX + 1;
  const xRange = Math.max(1, maxX - minX);
  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;

  const coords = points.map((p, i) => ({
    x: padLeft + (points.length > 1 ? i * stepX : innerW / 2),
    y: padTop + innerH - (p.y / maxY) * innerH,
    raw: p,
  }));

  const path = coords
    .map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
    .join(' ');
  const areaPath = `${path} L ${coords[coords.length - 1]?.x.toFixed(1) ?? padLeft + innerW} ${padTop + innerH} L ${padLeft} ${padTop + innerH} Z`;

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ display: 'block' }}
      role="img"
      aria-label={'chart'}
    >
      <title>{`max=${formatY(maxY)} min=${formatY(0)}`}</title>
      {/* baseline + max grid lines */}
      {[0, 0.5, 1].map((frac) => (
        <line
          key={frac}
          x1={padLeft}
          x2={padLeft + innerW}
          y1={padTop + innerH * (1 - frac)}
          y2={padTop + innerH * (1 - frac)}
          stroke="rgba(217,119,87,0.08)"
          strokeWidth={1}
        />
      ))}
      {/* y-axis labels */}
      <text x={4} y={padTop + 4} fill="#e9e3dc88" fontSize={10}>
        {formatY(maxY)}
      </text>
      <text x={4} y={padTop + innerH + 4} fill="#e9e3dc88" fontSize={10}>
        {formatY(0)}
      </text>
      {/* area */}
      <path d={areaPath} fill={accent} fillOpacity={0.12} />
      {/* line */}
      <path d={path} fill="none" stroke={accent} strokeWidth={1.5} />
      {/* points */}
      {coords.map((c) => (
        <g key={`${c.raw.x}`}>
          <circle cx={c.x} cy={c.y} r={3} fill={accent}>
            <title>{`${c.raw.label}: ${formatY(c.raw.y)}`}</title>
          </circle>
        </g>
      ))}
      {/* x-axis: first and last label */}
      <text x={padLeft} y={height - 8} fill="#e9e3dc88" fontSize={10}>
        {coords[0]?.raw.label ?? ''}
      </text>
      <text x={padLeft + innerW} y={height - 8} textAnchor="end" fill="#e9e3dc88" fontSize={10}>
        {coords[coords.length - 1]?.raw.label ?? ''}
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Traffic by platform — мини-таблица.
// ---------------------------------------------------------------------------

function TrafficByPlatform({
  summary,
}: {
  summary: ReturnType<typeof useAnalyticsSummary>['data'];
}): ReactNode {
  const rows = summary?.trafficByPlatform ?? [];
  return (
    <div
      style={{
        background: '#1a1410',
        border: '1px solid rgba(217,119,87,0.2)',
        borderRadius: 4,
        padding: 16,
      }}
    >
      <div
        style={{
          fontSize: 11,
          opacity: 0.7,
          textTransform: 'uppercase',
          letterSpacing: 1,
          marginBottom: 8,
        }}
      >
        Traffic by platform
      </div>
      {rows.length === 0 ? (
        <div style={{ opacity: 0.45, fontSize: 12 }}>пока пусто</div>
      ) : (
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: '#e9e3dc88' }}>
              <Th>Platform</Th>
              <Th align="right">Views</Th>
              <Th align="right">Comments</Th>
              <Th align="right">Likes</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.platform}>
                <Td>{r.platform}</Td>
                <Td align="right">{formatNumber(r.totalViews)}</Td>
                <Td align="right">{formatNumber(r.totalComments)}</Td>
                <Td align="right">{formatNumber(r.totalLikes)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TopPosts — top-3 by views и top-3 by cost (correlation-proxy).
// ---------------------------------------------------------------------------

function TopPosts({ posts }: { posts: PostDetailItem[] }): ReactNode {
  const topByViews = useMemo(
    () => [...posts].sort((a, b) => b.views - a.views).slice(0, 3),
    [posts],
  );
  const topByCost = useMemo(
    () => [...posts].sort((a, b) => b.costUsd - a.costUsd).slice(0, 3),
    [posts],
  );
  if (posts.length === 0) return null;
  return (
    <Grid cols={2}>
      <MiniList
        title="Top-3 by views"
        items={topByViews}
        formatValue={(p) => formatNumber(p.views)}
      />
      <MiniList
        title="Top-3 by cost"
        items={topByCost}
        formatValue={(p) => `$${p.costUsd.toFixed(2)}`}
      />
    </Grid>
  );
}

function MiniList({
  title,
  items,
  formatValue,
}: {
  title: string;
  items: PostDetailItem[];
  formatValue: (p: PostDetailItem) => string;
}): ReactNode {
  return (
    <div
      style={{
        background: '#1a1410',
        border: '1px solid rgba(217,119,87,0.2)',
        borderRadius: 4,
        padding: 16,
      }}
    >
      <div
        style={{
          fontSize: 11,
          opacity: 0.7,
          textTransform: 'uppercase',
          letterSpacing: 1,
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
        {items.map((p) => (
          <div
            key={p.postUrl}
            style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}
          >
            <a
              href={p.postUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                color: '#e9e3dc',
                textDecoration: 'none',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }}
              title={p.postUrl}
            >
              {shortUrl(p.postUrl)}
            </a>
            <span style={{ color: '#d97757' }}>{formatValue(p)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PostsTable.
// ---------------------------------------------------------------------------

function PostsTable({
  posts,
  loading,
}: {
  posts: PostDetailItem[];
  loading: boolean;
}): ReactNode {
  return (
    <div
      style={{
        background: '#1a1410',
        border: '1px solid rgba(217,119,87,0.2)',
        borderRadius: 4,
        padding: 16,
      }}
    >
      <div
        style={{
          fontSize: 11,
          opacity: 0.7,
          textTransform: 'uppercase',
          letterSpacing: 1,
          marginBottom: 8,
        }}
      >
        Posts
      </div>
      {loading && posts.length === 0 ? (
        <div style={{ opacity: 0.4, fontSize: 12, padding: '8px 0' }}>загружаю…</div>
      ) : posts.length === 0 ? (
        <div style={{ opacity: 0.4, fontSize: 12, padding: '8px 0' }}>
          пока нет постов с метриками. Запусти{' '}
          <code style={{ color: '#c4a747' }}>pnpm analytics:collect</code> после публикации.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: '#e9e3dc88' }}>
                <Th>Date</Th>
                <Th>Platform</Th>
                <Th>URL</Th>
                <Th align="right">Views</Th>
                <Th align="right">Comments</Th>
                <Th align="right">Likes</Th>
                <Th align="right">Cost</Th>
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => (
                <tr key={p.postUrl}>
                  <Td>{formatDate(p.postedAt)}</Td>
                  <Td>{p.platform}</Td>
                  <Td>
                    <a
                      href={p.postUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: '#d97757', textDecoration: 'none' }}
                      title={p.postUrl}
                    >
                      {shortUrl(p.postUrl)}
                    </a>
                  </Td>
                  <Td align="right">{formatNumber(p.views)}</Td>
                  <Td align="right">{formatNumber(p.comments)}</Td>
                  <Td align="right">{formatNumber(p.likes)}</Td>
                  <Td align="right">${p.costUsd.toFixed(2)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function Grid({ cols, children }: { cols: number; children: ReactNode }): ReactNode {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fit, minmax(${cols === 4 ? '200px' : '300px'}, 1fr))`,
        gap: 12,
      }}
    >
      {children}
    </div>
  );
}

function Th({
  children,
  align,
}: {
  children: ReactNode;
  align?: 'left' | 'right';
}): ReactNode {
  return (
    <th
      style={{
        textAlign: align ?? 'left',
        padding: '6px 8px',
        fontWeight: 400,
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: 1,
        borderBottom: '1px solid rgba(217,119,87,0.12)',
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
}: {
  children: ReactNode;
  align?: 'left' | 'right';
}): ReactNode {
  return (
    <td
      style={{
        textAlign: align ?? 'left',
        padding: '6px 8px',
        borderBottom: '1px solid rgba(217,119,87,0.06)',
      }}
    >
      {children}
    </td>
  );
}

function BridgeOfflineState({ message }: { message: string }): ReactNode {
  return (
    <div style={{ padding: 32 }}>
      <div
        style={{
          padding: 32,
          textAlign: 'center',
          lineHeight: 1.6,
          background: '#1a1410',
          border: '1px solid rgba(178,85,85,0.3)',
          borderRadius: 4,
          fontSize: 12,
        }}
      >
        <div style={{ fontSize: 28, marginBottom: 12 }}>⚠</div>
        <div style={{ color: '#b25555', marginBottom: 8 }}>Bridge offline</div>
        <div style={{ opacity: 0.7, fontSize: 11 }}>
          Запусти{' '}
          <code
            style={{ background: '#0a0a0a', padding: '2px 6px', borderRadius: 2, color: '#c4a747' }}
          >
            pnpm bridge:server
          </code>{' '}
          и убедись, что доступен <code style={{ color: '#c4a747' }}>http://127.0.0.1:3737</code>.
        </div>
        <div style={{ opacity: 0.4, fontSize: 10, marginTop: 12 }}>{message}</div>
      </div>
    </div>
  );
}

function computeDeltaPct(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null; // null = «нет с чем сравнить»
  return ((current - previous) / previous) * 100;
}

function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 30 ? `${u.pathname.slice(0, 27)}…` : u.pathname;
    return `${u.hostname}${path}`;
  } catch {
    return url.length > 50 ? `${url.slice(0, 47)}…` : url;
  }
}
