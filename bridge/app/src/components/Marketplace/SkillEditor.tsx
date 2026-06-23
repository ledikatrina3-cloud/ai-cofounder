// SkillEditor — модалка редактирования скилла (Ф5).
//
// Скилл = markdown (SKILL.md frontmatter + body) + опциональный permissions.md.
// Редактируем СЫРОЙ текст (через GET /skills/:name/raw) — без реконструкции из
// parsed-полей, чтобы не терять frontmatter/комментарии. Save → PUT /skills/:name
// (валидация на бэке через parseSkillSources).

import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';

const BRIDGE_URL = 'http://127.0.0.1:3737';

interface SkillEditorProps {
  /** Имя редактируемого скилла или null (закрыто). */
  skillName: string | null;
  onClose: () => void;
  onSaved: (name: string) => void;
}

export function SkillEditor({ skillName, onClose, onSaved }: SkillEditorProps): ReactNode {
  const [skillMd, setSkillMd] = useState('');
  const [permissionsMd, setPermissionsMd] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (skillName === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${BRIDGE_URL}/skills/${encodeURIComponent(skillName)}/raw`)
      .then((r) => r.json() as Promise<{ ok: boolean; skillMd?: string; permissionsMd?: string }>)
      .then((b) => {
        if (cancelled) return;
        setSkillMd(b.skillMd ?? '');
        setPermissionsMd(b.permissionsMd ?? '');
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
  }, [skillName]);

  useEffect(() => {
    if (skillName === null) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [skillName, onClose]);

  if (skillName === null) return null;

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${BRIDGE_URL}/skills/${encodeURIComponent(skillName)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skillMd, permissionsMd }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || body?.ok === false) {
        setError(body?.error ?? `HTTP ${res.status}`);
        setSaving(false);
        return;
      }
      setSaving(false);
      onSaved(skillName);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-dismiss; Escape тоже закрывает
    <div style={backdrop} onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation-обёртка */}
      <div onClick={(e) => e.stopPropagation()} style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#d97757' }}>
            ✎ Редактировать скилл · {skillName}
          </div>
          <button type="button" onClick={onClose} style={iconBtn}>
            ✕
          </button>
        </div>
        {loading ? (
          <div style={{ opacity: 0.6, padding: 16 }}>загрузка…</div>
        ) : (
          <>
            <Label>SKILL.md (frontmatter + тело)</Label>
            <textarea
              value={skillMd}
              onChange={(e) => setSkillMd(e.target.value)}
              rows={16}
              spellCheck={false}
              style={textarea}
            />
            <Label>permissions.md (опционально — пусто = дефолтные ограничения)</Label>
            <textarea
              value={permissionsMd}
              onChange={(e) => setPermissionsMd(e.target.value)}
              rows={6}
              spellCheck={false}
              style={textarea}
            />
            {error !== null && (
              <div
                style={{
                  fontSize: 12,
                  color: '#e08a8a',
                  background: 'rgba(178,85,85,0.1)',
                  border: '1px solid rgba(178,85,85,0.3)',
                  borderRadius: 4,
                  padding: '8px 10px',
                  marginTop: 10,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {error}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || skillMd.trim() === ''}
                style={{
                  ...primaryBtn,
                  flex: 1,
                  opacity: saving || skillMd.trim() === '' ? 0.5 : 1,
                }}
              >
                {saving ? 'сохраняю…' : 'Сохранить'}
              </button>
              <button type="button" onClick={onClose} style={secondaryBtn}>
                Отмена
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Label({ children }: { children: ReactNode }): ReactNode {
  return (
    <div
      style={{
        fontSize: 11,
        opacity: 0.6,
        textTransform: 'uppercase',
        letterSpacing: 1,
        margin: '10px 0 5px',
      }}
    >
      {children}
    </div>
  );
}

const backdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 300,
  background: 'rgba(0,0,0,0.65)',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'flex-start',
  padding: '40px 16px',
  overflowY: 'auto',
  fontFamily: 'JetBrains Mono, Menlo, monospace',
};
const card: CSSProperties = {
  width: 'min(720px, 100%)',
  background: '#0f0d0b',
  border: '1px solid rgba(217,119,87,0.35)',
  borderRadius: 6,
  color: '#e9e3dc',
  padding: 24,
};
const textarea: CSSProperties = {
  width: '100%',
  background: '#0a0a0a',
  border: '1px solid rgba(217,119,87,0.2)',
  borderRadius: 4,
  color: '#e9e3dc',
  padding: '10px 12px',
  fontSize: 12,
  fontFamily: 'JetBrains Mono, Menlo, monospace',
  outline: 'none',
  boxSizing: 'border-box',
  resize: 'vertical',
  lineHeight: 1.5,
};
const primaryBtn: CSSProperties = {
  padding: '10px 14px',
  fontFamily: 'JetBrains Mono, Menlo, monospace',
  fontSize: 13,
  fontWeight: 700,
  color: '#0a0a0a',
  background: '#d97757',
  border: '1px solid #d97757',
  borderRadius: 4,
  cursor: 'pointer',
};
const secondaryBtn: CSSProperties = {
  padding: '10px 14px',
  fontFamily: 'JetBrains Mono, Menlo, monospace',
  fontSize: 13,
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
  fontSize: 16,
  cursor: 'pointer',
};
