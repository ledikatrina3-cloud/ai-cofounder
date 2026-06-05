// SkillDetailDrawer — модалка/drawer с деталями скилла из маркетплейса.
//
// Открывается по клику на SkillCard. Показывает:
//   * Header: icon + displayName + version + category
//   * Description (полная)
//   * Body SKILL.md (как preformatted markdown — без полноценного MD-парсера;
//     этого достаточно для технического просмотра, тяжёлый markdown-it
//     добавлять ради одной фичи не хочется).
//   * Permissions: bashWhitelist, requiredSdkTools, maxStepsPerInvocation,
//     requiresApproval, healthCheck.
//   * dependsOn: чипы со ссылками — клик переключает drawer на тот скилл.
//   * usedBy: routine-id'ы как чипы (read-only, без навигации в Worker
//     drawer — это будет отдельная фича).

import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { type SkillHealthInfo, formatTimeAgo } from '../../hooks/useSkillHealth.js';
import { useSkillDetail } from '../../hooks/useSkills.js';

interface SkillDetailDrawerProps {
  /** Имя открытого скилла или null если drawer закрыт. */
  skillName: string | null;
  onClose: () => void;
  /** Клик по depend'у → переключаем drawer на тот скилл. */
  onSwitchSkill: (name: string) => void;
  /** Запись health-store или undefined если не было прогона. */
  health?: SkillHealthInfo;
}

const DEFAULT_ACCENT = '#d97757';

