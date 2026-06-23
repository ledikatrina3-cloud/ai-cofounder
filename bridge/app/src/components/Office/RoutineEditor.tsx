// RoutineEditor — модалка создания/редактирования агента.
//
// План 2026-06-23 (self-serve продукт): СОЗДАНИЕ пишет самодостаточную папку
// agents/<id>/ (через POST /routines без projectId — сервер маршрутизирует на
// agents-write). Это путь «создать агента из браузера без правки файлов»:
// config/projects.md и концепт «проект» больше не нужны в основном сценарии.
// РЕДАКТИРОВАНИЕ работает для обоих форматов (agents/<id>/ и legacy
// routines/<id>.md) — сервер сам выбирает writer по наличию agentDir.
//
// Самодостаточный компонент: сам тянет GET /departments и GET /skills для
// дропдаунов; на edit подтягивает GET /routines/:id и префилит форму.
// Стилистика — terminal-look (фон #0a0a0a, акцент #d97757, mono).

import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';

const BRIDGE_URL = 'http://127.0.0.1:3737';

// Список — подсказки в editable-combobox. Бэкенд принимает любой claude-*/voyage-*
// (parser.ts VALID_MODEL_PREFIX_RE), поэтому поле редактируемое — не залипает на
// устаревшем списке при бампе моделей.
const MODEL_OPTIONS = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'] as const;
const OUTPUT_OPTIONS = ['journal-only', 'telegram-thread', 'both'] as const;
const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export type EditorState = { mode: 'create' } | { mode: 'edit'; routineId: string } | null;

interface RoutineEditorProps {
  state: EditorState;
  onClose: () => void;
  onSaved: (id: string) => void;
  /** Контекст: отдел, в который добавляем агента (офис/команды передают свой). */
  defaultDepartmentId?: string;
}

interface DepartmentOption {
  id: string;
  name: string;
}
interface SkillItem {
  name: string;
  displayName?: string;
  description: string;
  color?: string;
}

interface FormState {
  id: string;
  enabled: boolean;
  triggerMode: 'manual' | 'cron';
  cron: string;
  model: string;
  description: string;
  role: string;
  avatar: string;
  color: string;
  prompt: string;
  toolsText: string;
  skills: string[];
  departmentId: string;
  maxTokens: number;
  timeoutMs: number;
  outputType: string;
}

const EMPTY_FORM: FormState = {
  id: '',
  enabled: false,
  triggerMode: 'manual',
  cron: '0 9 * * *',
  model: 'claude-haiku-4-5',
  description: '',
  role: '',
  avatar: '🤖',
  // Пустой по умолчанию — НЕ штампуем брендовый цвет в каждый файл (ревью
  // 2026-06-22). Если пусто, офис генерит цвет сам.
  color: '',
  prompt: '',
  toolsText: '',
  skills: [],
  departmentId: '',
  maxTokens: 8000,
  timeoutMs: 600000,
  outputType: 'journal-only',
};

