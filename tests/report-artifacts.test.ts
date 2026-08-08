import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveReportArtifacts, sendReportArtifacts } from '../src/report/artifacts.js';

let tmp: string | null = null;

function makeFixture(): string {
  tmp = mkdtempSync(join(tmpdir(), 'report-artifacts-'));
  mkdirSync(join(tmp, 'content'), { recursive: true });
  writeFileSync(join(tmp, 'content', 'ready.md'), '# Ready\n');
  writeFileSync(join(tmp, 'content', 'ready.html'), '<h1>Ready</h1>\n');
  writeFileSync(join(tmp, 'content', 'ready-cover.png'), 'png');
  writeFileSync(join(tmp, 'content', 'ready-cover.svg'), '<svg />');
  writeFileSync(join(tmp, 'content', 'ready.qa.json'), '{}');
  return tmp;
}

afterEach(() => {
  if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('resolveReportArtifacts', () => {
  it('extracts final article files from content and ignores unrelated or unsafe paths', async () => {
    const root = makeFixture();
    const artifacts = await resolveReportArtifacts(
      [
        'Article: content/ready.md',
        'HTML: `content/ready.html`',
        'Cover: content/ready-cover.png',
        'QA: content/ready.qa.json',
        'Cover: ../secret.png',
      ].join('\n'),
      { rootDir: root },
    );

    expect(
      artifacts.map((a) => ({ kind: a.kind, method: a.telegramMethod, fileName: a.fileName })),
    ).toEqual([
      { kind: 'article', method: 'document', fileName: 'ready.md' },
      { kind: 'html', method: 'document', fileName: 'ready.html' },
      { kind: 'cover', method: 'photo', fileName: 'ready-cover.png' },
    ]);
  });

  it('sends svg covers as documents and deduplicates repeated refs', async () => {
    const root = makeFixture();
    const artifacts = await resolveReportArtifacts(
      ['cover: content/ready-cover.svg', 'Cover: content/ready-cover.svg'].join('\n'),
      { rootDir: root },
    );

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.telegramMethod).toBe('document');
    expect(artifacts[0]?.kind).toBe('cover');
  });

  it('sends photos and documents through the matching Telegram API methods', async () => {
    const api = {
      sendPhoto: vi.fn(async () => ({})),
      sendDocument: vi.fn(async () => ({})),
    };

    await sendReportArtifacts(
      '123',
      [
        {
          kind: 'cover',
          path: '/tmp/cover.png',
          fileName: 'cover.png',
          telegramMethod: 'photo',
        },
        {
          kind: 'html',
          path: '/tmp/article.html',
          fileName: 'article.html',
          telegramMethod: 'document',
        },
      ],
      api,
      (path) => `input:${path}`,
    );

    expect(api.sendPhoto).toHaveBeenCalledWith('123', 'input:/tmp/cover.png', {
      caption: 'Cover: cover.png',
    });
    expect(api.sendDocument).toHaveBeenCalledWith('123', 'input:/tmp/article.html', {
      caption: 'HTML: article.html',
    });
  });
});
