// Тесты для pipeline.yml parser'а (Фаза 5).

import { describe, expect, it } from 'vitest';
import { PipelineParseError, parsePipeline } from '../src/pipelines/parser.js';
import { parseDuration } from '../src/pipelines/types.js';

const FILE = '/abs/repo/departments/marketing/pipeline.yml';

describe('parseDuration', () => {
  it('парсит ms/s/m/h/d', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('3s')).toBe(3000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1d')).toBe(86_400_000);
  });

  it('целое без суффикса = ms', () => {
    expect(parseDuration('1234')).toBe(1234);
  });

  it('бросает на невалидном формате', () => {
    expect(() => parseDuration('5x')).toThrow();
    expect(() => parseDuration('')).toThrow();
  });
});

describe('parsePipeline — happy path', () => {
  it('парсит минимальный pipeline с одной employee-нодой', () => {
    const yml = `
nodes:
  - id: research
    employee: marketing-researcher
    output: outputs/research/\${date}.md
`;
    const p = parsePipeline(yml, FILE);
    expect(p.nodes).toHaveLength(1);
    const n = p.nodes[0];
    if (n === undefined || n.kind !== 'employee') throw new Error('expected employee');
    expect(n.id).toBe('research');
    expect(n.employee).toBe('marketing-researcher');
    expect(n.output).toBe('outputs/research/${date}.md');
    expect(n.inputs).toEqual([]);
  });

  it('парсит human-gate с timeout и onTimeout', () => {
    const yml = `
nodes:
  - id: approve-theme
    type: human-gate
    via: telegram
    timeout: 24h
    onTimeout: skip-pipeline
`;
    const p = parsePipeline(yml, FILE);
    const n = p.nodes[0];
    if (n === undefined || n.kind !== 'human-gate') throw new Error('expected human-gate');
    expect(n.timeoutMs).toBe(86_400_000);
    expect(n.onTimeout).toBe('skip-pipeline');
    expect(n.via).toBe('telegram');
  });

  it('парсит parallel с тремя ветками', () => {
    const yml = `
nodes:
  - id: draft
    employee: writer
    output: drafts/\${date}.md
  - id: publish
    inputs: [draft]
    parallel:
      - employee: vc-pub
        input: draft
        output: out/vc.md
      - employee: dzen-pub
        input: draft
        output: out/dzen.md
      - employee: tg-pub
        input: draft
        output: out/tg.md
`;
    const p = parsePipeline(yml, FILE);
    const par = p.nodes.find((x) => x.id === 'publish');
    if (par === undefined || par.kind !== 'parallel') throw new Error('expected parallel');
    expect(par.branches).toHaveLength(3);
    expect(par.branches[0]?.employee).toBe('vc-pub');
  });

  it('парсит onFail с retries и backoff', () => {
    const yml = `
nodes:
  - id: research
    employee: r
    output: out.md
    onFail:
      retries: 2
      backoff: 5m
      then: alert
`;
    const p = parsePipeline(yml, FILE);
    const n = p.nodes[0];
    if (n === undefined || n.kind !== 'employee') throw new Error();
    expect(n.onFail).toEqual({ retries: 2, backoffMs: 300_000, then: 'alert' });
  });

  it('парсит lookback короткой формы', () => {
    const yml = `
nodes:
  - id: analytics
    employee: a
    output: out.json
    lookback: publish:24h
`;
    const p = parsePipeline(yml, FILE);
    const n = p.nodes[0];
    if (n === undefined || n.kind !== 'employee') throw new Error();
    expect(n.lookback).toEqual({ source: 'publish', windowMs: 86_400_000 });
  });

  it('парсит model override', () => {
    const yml = `
nodes:
  - id: seo
    employee: seo-auditor
    output: out.json
    model: claude-haiku-4-5
`;
    const p = parsePipeline(yml, FILE);
    const n = p.nodes[0];
    if (n === undefined || n.kind !== 'employee') throw new Error();
    expect(n.model).toBe('claude-haiku-4-5');
  });
});

describe('parsePipeline — errors', () => {
  it('пустые nodes — ошибка', () => {
    expect(() => parsePipeline('nodes: []', FILE)).toThrow(PipelineParseError);
  });

  it('дубль id — ошибка', () => {
    const yml = `
nodes:
  - id: a
    employee: x
    output: x.md
  - id: a
    employee: y
    output: y.md
`;
    expect(() => parsePipeline(yml, FILE)).toThrow(/дубль id/);
  });

  it('id не в kebab-case — ошибка', () => {
    const yml = `
nodes:
  - id: BadID
    employee: x
    output: x.md
`;
    expect(() => parsePipeline(yml, FILE)).toThrow(/kebab-case/);
  });

  it('input ссылается на неизвестную ноду', () => {
    const yml = `
nodes:
  - id: a
    employee: x
    inputs: [nonexistent]
    output: x.md
`;
    expect(() => parsePipeline(yml, FILE)).toThrow(/не соответствует ни одной известной node id/);
  });

  it('onFail.then с неизвестным значением', () => {
    const yml = `
nodes:
  - id: a
    employee: x
    output: x.md
    onFail:
      retries: 1
      then: explode
`;
    expect(() => parsePipeline(yml, FILE)).toThrow(/explode/);
  });

  it('human-gate без timeout — ошибка', () => {
    const yml = `
nodes:
  - id: g
    type: human-gate
    via: telegram
    onTimeout: halt
`;
    expect(() => parsePipeline(yml, FILE)).toThrow(/human-gate требует 'timeout'/);
  });

  it('parallel без веток — ошибка', () => {
    const yml = `
nodes:
  - id: p
    parallel: []
`;
    expect(() => parsePipeline(yml, FILE)).toThrow(/непустым массивом веток/);
  });
});
