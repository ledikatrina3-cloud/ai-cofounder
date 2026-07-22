import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../src/observe/redaction.js';

// Источник правды для масок: bridge/server.ts L280-289.
// 3 кейса = 3 регулярки в redaction.ts.
//
// Не дублируем shape BridgeEvent — redactSecrets оперирует на string. Проверяем
// именно строковые подстановки, чтобы тест не зависел от schema-эволюции.

describe('redactSecrets — мостик.md L280', () => {
  it('маскирует Telegram bot token (digits:base64url 35+)', () => {
    const realFormat = '1234567890:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const evt = JSON.stringify({
      type: 'tool.start',
      input: { url: `https://api.telegram.org/bot${realFormat}/sendMessage` },
    });
    const out = redactSecrets(evt);
    expect(out).not.toContain(realFormat);
    expect(out).toContain('***');
    // Структура JSON сохраняется — заменяем только сам токен.
    expect(out).toContain('api.telegram.org/bot***');
  });

  it('маскирует API-key с известным префиксом (sk-, rk_, whsec_, tok_)', () => {
    const samples = [
      'sk-ant-1234567890abcdefABCDEF',
      'rk_live_abcdefghijklmnop1234',
      'whsec_qrstuvwxyz0123456789ab',
      'tok_qrstuvwxyz0123456789abcd',
    ];
    for (const sample of samples) {
      const evt = JSON.stringify({ type: 'audit.spend', notes: `key=${sample} delivered` });
      const out = redactSecrets(evt);
      expect(out, `должно замаскировать ${sample}`).not.toContain(sample);
      expect(out).toContain('***');
    }
  });

  it('маскирует ключ-значение для известных имён (API_KEY, SECRET, TOKEN, PASSWORD, DATABASE_URL, BEARER)', () => {
    const cases: Array<[string, string]> = [
      ['ANTHROPIC_API_KEY=sk-totally-not-real-secret-12345', 'API_KEY=***'],
      ['SECRET: deadbeefdeadbeefdeadbeef', 'SECRET=***'],
      // Формат, который ловит regex из мостик.md L284: KEY=VALUE / KEY:VALUE.
      // HTTP-вид «Authorization: BEARER xxx» (BEARER+пробел) — НЕ покрывается этим
      // регексом и не должен покрываться: для HTTP-заголовков актуальный токен
      // обычно ловится PREFIX_TOKEN_PATTERN'ом ниже (sk-/rk_/whsec_/tok_).
      ['BEARER=abcdef1234567890', 'BEARER=***'],
      ['DATABASE_URL=postgres://user:pwd@host:5432/db', 'DATABASE_URL=***'],
      ['PASSWORD = "hunter2"', 'PASSWORD=***'],
      ['TOKEN: ghp_1234567890', 'TOKEN=***'],
    ];
    for (const [input, expectedFragment] of cases) {
      const out = redactSecrets(input);
      expect(out, `${input} должно содержать ${expectedFragment}`).toContain(expectedFragment);
      // Ничего полезного для расследования не теряем — оригинальное имя поля остаётся.
      expect(out).not.toContain(input.split(/[=:]/)[1]?.trim() ?? '');
    }
  });

  it('не трогает безобидные ULID-идентификаторы и обычный текст', () => {
    const safe = JSON.stringify({
      type: 'event.trigger',
      recordId: '01KQG8J51T0KM1NTCV1SM784FW',
      idempotencyKey: 'morning-detective:2026-04-30',
      message: 'detected 3 problems overnight',
    });
    const out = redactSecrets(safe);
    expect(out).toBe(safe);
  });
});
