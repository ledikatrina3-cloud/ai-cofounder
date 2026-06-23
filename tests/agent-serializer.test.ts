// Round-trip и patch-тесты для src/routines/agent-serializer.ts.
//
// Инвариант: авторинг/правка агента из UI не теряет полей. Формат AGENT.md —
// настоящий YAML, поэтому round-trip = семантический (parse(serialize) === input),
// а UPDATE — data-preserving merge frontmatter (комментарии не сохраняются, это
// сознательно — у UI-авторских агентов их нет).

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseAgentFolder } from '../src/routines/agent-loader.js';
import {
  type AgentMdInput,
  AgentSerializeError,
  applyAgentMdPatch,
  serializeAgentMd,
  serializePermissions,
} from '../src/routines/agent-serializer.js';

// Достаёт текст frontmatter между первыми двумя '---' (для проверки данных).
function fmText(md: string): string {
  return md.split('---')[1] ?? '';
}

// Папка примеров движка — реальные AGENT.md для round-trip.
const EXAMPLES_DIR = resolve(process.cwd(), 'examples/agents');

function listExampleAgentMd(): string[] {
  let dirs: string[];
  try {
    dirs = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(EXAMPLES_DIR, d.name, 'AGENT.md'));
  } catch {
    return [];
  }
  return dirs;
}

// DI-обёртка: parseAgentFolder поверх in-memory папки {AGENT.md, prompt.md, ...}.
async function parseInMemory(
  files: Record<string, string>,
  dir = '/virtual/agents/my-agent',
): ReturnType<typeof parseAgentFolder> {
  const read = async (p: string): Promise<string> => {
    const rel = p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : p;
    const content = files[rel];
    if (content === undefined) throw new Error(`ENOENT ${p}`);
    return content;
  };
  const fileExists = async (p: string): Promise<boolean> => {
    const rel = p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : p;
    return files[rel] !== undefined;
  };
  return parseAgentFolder(dir, { read, fileExists });
}

const BASE_INPUT: AgentMdInput = {
  displayName: 'SEO Analyst',
  description: 'Анализирует поисковую выдачу и даёт рекомендации по контенту.',
  model: 'claude-haiku-4-5',
  enabled: false,
  trigger: 'manual',
  outputType: 'journal-only',
  maxTokens: 8000,
  timeoutMs: 600000,
};

describe('agent-serializer — serializeAgentMd round-trip через parseAgentFolder', () => {
  it('базовый агент: поля переживают serialize→parse', async () => {
    const md = serializeAgentMd(BASE_INPUT);
    const r = await parseInMemory({ 'AGENT.md': md, 'prompt.md': 'Сделай SEO-аудит.' });
    expect(r.id).toBe('my-agent'); // = имя папки
    expect(r.role).toBe('SEO Analyst'); // displayName → role
    expect(r.description).toBe(BASE_INPUT.description);
    expect(r.model).toBe('claude-haiku-4-5');
    expect(r.enabled).toBe(false);
    expect(r.trigger).toBe('manual');
    expect(r.outputType).toBe('journal-only');
    expect(r.maxTokens).toBe(8000);
    expect(r.prompt).toBe('Сделай SEO-аудит.');
    expect(r.projectId).toBe('self');
  });

  it('cron + презентация + skills сохраняются', async () => {
    const md = serializeAgentMd({
      ...BASE_INPUT,
      enabled: true,
      trigger: '0 9 * * *',
      outputType: 'both',
      avatar: '🤖',
      color: '#9F7AEA',
      departmentId: 'content-team',
      skills: ['seo-audit', 'research-serp'],
    });
    const r = await parseInMemory({ 'AGENT.md': md, 'prompt.md': 'go' });
    expect(r.enabled).toBe(true);
    expect(r.trigger).toBe('0 9 * * *');
    expect(r.outputType).toBe('both');
    expect(r.avatar).toBe('🤖');
    expect(r.color).toBe('#9F7AEA');
    expect(r.departmentId).toBe('content-team');
    expect(r.skills).toEqual(['seo-audit', 'research-serp']);
  });

  it('schemaVersion пишется строкой в кавычках (не голым числом)', () => {
    const md = serializeAgentMd(BASE_INPUT);
    expect(md).toMatch(/schemaVersion:\s*"1\.0"/);
  });

  it('пустой displayName / description → AgentSerializeError', () => {
    expect(() => serializeAgentMd({ ...BASE_INPUT, displayName: '  ' })).toThrow(
      AgentSerializeError,
    );
    expect(() => serializeAgentMd({ ...BASE_INPUT, description: '' })).toThrow(AgentSerializeError);
  });

  it('пустые avatar/color/department не попадают во frontmatter', async () => {
    const md = serializeAgentMd({ ...BASE_INPUT, avatar: '', color: '', departmentId: '' });
    expect(md).not.toMatch(/avatar:/);
    expect(md).not.toMatch(/color:/);
    expect(md).not.toMatch(/department:/);
    const r = await parseInMemory({ 'AGENT.md': md, 'prompt.md': 'go' });
    expect(r.avatar).toBeUndefined();
    expect(r.color).toBeUndefined();
  });
});

