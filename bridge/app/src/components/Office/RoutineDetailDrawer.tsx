// Wave 2: drawer-панель деталей routine'ы.
//
// Открывается по клику на воркера в OfficeScene. Слайдится справа, ~480px.
// Контент берётся из GET /routines/:id. Если выбран конкретный run —
// контент-зона переключается на RunTranscript.
//
// Стилистика — тот же terminal-look, что и в Header/Brain (палитра #d97757,
// фон #0a0a0a/#1a1410, mono-шрифт). Никаких 3D — DOM + inline-styles.

import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { LiveActivityStream } from './LiveActivityStream.js';
import { RunTranscript } from './RunTranscript.js';
import type { SkillBadge, ToolStationKind } from './types.js';

// Зеркало контрактов из bridge/routines-api.ts. Фронт-only.
interface RoutineFull {
  id: string;
  projectId: string;
  enabled: boolean;
  trigger: string;
  model: string;
  description: string;
  role?: string;
  avatar?: string;
  color?: string;
  prompt?: string;
  tools?: string[];
  maxTokens?: number;
  timeoutMs?: number;
  outputType?: string;
  nextRunAt?: number; // unix ms — посчитан сервером из cron-trigger
}

interface RunSummary {
  triggerId: string;
  startedAt: number;
  endedAt?: number;
  status?: 'ok' | 'failed' | 'noop';
  durationMs?: number;
  totalUsd?: number;
  toolCallCount: number;
  output?: string;
}

interface DetailResponse {
  ok: boolean;
  routine?: RoutineFull;
  recentRuns?: RunSummary[];
  error?: string;
}

interface SkillsResponse {
  ok: boolean;
  skills?: SkillBadge[];
  error?: string;
}

interface RoutineDetailDrawerProps {
  routineId: string | null;
  onClose: () => void;
  /** Открыть редактор этого агента (Ф2). */
  onEdit?: (id: string) => void;
  /** Агент удалён через DELETE — родитель закрывает drawer и рефрешит офис. */
  onDeleted?: (id: string) => void;
}

const BRIDGE_URL = 'http://127.0.0.1:3737';

const PALETTE = ['#d97757', '#7c9eb2', '#c4a747', '#9ca77c', '#7cb29a', '#a77c9c', '#b25555'];
function colorFromId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length] ?? '#d97757';
}

// Цвет чипа для tool в зависимости от станции, к которой он маппится.
// Та же логика что в useWorkerEvents.mapToolToStation, но без импорта
// (drawer самостоятелен).
const STATION_COLOR: Record<ToolStationKind, string> = {
  db: '#7c9eb2',
  fs: '#c4a747',
  bash: '#9ca77c',
  web: '#7cb29a',
  tg: '#a77c9c',
  email: '#d97757',
};