export function SkillDetailDrawer({
  skillName,
  onClose,
  onSwitchSkill,
  health,
}: SkillDetailDrawerProps): ReactNode {
  const { skill, loading, error } = useSkillDetail(skillName);

  // Escape закрывает.
  useEffect(() => {
    if (skillName === null) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [skillName, onClose]);

  if (skillName === null) return null;

  return (
    <>
      {/* Backdrop */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Закрыть"
        style={{
          position: 'fixed',
          inset: 0,
          width: '100vw',
          height: '100vh',
          background: 'rgba(0,0,0,0.5)',
          border: 'none',
          padding: 0,
          margin: 0,
          cursor: 'default',
          zIndex: 200,
        }}
      />
      {/* Drawer */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 560,
          maxWidth: '95vw',
          background: '#0a0a0a',
          borderLeft: `1px solid ${DEFAULT_ACCENT}40`,
          boxShadow: '-12px 0 32px rgba(0,0,0,0.6)',
          zIndex: 201,
          display: 'flex',
          flexDirection: 'column',
          fontFamily: "'JetBrains Mono', 'Fira Mono', monospace",
          color: '#e9e3dc',
          fontSize: 12,
          overflow: 'hidden',
        }}
      >
        {loading && <DrawerLoadingState skillName={skillName} onClose={onClose} />}
        {!loading && error !== null && <DrawerErrorState message={error} onClose={onClose} />}
        {!loading && error === null && skill !== null && (
          <DrawerBody
            skill={skill}
            onClose={onClose}
            onSwitchSkill={onSwitchSkill}
            health={health}
          />
        )}
      </div>
    </>
  );
}

function DrawerLoadingState({
  skillName,
  onClose,
}: {
  skillName: string;
  onClose: () => void;
}): ReactNode {
  return (
    <div style={{ padding: 24 }}>
      <CloseButton onClose={onClose} />
      <div style={{ opacity: 0.6 }}>загружаю '{skillName}'…</div>
    </div>
  );
}

function DrawerErrorState({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}): ReactNode {
  return (
    <div style={{ padding: 24 }}>
      <CloseButton onClose={onClose} />
      <div style={{ color: '#b25555', lineHeight: 1.5 }}>error: {message}</div>
    </div>
  );
}

function DrawerBody({
  skill,
  onClose,
  onSwitchSkill,
  health,
}: {
  skill: NonNullable<ReturnType<typeof useSkillDetail>['skill']>;
  onClose: () => void;
  onSwitchSkill: (name: string) => void;
  health?: SkillHealthInfo;
}): ReactNode {
  const accent = skill.color ?? DEFAULT_ACCENT;
  const title = skill.displayName ?? skill.name;

  return (
    <>
      {/* Header */}
      <div
        style={{
          padding: '20px 24px',
          borderBottom: `1px solid ${accent}30`,
          display: 'flex',
          gap: 14,
          alignItems: 'flex-start',
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            fontSize: 32,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `${accent}20`,
            border: `1px solid ${accent}`,
            borderRadius: 8,
            flexShrink: 0,
          }}
        >
          {skill.icon ?? '◆'}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, color: accent, marginBottom: 4 }}>{title}</div>
          <div style={{ fontSize: 10, opacity: 0.55 }}>
            {skill.name}
            {skill.version !== undefined && ` · v${skill.version}`}
            {skill.category !== undefined && ` · ${skill.category}`}
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </div>

      {/* Scrollable body */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px 24px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}
      >
        {/* Description */}
        <div style={{ lineHeight: 1.6, fontSize: 12, opacity: 0.9 }}>{skill.description}</div>

        {/* Health (Фаза 7) */}
        <Section title="Здоровье">
          <HealthSection health={health} />
        </Section>

        {/* Body SKILL.md */}
        {skill.body.trim().length > 0 && (
          <Section title="SKILL.md">
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 11,
                lineHeight: 1.55,
                background: '#1a1410',
                padding: 14,
                borderRadius: 4,
                border: '1px solid rgba(217,119,87,0.1)',
                color: '#e9e3dc',
                margin: 0,
              }}
            >
              {skill.body}
            </pre>
          </Section>
        )}

        {/* dependsOn */}
        {skill.dependsOn !== undefined && skill.dependsOn.length > 0 && (
          <Section title={`dependsOn (${skill.dependsOn.length})`}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {skill.dependsOn.map((dep) => (
                <Chip key={dep} onClick={() => onSwitchSkill(dep)}>
                  {dep}
                </Chip>
              ))}
            </div>
          </Section>
        )}

        {/* Permissions */}
        <Section title="permissions">
          <PermissionsView permissions={skill.permissions} />
        </Section>

        {/* usedBy */}
        <Section title={`usedBy (${skill.usedBy.length})`}>
          {skill.usedBy.length === 0 ? (
            <div style={{ fontSize: 11, opacity: 0.55 }}>
              скилл пока не объявлен ни в одной routine
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {skill.usedBy.map((rid) => (
                <Chip key={rid} variant="muted">
                  {rid}
                </Chip>
              ))}
            </div>
          )}
        </Section>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          letterSpacing: 2,
          textTransform: 'uppercase',
          opacity: 0.5,
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Chip({
  children,
  onClick,
  variant = 'default',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'muted';
}): ReactNode {
  const isInteractive = onClick !== undefined;
  const color = variant === 'muted' ? '#7c9eb2' : '#d97757';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!isInteractive}
      style={{
        padding: '4px 10px',
        background: `${color}15`,
        border: `1px solid ${color}40`,
        borderRadius: 3,
        color,
        fontFamily: 'inherit',
        fontSize: 11,
        cursor: isInteractive ? 'pointer' : 'default',
        transition: 'background 0.12s',
      }}
      onMouseEnter={(e) => {
        if (isInteractive) e.currentTarget.style.background = `${color}30`;
      }}
      onMouseLeave={(e) => {
        if (isInteractive) e.currentTarget.style.background = `${color}15`;
      }}
    >
      {children}
    </button>
  );
}

function CloseButton({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Закрыть drawer"
      style={{
        background: 'transparent',
        border: '1px solid rgba(217,119,87,0.2)',
        color: '#e9e3dc',
        padding: '4px 10px',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 14,
        cursor: 'pointer',
        borderRadius: 3,
        flexShrink: 0,
      }}
    >
      ✕
    </button>
  );
}

