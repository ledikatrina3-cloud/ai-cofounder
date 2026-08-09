import { describe, expect, it, vi } from 'vitest';

const { emitMock } = vi.hoisted(() => ({
  emitMock: vi.fn(async () => undefined),
}));

vi.mock('../src/observe/bridge.js', () => ({
  emit: emitMock,
}));

const { emitFromSDKMessage } = await import('../src/llm/subagent.js');

describe('emitFromSDKMessage', () => {
  it('emits full assistant.message text so final reports keep artifact refs', () => {
    emitMock.mockClear();
    const report = [
      'Final report',
      '',
      `details: ${'x'.repeat(640)}`,
      'Artifacts:',
      'article: content/zayavki.md',
      'html: content/zayavki.html',
      'cover: content/zayavki-cover.png',
      'cover: content/zayavki-cover.svg',
    ].join('\n');

    emitFromSDKMessage(
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: report }] },
      } as never,
      new Map(),
    );

    expect(emitMock).toHaveBeenCalledWith({ type: 'assistant.message', text: report });
  });
});
