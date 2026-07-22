// Agent-serializer — обратная операция к `src/routines/agent-loader.ts`.
//
// Пишет/правит самодостаточную папку агента `agents/<id>/`. В отличие от legacy
// `serializer.ts` (hand-rolled YAML-подмножество), frontmatter AGENT.md — это
// НАСТОЯЩИЙ YAML (agent-loader парсит его через `yaml`-либу). Поэтому здесь
// serialize/patch идут через `yaml.stringify`/`yaml.parse`: это семантический
// round-trip (данные сохраняются точно). Единственная потеря на UPDATE —
// комментарии во frontmatter; для UI-авторских агентов их нет, а тело
// (description), prompt.md, permissions.yml/target.yml/rules.md мы не трогаем,
// если их не патчат. id в frontmatter НЕ пишем: источник истины — имя папки
// (agent-loader, иначе рассинхрон id↔папка = hard parse error).
//
// Маппинг полей (зеркало agent-loader §«Маппинг»):
//   displayName → role, body → description, departmentId → department,
//   trigger → schedule, outputType → output. prompt.md и permissions.yml
//   (tools/bash) пишет вызывающий (bridge/agents-write.ts), не этот модуль.

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export class AgentSerializeError extends Error {
  constructor(message: string) {
    super(`agent serialize: ${message}`);
    this.name = 'AgentSerializeError';
  }
}

const DELIM = '---';

// Поля для СОЗДАНИЯ AGENT.md. id = имя папки (тут не пишется). tools/bash идут в
// permissions.yml отдельным файлом (см. agents-write), не во frontmatter.
export interface AgentMdInput {
  displayName: string;
  description: string; // → body AGENT.md
  model: string;
  enabled: boolean;
  trigger: string; // → schedule (manual | cron)
  outputType: string; // → output
  maxTokens?: number;
  timeoutMs?: number;
  avatar?: string;
  color?: string;
  logo?: string;
  departmentId?: string; // → department
  skills?: string[];
  forceLoad?: string[];
  schemaVersion?: string;
}

// Патч для UPDATE. undefined — не трогать; для опц. полей null — удалить ключ.
export interface AgentMdPatch {
  displayName?: string; // role («сотрудник» в офисе); пустой запретит parseAgentFolder
  model?: string;
  enabled?: boolean;
  trigger?: string;
  outputType?: string;
  maxTokens?: number;
  timeoutMs?: number;
  description?: string; // → body
  avatar?: string | null;
  color?: string | null;
  logo?: string | null;
  departmentId?: string | null; // → department
  skills?: string[] | null;
  forceLoad?: string[] | null;
}

// yaml.stringify с отключённым фолдингом длинных строк (lineWidth:0) — иначе
// длинный displayName мог бы перенестись и усложнить diff.
function dumpFrontmatter(obj: Record<string, unknown>): string {
  return stringifyYaml(obj, { lineWidth: 0 }).trimEnd();
}

// Делит AGENT.md на сырой текст frontmatter и body (как splitAgentMd в loader).
function splitAgentMd(source: string): { fm: string; body: string } {
  const lines = source.split('\n');
  if (lines[0]?.trim() !== DELIM) {
    throw new AgentSerializeError('AGENT.md должен начинаться с frontmatter-делимитера ---.');
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === DELIM) {
      close = i;
      break;
    }
  }
  if (close === -1) {
    throw new AgentSerializeError('AGENT.md frontmatter не закрыт вторым ---.');
  }
  const fm = lines.slice(1, close).join('\n');
  const body = lines
    .slice(close + 1)
    .join('\n')
    .trim();
  return { fm, body };
}

/**
 * serializeAgentMd — полный текст AGENT.md для СОЗДАНИЯ.
 * Контракт: parseAgentFolder поверх записанной папки возвращает Routine с теми
 * же полями (семантический round-trip; валидируется в agents-write после записи).
 */
