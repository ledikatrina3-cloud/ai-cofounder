// Тесты для tool report.send (фаза 2.5).
//
// Стратегия:
//   * vi.mock на src/report/sender.js — мокируем sendReport.
//     Никаких сетевых вызовов Telegram, никакого реального botApi.
//   * resolveFounderChatId передаётся через ReportSendDeps — тесты задают
//     founder chatId детерминированно без keychain и allowlist.md.
//   * Проверяем: sendReport вызвана нужное число раз, с правильным текстом,
//     ошибка оборачивается в ReportSendError.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportSendError, reportSend } from '../src/tools/report-send/index.js';

// ---------------------------------------------------------------------------
// Mock sendReport из sender.ts.
// ---------------------------------------------------------------------------

vi.mock('../src/report/sender.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/report/sender.js')>();
  return {
    ...actual,
    sendReport: vi.fn(),
  };
});

import { sendReport } from '../src/report/sender.js';

const mockSendReport = vi.mocked(sendReport);

// ---------------------------------------------------------------------------
// Test rig.
// ---------------------------------------------------------------------------

const FOUNDER_CHAT_ID = '123456789';

function makeDeps() {
  return {
    resolveFounderChatId: async () => FOUNDER_CHAT_ID,
    sleep: async (_ms: number) => {},
  };
}

beforeEach(() => {
  mockSendReport.mockClear();
  // По умолчанию sendReport успешно завершается.
  mockSendReport.mockResolvedValue({
    sentMessageIds: [1],
    messages: [],
    founderChatId: FOUNDER_CHAT_ID,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('reportSend', () => {
  it('reportSend([{text}]) → sendReport вызван 1 раз с текстом и founder chatId', async () => {
    await reportSend([{ text: 'hello' }], makeDeps());

    expect(mockSendReport).toHaveBeenCalledTimes(1);

    const [messagesArg, depsArg] = mockSendReport.mock.calls[0] ?? [];
    // Проверяем текст первого сообщения.
    expect(Array.isArray(messagesArg)).toBe(true);
    expect((messagesArg as Array<{ text: string }>)[0]?.text).toBe('hello');
    // resolveFounderChatId пробрасывается в deps.
    expect(typeof (depsArg as { resolveFounderChatId?: unknown })?.resolveFounderChatId).toBe(
      'function',
    );
  });

  it('reportSend([{text: a}, {text: b}]) → sendReport вызван 1 раз с двумя сообщениями', async () => {
    await reportSend([{ text: 'a' }, { text: 'b' }], makeDeps());

    expect(mockSendReport).toHaveBeenCalledTimes(1);

    const [messagesArg] = mockSendReport.mock.calls[0] ?? [];
    expect(Array.isArray(messagesArg)).toBe(true);
    expect(messagesArg as Array<{ text: string }>).toHaveLength(2);
    expect((messagesArg as Array<{ text: string }>)[0]?.text).toBe('a');
    expect((messagesArg as Array<{ text: string }>)[1]?.text).toBe('b');
  });

  it('пустой массив → sendReport не вызывается', async () => {
    await reportSend([], makeDeps());
    expect(mockSendReport).not.toHaveBeenCalled();
  });

  it('sendReport throws → ReportSendError оборачивает ошибку', async () => {
    mockSendReport.mockRejectedValue(new Error('network failure'));

    await expect(reportSend([{ text: 'hello' }], makeDeps())).rejects.toThrow(ReportSendError);
    await expect(reportSend([{ text: 'hello' }], makeDeps())).rejects.toThrow(
      /report\.send:.*network failure/,
    );
  });

  it('parseMode передаётся в TelegramMessage корректно (HTML)', async () => {
    await reportSend([{ text: 'bold', parseMode: 'HTML' }], makeDeps());

    const [messagesArg] = mockSendReport.mock.calls[0] ?? [];
    const first = (messagesArg as Array<{ parseMode: string }>)[0];
    expect(first?.parseMode).toBe('HTML');
  });

  it('дефолтный parseMode → Markdown', async () => {
    await reportSend([{ text: 'plain' }], makeDeps());

    const [messagesArg] = mockSendReport.mock.calls[0] ?? [];
    const first = (messagesArg as Array<{ parseMode: string }>)[0];
    expect(first?.parseMode).toBe('Markdown');
  });
});
