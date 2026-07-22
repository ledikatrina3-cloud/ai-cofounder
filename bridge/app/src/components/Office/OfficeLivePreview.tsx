// Wave 2 dev-preview: офис с реальными routine'ами из bridge + drawer + live events.
//
//  - вызывает /routines через useRoutines (real)
//  - подписан на SSE через useBridgeEvents
//  - сводит данные через useWorkerEvents → live `status`/`walkingTo`/thinking
//  - открывает RoutineDetailDrawer по клику
//
// Один отдел из реальных routine'ов. Никаких синтетических демо-воркеров.

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { BridgeEvent } from '../../../../events.js';
import { useBridgeEvents } from '../../hooks/useBridgeEvents.js';
import { computeProgress } from '../../hooks/useRoutineProgress.js';
import { type SkillsByRoutineId, useRoutineSkills } from '../../hooks/useRoutineSkills.js';
import { useRoutines } from '../../hooks/useRoutines.js';
import { type LiveStateMap, useWorkerEvents } from '../../hooks/useWorkerEvents.js';
import { OfficeScene } from './OfficeScene.js';
import { RoutineDetailDrawer } from './RoutineDetailDrawer.js';
import { type EditorState, RoutineEditor } from './RoutineEditor.js';
import type { WorkerData } from './types.js';

/**
 * Считаем сколько успешных tool.end произошло для конкретного routine
 * с момента последнего routine.start. На routine.end сбрасываем счётчик
 * до 0 (новый прогон стартует с пустой стопки).
 */
function countDocumentsForRoutine(events: BridgeEvent[], routineId: string): number {
  let count = 0;
  let isActive = false;
  for (const ev of events) {
    if (ev.type === 'routine.start' && ev.routineId === routineId) {
      isActive = true;
      count = 0;
    } else if (ev.type === 'routine.end' && ev.routineId === routineId) {
      isActive = false;
    } else if (isActive && ev.type === 'tool.end') {
      count++;
    }
  }
  return count;
}

/**
 * Слияние base WorkerData (polling) + live override (events) + skills (per-routine).
 *
 * Фаза 3: skills[0] (если есть) переопределяет цвет «футболки» — это primary
 * skill сотрудника. Fallback на base.color (тот, что пришёл с polling'а из
 * routine.color или сгенерён хэшем).
 */
function mergeWorkerState(
  base: WorkerData[],
  live: LiveStateMap,
  skillsById: SkillsByRoutineId,
  events: BridgeEvent[],
): WorkerData[] {
  return base.map((w) => {
    const liveState = live[w.id];
    const skills = skillsById[w.id];
    const primarySkillColor = skills?.[0]?.color;
    // Авторитет status'а:
    //   • polling='running' — true source: БД active_runs знает что routine
    //     прямо сейчас работает. Live мог потерять routine.start (вышел из
    //     SSE ring-buffer, ~500 events) и собрать idle через decay от
    //     устаревшего routine.end предыдущего прогона. Доверяем polling'у.
    //   • finished/failed — короткоживущие state'ы, их видит только live
    //     (polling в любой момент перерисует на idle). Берём из live.
    //   • Иначе — live, если есть, fallback на polling.
    let mergedStatus: WorkerData['status'];
    if (w.status === 'running') {
      mergedStatus = 'running';
    } else if (liveState?.status === 'finished' || liveState?.status === 'failed') {
      mergedStatus = liveState.status;
    } else {
      mergedStatus = liveState?.status ?? w.status;
    }
    const next: WorkerData = {
      id: w.id,
      role: w.role,
      // Primary skill color > base color > fallback (всё равно был сгенерирован в useRoutines).
      color: primarySkillColor ?? w.color,
      status: mergedStatus,
    };
    if (w.avatar !== undefined) next.avatar = w.avatar;
    if (w.logo !== undefined) next.logo = w.logo;
    if (skills !== undefined && skills.length > 0) next.skills = skills;
    // nextRunAt берём из baseWorker (он пришёл из polling /routines). Live-events
    // его не меняют — это plan, а не state.
    if (w.nextRunAt !== undefined) next.nextRunAt = w.nextRunAt;
    if (liveState !== undefined) {
      if (liveState.currentTool !== undefined) next.walkingTo = liveState.currentTool;
      if (liveState.currentToolName !== undefined) next.currentToolName = liveState.currentToolName;
      if (liveState.currentToolInput !== undefined) {
        next.currentToolInput = liveState.currentToolInput;
      }
      if (liveState.thinking !== undefined) next.thinking = liveState.thinking;
      if (liveState.thinkingExpiresAt !== undefined) {
        next.thinkingExpiresAt = liveState.thinkingExpiresAt;
      }
      // runningSince — момент перехода в running, для elapsed-таймера.
      if (liveState.runningSince !== undefined) next.runningSince = liveState.runningSince;
    }
    // Прогресс по 14 этапам — text-regex по assistant.thinking/message + tool heuristics.
    // Показываем bar только когда running и progress > 0.
    if (next.status === 'running') {
      const progress = computeProgress(events, w.id);
      if (progress.percent > 0) {
        next.progressPercent = progress.percent;
        if (progress.stageLabel !== null) next.progressStageLabel = progress.stageLabel;
      }
      // Стопка документов — каждый tool.end растит стопку.
      const docs = countDocumentsForRoutine(events, w.id);
      if (docs > 0) next.documentsCount = docs;
    }
    return next;
  });
}

