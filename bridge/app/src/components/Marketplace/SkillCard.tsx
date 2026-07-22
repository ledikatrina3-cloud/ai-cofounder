// SkillCard — карточка скилла в маркетплейсе (Фаза 4 плана
// 2026-05-21-skills-architecture-v3, пункт 12).
//
// Layout:
//   ┌───────────────────────────────┐
//   │ ┃[icon]    displayName  v1.0  │   ← header: цветной leftborder + icon
//   │ ┃          name (small)        │
//   │ ┃                              │
//   │   description (2 строки max)   │
//   │                                │
//   │   [category]   used by 2       │   ← footer
//   └───────────────────────────────┘
//
// Скрываем категорию `internal` по умолчанию (см. SKILL_CATEGORIES) —
// это служебные скиллы, в маркетплейсе им делать нечего. Фильтр в index.tsx.

import type { ReactNode } from 'react';
import { type SkillHealthInfo, formatTimeAgo } from '../../hooks/useSkillHealth.js';
import type { SkillListItem } from '../../hooks/useSkills.js';

interface SkillCardProps {
  skill: SkillListItem;
  onClick: () => void;
  /** Запись health-store или undefined если health-check не прогонялся. */
  health?: SkillHealthInfo;
}

const DEFAULT_ACCENT = '#d97757';

export function SkillCard({ skill, onClick, health }: SkillCardProps): ReactNode {
  const accent = skill.color ?? DEFAULT_ACCENT;
  const title = skill.displayName ?? skill.name;
  const usedByCount = skill.usedBy?.length ?? 0;

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 16,
        background: '#1a1410',
        border: '1px solid rgba(217,119,87,0.15)',
        borderLeft: `3px solid ${accent}`,
        borderRadius: 4,
        color: '#e9e3dc',
        fontFamily: "'JetBrains Mono', 'Fira Mono', monospace",
        textAlign: 'left',
        cursor: 'pointer',
        transition: 'background 0.12s, transform 0.08s, border-color 0.12s',
        minHeight: 168,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = '#221b15';
        e.currentTarget.style.borderColor = 'rgba(217,119,87,0.3)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = '#1a1410';
        e.currentTarget.style.borderColor = 'rgba(217,119,87,0.15)';
      }}
    >
      <HealthDot health={health} />
      {/* Header: icon + title + version */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div
          style={{
            width: 44,
            height: 44,
            fontSize: 26,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `${accent}20`,
            border: `1px solid ${accent}80`,
            borderRadius: 6,
            flexShrink: 0,
          }}
        >
          {skill.icon ?? '◆'}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              color: accent,
              marginBottom: 2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: 10,
              opacity: 0.5,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {skill.name}
            {skill.version !== undefined && ` · v${skill.version}`}
          </div>
        </div>
      </div>

      {/* Description (clamped to 2 lines) */}
      <div
        style={{
          fontSize: 11,
          opacity: 0.75,
          lineHeight: 1.5,
          flex: 1,
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {skill.description}
      </div>

      {/* Footer: category + usedBy */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          paddingTop: 8,
          borderTop: '1px solid rgba(217,119,87,0.08)',
        }}
      >
        {skill.category !== undefined ? (
          <span
            style={{
              padding: '2px 8px',
              fontSize: 10,
              background: 'rgba(217,119,87,0.08)',
              border: '1px solid rgba(217,119,87,0.2)',
              borderRadius: 3,
              color: '#c4a747',
            }}
          >
            {skill.category}
          </span>
        ) : (
          <span style={{ fontSize: 10, opacity: 0.4 }}>—</span>
        )}
        <span style={{ fontSize: 10, opacity: 0.6 }}>
          {usedByCount === 0
            ? 'не используется'
            : `used by ${usedByCount} ${declOfNum(usedByCount, ['сотрудником', 'сотрудниками', 'сотрудниками'])}`}
        </span>
      </div>
    </button>
  );
}

/** Простой плюрализатор для русского. ['сотрудник', 'сотрудника', 'сотрудников']. */
function declOfNum(n: number, titles: [string, string, string]): string {
  const abs = Math.abs(n) % 100;
  const n1 = abs % 10;
  if (abs > 10 && abs < 20) return titles[2];
  if (n1 > 1 && n1 < 5) return titles[1];
  if (n1 === 1) return titles[0];
  return titles[2];
}

/**
 * HealthDot — цветная точка в правом верхнем углу карточки.
 *   зелёная → status='ok' (последний прогон успешен)
 *   красная → status='failed'
 *   серая   → status='skipped' (нет healthCheck в permissions) ИЛИ undefined (не было прогона)
 * tooltip (`title`) — статус и timeago.
 */
function HealthDot({ health }: { health: SkillHealthInfo | undefined }): ReactNode {
  let color: string;
  let label: string;
  if (health === undefined) {
    color = '#666';
    label = 'health: не прогонялся';
  } else if (health.status === 'ok') {
    color = '#5fb44a';
    label = `health: ok · ${formatTimeAgo(health.lastCheckAt)}`;
  } else if (health.status === 'failed') {
    color = '#d35d4a';
    label = `health: failed · ${formatTimeAgo(health.lastCheckAt)}${
      health.error !== undefined ? ` · ${truncate(health.error, 80)}` : ''
    }`;
  } else {
    color = '#7a7a7a';
    label = `health: skipped · ${formatTimeAgo(health.lastCheckAt)}`;
  }
  return (
    <span
      title={label}
      aria-label={label}
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        width: 9,
        height: 9,
        borderRadius: '50%',
        background: color,
        boxShadow: `0 0 6px ${color}80`,
        pointerEvents: 'none',
      }}
    />
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/** Скелетон для loading-state карточки. */
export function SkillCardSkeleton(): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 16,
        background: '#1a1410',
        border: '1px solid rgba(217,119,87,0.08)',
        borderRadius: 4,
        minHeight: 168,
      }}
    >
      <div style={{ display: 'flex', gap: 12 }}>
        <ShimmerBox width={44} height={44} radius={6} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 4 }}>
          <ShimmerBox width="60%" height={12} />
          <ShimmerBox width="40%" height={10} />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
        <ShimmerBox width="100%" height={10} />
        <ShimmerBox width="90%" height={10} />
        <ShimmerBox width="70%" height={10} />
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          paddingTop: 8,
          borderTop: '1px solid rgba(217,119,87,0.08)',
        }}
      >
        <ShimmerBox width={60} height={14} />
        <ShimmerBox width={80} height={10} />
      </div>
    </div>
  );
}

function ShimmerBox({
  width,
  height,
  radius = 3,
}: {
  width: number | string;
  height: number;
  radius?: number;
}): ReactNode {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: radius,
        background:
          'linear-gradient(90deg, rgba(217,119,87,0.06), rgba(217,119,87,0.15), rgba(217,119,87,0.06))',
        backgroundSize: '200% 100%',
        animation: 'marketplace-shimmer 1.4s infinite linear',
      }}
    />
  );
}
