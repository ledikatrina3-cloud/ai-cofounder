// Teams — вкладка «Команды» (Ф4 плана 2026-06-22-bridge-control-panel).
//
// Отделы: список, создание (＋ Создать отдел), деталь отдела со списком
// сотрудников (routines с departmentId) + добавление сотрудника через
// RoutineEditor (defaultDepartmentId). Стилистика — terminal-look.

import { type CSSProperties, type ReactNode, useCallback, useEffect, useState } from 'react';
import { type EditorState, RoutineEditor } from '../Office/RoutineEditor.js';

const BRIDGE_URL = 'http://127.0.0.1:3737';

interface DeptBudget {
  perDayUsd: number;
  perRunUsd: number;
}
interface DepartmentItem {
  id: string;
  name: string;
  description: string;
  budget?: DeptBudget;
  members: string[];
}

const KEBAB_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function Teams(): ReactNode {
  const [departments, setDepartments] = useState<DepartmentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`${BRIDGE_URL}/departments`)
      .then((r) => r.json() as Promise<{ ok: boolean; items?: DepartmentItem[]; error?: string }>)
      .then((b) => {
        if (cancelled) return;
        if (b.ok && Array.isArray(b.items)) {
          setDepartments(b.items);
          setError(null);
        } else {
          setError(b.error ?? 'unknown error');
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const selected = departments.find((d) => d.id === selectedId) ?? null;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: '#0a0a0a',
        color: '#e9e3dc',
        fontFamily: 'JetBrains Mono, Menlo, monospace',
        overflowY: 'auto',
        padding: '72px 24px 24px',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 20,
        }}
      >
        <div style={{ fontSize: 18, color: '#d97757', fontWeight: 700 }}>Команды · отделы</div>
        <button type="button" onClick={() => setCreating(true)} style={primaryBtn}>
          ＋ Создать отдел
        </button>
      </div>

      {loading && <div style={{ opacity: 0.6 }}>загрузка…</div>}
      {error !== null && (
        <div style={{ color: '#b25555', marginBottom: 12 }}>
          err: {error}
          <div style={{ opacity: 0.6, fontSize: 11, marginTop: 4 }}>
            Проверь, что bridge поднят (http://127.0.0.1:3737) и dist собран.
          </div>
        </div>
      )}

      {!loading && departments.length === 0 && error === null && (
        <div style={{ opacity: 0.6, lineHeight: 1.6, maxWidth: 460 }}>
          Отделов пока нет. Отдел — это группа агентов с общим бюджетом. Нажми «＋ Создать отдел»,
          затем добавь в него сотрудников.
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 14,
        }}
      >
        {departments.map((d) => (
          <button
            type="button"
            key={d.id}
            onClick={() => setSelectedId(d.id)}
            style={{
              textAlign: 'left',
              background: selectedId === d.id ? 'rgba(217,119,87,0.1)' : '#0f0d0b',
              border: `1px solid ${selectedId === d.id ? '#d97757' : 'rgba(217,119,87,0.2)'}`,
              borderRadius: 6,
              padding: 16,
              cursor: 'pointer',
              color: '#e9e3dc',
              fontFamily: 'inherit',
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, color: '#d97757', marginBottom: 4 }}>
              {d.name}
            </div>
            <div style={{ fontSize: 11, opacity: 0.7, lineHeight: 1.5, marginBottom: 10 }}>
              {d.description.length > 120 ? `${d.description.slice(0, 120)}…` : d.description}
            </div>
            <div style={{ display: 'flex', gap: 12, fontSize: 11, opacity: 0.8 }}>
              <span>👥 {d.members.length} сотрудн.</span>
              {d.budget !== undefined && <span>💰 ${d.budget.perDayUsd}/день</span>}
            </div>
          </button>
        ))}
      </div>

      {selected !== null && (
        <DepartmentDetail
          dept={selected}
          onClose={() => setSelectedId(null)}
          onAddEmployee={() => setEditor({ mode: 'create' })}
          onEditEmployee={(id) => setEditor({ mode: 'edit', routineId: id })}
          onDeleted={() => {
            setSelectedId(null);
            refresh();
          }}
        />
      )}

      {creating && (
        <CreateDepartmentModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            refresh();
          }}
        />
      )}

      <RoutineEditor
        state={editor}
        defaultDepartmentId={selected?.id}
        onClose={() => setEditor(null)}
        onSaved={() => {
          setEditor(null);
          refresh();
        }}
      />
    </div>
  );
}