export function OfficeLivePreview(): ReactNode {
  // refreshKey форсит re-fetch /routines сразу после create/edit/delete.
  const [refreshKey, setRefreshKey] = useState(0);
  // Отдел для фильтра офиса. null = все агенты. Список отделов + дефолт (первый)
  // тянем из GET /departments — БЕЗ хардкода (раньше тут жил 'content-team',
  // из-за чего агенты других отделов/проектов были невидимы; Ф6).
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [selectedDept, setSelectedDept] = useState<string | null>(null);
  const [deptInitialized, setDeptInitialized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('http://127.0.0.1:3737/departments')
      .then((r) => r.json() as Promise<{ ok: boolean; items?: { id: string; name: string }[] }>)
      .then((b) => {
        if (cancelled || !b.ok || !Array.isArray(b.items)) return;
        setDepartments(b.items.map((d) => ({ id: d.id, name: d.name })));
        if (!deptInitialized) {
          setSelectedDept(b.items[0]?.id ?? null);
          setDeptInitialized(true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [deptInitialized]);

  const {
    workers: baseWorkers,
    loading,
    error,
  } = useRoutines({
    departmentId: selectedDept ?? undefined,
    refreshKey,
  });
  const events = useBridgeEvents();
  const liveState = useWorkerEvents(events);
  const routineIds = useMemo(() => baseWorkers.map((w) => w.id), [baseWorkers]);
  const skillsById = useRoutineSkills(routineIds);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  // Дев-телеметрия (счётчики событий, raw live-state) — только при ?debug.
  // Конечному пользователю в проде она не нужна.
  const showDebug =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug');

  const workers = useMemo(
    () => mergeWorkerState(baseWorkers, liveState, skillsById, events),
    [baseWorkers, liveState, skillsById, events],
  );

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: '#0a0a0a',
        overflow: 'hidden',
      }}
    >
      <OfficeScene
        workers={workers}
        onWorkerClick={(id) => setSelectedId(id)}
        selectedWorkerId={selectedId ?? undefined}
      />

      {/* Селектор отдела (Ф6) — вместо хардкода. По центру сверху. */}
      <div
        style={{
          position: 'absolute',
          top: 64,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 10,
            opacity: 0.5,
            color: '#d97757',
            fontFamily: 'JetBrains Mono, monospace',
            textTransform: 'uppercase',
          }}
        >
          отдел
        </span>
        <select
          value={selectedDept ?? ''}
          onChange={(e) => setSelectedDept(e.target.value === '' ? null : e.target.value)}
          style={{
            background: 'rgba(10,10,10,0.85)',
            color: '#e9e3dc',
            border: '1px solid rgba(217,119,87,0.3)',
            borderRadius: 4,
            padding: '5px 8px',
            fontSize: 11,
            fontFamily: 'JetBrains Mono, monospace',
            outline: 'none',
          }}
        >
          <option value="">Все агенты</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>

      {/* Empty-state: в выбранном отделе нет агентов. */}
      {!loading && workers.length === 0 && error === null && (
        <div
          style={{
            position: 'absolute',
            top: '45%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center',
            color: '#e9e3dc',
            fontFamily: 'JetBrains Mono, monospace',
            pointerEvents: 'none',
            maxWidth: 360,
          }}
        >
          <div style={{ fontSize: 40, opacity: 0.3, marginBottom: 12 }}>◇</div>
          <div style={{ fontSize: 13, opacity: 0.8, lineHeight: 1.6 }}>
            {selectedDept === null ? 'Агентов пока нет.' : 'В этом отделе пока нет агентов.'}
            <br />
            Нажми «＋ Создать агента» снизу-справа.
          </div>
        </div>
      )}

      {/* Человеческая плашка ошибки (bridge недоступен / dist не собран). */}
      {error !== null && (
        <div
          style={{
            position: 'absolute',
            top: 64,
            left: 16,
            padding: '8px 10px',
            background: 'rgba(178,85,85,0.12)',
            border: '1px solid rgba(178,85,85,0.4)',
            color: '#e08a8a',
            fontSize: 11,
            fontFamily: 'JetBrains Mono, monospace',
            maxWidth: 360,
            lineHeight: 1.5,
            borderRadius: 4,
          }}
        >
          Не удалось загрузить агентов. Проверь, что bridge поднят (pnpm bridge:server) и dist
          собран (pnpm exec tsc).
          <div style={{ opacity: 0.6, marginTop: 4 }}>{error}</div>
        </div>
      )}

      {/* Dev-телеметрия — только при ?debug. */}
      {showDebug && (
        <div
          style={{
            position: 'absolute',
            top: error !== null ? 150 : 64,
            left: 16,
            padding: 10,
            background: 'rgba(10,10,10,0.7)',
            border: '1px solid rgba(217,119,87,0.15)',
            color: 'rgba(217,119,87,0.85)',
            fontSize: 11,
            fontFamily: 'JetBrains Mono, monospace',
            pointerEvents: 'none',
            maxWidth: 360,
            lineHeight: 1.4,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>OFFICE · LIVE-PREVIEW</div>
          <div style={{ opacity: 0.7 }}>
            routines: {workers.length}
            {loading ? ' (loading...)' : ''}
          </div>
          <div style={{ opacity: 0.7, marginTop: 4 }}>events buffered: {events.length}</div>
          {Object.entries(liveState).length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ opacity: 0.5, fontSize: 9, textTransform: 'uppercase' }}>
                live state
              </div>
              {Object.entries(liveState).map(([id, s]) => (
                <div key={id} style={{ fontSize: 10, opacity: 0.85 }}>
                  {id}: {s.status}
                  {s.currentTool !== undefined ? ` → ${s.currentTool}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* «+ Создать агента» — плавающая кнопка снизу-справа. */}
      <button
        type="button"
        onClick={() => setEditor({ mode: 'create' })}
        style={{
          position: 'absolute',
          bottom: 24,
          right: 24,
          padding: '12px 18px',
          fontFamily: 'JetBrains Mono, Menlo, monospace',
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: 1,
          color: '#0a0a0a',
          background: '#d97757',
          border: '1px solid #d97757',
          borderRadius: 6,
          cursor: 'pointer',
          boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
        }}
      >
        ＋ Создать агента
      </button>

      <RoutineDetailDrawer
        routineId={selectedId}
        onClose={() => setSelectedId(null)}
        onEdit={(id) => {
          // Закрываем drawer перед открытием редактора — иначе Escape закроет оба
          // (оба слушают window keydown; ревью finding #10).
          setSelectedId(null);
          setEditor({ mode: 'edit', routineId: id });
        }}
        onDeleted={() => {
          setSelectedId(null);
          setRefreshKey((k) => k + 1);
        }}
      />

      <RoutineEditor
        state={editor}
        defaultDepartmentId={selectedDept ?? undefined}
        onClose={() => setEditor(null)}
        onSaved={(id) => {
          setEditor(null);
          setRefreshKey((k) => k + 1);
          setSelectedId(id);
        }}
      />
    </div>
  );
}
