// Marketplace — главное полотно раздела «Скиллы» (Фаза 4 плана
// 2026-05-21-skills-architecture-v3, пункт 12).
//
// Layout:
//   Header: заголовок, счётчик, тулбар (поиск + чекбокс «показать internal»)
//   Категории chips ([Все] [publishing] [research] ...)
//   Сетка карточек (auto-fill minmax(220px, 1fr))
//   SkillDetailDrawer открывается справа по клику на карточку.
//
// По плану:
//   - Скрываем категорию `internal` по умолчанию (служебные скиллы).
//     Чекбокс в тулбаре включает её обратно.
//   - Поиск работает по name, displayName, description.
//   - Empty state: понятный текст «нет скиллов под фильтр» / «bridge offline».
//   - Loading: 6 шиммер-карточек.

import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useSkillHealth } from '../../hooks/useSkillHealth.js';
import { useSkills } from '../../hooks/useSkills.js';
import { SkillBuilder } from '../SkillBuilder/index.js';
import { SkillCard, SkillCardSkeleton } from './SkillCard.js';
import { SkillDetailDrawer } from './SkillDetailDrawer.js';
import { SkillEditor } from './SkillEditor.js';

const ALL_CATEGORIES = [
  'publishing',
  'research',
  'writing',
  'analysis',
  'communication',
  'automation',
  'internal',
] as const;

type Category = (typeof ALL_CATEGORIES)[number];

// Стабильные ключи для skeleton-карточек (Biome ругается на index-key).
const SKELETON_KEYS = ['sk-a', 'sk-b', 'sk-c', 'sk-d', 'sk-e', 'sk-f'] as const;

interface CategoryChipProps {
  label: string;
  active: boolean;
  count: number;
  onClick: () => void;
}

