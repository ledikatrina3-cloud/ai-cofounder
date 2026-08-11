import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractPageSummary,
  normalizeReferenceUrl,
} from '../skills/research-serp/scripts/reference-blogs.js';

function runValidation(evidence: unknown, registry: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'editorial-evidence-'));
  const evidencePath = join(dir, 'evidence.json');
  const registryPath = join(dir, 'references.md');
  writeFileSync(evidencePath, JSON.stringify(evidence), 'utf8');
  writeFileSync(
    registryPath,
    registry.map((url) => `| ${url} | test purpose |`).join('\n'),
    'utf8',
  );
  const result = spawnSync(
    'node',
    [
      'scripts/article-editorial-context.mjs',
      '--validate-evidence',
      evidencePath,
      '--registry',
      registryPath,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  return { status: result.status, stderr: result.stderr, json: JSON.parse(result.stdout) };
}

const references = ['https://example.com/blog', 'https://t.me/findir_pro'];

function validEvidence() {
  return {
    references: [
      {
        url: 'https://example.com/blog',
        status: 'opened',
        observed_pattern: 'Заголовок строится вокруг конфликта собственника и финансов.',
        article_decision: 'Открыть статью конкретным противоречием, без вопроса в H1.',
        accessed_at: '2026-08-11T09:00:00Z',
      },
      {
        url: 'https://t.me/s/findir_pro',
        status: 'failed',
        article_decision: 'Не использовать неподтвержденные наблюдения из канала.',
        accessed_at: '2026-08-11T09:01:00Z',
      },
    ],
    mastery: {
      pre_draft: [
        {
          source: 'mastery/copywriting/igor-ledohovsky.md',
          method: 'контраст ожидания и факта',
          problem: 'абстрактное начало не показывает цену ошибки',
          location: 'лид и первый смысловой поворот',
          rejected_alternative: 'начать с общего определения автоматизации',
        },
      ],
      post_draft: [
        {
          source: 'mastery/redaktor/INDEX.md',
          method: 'проверка естественности фразы',
          before: 'Просьба объединяла несколько разных работ.',
          after: 'В одной просьбе смешались несколько участков работы.',
          reason: 'После правки фраза звучит естественно и называет предмет точно.',
        },
      ],
    },
  };
}

describe('Telegram reference extraction', () => {
  it('normalizes a channel URL to the public preview', () => {
    expect(normalizeReferenceUrl('https://t.me/findir_pro')).toBe('https://t.me/s/findir_pro');
    expect(normalizeReferenceUrl('https://t.me/s/findir_pro')).toBe('https://t.me/s/findir_pro');
  });

  it('extracts visible post headings and questions from an offline HTML fixture', () => {
    const html = `
      <html><head><title>Мастер CFO</title></head><body>
        <div class="tgme_widget_message_text">Почему прибыль есть, а денег нет?<br>Три ошибки в платежном календаре</div>
        <div class="tgme_widget_message_text"><b>Что собственник не видит в отчете?</b><br>Разбираем на цифрах</div>
      </body></html>`;
    const page = extractPageSummary('https://t.me/s/findir_pro', html, ['прибыль']);

    expect(page.headings).toEqual([
      'Почему прибыль есть, а денег нет?',
      'Три ошибки в платежном календаре',
      'Что собственник не видит в отчете?',
      'Разбираем на цифрах',
    ]);
  });
});

describe('editorial evidence validation', () => {
  it('accepts complete reference and mastery evidence', () => {
    const result = runValidation(validEvidence(), references);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.json).toEqual({ pass: true, issues: [] });
  });

  it('requires exactly one attempt for every enabled registry URL', () => {
    const evidence = validEvidence();
    evidence.references.pop();
    evidence.references.push({ ...evidence.references[0] });
    const result = runValidation(evidence, references);

    expect(result.status).toBe(1);
    expect(result.json.issues.map((issue: { code: string }) => issue.code)).toEqual(
      expect.arrayContaining(['reference_duplicate_attempt', 'reference_missing_attempt']),
    );
  });

  it('requires observed_pattern only for opened references and all common fields', () => {
    const evidence = validEvidence();
    evidence.references[0].observed_pattern = '';
    evidence.references[1].status = 'unknown';
    evidence.references[1].article_decision = 'не применено';
    const result = runValidation(evidence, references);

    expect(result.status).toBe(1);
    expect(result.json.issues.map((issue: { code: string }) => issue.code)).toEqual(
      expect.arrayContaining([
        'reference_observed_pattern_required',
        'reference_status_invalid',
        'field_too_generic',
      ]),
    );
  });

  it('rejects path-only and generic pre-draft mastery evidence', () => {
    const evidence = validEvidence();
    evidence.mastery.pre_draft = [
      {
        source: 'notes/random.md',
        method: 'прочитано',
        problem: '',
        location: 'применено',
        rejected_alternative: '',
      },
    ];
    const result = runValidation(evidence, references);

    expect(result.status).toBe(1);
    expect(result.json.issues.map((issue: { code: string }) => issue.code)).toEqual(
      expect.arrayContaining(['mastery_source_invalid', 'field_required', 'field_too_generic']),
    );
  });

  it('requires a concrete before-after edit tied to mastery after the draft', () => {
    const evidence = validEvidence();
    evidence.mastery.post_draft = [
      {
        source: 'mastery/redaktor/INDEX.md',
        method: 'применено',
        before: 'Одинаковая фраза.',
        after: 'Одинаковая фраза.',
        reason: 'готово',
      },
    ];
    const result = runValidation(evidence, references);

    expect(result.status).toBe(1);
    expect(result.json.issues.map((issue: { code: string }) => issue.code)).toEqual(
      expect.arrayContaining(['mastery_edit_unchanged', 'field_too_generic']),
    );
  });
});