export function RoutineEditor({
  state,
  onClose,
  onSaved,
  defaultDepartmentId,
}: RoutineEditorProps): ReactNode {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);
  const [allSkills, setAllSkills] = useState<SkillItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = state?.mode === 'edit';

  // Загрузка справочников + (для edit) самого routine.
  useEffect(() => {
    if (state === null) return;
    let cancelled = false;
    setError(null);
    setLoading(true);
    setForm(EMPTY_FORM);
    (async (): Promise<void> => {
      const [deptRes, skillRes] = await Promise.all([
        fetch(`${BRIDGE_URL}/departments`)
          .then((r) => r.json() as Promise<{ items?: DepartmentOption[] }>)
          .catch(() => ({ items: [] })),
        fetch(`${BRIDGE_URL}/skills`)
          .then((r) => r.json() as Promise<{ skills?: SkillItem[] }>)
          .catch(() => ({ skills: [] })),
      ]);
      if (cancelled) return;
      setDepartments((deptRes.items ?? []).map((d) => ({ id: d.id, name: d.name })));
      setAllSkills(skillRes.skills ?? []);

      if (state.mode === 'edit') {
        const detail = await fetch(`${BRIDGE_URL}/routines/${encodeURIComponent(state.routineId)}`)
          .then((r) => r.json() as Promise<{ routine?: Record<string, unknown> }>)
          .catch(() => ({ routine: undefined }));
        if (cancelled) return;
        const r = detail.routine;
        if (r !== undefined) {
          const trigger = String(r.trigger ?? 'manual');
          setForm({
            id: String(r.id ?? ''),
            enabled: Boolean(r.enabled),
            triggerMode: trigger === 'manual' ? 'manual' : 'cron',
            cron: trigger === 'manual' ? '0 9 * * *' : trigger,
            model: String(r.model ?? 'claude-haiku-4-5'),
            description: String(r.description ?? ''),
            role: String(r.role ?? ''),
            avatar: String(r.avatar ?? ''),
            // НЕ подставляем брендовый дефолт: если у агента нет color — поле
            // пустое, и PATCH не впишет чужой цвет (ревью 2026-06-22).
            color: r.color !== undefined && r.color !== null ? String(r.color) : '',
            prompt: String(r.prompt ?? ''),
            toolsText: Array.isArray(r.tools) ? (r.tools as string[]).join(', ') : '',
            skills: Array.isArray(r.skills) ? (r.skills as string[]) : [],
            departmentId: typeof r.departmentId === 'string' ? r.departmentId : '',
            maxTokens: typeof r.maxTokens === 'number' ? r.maxTokens : 8000,
            timeoutMs: typeof r.timeoutMs === 'number' ? r.timeoutMs : 600000,
            outputType: String(r.outputType ?? 'journal-only'),
          });
        }
      } else {
        // create: только дефолтный отдел из контекста (офис/команды). id — свободный.
        setForm((f) => ({ ...f, departmentId: defaultDepartmentId ?? '' }));
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [state, defaultDepartmentId]);

  // Escape закрывает (как в RoutineDetailDrawer).
  useEffect(() => {
    if (state === null) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, onClose]);

  if (state === null) return null;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const toggleSkill = (name: string): void => {
    setForm((f) => ({
      ...f,
      skills: f.skills.includes(name) ? f.skills.filter((s) => s !== name) : [...f.skills, name],
    }));
  };

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    const tools = form.toolsText
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== '');
    const trigger = form.triggerMode === 'manual' ? 'manual' : form.cron.trim();
    try {
      let res: Response;
      if (state.mode === 'create') {
        // Без projectId → сервер создаёт agents/<id>/ (привязан к 'self',
        // config/projects.md не нужен). role → displayName агента.
        res = await fetch(`${BRIDGE_URL}/routines`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: form.id,
            enabled: form.enabled,
            trigger,
            tools,
            model: form.model,
            maxTokens: form.maxTokens,
            timeoutMs: form.timeoutMs,
            outputType: form.outputType,
            description: form.description,
            prompt: form.prompt,
            ...(form.role !== '' ? { role: form.role } : {}),
            ...(form.avatar !== '' ? { avatar: form.avatar } : {}),
            ...(form.color !== '' ? { color: form.color } : {}),
            ...(form.skills.length > 0 ? { skills: form.skills } : {}),
            ...(form.departmentId !== '' ? { departmentId: form.departmentId } : {}),
          }),
        });
      } else {
        res = await fetch(`${BRIDGE_URL}/routines/${encodeURIComponent(form.id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            enabled: form.enabled,
            trigger,
            tools,
            model: form.model,
            maxTokens: form.maxTokens,
            timeoutMs: form.timeoutMs,
            outputType: form.outputType,
            description: form.description,
            prompt: form.prompt,
            // role непустой шлём как значение; для агента он же displayName.
            ...(form.role !== '' ? { role: form.role } : {}),
            avatar: form.avatar !== '' ? form.avatar : null,
            color: form.color !== '' ? form.color : null,
            skills: form.skills.length > 0 ? form.skills : null,
            departmentId: form.departmentId !== '' ? form.departmentId : null,
          }),
        });
      }
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || body?.ok === false) {
        setError(body?.error ?? friendlyHttp(res.status));
        setSaving(false);
        return;
      }
      setSaving(false);
      onSaved(form.id);
    } catch (e) {
      // Сеть/bridge недоступен — человеческая подсказка вместо «Failed to fetch».
      setError(
        `Не удалось связаться с bridge (${BRIDGE_URL}). Проверь, что сервер поднят (pnpm bridge:server) и dist собран (pnpm exec tsc). ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      setSaving(false);
    }
  };

  const idValid = isEdit || ID_RE.test(form.id);
  // В cron-режиме нужен непустой cron — иначе trigger='' и сервер вернёт 400.
  const triggerValid = form.triggerMode === 'manual' || form.cron.trim() !== '';
  // id/описание/промт/модель — обязательны (parser требует, kebab-id на create).
  const canSave =
    !saving &&
    form.id !== '' &&
    idValid &&
    form.prompt !== '' &&
    form.description !== '' &&
    form.model.trim() !== '' &&
    triggerValid;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-dismiss; Escape и кнопка «Отмена» тоже закрывают
    <div
      style={{
        position: 'fixed',
        inset: 0,
        // Выше drawer (z-index 100/101), чтобы клики шли в редактор, а не в drawer.
        zIndex: 200,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        padding: '40px 16px',
        overflowY: 'auto',
        fontFamily: 'JetBrains Mono, Menlo, monospace',
      }}
      onClick={onClose}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation-обёртка, не интерактивный элемент */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(640px, 100%)',
          background: '#0f0d0b',
          border: '1px solid rgba(217,119,87,0.35)',
          borderRadius: 6,
          color: '#e9e3dc',
          padding: 24,
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 18,
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, color: '#d97757' }}>
            {isEdit ? '✎ Редактировать агента' : '＋ Новый агент'}
          </div>
          <button type="button" onClick={onClose} style={iconBtnStyle}>
            ✕
          </button>
        </div>

        {loading ? (
          <div style={{ opacity: 0.7, padding: 20 }}>загрузка…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Row label="ID агента *">
              <input
                value={form.id}
                disabled={isEdit}
                onChange={(e) => set('id', e.target.value)}
                placeholder="например seo-analyst"
                style={{
                  ...inputStyle,
                  opacity: isEdit ? 0.6 : 1,
                  borderColor: idValid ? (inputStyle.border as string) : 'rgba(178,85,85,0.6)',
                }}
              />
              {!isEdit && (
                <span style={{ fontSize: 10, opacity: 0.5 }}>
                  {form.id === '' || idValid
                    ? 'латиница-в-kebab-case, станет папкой agents/<id>/'
                    : 'только строчные буквы, цифры и дефис (kebab-case)'}
                </span>
              )}
            </Row>

            <Row label="Роль (имя сотрудника в офисе)">
              <input
                value={form.role}
                onChange={(e) => set('role', e.target.value)}
                placeholder="Например: SEO-аналитик"
                style={inputStyle}
              />
            </Row>

            <div style={{ display: 'flex', gap: 12 }}>
              <Row label="Аватар" flex={1}>
                <input
                  value={form.avatar}
                  onChange={(e) => set('avatar', e.target.value)}
                  placeholder="🤖"
                  style={inputStyle}
                />
              </Row>
              <Row label="Цвет" flex={1}>
                <input
                  value={form.color}
                  onChange={(e) => set('color', e.target.value)}
                  placeholder="авто (#RRGGBB)"
                  style={inputStyle}
                />
              </Row>
            </div>

            <Row label="Отдел">
              <select
                value={form.departmentId}
                onChange={(e) => set('departmentId', e.target.value)}
                style={inputStyle}
              >
                <option value="">— без отдела —</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.id})
                  </option>
                ))}
              </select>
            </Row>

            <Row label="Описание (задача агента) *">
              {/* textarea, а не input: описание = тело AGENT.md, у существующих
                  агентов может быть многострочным — одной строкой бы схлопнулось. */}
              <textarea
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                rows={3}
                placeholder="Что делает агент (обязательно). У существующих агентов это тело AGENT.md."
                style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }}
              />
            </Row>

            <Row label="Модель">
              <input
                value={form.model}
                onChange={(e) => set('model', e.target.value)}
                list="routine-model-options"
                placeholder="claude-…"
                style={inputStyle}
              />
              <datalist id="routine-model-options">
                {MODEL_OPTIONS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Row>

            <Row label="Расписание">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <ToggleChip
                    active={form.triggerMode === 'manual'}
                    onClick={() => set('triggerMode', 'manual')}
                    label="Вручную"
                  />
                  <ToggleChip
                    active={form.triggerMode === 'cron'}
                    onClick={() => set('triggerMode', 'cron')}
                    label="По расписанию (cron)"
                  />
                </div>
                {form.triggerMode === 'cron' && (
                  <input
                    value={form.cron}
                    onChange={(e) => set('cron', e.target.value)}
                    placeholder="0 9 * * * (минута час день месяц день-недели)"
                    style={inputStyle}
                  />
                )}
              </div>
            </Row>

            <Row label="Промт (полная инструкция) *">
              <textarea
                value={form.prompt}
                onChange={(e) => set('prompt', e.target.value)}
                rows={8}
                placeholder="Что агент должен сделать. Это его системная инструкция (prompt.md)."
                style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }}
              />
            </Row>

            <Row label={`Скиллы (${form.skills.length})`}>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 6,
                  maxHeight: 120,
                  overflowY: 'auto',
                  padding: 2,
                }}
              >
                {allSkills.length === 0 && (
                  <span style={{ opacity: 0.5, fontSize: 11 }}>скиллов нет</span>
                )}
                {allSkills.map((s) => {
                  const on = form.skills.includes(s.name);
                  return (
                    <button
                      type="button"
                      key={s.name}
                      onClick={() => toggleSkill(s.name)}
                      title={s.description}
                      style={{
                        ...chipStyle,
                        background: on ? 'rgba(217,119,87,0.25)' : 'rgba(255,255,255,0.04)',
                        borderColor: on ? '#d97757' : 'rgba(255,255,255,0.12)',
                        color: on ? '#f0d8cc' : '#bdb6ae',
                      }}
                    >
                      {on ? '✓ ' : ''}
                      {s.displayName ?? s.name}
                    </button>
                  );
                })}
              </div>
            </Row>

            <details style={{ fontSize: 12 }}>
              <summary style={{ cursor: 'pointer', opacity: 0.7, marginBottom: 8 }}>
                Дополнительно (tools, лимиты, вывод)
              </summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 6 }}>
                <Row label="Tools (через запятую)">
                  <input
                    value={form.toolsText}
                    onChange={(e) => set('toolsText', e.target.value)}
                    placeholder="project.read, project.grep"
                    style={inputStyle}
                  />
                </Row>
                <div style={{ display: 'flex', gap: 12 }}>
                  <Row label="maxTokens" flex={1}>
                    <input
                      type="number"
                      value={form.maxTokens}
                      onChange={(e) => set('maxTokens', Number(e.target.value))}
                      style={inputStyle}
                    />
                  </Row>
                  <Row label="timeoutMs" flex={1}>
                    <input
                      type="number"
                      value={form.timeoutMs}
                      onChange={(e) => set('timeoutMs', Number(e.target.value))}
                      style={inputStyle}
                    />
                  </Row>
                </div>
                <Row label="Вывод (outputType)">
                  <select
                    value={form.outputType}
                    onChange={(e) => set('outputType', e.target.value)}
                    style={inputStyle}
                  >
                    {OUTPUT_OPTIONS.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </Row>
              </div>
            </details>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => set('enabled', e.target.checked)}
              />
              Включён (enabled) — будет запускаться по расписанию
            </label>

            {error !== null && (
              <div
                style={{
                  fontSize: 12,
                  color: '#e08a8a',
                  background: 'rgba(178,85,85,0.1)',
                  border: '1px solid rgba(178,85,85,0.3)',
                  borderRadius: 4,
                  padding: '8px 10px',
                }}
              >
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button
                type="button"
                onClick={handleSave}
                disabled={!canSave}
                style={{
                  ...primaryBtnStyle,
                  opacity: canSave ? 1 : 0.5,
                  cursor: saving ? 'wait' : 'pointer',
                }}
              >
                {saving ? 'сохраняю…' : isEdit ? 'Сохранить' : 'Создать агента'}
              </button>
              <button type="button" onClick={onClose} style={secondaryBtnStyle}>
                Отмена
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function friendlyHttp(status: number): string {
  if (status === 409) return 'Агент с таким id уже существует.';
  if (status === 404) return 'Агент не найден.';
  if (status >= 500)
    return `Ошибка сервера (HTTP ${status}). Проверь, что dist собран (pnpm exec tsc).`;
  return `HTTP ${status}`;
}

function Row({
  label,
  children,
  flex,
}: {
  label: string;
  children: ReactNode;
  flex?: number;
}): ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flex }}>
      <span style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 1 }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function ToggleChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...chipStyle,
        background: active ? 'rgba(217,119,87,0.25)' : 'rgba(255,255,255,0.04)',
        borderColor: active ? '#d97757' : 'rgba(255,255,255,0.12)',
        color: active ? '#f0d8cc' : '#bdb6ae',
      }}
    >
      {label}
    </button>
  );
}

const inputStyle: CSSProperties = {
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

const chipStyle: CSSProperties = {
  padding: '5px 9px',
  borderRadius: 4,
  border: '1px solid',
  fontSize: 11,
  cursor: 'pointer',
  fontFamily: 'JetBrains Mono, Menlo, monospace',
};

const iconBtnStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#bdb6ae',
  fontSize: 16,
  cursor: 'pointer',
};

const primaryBtnStyle: CSSProperties = {
  flex: 1,
  padding: '10px 14px',
  fontFamily: 'JetBrains Mono, Menlo, monospace',
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: 1,
  color: '#0a0a0a',
  background: '#d97757',
  border: '1px solid #d97757',
  borderRadius: 4,
};

const secondaryBtnStyle: CSSProperties = {
  padding: '10px 14px',
  fontFamily: 'JetBrains Mono, Menlo, monospace',
  fontSize: 13,
  color: '#bdb6ae',
  background: 'transparent',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: 4,
  cursor: 'pointer',
};