export function Marketplace(): ReactNode {
  // skillRefreshKey объявляем ДО useSkills — иначе TDZ (Cannot access before
  // initialization) роняет всю вкладку в чёрный экран.
  const [skillRefreshKey, setSkillRefreshKey] = useState(0);
  const { items, loading, error } = useSkills(skillRefreshKey);
  const { byName: healthByName } = useSkillHealth();

  const [selectedCategory, setSelectedCategory] = useState<Category | 'all'>('all');
  const [query, setQuery] = useState('');
  const [showInternal, setShowInternal] = useState(false);
  const [openSkillName, setOpenSkillName] = useState<string | null>(null);
  const [editorSkill, setEditorSkill] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);

  // Скиллы, доступные с учётом internal-чекбокса и категории.
  const visibleSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((s) => {
      if (!showInternal && s.category === 'internal') return false;
      if (selectedCategory !== 'all' && s.category !== selectedCategory) return false;
      if (q.length === 0) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        (s.displayName ?? '').toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
      );
    });
  }, [items, selectedCategory, query, showInternal]);

  // Подсчёт скиллов в каждой категории (с учётом internal-чекбокса) — для chip-counter.
  const categoryCounts = useMemo(() => {
    const counts = new Map<Category | 'all', number>();
    counts.set('all', 0);
    for (const cat of ALL_CATEGORIES) counts.set(cat, 0);
    for (const s of items) {
      if (!showInternal && s.category === 'internal') continue;
      counts.set('all', (counts.get('all') ?? 0) + 1);
      if (s.category !== undefined) {
        const c = s.category as Category;
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }
    return counts;
  }, [items, showInternal]);

  const bridgeOffline = error !== null && items.length === 0;

  return (
    <div
      style={{
        flex: 1,
        height: '100%',
        background: '#0a0a0a',
        color: '#e9e3dc',
        fontFamily: "'JetBrains Mono', 'Fira Mono', monospace",
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Spacer чтобы заголовок не уезжал под nav-overlay (top:16, height ~32px) */}
      <div style={{ height: 56, flexShrink: 0 }} />
      <Header
        totalCount={items.length}
        visibleCount={visibleSkills.length}
        query={query}
        onQueryChange={setQuery}
        showInternal={showInternal}
        onToggleInternal={() => setShowInternal((v) => !v)}
        loading={loading && items.length === 0}
        onCreate={() => setBuilderOpen(true)}
      />

      {/* Category chips */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          padding: '0 24px 16px',
          borderBottom: '1px solid rgba(217,119,87,0.08)',
        }}
      >
        <CategoryChip
          label="Все"
          active={selectedCategory === 'all'}
          count={categoryCounts.get('all') ?? 0}
          onClick={() => setSelectedCategory('all')}
        />
        {ALL_CATEGORIES.filter((c) => showInternal || c !== 'internal').map((cat) => (
          <CategoryChip
            key={cat}
            label={cat}
            active={selectedCategory === cat}
            count={categoryCounts.get(cat) ?? 0}
            onClick={() => setSelectedCategory(cat)}
          />
        ))}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px 40px' }}>
        {bridgeOffline ? (
          <BridgeOfflineState message={error ?? ''} />
        ) : loading && items.length === 0 ? (
          <SkillGrid>
            {SKELETON_KEYS.map((k) => (
              <SkillCardSkeleton key={k} />
            ))}
          </SkillGrid>
        ) : visibleSkills.length === 0 ? (
          <EmptyState query={query} category={selectedCategory} />
        ) : (
          <SkillGrid>
            {visibleSkills.map((s) => (
              <SkillCard
                key={s.name}
                skill={s}
                onClick={() => setOpenSkillName(s.name)}
                health={healthByName.get(s.name)}
              />
            ))}
          </SkillGrid>
        )}
      </div>

      <SkillDetailDrawer
        skillName={openSkillName}
        onClose={() => setOpenSkillName(null)}
        onSwitchSkill={(name) => setOpenSkillName(name)}
        health={openSkillName !== null ? healthByName.get(openSkillName) : undefined}
        refreshKey={skillRefreshKey}
        onEdit={(name) => {
          // Закрываем drawer перед открытием редактора — иначе Escape закроет оба
          // (ревью finding #10).
          setOpenSkillName(null);
          setEditorSkill(name);
        }}
        onDeleted={() => {
          setOpenSkillName(null);
          setSkillRefreshKey((k) => k + 1);
        }}
      />

      <SkillEditor
        skillName={editorSkill}
        onClose={() => setEditorSkill(null)}
        onSaved={(name) => {
          setEditorSkill(null);
          // Инвалидируем кэш detail + рефрешим список, потом снова открываем.
          setSkillRefreshKey((k) => k + 1);
          setOpenSkillName(name);
        }}
      />

      {builderOpen && (
        <SkillBuilder
          onClose={() => setBuilderOpen(false)}
          onCreated={(name) => {
            setBuilderOpen(false);
            setOpenSkillName(name);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components.
// ---------------------------------------------------------------------------

interface HeaderProps {
  totalCount: number;
  visibleCount: number;
  query: string;
  onQueryChange: (q: string) => void;
  showInternal: boolean;
  onToggleInternal: () => void;
  loading: boolean;
  onCreate: () => void;
}

function Header({
  totalCount,
  visibleCount,
  query,
  onQueryChange,
  showInternal,
  onToggleInternal,
  loading,
  onCreate,
}: HeaderProps): ReactNode {
  return (
    <div
      style={{
        padding: '20px 24px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 500,
              color: '#d97757',
              margin: 0,
            }}
          >
            Скиллы
          </h1>
          <div style={{ fontSize: 11, opacity: 0.55, marginTop: 4 }}>
            {loading
              ? 'загружаю реестр…'
              : `${visibleCount} из ${totalCount} ${declSkills(totalCount)}`}
          </div>
        </div>
        <button
          type="button"
          onClick={onCreate}
          style={{
            padding: '8px 14px',
            background: '#d97757',
            border: '1px solid #d97757',
            borderRadius: 3,
            color: '#0a0a0a',
            fontFamily: "'JetBrains Mono', 'Fira Mono', monospace",
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'background 0.12s, opacity 0.12s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = '0.85';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = '1';
          }}
        >
          + Создать скилл
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="search"
          placeholder="поиск по name, displayName, описанию…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          style={{
            flex: 1,
            minWidth: 220,
            padding: '8px 12px',
            background: '#1a1410',
            border: '1px solid rgba(217,119,87,0.2)',
            borderRadius: 3,
            color: '#e9e3dc',
            fontFamily: 'inherit',
            fontSize: 12,
            outline: 'none',
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = '#d97757';
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = 'rgba(217,119,87,0.2)';
          }}
        />
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            opacity: 0.8,
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <input
            type="checkbox"
            checked={showInternal}
            onChange={onToggleInternal}
            style={{ accentColor: '#d97757' }}
          />
          показать internal
        </label>
      </div>
    </div>
  );
}

function CategoryChip({ label, active, count, onClick }: CategoryChipProps): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '6px 12px',
        background: active ? 'rgba(217,119,87,0.15)' : 'transparent',
        border: active ? '1px solid #d97757' : '1px solid rgba(217,119,87,0.2)',
        borderRadius: 3,
        color: active ? '#d97757' : '#e9e3dc',
        fontFamily: 'inherit',
        fontSize: 11,
        cursor: 'pointer',
        transition: 'background 0.12s, border-color 0.12s',
        opacity: count === 0 && !active ? 0.45 : 1,
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = 'rgba(217,119,87,0.06)';
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'transparent';
      }}
    >
      {label}
      <span style={{ marginLeft: 6, opacity: 0.6 }}>{count}</span>
    </button>
  );
}

function SkillGrid({ children }: { children: ReactNode }): ReactNode {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 16,
      }}
    >
      {children}
    </div>
  );
}

function EmptyState({
  query,
  category,
}: {
  query: string;
  category: Category | 'all';
}): ReactNode {
  let line = 'нет скиллов под этот фильтр';
  if (query.trim().length > 0) line = `ничего не найдено по запросу «${query}»`;
  else if (category !== 'all') line = `в категории «${category}» пока пусто`;
  return (
    <div
      style={{
        padding: 32,
        textAlign: 'center',
        opacity: 0.55,
        fontSize: 12,
        lineHeight: 1.6,
      }}
    >
      <div style={{ fontSize: 32, marginBottom: 12 }}>◇</div>
      <div>{line}</div>
    </div>
  );
}

function BridgeOfflineState({ message }: { message: string }): ReactNode {
  return (
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
          style={{
            background: '#0a0a0a',
            padding: '2px 6px',
            borderRadius: 2,
            color: '#c4a747',
          }}
        >
          pnpm bridge:server
        </code>{' '}
        и убедись, что доступен <code style={{ color: '#c4a747' }}>http://127.0.0.1:3737</code>.
      </div>
      <div style={{ opacity: 0.4, fontSize: 10, marginTop: 12 }}>{message}</div>
    </div>
  );
}

function declSkills(n: number): string {
  const abs = Math.abs(n) % 100;
  const n1 = abs % 10;
  if (abs > 10 && abs < 20) return 'скиллов';
  if (n1 > 1 && n1 < 5) return 'скилла';
  if (n1 === 1) return 'скилл';
  return 'скиллов';
}