function DepartmentDetail({
  dept,
  onClose,
  onAddEmployee,
  onEditEmployee,
  onDeleted,
}: {
  dept: DepartmentItem;
  onClose: () => void;
  onAddEmployee: () => void;
  onEditEmployee: (id: string) => void;
  onDeleted: () => void;
}): ReactNode {
  const [confirmDel, setConfirmDel] = useState(false);

  const handleDelete = async (): Promise<void> => {
    if (!confirmDel) {
      setConfirmDel(true);
      return;
    }
    await fetch(`${BRIDGE_URL}/departments/${encodeURIComponent(dept.id)}`, { method: 'DELETE' });
    onDeleted();
  };

  return (
    <div
      style={{
        marginTop: 20,
        background: '#0f0d0b',
        border: '1px solid rgba(217,119,87,0.3)',
        borderRadius: 6,
        padding: 18,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 15, color: '#d97757', fontWeight: 700 }}>{dept.name}</div>
        <button type="button" onClick={onClose} style={iconBtn}>
          ✕
        </button>
      </div>
      <div style={{ fontSize: 11, opacity: 0.7, margin: '8px 0 14px', lineHeight: 1.5 }}>
        {dept.description}
      </div>
      {dept.budget !== undefined && (
        <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 14 }}>
          Бюджет: ${dept.budget.perDayUsd}/день · ${dept.budget.perRunUsd}/запуск
        </div>
      )}

      <div style={{ fontSize: 11, opacity: 0.5, textTransform: 'uppercase', marginBottom: 8 }}>
        Сотрудники ({dept.members.length})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
        {dept.members.length === 0 && (
          <div style={{ opacity: 0.5, fontSize: 12 }}>Пока никого. Добавь первого сотрудника.</div>
        )}
        {dept.members.map((m) => (
          <button
            type="button"
            key={m}
            onClick={() => onEditEmployee(m)}
            style={{
              textAlign: 'left',
              background: '#0a0a0a',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 4,
              padding: '7px 10px',
              fontSize: 12,
              color: '#bdb6ae',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {m} <span style={{ opacity: 0.4 }}>· ✎</span>
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" onClick={onAddEmployee} style={primaryBtn}>
          ＋ Сотрудник
        </button>
        <button
          type="button"
          onClick={handleDelete}
          style={{
            ...iconBtn,
            padding: '8px 12px',
            fontSize: 12,
            color: '#b25555',
            border: '1px solid rgba(178,85,85,0.5)',
            borderRadius: 3,
            background: confirmDel ? 'rgba(178,85,85,0.15)' : 'transparent',
          }}
        >
          {confirmDel ? '✓ Точно удалить отдел?' : '🗑 Удалить отдел'}
        </button>
      </div>
    </div>
  );
}

function CreateDepartmentModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}): ReactNode {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [perDay, setPerDay] = useState('5');
  const [perRun, setPerRun] = useState('1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = KEBAB_RE.test(id) && name.trim() !== '' && description.trim() !== '' && !saving;

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const budget =
        perDay !== '' && perRun !== ''
          ? { perDayUsd: Number(perDay), perRunUsd: Number(perRun) }
          : undefined;
      const res = await fetch(`${BRIDGE_URL}/departments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, name, description, ...(budget ? { budget } : {}) }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || body?.ok === false) {
        setError(body?.error ?? `HTTP ${res.status}`);
        setSaving(false);
        return;
      }
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-dismiss
    <div style={backdrop} onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation-обёртка */}
      <div onClick={(e) => e.stopPropagation()} style={modalCard}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#d97757', marginBottom: 16 }}>
          ＋ Новый отдел
        </div>
        <Field label="ID (kebab-case) *">
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="content-team"
            style={input}
          />
        </Field>
        <Field label="Название *">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Контент-отдел"
            style={input}
          />
        </Field>
        <Field label="Описание *">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Что делает отдел"
            style={input}
          />
        </Field>
        <div style={{ display: 'flex', gap: 12 }}>
          <Field label="Бюджет $/день">
            <input
              type="number"
              value={perDay}
              onChange={(e) => setPerDay(e.target.value)}
              style={input}
            />
          </Field>
          <Field label="Бюджет $/запуск">
            <input
              type="number"
              value={perRun}
              onChange={(e) => setPerRun(e.target.value)}
              style={input}
            />
          </Field>
        </div>
        {error !== null && (
          <div style={{ fontSize: 12, color: '#e08a8a', marginTop: 10 }}>{error}</div>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            style={{ ...primaryBtn, flex: 1, opacity: canSave ? 1 : 0.5 }}
          >
            {saving ? 'создаю…' : 'Создать отдел'}
          </button>
          <button type="button" onClick={onClose} style={secondaryBtn}>
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12, flex: 1 }}>
      <span style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase' }}>{label}</span>
      {children}
    </div>
  );
}

const primaryBtn: CSSProperties = {
  padding: '9px 14px',
  fontFamily: 'JetBrains Mono, Menlo, monospace',
  fontSize: 12,
  fontWeight: 700,
  color: '#0a0a0a',
  background: '#d97757',
  border: '1px solid #d97757',
  borderRadius: 4,
  cursor: 'pointer',
};
const secondaryBtn: CSSProperties = {
  padding: '9px 14px',
  fontFamily: 'JetBrains Mono, Menlo, monospace',
  fontSize: 12,
  color: '#bdb6ae',
  background: 'transparent',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: 4,
  cursor: 'pointer',
};
const iconBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#bdb6ae',
  fontSize: 15,
  cursor: 'pointer',
};
const input: CSSProperties = {
  width: '100%',
  background: '#0a0a0a',
  border: '1px solid rgba(217,119,87,0.2)',
  borderRadius: 4,
  color: '#e9e3dc',
  padding: '8px 10px',
  fontSize: 13,
  fontFamily: 'JetBrains Mono, Menlo, monospace',
  outline: 'none',
  boxSizing: 'border-box',
};
const backdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 200,
  background: 'rgba(0,0,0,0.65)',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'flex-start',
  padding: '60px 16px',
  fontFamily: 'JetBrains Mono, Menlo, monospace',
};
const modalCard: CSSProperties = {
  width: 'min(520px, 100%)',
  background: '#0f0d0b',
  border: '1px solid rgba(217,119,87,0.35)',
  borderRadius: 6,
  color: '#e9e3dc',
  padding: 24,
};