describe('agent-serializer — applyAgentMdPatch', () => {
  it('меняет model/enabled/schedule/output, сохраняет остальное', () => {
    const src = serializeAgentMd({
      ...BASE_INPUT,
      skills: ['seo-audit'],
      avatar: '🤖',
    });
    const out = applyAgentMdPatch(src, {
      model: 'claude-opus-4-8',
      enabled: true,
      trigger: '30 8 * * 1',
      outputType: 'telegram-thread',
    });
    const fm = parseYaml(fmText(out));
    expect(fm.model).toBe('claude-opus-4-8');
    expect(fm.enabled).toBe(true);
    expect(fm.schedule).toBe('30 8 * * 1');
    expect(fm.output).toBe('telegram-thread');
    expect(fm.skills).toEqual(['seo-audit']); // не затронуто
    expect(fm.avatar).toBe('🤖');
  });

  it('null удаляет опц. поле, новое значение ставит', () => {
    const src = serializeAgentMd({ ...BASE_INPUT, color: '#9F7AEA', departmentId: 'x' });
    const out = applyAgentMdPatch(src, { color: null, departmentId: 'content-team' });
    const fm = parseYaml(fmText(out));
    expect(fm.color).toBeUndefined();
    expect(fm.department).toBe('content-team');
  });

  it('description заменяет body; без description body сохраняется', () => {
    const src = serializeAgentMd(BASE_INPUT);
    const changed = applyAgentMdPatch(src, { description: 'Новая задача агента.' });
    expect(changed).toMatch(/Новая задача агента\./);
    const untouched = applyAgentMdPatch(src, { enabled: true });
    expect(untouched).toMatch(/Анализирует поисковую выдачу/);
  });

  it('пустой патч — data-preserving (frontmatter и body совпадают по данным)', () => {
    const src = serializeAgentMd({ ...BASE_INPUT, skills: ['a', 'b'], color: '#112233' });
    const out = applyAgentMdPatch(src, {});
    expect(parseYaml(fmText(out))).toEqual(parseYaml(fmText(src)));
  });

  it('правка displayName синхронит coexisting role (не оставляет stale) [DI-1]', () => {
    const src =
      '---\ndisplayName: Старое имя\nrole: Старая роль\nmodel: claude-haiku-4-5\nenabled: false\nschedule: manual\noutput: journal-only\n---\n\nТело.\n';
    const out = applyAgentMdPatch(src, { displayName: 'Новое имя' });
    const fm = parseYaml(fmText(out));
    expect(fm.displayName).toBe('Новое имя');
    expect(fm.role).toBe('Новое имя'); // синхронизирован, а не расходится
  });
});

describe('agent-serializer — round-trip на реальных примерах examples/agents', () => {
  const files = listExampleAgentMd();

  it('примеры найдены (sanity)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const name = file.split('/').slice(-2, -1)[0];
    it(`пустой патч сохраняет данные frontmatter: ${name}`, () => {
      const src = readFileSync(file, 'utf8');
      const out = applyAgentMdPatch(src, {});
      // Данные frontmatter совпадают (комментарии могут уйти — это ок).
      const fmSrc = parseYaml(fmText(src));
      const fmOut = parseYaml(fmText(out));
      expect(fmOut).toEqual(fmSrc);
    });
  }
});

describe('agent-serializer — serializePermissions', () => {
  it('tools/bash → yaml; пустые — null', () => {
    expect(serializePermissions(null, [], undefined)).toBeNull();
    const y = serializePermissions(null, ['project.read'], ['git log']);
    expect(y).toMatch(/tools:/);
    expect(y).toMatch(/project\.read/);
    expect(y).toMatch(/bash:/);
  });

  it('сохраняет прочие ключи existing (merge)', () => {
    const y = serializePermissions({ secrets: ['FOO'] }, ['t'], undefined);
    expect(y).toMatch(/secrets:/);
    expect(y).toMatch(/FOO/);
    expect(y).toMatch(/tools:/);
  });
});