function stationForTool(toolName: string): ToolStationKind {
  const n = toolName.toLowerCase();
  if (
    n.startsWith('mcp__postgres') ||
    n.includes('postgres') ||
    n.includes('sql') ||
    n.includes('mysql')
  ) {
    return 'db';
  }
  if (n.startsWith('mcp__telegram') || n.includes('telegram')) return 'tg';
  if (n.includes('email') || n.includes('mail')) return 'email';
  if (toolName === 'Bash') return 'bash';
  if (toolName === 'WebSearch' || toolName === 'WebFetch') return 'web';
  return 'fs';
}

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(d.getDate())} ${d.toLocaleDateString('en', { month: 'short' })} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatUsd(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

// formatSchedule превращает routine.trigger (cron-expr или 'manual') в
// человекочитаемое описание. Поддерживает ';'-разделённые слоты (см.
// src/routines/parser.ts) — каждое выражение парсится отдельно, потом
// объединяется в одну строку.
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

const WEEKDAYS_LOCATIVE = [
  'воскресеньям',
  'понедельникам',
  'вторникам',
  'средам',
  'четвергам',
  'пятницам',
  'субботам',
];

function describeSingleCron(part: string): string | null {
  // Возвращает «каждый день в HH:MM» / «по средам в HH:MM» / «каждые N мин»
  // ИЛИ null если паттерн нестандартный (fallback на raw).
  const dailyMatch = /^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/.exec(part);
  if (dailyMatch) {
    return `каждый день в ${pad2(Number(dailyMatch[2]))}:${pad2(Number(dailyMatch[1]))}`;
  }
  const everyNMin = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/.exec(part);
  if (everyNMin) {
    return `каждые ${everyNMin[1]} мин`;
  }
  const weeklyMatch = /^(\d+)\s+(\d+)\s+\*\s+\*\s+([0-6])$/.exec(part);
  if (weeklyMatch) {
    const dayIdx = Number(weeklyMatch[3]);
    return `по ${WEEKDAYS_LOCATIVE[dayIdx]} в ${pad2(Number(weeklyMatch[2]))}:${pad2(Number(weeklyMatch[1]))}`;
  }
  return null;
}

function formatScheduleSummary(trigger: string): string {
  if (trigger === 'manual') return 'только вручную';
  const parts = trigger
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  // Если все слоты — простые daily (M H * * *), объединяем в одну фразу:
  // «каждый день в 08:55, 16:47, 20:15» (отсортировано по времени).
  const dailySlots: { hh: number; mm: number }[] = [];
  let allDaily = true;
  for (const part of parts) {
    const dm = /^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/.exec(part);
    if (dm) {
      dailySlots.push({ mm: Number(dm[1]), hh: Number(dm[2]) });
    } else {
      allDaily = false;
      break;
    }
  }
  if (allDaily && dailySlots.length > 0) {
    const sorted = dailySlots.sort((a, b) => a.hh - b.hh || a.mm - b.mm);
    const times = sorted.map((s) => `${pad2(s.hh)}:${pad2(s.mm)}`).join(', ');
    return `каждый день в ${times}`;
  }
  // Иначе — каждый слот описываем своей фразой, либо fallback cron:<part>.
  return parts.map((p) => describeSingleCron(p) ?? `cron: ${p}`).join('; ');
}

// Парсит ';'-разделённые daily-слоты (M H * * *) в массив {hh, mm}. Возвращает
// null если хотя бы один слот — не простой daily (тогда UI падает на текст).
function parseDailySlots(trigger: string): { hh: number; mm: number }[] | null {
  const parts = trigger
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (parts.length === 0) return null;
  const slots: { hh: number; mm: number }[] = [];
  for (const part of parts) {
    const m = /^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/.exec(part);
    if (!m) return null;
    slots.push({ mm: Number(m[1]), hh: Number(m[2]) });
  }
  slots.sort((a, b) => a.hh - b.hh || a.mm - b.mm);
  return slots;
}

function ScheduleBlocks({
  trigger,
  nextRunAt,
  accentColor,
}: {
  trigger: string;
  nextRunAt?: number;
  accentColor: string;
}): ReactNode {
  if (trigger === 'manual') {
    return (
      <div
        style={{
          padding: '16px 18px',
          border: '1px dashed rgba(255,255,255,0.2)',
          borderRadius: 8,
          fontSize: 13,
          opacity: 0.65,
          textAlign: 'center',
          background: 'rgba(255,255,255,0.02)',
        }}
      >
        только вручную
      </div>
    );
  }

  const slots = parseDailySlots(trigger);
  if (slots === null) {
    // нестандартный паттерн (weekly, */N min, mixed) — рендерим текстом.
    return (
      <div>
        <div style={{ fontSize: 13, opacity: 0.9 }}>{formatScheduleSummary(trigger)}</div>
        {nextRunAt !== undefined && (
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>
            {formatNextRunAt(nextRunAt)}
          </div>
        )}
      </div>
    );
  }

  // Активный — тот слот, чей HH:MM совпадает с nextRunAt (сервер уже выбрал
  // минимальный по всем cron-выражениям).
  let activeIdx = -1;
  if (nextRunAt !== undefined) {
    const tgt = new Date(nextRunAt);
    activeIdx = slots.findIndex((s) => s.hh === tgt.getHours() && s.mm === tgt.getMinutes());
  }

  return (
    <div>
      <div
        style={{
          fontSize: 10,
          opacity: 0.5,
          marginBottom: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
        }}
      >
        каждый день
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {slots.map((s, i) => {
          const isActive = i === activeIdx;
          return (
            <div
              key={`${s.hh}-${s.mm}`}
              style={{
                flex: '1 1 100px',
                minWidth: 96,
                padding: '14px 12px 12px',
                borderRadius: 8,
                border: isActive ? `1.5px solid ${accentColor}` : '1px solid rgba(255,255,255,0.1)',
                background: isActive ? `${accentColor}1c` : 'rgba(255,255,255,0.02)',
                boxShadow: isActive ? `0 0 14px ${accentColor}40` : 'none',
                textAlign: 'center',
                transition: 'all 0.2s ease',
              }}
            >
              <div
                style={{
                  fontSize: 26,
                  fontWeight: 600,
                  fontFamily: 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace',
                  letterSpacing: '0.02em',
                  lineHeight: 1,
                  color: isActive ? accentColor : 'rgba(255,255,255,0.82)',
                  textShadow: isActive ? `0 0 10px ${accentColor}80` : 'none',
                }}
              >
                {pad2(s.hh)}:{pad2(s.mm)}
              </div>
              {isActive && (
                <div
                  style={{
                    fontSize: 9,
                    opacity: 0.8,
                    marginTop: 6,
                    color: accentColor,
                    textTransform: 'uppercase',
                    letterSpacing: '0.14em',
                  }}
                >
                  next
                </div>
              )}
            </div>
          );
        })}
      </div>
      {nextRunAt !== undefined && (
        <div
          style={{
            fontSize: 11,
            opacity: 0.6,
            marginTop: 10,
            textAlign: 'center',
          }}
        >
          {formatNextRunAt(nextRunAt)}
        </div>
      )}
    </div>
  );
}

function formatNextRunAt(nextRunAt: number, now: number = Date.now()): string {
  const target = new Date(nextRunAt);
  const today = new Date(now);
  const tomorrow = new Date(now + 86_400_000);
  let dayLabel: string;
  if (target.toDateString() === today.toDateString()) dayLabel = 'сегодня';
  else if (target.toDateString() === tomorrow.toDateString()) dayLabel = 'завтра';
  else dayLabel = target.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long' });
  const timeLabel = `${pad2(target.getHours())}:${pad2(target.getMinutes())}`;
  const diffMs = nextRunAt - now;
  let rel: string;
  if (diffMs <= 0) {
    rel = 'сейчас';
  } else if (diffMs < 60_000) {
    rel = 'через <1 мин';
  } else if (diffMs < 3_600_000) {
    rel = `через ${Math.round(diffMs / 60_000)} мин`;
  } else {
    const h = Math.floor(diffMs / 3_600_000);
    const m = Math.round((diffMs - h * 3_600_000) / 60_000);
    rel = m === 0 ? `через ${h} ч` : `через ${h} ч ${m} мин`;
  }
  return `следующий — ${dayLabel} в ${timeLabel} (${rel})`;
}

export function RoutineDetailDrawer({
  routineId,
  onClose,
  onEdit,
  onDeleted,
}: RoutineDetailDrawerProps): ReactNode {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [skills, setSkills] = useState<SkillBadge[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [promptExpanded, setPromptExpanded] = useState(false);

  // Fetch при открытии. routineId null = закрыто.
  // Параллельно: GET /routines/:id + GET /routines/:id/skills. Скиллы могут
  // не приехать (например, dist/src/skills/registry.js нет) — это не критично,
  // drawer просто не покажет секцию.
  useEffect(() => {
    if (routineId === null) {
      setData(null);
      setSkills([]);
      setSelectedRunId(null);
      setPromptExpanded(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setData(null);
    setSkills([]);
    (async (): Promise<void> => {
      const detailPromise = fetch(`${BRIDGE_URL}/routines/${encodeURIComponent(routineId)}`)
        .then((res) => res.json() as Promise<DetailResponse>)
        .catch(
          (err): DetailResponse => ({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      const skillsPromise = fetch(`${BRIDGE_URL}/routines/${encodeURIComponent(routineId)}/skills`)
        .then((res) => res.json() as Promise<SkillsResponse>)
        .catch(() => ({ ok: false, skills: [] }) as SkillsResponse);

      const [detail, skillsBody] = await Promise.all([detailPromise, skillsPromise]);
      if (cancelled) return;
      setData(detail);
      if (skillsBody.ok && Array.isArray(skillsBody.skills)) {
        setSkills(skillsBody.skills);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [routineId]);

  // Escape закрывает.
  useEffect(() => {
    if (routineId === null) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (selectedRunId !== null) setSelectedRunId(null);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [routineId, selectedRunId, onClose]);

  const handleBackdropClick = useCallback(() => {
    onClose();
  }, [onClose]);

  if (routineId === null) return null;

  const routine = data?.routine;
  const runs = data?.recentRuns ?? [];

  return (
    <>
      {/* Backdrop */}
      <button
        type="button"
        onClick={handleBackdropClick}
        aria-label="Close drawer"
        style={{
          position: 'fixed',
          inset: 0,
          width: '100vw',
          height: '100vh',
          background: 'rgba(0,0,0,0.45)',
          border: 'none',
          padding: 0,
          margin: 0,
          cursor: 'default',
          zIndex: 100,
        }}
      />
      {/* Drawer */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 480,
          maxWidth: '95vw',
          background: '#0a0a0a',
          borderLeft: '1px solid rgba(217,119,87,0.3)',
          boxShadow: '-12px 0 32px rgba(0,0,0,0.6)',
          zIndex: 101,
          display: 'flex',
          flexDirection: 'column',
          fontFamily: "'JetBrains Mono', 'Fira Mono', monospace",
          color: '#e9e3dc',
          fontSize: 12,
          overflow: 'hidden',
        }}
      >
        {selectedRunId !== null && routine !== undefined ? (
          <RunTranscript
            routineId={routine.id}
            triggerId={selectedRunId}
            onBack={() => setSelectedRunId(null)}
          />
        ) : (
          <DrawerBody
            loading={loading}
            error={data?.ok === false ? (data.error ?? 'unknown error') : null}
            routine={routine}
            runs={runs}
            skills={skills}
            onClose={onClose}
            onSelectRun={setSelectedRunId}
            promptExpanded={promptExpanded}
            setPromptExpanded={setPromptExpanded}
            onEdit={onEdit}
            onDeleted={onDeleted}
          />
        )}
      </div>
    </>
  );
}

interface DrawerBodyProps {
  loading: boolean;
  error: string | null;
  routine: RoutineFull | undefined;
  runs: RunSummary[];
  skills: SkillBadge[];
  onClose: () => void;
  onSelectRun: (triggerId: string) => void;
  promptExpanded: boolean;
  setPromptExpanded: (v: boolean) => void;
  onEdit?: (id: string) => void;
  onDeleted?: (id: string) => void;
}

function DrawerBody(props: DrawerBodyProps): ReactNode {
  const {
    loading,
    error,
    routine,
    runs,
    skills,
    onClose,
    onSelectRun,
    promptExpanded,
    setPromptExpanded,
    onEdit,
    onDeleted,
  } = props;

  if (loading) {
    return (
      <div style={{ padding: 32, opacity: 0.7 }}>
        <CloseButton onClose={onClose} />
        loading routine...
      </div>
    );
  }
  if (error !== null) {
    return (
      <div style={{ padding: 32 }}>
        <CloseButton onClose={onClose} />
        <div style={{ color: '#b25555' }}>error: {error}</div>
      </div>
    );
  }
  if (routine === undefined) {
    return (
      <div style={{ padding: 32 }}>
        <CloseButton onClose={onClose} />
        <div style={{ opacity: 0.6 }}>no data</div>
      </div>
    );
  }

  const accentColor = routine.color ?? colorFromId(routine.id);
  const prompt = routine.prompt ?? '';
  const promptShort = prompt.slice(0, 200);
  const hasLongPrompt = prompt.length > 200;

  return (
    <>
      {/* Header */}
      <div
        style={{
          padding: '16px 20px',
          borderBottom: '1px solid rgba(217,119,87,0.18)',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
        }}
      >
        <div
          style={{
            fontSize: 28,
            width: 44,
            height: 44,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(217,119,87,0.08)',
            border: `1px solid ${accentColor}`,
            borderRadius: 6,
            flexShrink: 0,
          }}
        >
          {routine.avatar ?? '◆'}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, color: accentColor, marginBottom: 2 }}>
            {routine.role ?? routine.id}
          </div>
          <div style={{ fontSize: 10, opacity: 0.5 }}>{routine.id}</div>
        </div>
        <CloseButton onClose={onClose} />
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        {/* Status pills */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
          <Pill color={routine.enabled ? '#7cb29a' : '#7c7c7c'}>
            {routine.enabled ? 'enabled' : 'disabled'}
          </Pill>
          <Pill color="#c4a747">{routine.trigger === 'manual' ? 'manual' : 'cron'}</Pill>
          <Pill color="#7c9eb2">{routine.model}</Pill>
          {routine.outputType !== undefined && <Pill color="#9ca77c">{routine.outputType}</Pill>}
        </div>

        {/* Description */}
        {routine.description.length > 0 && (
          <div
            style={{
              fontStyle: 'italic',
              opacity: 0.75,
              marginBottom: 16,
              lineHeight: 1.5,
              fontSize: 11,
            }}
          >
            {routine.description}
          </div>
        )}

        {/* Skills — резолвнутые скиллы routine'ы (Фаза 3 плана
            2026-05-21-skills-architecture-v3, п.8). С транзитивными deps
            (резолвит бэкенд через resolveDeps). Кнопка «Подробнее»
            пока no-op — маркетплейс приедет в Фазе 4. */}
        {skills.length > 0 && (
          <Section title={`скиллы (${skills.length})`}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {skills.map((s) => (
                <div
                  key={s.name}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'auto 1fr auto',
                    gap: 10,
                    alignItems: 'flex-start',
                    padding: '8px 10px',
                    background: 'rgba(26,20,16,0.5)',
                    border: '1px solid rgba(217,119,87,0.12)',
                    borderLeft: `3px solid ${s.color ?? '#d97757'}`,
                    borderRadius: 3,
                  }}
                >
                  <span
                    style={{
                      width: 24,
                      height: 24,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: '50%',
                      background: s.color ?? '#3a2818',
                      fontSize: 14,
                      color: '#f0e6dc',
                    }}
                  >
                    {s.icon ?? s.name[0]?.toUpperCase() ?? '?'}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: '#e9e3dc' }}>
                      {s.displayName ?? s.name}
                      {s.category !== undefined && (
                        <span style={{ marginLeft: 6, fontSize: 9, opacity: 0.55 }}>
                          [{s.category}]
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 10, opacity: 0.65, marginTop: 2, lineHeight: 1.45 }}>
                      {s.description}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      // Фаза 4: открыть маркетплейс на этом скилле.
                      // Пока no-op — выводим в консоль для debug'а.
                      console.log('[skill:details] requested for', s.name);
                    }}
                    title="Подробнее (откроется в маркетплейсе)"
                    style={{
                      background: 'none',
                      border: '1px solid rgba(217,119,87,0.3)',
                      color: '#d97757',
                      padding: '2px 6px',
                      fontSize: 9,
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                      borderRadius: 3,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    подробнее →
                  </button>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* System prompt */}
        {prompt.length > 0 && (
          <Section title="system prompt">
            <div
              style={{
                background: '#1a1410',
                padding: 12,
                border: '1px solid rgba(217,119,87,0.12)',
                fontSize: 11,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: '#cfc6bc',
                maxHeight: promptExpanded ? 'none' : 120,
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              {promptExpanded || !hasLongPrompt ? prompt : `${promptShort}...`}
            </div>
            {hasLongPrompt && (
              <button
                type="button"
                onClick={() => setPromptExpanded(!promptExpanded)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#d97757',
                  fontFamily: 'inherit',
                  fontSize: 10,
                  cursor: 'pointer',
                  padding: '6px 0 0',
                  textDecoration: 'underline',
                }}
              >
                {promptExpanded ? 'collapse' : 'expand full prompt'}
              </button>
            )}
          </Section>
        )}

        {/* Tools allowed */}
        {routine.tools !== undefined && routine.tools.length > 0 && (
          <Section title={`tools allowed (${routine.tools.length})`}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {routine.tools.map((t) => {
                const station = stationForTool(t);
                const color = STATION_COLOR[station];
                return (
                  <span
                    key={t}
                    style={{
                      fontSize: 10,
                      padding: '2px 8px',
                      border: `1px solid ${color}`,
                      borderRadius: 3,
                      color,
                      background: 'rgba(217,119,87,0.05)',
                    }}
                  >
                    {t}
                  </span>
                );
              })}
            </div>
          </Section>
        )}

        {/* Schedule */}
        <Section title="schedule">
          <ScheduleBlocks
            trigger={routine.trigger}
            nextRunAt={routine.nextRunAt}
            accentColor={accentColor}
          />
        </Section>

        {/* Live activity stream — фильтрует useBridgeEvents по этому routine'у
            и рисует хронологический лог assistant.thinking + tool.start/end +
            skill.loaded + spend. Показывается всегда; если событий нет — empty
            state. Когда воркер работает — обновляется live. */}
        <Section title="live activity">
          <LiveActivityStream routineId={routine.id} accentColor={accentColor} />
        </Section>

        {/* Last output — финальный текст агента из последнего успешного run'а.
            Появилось в audit.routine.end.properties.output (dispatcher.ts). */}
        {(() => {
          const last = runs.find((r) => r.output && r.output.length > 0);
          if (!last || !last.output) return null;
          return (
            <Section title="последний отчёт">
              <pre
                style={{
                  margin: 0,
                  padding: 10,
                  fontSize: 11,
                  fontFamily: 'JetBrains Mono, Menlo, monospace',
                  color: '#e9e3dc',
                  background: 'rgba(217,119,87,0.06)',
                  border: '1px solid rgba(217,119,87,0.2)',
                  borderRadius: 3,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 280,
                  overflow: 'auto',
                  lineHeight: 1.45,
                }}
              >
                {last.output}
              </pre>
            </Section>
          );
        })()}

        {/* Recent runs */}
        <Section title={`recent runs (${runs.length})`}>
          {runs.length === 0 ? (
            <div style={{ opacity: 0.5, fontSize: 11 }}>no runs yet</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {runs.map((r) => (
                <button
                  type="button"
                  key={r.triggerId}
                  onClick={() => onSelectRun(r.triggerId)}
                  style={{
                    background: 'rgba(26,20,16,0.5)',
                    border: '1px solid rgba(217,119,87,0.1)',
                    padding: '8px 10px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: 'inherit',
                    fontSize: 11,
                    color: '#e9e3dc',
                    display: 'grid',
                    gridTemplateColumns: 'auto 1fr auto',
                    gap: 8,
                    alignItems: 'center',
                  }}
                >
                  <span style={{ opacity: 0.5 }}>▶</span>
                  <span>
                    {formatDateTime(r.startedAt)}
                    <span style={{ opacity: 0.4 }}> · </span>
                    <RunStatusBadge status={r.status} />
                    {r.durationMs !== undefined && (
                      <>
                        <span style={{ opacity: 0.4 }}> · </span>
                        {formatDuration(r.durationMs)}
                      </>
                    )}
                    {r.totalUsd !== undefined && r.totalUsd > 0 && (
                      <>
                        <span style={{ opacity: 0.4 }}> · </span>
                        {formatUsd(r.totalUsd)}
                      </>
                    )}
                    {r.toolCallCount > 0 && (
                      <>
                        <span style={{ opacity: 0.4 }}> · </span>
                        <span style={{ opacity: 0.7 }}>{r.toolCallCount} tool calls</span>
                      </>
                    )}
                  </span>
                  <span style={{ opacity: 0.3 }}>→</span>
                </button>
              ))}
            </div>
          )}
        </Section>

        {/* Ручной запуск через POST /routines/:id/run (bridge/server.ts).
            Backend сразу 202, runRoutine крутится в фоне — UI ловит routine.start/end
            через SSE → human-figure в OfficeScene оживает. */}
        <RunNowButton routineId={routine.id} />

        <ScheduleApplyButton routineId={routine.id} trigger={routine.trigger} />

        {(onEdit !== undefined || onDeleted !== undefined) && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {onEdit !== undefined && (
              <button
                type="button"
                onClick={() => onEdit(routine.id)}
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  fontFamily: 'JetBrains Mono, Menlo, monospace',
                  fontSize: 12,
                  color: '#d97757',
                  background: 'transparent',
                  border: '1px solid rgba(217,119,87,0.5)',
                  borderRadius: 3,
                  cursor: 'pointer',
                }}
              >
                ✎ Редактировать
              </button>
            )}
            {onDeleted !== undefined && (
              <DeleteButton routineId={routine.id} onDeleted={onDeleted} />
            )}
          </div>
        )}
      </div>
    </>
  );
}

// Применение расписания к launchd (Ф3). Двухшаговое подтверждение, т.к. это
// мутирует живой планировщик мака.
function ScheduleApplyButton({
  routineId,
  trigger,
}: {
  routineId: string;
  trigger: string;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'err'>('idle');
  const [msg, setMsg] = useState<string | null>(null);

  const handle = useCallback(async (): Promise<void> => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setState('busy');
    setMsg(null);
    try {
      const res = await fetch(
        `${BRIDGE_URL}/routines/${encodeURIComponent(routineId)}/schedule/apply`,
        { method: 'POST', headers: { 'content-type': 'application/json' } },
      );
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        action?: string;
        reason?: string;
        error?: string;
      } | null;
      if (!res.ok || body?.ok === false) {
        setMsg(body?.error ?? `HTTP ${res.status}`);
        setState('err');
        return;
      }
      setMsg(body?.reason ?? body?.action ?? 'применено');
      setState('ok');
      setTimeout(() => setState('idle'), 5000);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      setState('err');
    }
  }, [confirming, routineId]);

  const isCron = trigger !== 'manual';
  const label =
    state === 'busy'
      ? '⏳ применяю…'
      : confirming
        ? isCron
          ? '✓ Загрузить в launchd?'
          : '✓ Снять с launchd?'
        : '⏰ Применить расписание';

  return (
    <div style={{ marginTop: 8 }}>
      <button
        type="button"
        onClick={handle}
        disabled={state === 'busy'}
        style={{
          width: '100%',
          padding: '8px 12px',
          fontFamily: 'JetBrains Mono, Menlo, monospace',
          fontSize: 12,
          color: state === 'err' ? '#b25555' : '#c4a747',
          background: confirming ? 'rgba(196,167,71,0.15)' : 'transparent',
          border: '1px solid rgba(196,167,71,0.45)',
          borderRadius: 3,
          cursor: state === 'busy' ? 'wait' : 'pointer',
        }}
      >
        {label}
      </button>
      {msg !== null && (
        <div
          style={{
            marginTop: 6,
            fontSize: 10,
            color: state === 'err' ? '#b25555' : '#9ca77c',
            opacity: 0.9,
            fontFamily: 'JetBrains Mono, Menlo, monospace',
          }}
        >
          {state === 'ok' ? '✓ ' : ''}
          {msg}
        </div>
      )}
    </div>
  );
}

function DeleteButton({
  routineId,
  onDeleted,
}: {
  routineId: string;
  onDeleted: (id: string) => void;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const handle = useCallback(async (): Promise<void> => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${BRIDGE_URL}/routines/${encodeURIComponent(routineId)}`, {
        method: 'DELETE',
      });
      if (res.ok) onDeleted(routineId);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }, [confirming, routineId, onDeleted]);
  return (
    <button
      type="button"
      onClick={handle}
      disabled={busy}
      style={{
        flex: confirming ? 1 : undefined,
        padding: '8px 12px',
        fontFamily: 'JetBrains Mono, Menlo, monospace',
        fontSize: 12,
        color: '#b25555',
        background: confirming ? 'rgba(178,85,85,0.15)' : 'transparent',
        border: '1px solid rgba(178,85,85,0.5)',
        borderRadius: 3,
        cursor: busy ? 'wait' : 'pointer',
      }}
    >
      {busy ? 'удаляю…' : confirming ? '✓ Точно удалить?' : '🗑 Удалить'}
    </button>
  );
}

function RunNowButton({ routineId }: { routineId: string }): ReactNode {
  const [state, setState] = useState<'idle' | 'starting' | 'ok' | 'err'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const handle = useCallback(async (): Promise<void> => {
    setState('starting');
    setErr(null);
    try {
      const res = await fetch(
        `http://127.0.0.1:3737/routines/${encodeURIComponent(routineId)}/run`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setErr(body?.error ?? `HTTP ${res.status}`);
        setState('err');
        return;
      }
      setState('ok');
      setTimeout(() => setState('idle'), 3000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setState('err');
    }
  }, [routineId]);

  const label =
    state === 'starting'
      ? '▶ запускаю...'
      : state === 'ok'
        ? '✓ запущено · смотри офис'
        : state === 'err'
          ? '✗ ошибка'
          : '▶ Запустить сейчас';

  return (
    <div style={{ marginTop: 16 }}>
      <button
        type="button"
        onClick={handle}
        disabled={state === 'starting'}
        style={{
          width: '100%',
          padding: '10px 14px',
          fontFamily: 'JetBrains Mono, Menlo, monospace',
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: 1,
          color: state === 'err' ? '#b25555' : '#0a0a0a',
          background:
            state === 'err'
              ? 'rgba(178,85,85,0.12)'
              : state === 'ok'
                ? '#9ca77c'
                : state === 'starting'
                  ? 'rgba(217,119,87,0.4)'
                  : '#d97757',
          border: '1px solid #d97757',
          borderRadius: 3,
          cursor: state === 'starting' ? 'wait' : 'pointer',
          outline: 'none',
          transition: 'background 0.15s ease',
        }}
      >
        {label}
      </button>
      {err !== null && (
        <div
          style={{
            marginTop: 6,
            fontSize: 10,
            color: '#b25555',
            opacity: 0.85,
            fontFamily: 'JetBrains Mono, Menlo, monospace',
          }}
        >
          {err}
        </div>
      )}
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close"
      style={{
        background: 'none',
        border: '1px solid rgba(217,119,87,0.3)',
        color: '#d97757',
        width: 28,
        height: 28,
        fontSize: 14,
        cursor: 'pointer',
        fontFamily: 'inherit',
        flexShrink: 0,
        padding: 0,
      }}
    >
      ×
    </button>
  );
}

function Pill({ color, children }: { color: string; children: ReactNode }): ReactNode {
  return (
    <span
      style={{
        fontSize: 10,
        padding: '2px 8px',
        border: `1px solid ${color}`,
        borderRadius: 10,
        color,
        background: 'transparent',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div style={{ marginBottom: 20 }}>
      <div
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          opacity: 0.45,
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function RunStatusBadge({ status }: { status?: 'ok' | 'failed' | 'noop' }): ReactNode {
  let color = '#7c7c7c';
  const label: string = status ?? 'running';
  if (status === 'ok') color = '#7cb29a';
  else if (status === 'failed') color = '#b25555';
  else if (status === 'noop') color = '#c4a747';
  return <span style={{ color }}>{label}</span>;
}
