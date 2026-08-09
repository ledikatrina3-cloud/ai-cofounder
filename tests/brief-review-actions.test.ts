import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonlSession } from '../bridge/jsonl-writer.js';
import { type BridgeServerHandle, startBridgeServer } from '../bridge/server.js';

function noopSession(): JsonlSession {
  return {
    sessionId: 'test',
    filePath: '/tmp/noop.jsonl',
    write: async () => undefined,
  };
}

function writeBrief(cwd: string, status = 'needs_human_review'): string {
  const dir = join(cwd, 'content', 'briefs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'article-brief-latest.md');
  writeFileSync(
    file,
    `# Article Brief: Test topic\n\nДата: 2026-08-08\nStatus: ${status}\nAgent: article-brief-researcher\nCORE-KEYWORD: test keyword\n\n## 1. Тема\nТестовая тема.\n`,
    'utf8',
  );
  return file;
}

function writeBacklog(cwd: string): string {
  const dir = join(cwd, 'departments', 'marketing-content', 'shared');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'topics-backlog.md');
  writeFileSync(
    file,
    `# Topics backlog

## High priority
- [ ] Old repeated topic
- [ ] Fresh next topic
`,
    'utf8',
  );
  return file;
}

function installFakeRoutineRunner(cwd: string): string {
  const coreDir = join(cwd, 'dist', 'src', 'core');
  mkdirSync(coreDir, { recursive: true });
  const callsFile = join(cwd, 'content', 'briefs', 'routine-run-calls.json');
  writeFileSync(
    join(coreDir, 'triggers.js'),
    `export function triggerManualRoutine(id) { return { source: 'manual', routineId: id }; }\n`,
    'utf8',
  );
  writeFileSync(
    join(coreDir, 'dispatcher.js'),
    `import { writeFileSync } from 'node:fs';\nexport async function runRoutine(id, runDate, trigger) { writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ id, runDate, trigger }), 'utf8'); }\n`,
    'utf8',
  );
  return callsFile;
}

describe('article brief review actions', () => {
  let previousCwd: string;
  let cwd: string;
  let handle: BridgeServerHandle;

  beforeEach(async () => {
    previousCwd = process.cwd();
    cwd = join(
      tmpdir(),
      `brief-review-actions-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(cwd, { recursive: true });
    process.chdir(cwd);
    handle = await startBridgeServer({ port: 0, session: noopSession() });
  });

  afterEach(async () => {
    await handle.close();
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('reject marks latest brief as rejected and appends reviewer comment', async () => {
    const file = writeBrief(cwd);
    const backlogFile = writeBacklog(cwd);

    const res = await fetch(`http://127.0.0.1:${handle.port}/content/briefs/latest/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comment: 'Угол уже раскрыт, тему не берем.' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status?: string };
    expect(body).toMatchObject({ ok: true, status: 'rejected' });
    const markdown = readFileSync(file, 'utf8');
    expect(markdown).toContain('Status: rejected');
    expect(markdown).toContain('Угол уже раскрыт, тему не берем.');
    const backlog = readFileSync(backlogFile, 'utf8');
    expect(backlog).toContain('- [x] Old repeated topic <!-- rejected ');
    expect(backlog).toContain('- [ ] Fresh next topic');
  });

  it('research retry requires a reviewer comment', async () => {
    writeBrief(cwd);

    const res = await fetch(
      `http://127.0.0.1:${handle.port}/content/briefs/latest/research-retry`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ comment: '   ' }),
      },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/comment/i);
  });

  it('research retry marks brief and starts article-brief-researcher', async () => {
    const file = writeBrief(cwd);
    const backlogFile = writeBacklog(cwd);
    const callsFile = installFakeRoutineRunner(cwd);

    const res = await fetch(
      `http://127.0.0.1:${handle.port}/content/briefs/latest/research-retry`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ comment: 'Нужен другой угол, без повторения готовой статьи.' }),
      },
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; status?: string; routineId?: string };
    expect(body).toMatchObject({
      ok: true,
      status: 'research_requested',
      routineId: 'article-brief-researcher',
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    const markdown = readFileSync(file, 'utf8');
    expect(markdown).toContain('Status: research_requested');
    expect(markdown).toContain('Нужен другой угол, без повторения готовой статьи.');

    const backlog = readFileSync(backlogFile, 'utf8');
    expect(backlog).toContain('- [x] Old repeated topic <!-- skipped ');
    expect(backlog).toContain('- [ ] Fresh next topic');

    const call = JSON.parse(readFileSync(callsFile, 'utf8')) as { id: string; trigger: unknown };
    expect(call.id).toBe('article-brief-researcher');
    expect(call.trigger).toMatchObject({ source: 'manual', routineId: 'article-brief-researcher' });
  });
});
