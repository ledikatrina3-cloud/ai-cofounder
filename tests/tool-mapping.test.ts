import { describe, expect, it } from 'vitest';
import { mapTool } from '../bridge/app/src/lib/tool-mapping.js';

describe('mapTool', () => {
  it('Read → FS', () => expect(mapTool('Read').orbital).toBe('FS'));
  it('Bash → BASH', () => expect(mapTool('Bash').orbital).toBe('BASH'));
  it('WebFetch → WEB', () => expect(mapTool('WebFetch').orbital).toBe('WEB'));
  it('mcp__postgres__query → DB', () => expect(mapTool('mcp__postgres__query').orbital).toBe('DB'));
  it('mcp__telegram__sendMessage → TG', () =>
    expect(mapTool('mcp__telegram__sendMessage').orbital).toBe('TG'));
  it('mcp__gmail__send → EMAIL', () => expect(mapTool('mcp__gmail__send').orbital).toBe('EMAIL'));
  it('unknown tool → FS default', () => expect(mapTool('SomeTool').orbital).toBe('FS'));
  it('Edit → FS с акцентным цветом', () => expect(mapTool('Edit').color).toBe('#d97757'));
});
