// NavOverlay (исторически назывался Sidebar) — компактная навигация поверх
// MainView, занимает левый верхний угол. Дизайн — терминальная плашка в том
// же стиле, что Office status-overlay: тёмный фон с rgba, оранжевый акцент
// #d97757, mono-шрифт. 4 чипа с emoji + лейблом, активный подсвечен
// заливкой.
//
// Раньше был левой колонкой 180px (флекс-родитель). Перенесли в overlay
// чтобы освободить горизонтальное пространство для 3D-сцены и маркетплейса
// (decision 2026-05-22: «лаконично вписать в дизайн»).

import type { CSSProperties, ReactNode } from 'react';

export type SidebarView = 'office' | 'teams' | 'skills' | 'metrics';

interface NavItem {
  view: SidebarView;
  icon: string;
  label: string;
  disabledHint?: string;
}

const ITEMS: NavItem[] = [
  { view: 'office', icon: '🏢', label: 'Офис' },
  { view: 'teams', icon: '👥', label: 'Команды', disabledHint: 'Раздел появится в Фазе 5' },
  { view: 'skills', icon: '🎯', label: 'Скиллы' },
  { view: 'metrics', icon: '📊', label: 'Метрики' },
];

interface SidebarProps {
  active: SidebarView;
  onChange: (view: SidebarView) => void;
}

export function Sidebar({ active, onChange }: SidebarProps): ReactNode {
  return (
    <nav
      style={{
        position: 'absolute',
        top: 16,
        left: 16,
        zIndex: 10,
        display: 'flex',
        gap: 4,
        padding: 4,
        background: 'rgba(10,10,10,0.78)',
        border: '1px solid rgba(217,119,87,0.18)',
        borderRadius: 6,
        fontFamily: "'JetBrains Mono', 'Fira Mono', monospace",
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
      }}
    >
      {ITEMS.map((item) => (
        <NavButton
          key={item.view}
          item={item}
          active={item.view === active}
          onClick={() => onChange(item.view)}
        />
      ))}
    </nav>
  );
}

function NavButton({
  item,
  active,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
}): ReactNode {
  const accent = '#d97757';
  const buttonStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    background: active ? 'rgba(217,119,87,0.16)' : 'transparent',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    color: active ? accent : '#e9e3dc',
    fontSize: 12,
    fontFamily: 'inherit',
    transition: 'background 0.12s ease, color 0.12s ease',
    opacity: item.disabledHint ? 0.55 : 1,
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={item.disabledHint ?? item.label}
      style={buttonStyle}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = 'rgba(217,119,87,0.08)';
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'transparent';
      }}
    >
      <span style={{ fontSize: 14 }}>{item.icon}</span>
      <span style={{ letterSpacing: 0.3 }}>{item.label}</span>
    </button>
  );
}
