// AI-Cofounder Bridge — главное полотно.
//
// С 2026-05-17 (plans/) дефолтный режим:
// 3D-офис AI-сотрудников. Header сверху, OfficeLivePreview под ним на всё
// оставшееся пространство, RoutineDetailDrawer slide-out по клику на worker'а.
//
// Фаза 4 плана 2026-05-21-skills-architecture-v3 (пункт 12): добавлен
// Sidebar слева с 4 разделами. Office остаётся дефолтным, Skills — новый
// маркетплейс, Teams/Metrics — stub'ы (Фаза 5/8).
//
// Legacy-режим (старая раскладка с ActivityStream/Brain/Terminal/...) доступен
// через `?legacy=1` — оставлен на короткий переходный период, удалим после
// первой недели реальной работы с офисом.

import { type ReactNode, useMemo, useState } from 'react';
import { ActivityStream } from './components/ActivityStream/index.js';
import { DecisionFeed } from './components/DecisionFeed/index.js';
import { EventTimeline } from './components/EventTimeline/index.js';
import { Header } from './components/Header/index.js';
import { LiveMetrics } from './components/LiveMetrics/index.js';
import { Marketplace } from './components/Marketplace/index.js';
import { Metrics } from './components/Metrics/index.js';
import { OfficeLivePreview } from './components/Office/OfficeLivePreview.js';
import { Sidebar, type SidebarView } from './components/Sidebar/Sidebar.js';
import { Terminal } from './components/Terminal/index.js';
import { useAgentStatus } from './hooks/useAgentStatus.js';
import { useBridgeEvents } from './hooks/useBridgeEvents.js';

function isLegacy(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('legacy') === '1';
}

export default function App(): ReactNode {
  const events = useBridgeEvents();
  const status = useAgentStatus(events);
  const legacy = useMemo(isLegacy, []);

  // Flat view-state без react-router. Когда понадобятся ссылки/back-button —
  // добавим минимальный hash-router (см. план 2026-05-21-skills-architecture-v3,
  // п.12: «простой роутинг через useState»).
  const [view, setView] = useState<SidebarView>('office');

  if (legacy) {
    return <LegacyLayout events={events} status={status} />;
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: '28px 1fr',
        width: '100vw',
        height: '100vh',
        background: '#0a0a0a',
        overflow: 'hidden',
      }}
    >
      <div style={{ borderBottom: '1px solid rgba(217,119,87,0.12)' }}>
        <Header status={status} events={events} />
      </div>
      <div
        style={{
          position: 'relative',
          minHeight: 0,
          minWidth: 0,
        }}
      >
        <MainView view={view} />
        <Sidebar active={view} onChange={setView} />
      </div>
    </div>
  );
}

function MainView({ view }: { view: SidebarView }): ReactNode {
  switch (view) {
    case 'office':
      return <OfficeLivePreview />;
    case 'skills':
      return <Marketplace />;
    case 'teams':
      return <StubView title="Команды" hint="Раздел появится в Фазе 5 (departments + pipeline)." />;
    case 'metrics':
      return <Metrics />;
    default:
      return null;
  }
}

function StubView({ title, hint }: { title: string; hint: string }): ReactNode {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        background: '#0a0a0a',
        color: '#e9e3dc',
        fontFamily: "'JetBrains Mono', 'Fira Mono', monospace",
        textAlign: 'center',
        padding: 32,
      }}
    >
      <div style={{ fontSize: 56, opacity: 0.4 }}>◇</div>
      <div style={{ fontSize: 18, color: '#d97757' }}>{title}</div>
      <div style={{ fontSize: 12, opacity: 0.6, maxWidth: 360, lineHeight: 1.6 }}>{hint}</div>
    </div>
  );
}

function LegacyLayout({
  events,
  status,
}: {
  events: ReturnType<typeof useBridgeEvents>;
  status: ReturnType<typeof useAgentStatus>;
}): ReactNode {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1.5fr 1fr',
        gridTemplateRows: '60px 1fr 64px 110px',
        width: '100vw',
        height: '100vh',
        gap: '1px',
        background: 'rgba(217,119,87,0.08)',
      }}
    >
      <div style={{ gridColumn: '1 / -1' }}>
        <Header status={status} events={events} />
      </div>
      <ActivityStream events={events} />
      <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', gap: '1px', minHeight: 0 }}>
        <div style={{ border: '1px solid rgba(217,119,87,0.18)', overflow: 'hidden' }}>
          <LiveMetrics events={events} />
        </div>
        <div
          style={{
            border: '1px solid rgba(217,119,87,0.18)',
            overflow: 'hidden',
            minHeight: 0,
          }}
        >
          <DecisionFeed events={events} />
        </div>
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <EventTimeline events={events} />
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <Terminal events={events} />
      </div>
    </div>
  );
}