function HealthSection({ health }: { health?: SkillHealthInfo }): ReactNode {
  if (health === undefined) {
    return (
      <div style={{ fontSize: 11, opacity: 0.55 }}>
        health-check ещё не прогонялся. Запусти{' '}
        <code
          style={{ background: '#0a0a0a', padding: '2px 6px', borderRadius: 2, color: '#c4a747' }}
        >
          pnpm health:run
        </code>{' '}
        вручную или дождись cron'а.
      </div>
    );
  }
  let color: string;
  let label: string;
  if (health.status === 'ok') {
    color = '#5fb44a';
    label = 'ok';
  } else if (health.status === 'failed') {
    color = '#d35d4a';
    label = 'failed';
  } else {
    color = '#7a7a7a';
    label = 'skipped';
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 10px',
          background: 'rgba(26,20,16,0.6)',
          border: '1px solid rgba(217,119,87,0.1)',
          borderRadius: 3,
        }}
      >
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: color,
            boxShadow: `0 0 6px ${color}80`,
          }}
        />
        <span style={{ fontSize: 11, color }}>{label}</span>
        <span style={{ fontSize: 10, opacity: 0.6 }}>
          {formatTimeAgo(health.lastCheckAt)} · {health.durationMs}ms
        </span>
      </div>
      {health.error !== undefined && (
        <div
          style={{
            padding: '8px 10px',
            background: 'rgba(178,85,85,0.08)',
            border: '1px solid rgba(178,85,85,0.25)',
            borderRadius: 3,
            fontSize: 11,
            color: '#e3a4a4',
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {health.error}
        </div>
      )}
      {health.reason !== undefined && (
        <div style={{ fontSize: 10, opacity: 0.55 }}>{health.reason}</div>
      )}
      {health.output !== undefined && Object.keys(health.output).length > 0 && (
        <pre
          style={{
            margin: 0,
            padding: 10,
            background: '#1a1410',
            border: '1px solid rgba(217,119,87,0.08)',
            borderRadius: 3,
            fontSize: 10,
            lineHeight: 1.5,
            color: '#e9e3dc',
            opacity: 0.8,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 200,
            overflow: 'auto',
          }}
        >
          {JSON.stringify(health.output, null, 2)}
        </pre>
      )}
    </div>
  );
}

function PermissionsView({ permissions }: { permissions: Record<string, unknown> }): ReactNode {
  const keys = Object.keys(permissions);
  if (keys.length === 0) {
    return (
      <div style={{ fontSize: 11, opacity: 0.55 }}>
        permissions.md не задан — скилл использует дефолтные ограничения
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {keys.map((key) => (
        <PermissionField key={key} name={key} value={permissions[key]} />
      ))}
    </div>
  );
}

function PermissionField({ name, value }: { name: string; value: unknown }): ReactNode {
  return (
    <div
      style={{
        padding: '8px 10px',
        background: 'rgba(26,20,16,0.6)',
        border: '1px solid rgba(217,119,87,0.1)',
        borderRadius: 3,
      }}
    >
      <div style={{ fontSize: 10, color: '#c4a747', marginBottom: 4 }}>{name}</div>
      <PermissionValue value={value} />
    </div>
  );
}

function PermissionValue({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined) {
    return <span style={{ fontSize: 11, opacity: 0.5 }}>—</span>;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <span style={{ fontSize: 11 }}>{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {value.map((item, idx) => (
          <div
            key={typeof item === 'string' ? `s:${item}` : `i:${idx}`}
            style={{ fontSize: 11, opacity: 0.85, fontFamily: 'inherit' }}
          >
            {typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item)}
          </div>
        ))}
      </div>
    );
  }
  return (
    <pre
      style={{
        margin: 0,
        fontSize: 11,
        opacity: 0.85,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
