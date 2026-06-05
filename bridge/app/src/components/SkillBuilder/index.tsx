// SkillBuilder — wizard для создания нового скилла (Фаза 7, пункт C).
//
// Полноэкранная модалка со split-screen:
//   ┌────────────────────────────┬───────────────────────────────┐
//   │                            │  ── SKILL.md ──               │
//   │  Чат с Sonnet (assistant)  │  <syntax-highlighted-preview> │
//   │                            │                               │
//   │  ▸ user/assistant bubbles  │  ── permissions.md ──         │
//   │  ▸ input снизу             │  <syntax-highlighted-preview> │
//   │                            │                               │
//   │                            │  [💾 Сохранить] [✕ Отменить]  │
//   └────────────────────────────┴───────────────────────────────┘
//
// Чат stateless: каждый запрос содержит всю history. Sonnet возвращает
// {assistantMessage, draftSkillMd, draftPermissionsMd} — последние два
// сразу обновляют preview справа. По кнопке «💾 Сохранить» POST /skills.
// 400 → ошибки валидации показываются под кнопкой.

import { type ReactNode, useEffect, useRef, useState } from 'react';

const BRIDGE_URL = 'http://127.0.0.1:3737';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

interface BuilderReply {
  ok: boolean;
  assistantMessage?: string;
  draftSkillMd?: string;
  draftPermissionsMd?: string;
  error?: string;
}

interface SaveReply {
  ok: boolean;
  name?: string;
  filePath?: string;
  error?: string;
}

interface SkillBuilderProps {
  onClose: () => void;
  /** Колбэк после успешного сохранения (UI открывает drawer с этим скиллом). */
  onCreated: (skillName: string) => void;
}

export function SkillBuilder({ onClose, onCreated }: SkillBuilderProps): ReactNode {
  const [history, setHistory] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      text:
        'Привет. Я помогу собрать новый скилл. Расскажи коротко: что должен уметь скилл? ' +
        'В какую категорию (publishing/research/writing/analysis/communication/automation)? ' +
        'Если уже есть рабочий скрипт — назови путь.',
    },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [draftSkillMd, setDraftSkillMd] = useState('');
  const [draftPermissionsMd, setDraftPermissionsMd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Escape — закрыть.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sendMessage = async (): Promise<void> => {
    const text = input.trim();
    if (text === '' || sending) return;
    setInput('');
    setError(null);
    const nextHistory: ChatMessage[] = [...history, { role: 'user', text }];
    setHistory(nextHistory);
    setSending(true);
    try {
      const res = await fetch(`${BRIDGE_URL}/skills/builder/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          history,
          userMessage: text,
        }),
      });
      const body = (await res.json()) as BuilderReply;
      if (!body.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        setHistory((h) => [
          ...h,
          {
            role: 'assistant',
            text: `[ошибка] ${body.error ?? `HTTP ${res.status}`}`,
          },
        ]);
        return;
      }
      const assistantText = body.assistantMessage ?? '(пустой ответ)';
      setHistory((h) => [...h, { role: 'assistant', text: assistantText }]);
      if (typeof body.draftSkillMd === 'string') setDraftSkillMd(body.draftSkillMd);
      if (typeof body.draftPermissionsMd === 'string') {
        setDraftPermissionsMd(body.draftPermissionsMd);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setHistory((h) => [...h, { role: 'assistant', text: `[ошибка] ${msg}` }]);
    } finally {
      setSending(false);
    }
  };

  const extractedName = extractNameFromSkillMd(draftSkillMd);

  const save = async (): Promise<void> => {
    if (extractedName === null) {
      setError(
        "не удалось извлечь 'name' из SKILL.md. Попроси ассистента сгенерировать frontmatter.",
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${BRIDGE_URL}/skills`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: extractedName,
          skillMd: draftSkillMd,
          permissionsMd: draftPermissionsMd,
        }),
      });
      const body = (await res.json()) as SaveReply;
      if (!body.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      onCreated(body.name ?? extractedName);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 300,
        background: '#0a0a0a',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        fontFamily: "'JetBrains Mono', 'Fira Mono', monospace",
        color: '#e9e3dc',
      }}
    >
      <ChatPane
        history={history}
        input={input}
        sending={sending}
        onInputChange={setInput}
        onSubmit={() => void sendMessage()}
        onClose={onClose}
      />
      <PreviewPane
        skillMd={draftSkillMd}
        permissionsMd={draftPermissionsMd}
        extractedName={extractedName}
        error={error}
        saving={saving}
        onSave={() => void save()}
        onClose={onClose}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatPane (left side).
// ---------------------------------------------------------------------------