export function serializeAgentMd(a: AgentMdInput): string {
  if (a.displayName.trim() === '') {
    throw new AgentSerializeError("'displayName' не может быть пустым.");
  }
  // Канонический порядок ключей (insertion order сохраняется yaml.stringify).
  const fm: Record<string, unknown> = {};
  fm.schemaVersion = a.schemaVersion ?? '1.0';
  fm.displayName = a.displayName;
  if (a.avatar !== undefined && a.avatar !== '') fm.avatar = a.avatar;
  if (a.color !== undefined && a.color !== '') fm.color = a.color;
  if (a.logo !== undefined && a.logo !== '') fm.logo = a.logo;
  if (a.departmentId !== undefined && a.departmentId !== '') fm.department = a.departmentId;
  fm.model = a.model;
  fm.enabled = a.enabled;
  fm.schedule = a.trigger;
  fm.output = a.outputType;
  if (a.maxTokens !== undefined) fm.maxTokens = a.maxTokens;
  if (a.timeoutMs !== undefined) fm.timeoutMs = a.timeoutMs;
  if (a.skills !== undefined && a.skills.length > 0) fm.skills = a.skills;
  if (a.forceLoad !== undefined && a.forceLoad.length > 0) fm.forceLoad = a.forceLoad;

  const body = a.description.replace(/\s+$/, '');
  if (body === '') {
    throw new AgentSerializeError("'description' (тело AGENT.md) не может быть пустым.");
  }
  return `${DELIM}\n${dumpFrontmatter(fm)}\n${DELIM}\n\n${body}\n`;
}

/**
 * applyAgentMdPatch — UPDATE существующего AGENT.md. parse→merge→stringify
 * frontmatter (real YAML, data-preserving) + замена body, если патчат description.
 * prompt.md/permissions.yml патчит вызывающий — этот модуль их не видит.
 */
export function applyAgentMdPatch(source: string, patch: AgentMdPatch): string {
  const { fm, body } = splitAgentMd(source);
  let parsed: unknown;
  try {
    parsed = parseYaml(fm);
  } catch (err) {
    throw new AgentSerializeError(
      `frontmatter не парсится как YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AgentSerializeError('frontmatter пуст или не YAML-маппинг.');
  }
  const obj = parsed as Record<string, unknown>;

  // undefined-значение yaml.stringify омитит (как JSON) — это и есть «удалить ключ».
  const setOpt = (key: string, v: string | null | undefined): void => {
    if (v === undefined) return;
    obj[key] = v === null || v === '' ? undefined : v;
  };
  const setArr = (key: string, v: string[] | null | undefined): void => {
    if (v === undefined) return;
    obj[key] = v === null || v.length === 0 ? undefined : v;
  };

  if (patch.displayName !== undefined) {
    obj.displayName = patch.displayName;
    // agent-loader выводит role из displayName, но допускает и отдельный ключ
    // `role` (примеры движка несут оба). Чтобы переименование не оставило
    // расходящийся stale `role`, синхронизируем его, если он есть (ревью DI-1).
    if (obj.role !== undefined) obj.role = patch.displayName;
  }
  if (patch.model !== undefined) obj.model = patch.model;
  if (patch.enabled !== undefined) obj.enabled = patch.enabled;
  if (patch.trigger !== undefined) obj.schedule = patch.trigger;
  if (patch.outputType !== undefined) obj.output = patch.outputType;
  if (patch.maxTokens !== undefined) obj.maxTokens = patch.maxTokens;
  if (patch.timeoutMs !== undefined) obj.timeoutMs = patch.timeoutMs;
  setOpt('avatar', patch.avatar);
  setOpt('color', patch.color);
  setOpt('logo', patch.logo);
  setOpt('department', patch.departmentId);
  setArr('skills', patch.skills);
  setArr('forceLoad', patch.forceLoad);

  const newBody = patch.description !== undefined ? patch.description.replace(/\s+$/, '') : body;
  if (newBody.trim() === '') {
    throw new AgentSerializeError("'description' (тело AGENT.md) не может быть пустым.");
  }
  return `${DELIM}\n${dumpFrontmatter(obj)}\n${DELIM}\n\n${newBody}\n`;
}

// permissions.yml: сериализуем только tools/bash (то, что правит UI). Прочие
// ключи (dbScopes/secrets/telegram/budget) сохраняем, если уже были (merge).
export function serializePermissions(
  existing: Record<string, unknown> | null,
  tools: string[] | undefined,
  bash: string[] | undefined,
): string | null {
  // Стартуем со всех ключей existing КРОМЕ tools/bash — их задаём заново ниже
  // (так пустой массив = убрать ключ, без delete).
  const obj: Record<string, unknown> = {};
  if (existing) {
    for (const [k, v] of Object.entries(existing)) {
      if (k !== 'tools' && k !== 'bash') obj[k] = v;
    }
  }
  const resolvedTools = tools !== undefined ? tools : (existing?.tools as string[] | undefined);
  const resolvedBash = bash !== undefined ? bash : (existing?.bash as string[] | undefined);
  if (Array.isArray(resolvedTools) && resolvedTools.length > 0) obj.tools = resolvedTools;
  if (Array.isArray(resolvedBash) && resolvedBash.length > 0) obj.bash = resolvedBash;
  if (Object.keys(obj).length === 0) return null; // нечего писать — файл не нужен
  return `${dumpFrontmatter(obj)}\n`;
}