function ChatPane({
  history,
  input,
  sending,
  onInputChange,
  onSubmit,
  onClose,
}: {
  history: ChatMessage[];
  input: string;
  sending: boolean;
  onInputChange: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}): ReactNode {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Скроллим вниз после каждого нового сообщения.
  // biome-ignore lint/correctness/useExhaustiveDependencies: эффект-триггер на смену history — само значение внутри не читается, но изменение должно перезапускать автоскролл
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) {
      el.scrollTop = el.scrollHeight;
    }
  }, [history]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        borderRight: '1px solid rgba(217,119,87,0.2)',
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 18px',
          borderBottom: '1px solid rgba(217,119,87,0.15)',
        }}
      >
        <div style={{ fontSize: 14, color: '#d97757' }}>SkillBuilder</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть SkillBuilder"
          style={{
            background: 'transparent',
            border: '1px solid rgba(217,119,87,0.3)',
            color: '#e9e3dc',
            padding: '4px 10px',
            fontSize: 13,
            cursor: 'pointer',
            borderRadius: 3,
            fontFamily: 'inherit',
          }}
        >
          ✕ закрыть
        </button>
      </div>

      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {history.map((m, idx) => (
          <ChatBubble key={`${idx}-${m.role}`} messageRole={m.role} text={m.text} />
        ))}
        {sending && <ChatBubble messageRole="assistant" text="…думаю" />}
      </div>

      <div
        style={{
          padding: 14,
          borderTop: '1px solid rgba(217,119,87,0.15)',
          display: 'flex',
          gap: 8,
        }}
      >
        <textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder="напиши что хочешь от скилла… (Cmd/Ctrl+Enter для отправки)"
          rows={3}
          style={{
            flex: 1,
            padding: '8px 12px',
            background: '#1a1410',
            border: '1px solid rgba(217,119,87,0.2)',
            borderRadius: 3,
            color: '#e9e3dc',
            fontFamily: 'inherit',
            fontSize: 12,
            outline: 'none',
            resize: 'none',
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = '#d97757';
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = 'rgba(217,119,87,0.2)';
          }}
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={sending || input.trim() === ''}
          style={{
            background: sending ? '#3a2a22' : '#d97757',
            color: sending ? '#7a6055' : '#0a0a0a',
            border: '1px solid #d97757',
            borderRadius: 3,
            padding: '8px 16px',
            fontSize: 12,
            fontWeight: 500,
            cursor: sending || input.trim() === '' ? 'default' : 'pointer',
            fontFamily: 'inherit',
            opacity: sending || input.trim() === '' ? 0.6 : 1,
          }}
        >
          Отправить
        </button>
      </div>
    </div>
  );
}

function ChatBubble({
  messageRole,
  text,
}: { messageRole: 'user' | 'assistant'; text: string }): ReactNode {
  const isUser = messageRole === 'user';
  return (
    <div
      style={{
        alignSelf: isUser ? 'flex-end' : 'flex-start',
        maxWidth: '85%',
        padding: '10px 14px',
        background: isUser ? 'rgba(217,119,87,0.15)' : '#1a1410',
        border: `1px solid ${isUser ? 'rgba(217,119,87,0.35)' : 'rgba(217,119,87,0.12)'}`,
        borderRadius: 6,
        fontSize: 12,
        lineHeight: 1.6,
        color: '#e9e3dc',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PreviewPane (right side).
// ---------------------------------------------------------------------------

function PreviewPane({
  skillMd,
  permissionsMd,
  extractedName,
  error,
  saving,
  onSave,
  onClose,
}: {
  skillMd: string;
  permissionsMd: string;
  extractedName: string | null;
  error: string | null;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
}): ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 18px',
          borderBottom: '1px solid rgba(217,119,87,0.15)',
        }}
      >
        <div style={{ fontSize: 14, color: '#d97757' }}>
          Preview{' '}
          {extractedName !== null && <span style={{ opacity: 0.6 }}>· {extractedName}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={onSave}
            disabled={saving || extractedName === null}
            style={{
              padding: '6px 14px',
              background: extractedName === null ? '#3a2a22' : '#5fb44a',
              color: extractedName === null ? '#7a6055' : '#0a0a0a',
              border: `1px solid ${extractedName === null ? '#3a2a22' : '#5fb44a'}`,
              borderRadius: 3,
              fontFamily: 'inherit',
              fontSize: 12,
              fontWeight: 500,
              cursor: extractedName === null || saving ? 'default' : 'pointer',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'сохраняю…' : '💾 Сохранить'}
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '6px 14px',
              background: 'transparent',
              color: '#e9e3dc',
              border: '1px solid rgba(217,119,87,0.3)',
              borderRadius: 3,
              fontFamily: 'inherit',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Отменить
          </button>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        {error !== null && (
          <div
            style={{
              padding: 12,
              background: 'rgba(178,85,85,0.1)',
              border: '1px solid rgba(178,85,85,0.4)',
              borderRadius: 3,
              fontSize: 11,
              color: '#e3a4a4',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {error}
          </div>
        )}

        <PreviewBlock
          title="SKILL.md"
          content={skillMd}
          emptyHint="Sonnet ещё не сгенерил frontmatter — продолжай чат."
        />
        <PreviewBlock
          title="permissions.md"
          content={permissionsMd}
          emptyHint="permissions.md опционален; если нужны bashWhitelist или approval — расскажи ассистенту."
        />
      </div>
    </div>
  );
}

function PreviewBlock({
  title,
  content,
  emptyHint,
}: {
  title: string;
  content: string;
  emptyHint: string;
}): ReactNode {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          letterSpacing: 2,
          textTransform: 'uppercase',
          opacity: 0.55,
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      {content.trim() === '' ? (
        <div style={{ fontSize: 11, opacity: 0.5, padding: '10px 0', lineHeight: 1.6 }}>
          {emptyHint}
        </div>
      ) : (
        <pre
          style={{
            margin: 0,
            padding: 14,
            background: '#1a1410',
            border: '1px solid rgba(217,119,87,0.12)',
            borderRadius: 4,
            fontSize: 11,
            lineHeight: 1.6,
            color: '#e9e3dc',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: "'JetBrains Mono', 'Fira Mono', monospace",
          }}
        >
          {content}
        </pre>
      )}
    </div>
  );
}

/** Достаёт `name:` из frontmatter без полного yaml-парсинга (минимум кода во фронте). */
function extractNameFromSkillMd(md: string): string | null {
  const m = /^\s*name\s*:\s*(.+?)\s*$/m.exec(md);
  if (m === null || m[1] === undefined) return null;
  const v = m[1].trim().replace(/^['"]|['"]$/g, '');
  if (v === '' || /\s/.test(v)) return null;
  return v;
}
